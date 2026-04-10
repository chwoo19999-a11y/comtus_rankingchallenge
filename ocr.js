// =============================================
//  OCR Module - Tesseract.js 연동 + 요일별 차분 계산
// =============================================
//  로직:
//    월요일 → 스크린샷 값 그대로 적용
//    화~일요일 → 오늘 누적값 - 전날 누적값 = 해당 요일 실제 기록
// =============================================

const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

// 타자 포지션: 게임 화면 영문 코드 → 내부 한국어명 매핑
const BATTER_POS_MAP = {
    'C': '포수',
    '1B': '1루수',
    '2B': '2루수',
    '3B': '3루수',
    'SS': '유격수',
    'LF': '좌익수',
    'CF': '중견수',
    'RF': '우익수',
    'DH': '지명타자',
};
// 순서 중요: 더 긴 코드(예: 1B)를 먼저 인식해야 '1'메치 오탐을 피할 수 있음
const BATTER_POS_CODES = ['DH', 'SS', '1B', '2B', '3B', 'LF', 'CF', 'RF', 'C'];

// 투수 포지션: SP1에서 CP까지
const PITCHER_POS_PATTERNS = ['SP1', 'SP2', 'SP3', 'SP4', 'SP5', 'RP1', 'RP2', 'RP3', 'RP4', 'CP'];

// ── Tesseract 동적 로드 ──
let _tesseractLoaded = false;
function loadTesseract() {
    return new Promise((resolve, reject) => {
        if (_tesseractLoaded && window.Tesseract) { resolve(); return; }
        if (document.getElementById('tesseractScript')) {
            // 이미 로드 중이면 최대 10초 대기
            const t = setInterval(() => { if (window.Tesseract) { clearInterval(t); resolve(); } }, 200);
            setTimeout(() => { clearInterval(t); reject(new Error('Tesseract 로드 타임아웃')); }, 10000);
            return;
        }
        const script = document.createElement('script');
        script.id = 'tesseractScript';
        script.src = TESSERACT_CDN;
        script.onload = () => { _tesseractLoaded = true; resolve(); };
        script.onerror = () => reject(new Error('Tesseract.js 로드 실패 (인터넷 연결 확인)'));
        document.head.appendChild(script);
    });
}

// ── 이미지 → Canvas 변환 + 대비 강화 ──
function preprocessImageToCanvas(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const maxW = 2400;
            const scale = img.width > maxW ? maxW / img.width : 1;
            canvas.width = img.width * scale;
            canvas.height = img.height * scale;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

            // 대비 강화
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const d = imageData.data;
            const contrast = 60;
            const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
            for (let i = 0; i < d.length; i += 4) {
                d[i] = clamp(factor * (d[i] - 128) + 128);
                d[i + 1] = clamp(factor * (d[i + 1] - 128) + 128);
                d[i + 2] = clamp(factor * (d[i + 2] - 128) + 128);
            }
            ctx.putImageData(imageData, 0, 0);
            URL.revokeObjectURL(url);
            resolve(canvas);
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지 로드 실패')); };
        img.src = url;
    });
}

function clamp(v) { return Math.max(0, Math.min(255, Math.round(v))); }

// ── OCR 실행 ──
async function runOCR(canvas, onProgress) {
    const worker = await Tesseract.createWorker('kor+eng', 1, {
        logger: m => {
            if (m.status === 'recognizing text' && onProgress) {
                onProgress(Math.round(m.progress * 100));
            }
        }
    });
    const { data: { text } } = await worker.recognize(canvas);
    await worker.terminate();
    return text;
}

// ── 텍스트 파싱: 타자 ──
function parseOCRBatterText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const results = [];

    for (const line of lines) {
        // 숫자가 없는 줄은 스킵 (팀명 등 제외)
        if (!/\d/.test(line)) continue;

        // 한글 선수명 찾기 (2~4글자, 선택적으로 영문자·연도 포함)
        const nameMatch = line.match(/([가-힣]{2,4}(?:[A-Z]?['']?\d{2})?[A-Z]?)/);
        if (!nameMatch) continue;

        const name = nameMatch[1].trim();

        // 순서대로 포지션 배정 (1번째 선수 → 포수, 2번째 → 1루수, ...)
        const posIdx = results.length;
        if (posIdx >= window.BATTER_POSITIONS.length) break;
        const korPos = window.BATTER_POSITIONS[posIdx].pos;

        // 숫자 추출
        const nums = extractNumbers(line);
        const inputNums = skipDerivedStats(nums);

        results.push({
            pos: korPos,
            name,
            '경기': safeInt(inputNums, 0),
            '타수': safeInt(inputNums, 1),
            '안타': safeInt(inputNums, 2),
            '2루타': safeInt(inputNums, 3),
            '3루타': safeInt(inputNums, 4),
            '홈런': safeInt(inputNums, 5),
            '볼넷': safeInt(inputNums, 6),
            '사구': safeInt(inputNums, 7),
            '희생플라이': safeInt(inputNums, 8),
            '득점권타수': safeInt(inputNums, 9),
            '득점권안타': safeInt(inputNums, 10),
        });
    }
    return results;
}

// ── 텍스트 파싱: 투수 ──
function parseOCRPitcherText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const results = [];
    for (const line of lines) {
        // 숫자가 없는 줄은 스킵 (팀명 등 제외)
        if (!/\d/.test(line)) continue;

        // 한글 선수명 찾기 (2~4글자, 선택적으로 영문자·연도 포함)
        const nameMatch = line.match(/([가-힣]{2,4}(?:[A-Z]?['']?\d{2})?[A-Z]?)/);
        if (!nameMatch) continue;

        const name = nameMatch[1].trim();

        // 순서대로 포지션 배정
        const posIdx = results.length;
        if (posIdx >= window.PITCHER_POSITIONS.length) break;
        const pos = window.PITCHER_POSITIONS[posIdx];

        const nums = extractNumbers(line);
        const inputNums = nums.length > 0 ? nums.slice(1) : nums; // ERA 스킵
        const inningRaw = extractInning(line);
        results.push({
            pos,
            name,
            '경기': safeInt(inputNums, 0),
            '승': safeInt(inputNums, 1),
            '패': safeInt(inputNums, 2),
            '이닝': inningRaw || safeInt(inputNums, 3),
            '자책점': safeInt(inputNums, 4),
        });
    }
    return results;
}

// ── 숫자 파싱 유틸 ──
function extractNumbers(str) {
    return (str.match(/\d+(\.\d+)?/g) || []).map(Number);
}
function extractInning(str) {
    const m = str.match(/(\d+)\s*(1\/3|2\/3)/);
    if (m) return `${m[1]} ${m[2]}`;
    return null;
}
function skipDerivedStats(nums) {
    let skip = 0;
    for (let i = 0; i < nums.length && skip < 5; i++) {
        if (!Number.isInteger(nums[i]) || nums[i] < 1) skip++;
        else break;
    }
    return nums.slice(skip);
}
function safeInt(arr, idx) {
    return arr[idx] !== undefined ? String(Math.round(arr[idx])) : '0';
}

// ── 이닝 파싱/포맷 ──
function parseInningNum(v) {
    if (!v && v !== 0) return 0;
    const s = String(v).trim();
    const m = s.match(/^(\d+)\s*(1\/3|2\/3)/);
    if (m) return parseInt(m[1]) + (m[2] === '1/3' ? 1 / 3 : 2 / 3);
    return parseFloat(s) || 0;
}
function formatInningStr(val) {
    const total = typeof val === 'number' ? val : parseInningNum(val);
    const full = Math.floor(total);
    const frac = total - full;
    if (Math.abs(frac - 1 / 3) < 0.01) return `${full} 1/3`;
    if (Math.abs(frac - 2 / 3) < 0.01) return `${full} 2/3`;
    return `${full}`;
}

// ── 요일별 차분 계산 ──
// today[]  : 오늘 스크린샷의 누적값 배열 (parseOCRBatterText 결과)
// prevRaw[]: 전날 저장된 raw 누적값 배열 (없으면 null → 월요일)
// 반환: { diffRow[], todayRaw[] } — diffRow는 오늘 하루 실제 기록
function computeDiff(todayParsed, prevRaw, type) {
    const fields = type === 'batter'
        ? ['경기', '타수', '안타', '2루타', '3루타', '홈런', '볼넷', '사구', '희생플라이', '득점권타수', '득점권안타']
        : ['경기', '승', '패', '이닝', '자책점'];

    const posList = type === 'batter' ? BATTER_POS_PATTERNS : PITCHER_POS_PATTERNS;

    return todayParsed.map(todayRow => {
        const prevRow = prevRaw
            ? prevRaw.find(r => r.pos === todayRow.pos)
            : null;

        const diffRow = { pos: todayRow.pos, name: todayRow.name };
        const todayRawRow = { pos: todayRow.pos, name: todayRow.name };

        fields.forEach(f => {
            // 저장용 raw = 오늘 스크린샷 그대로
            todayRawRow[f] = todayRow[f];

            if (!prevRow) {
                // 월요일(또는 전날 raw 없음) → 그대로 사용
                diffRow[f] = todayRow[f];
            } else if (f === '이닝') {
                const diff = parseInningNum(todayRow[f]) - parseInningNum(prevRow[f]);
                diffRow[f] = formatInningStr(Math.max(0, diff));
            } else {
                const diff = (parseInt(todayRow[f]) || 0) - (parseInt(prevRow[f]) || 0);
                diffRow[f] = String(Math.max(0, diff));
            }
        });

        return { diffRow, todayRawRow };
    });
}

// ── 메인 OCR 파이프라인 ──
async function runOCRPipeline(file, type, day) {
    showOCRProgress(0);
    try {
        showOCRStatus('Tesseract.js 로딩 중...');
        await loadTesseract();

        showOCRStatus('이미지 전처리 중...');
        const canvas = await preprocessImageToCanvas(file);

        showOCRStatus('텍스트 인식 중...');
        const text = await runOCR(canvas, pct => {
            showOCRProgress(pct);
            showOCRStatus(`텍스트 인식 중... ${pct}%`);
        });

        showOCRStatus('기록 파싱 중...');
        const parsed = type === 'batter'
            ? parseOCRBatterText(text)
            : parseOCRPitcherText(text);

        hideOCRProgress();

        if (parsed.length === 0) {
            showOCRError('인식된 선수 기록이 없습니다.\n선수명(한글 2~4글자)이 스크린샷에 보이는지 확인해주세요.');
            return;
        }

        // 이전 요일 raw 조회
        const prevRaw = window.getPrevDayRaw(day, type);

        // 차분 계산
        const pairs = computeDiff(parsed, prevRaw, type);

        showOCRConfirmDialog(pairs, type, day, prevRaw, text);

    } catch (err) {
        hideOCRProgress();
        showOCRError(`OCR 오류: ${err.message}`);
    }
}

// ── 확인 다이얼로그 ──
function showOCRConfirmDialog(pairs, type, day, prevRaw, rawText) {
    const modal = document.getElementById('ocrConfirmModal');
    const tbody = document.getElementById('ocrConfirmBody');
    const title = document.getElementById('ocrConfirmTitle');
    const thead = document.getElementById('ocrConfirmHead');

    const days = window.DAYS;
    const dayLabels = window.DAY_LABELS;
    const dayIdx = days.indexOf(day);
    const prevDay = dayIdx > 0 ? days[dayIdx - 1] : null;

    const hasDiff = !!prevRaw;
    const fields = type === 'batter'
        ? ['경기', '타수', '안타', '2루타', '3루타', '홈런', '볼넷', '사구', '희생플라이', '득점권타수', '득점권안타']
        : ['경기', '승', '패', '이닝', '자책점'];

    title.textContent = type === 'batter'
        ? `📸 타자 기록 인식 — ${dayLabels[day]}`
        : `📸 투수 기록 인식 — ${dayLabels[day]}`;

    // 헤더: 필드당 "오늘누적 / 전날누적 / 오늘기록" 또는 단순 "오늘기록"
    let headerHTML = `<tr>
        <th>선수명</th>`;
    fields.forEach(f => {
        if (hasDiff) {
            headerHTML += `
        <th class="ocr-th-group" colspan="3">${f}</th>`;
        } else {
            headerHTML += `<th>${f}</th>`;
        }
    });
    headerHTML += '</tr>';

    if (hasDiff) {
        headerHTML += `<tr>
            <th></th>`;
        fields.forEach(() => {
            headerHTML += `
            <th class="ocr-sub-th today-raw">오늘누적</th>
            <th class="ocr-sub-th prev-raw">전날누적</th>
            <th class="ocr-sub-th diff-val">📌오늘기록</th>`;
        });
        headerHTML += '</tr>';
    }
    thead.innerHTML = headerHTML;

    // 바디
    tbody.innerHTML = '';
    pairs.forEach(({ diffRow, todayRawRow }, ri) => {
        const tr = document.createElement('tr');

        // 이름
        const tdName = document.createElement('td');
        const nameInp = document.createElement('input');
        nameInp.className = 'ocr-edit-input';
        nameInp.value = diffRow.name;
        nameInp.addEventListener('input', e => { diffRow.name = e.target.value; todayRawRow.name = e.target.value; });
        tdName.appendChild(nameInp);
        tr.appendChild(tdName);

        // 필드들
        const prevRow = prevRaw ? prevRaw.find(r => r.pos === diffRow.pos) : null;

        fields.forEach(f => {
            if (hasDiff) {
                // 오늘 누적 (읽기전용)
                const tdToday = document.createElement('td');
                tdToday.className = 'ocr-cell-raw today-raw';
                tdToday.textContent = todayRawRow[f] || '0';
                tr.appendChild(tdToday);

                // 전날 누적 (읽기전용)
                const tdPrev = document.createElement('td');
                tdPrev.className = 'ocr-cell-raw prev-raw';
                tdPrev.textContent = prevRow ? (prevRow[f] || '0') : '-';
                tr.appendChild(tdPrev);

                // 오늘 기록 (편집 가능)
                const tdDiff = document.createElement('td');
                tdDiff.className = 'ocr-cell-diff';
                const diffInp = document.createElement('input');
                diffInp.className = 'ocr-edit-input diff-input';
                diffInp.value = diffRow[f] || '0';
                diffInp.addEventListener('input', e => { diffRow[f] = e.target.value; });
                tdDiff.appendChild(diffInp);
                tr.appendChild(tdDiff);
            } else {
                // 월요일: 단순 편집
                const td = document.createElement('td');
                const inp = document.createElement('input');
                inp.className = 'ocr-edit-input';
                inp.value = diffRow[f] || '0';
                inp.addEventListener('input', e => { diffRow[f] = e.target.value; });
                td.appendChild(inp);
                tr.appendChild(td);
            }
        });

        tbody.appendChild(tr);
    });

    // 안내 메시지
    const hint = document.getElementById('ocrModalHint');
    if (hasDiff && prevDay) {
        hint.innerHTML = `📌 <strong>${dayLabels[day]}</strong> 기록 = 오늘 누적 − ${dayLabels[prevDay]} 누적으로 자동 계산했습니다. 오늘기록 칸을 수정 후 적용하세요.`;
    } else {
        hint.innerHTML = `📌 <strong>월요일</strong>은 이전 요일 기록이 없으므로 스크린샷 값 그대로 적용합니다. 수정 후 적용하세요.`;
    }

    // 원문
    const rawEl = document.getElementById('ocrRawText');
    if (rawEl) rawEl.textContent = rawText;

    // 적용 버튼
    document.getElementById('ocrApplyBtn').onclick = () => {
        const diffRows = pairs.map(p => p.diffRow);
        const todayRawRows = pairs.map(p => p.todayRawRow);
        applyOCRResult(diffRows, type, day, todayRawRows);
        modal.classList.remove('open');
        if (window.showToast) window.showToast('📸 OCR 기록이 적용되었습니다!');
    };

    document.getElementById('ocrCancelBtn').onclick = () => modal.classList.remove('open');

    modal.classList.add('open');
}

// ── 결과 적용 ──
function applyOCRResult(diffRows, type, day, todayRawRows) {
    const data = window.__appData();
    const targetArray = type === 'batter' ? data[day].batters : data[day].pitchers;
    const posList = type === 'batter'
        ? window.BATTER_POSITIONS.map(p => p.pos)
        : window.PITCHER_POSITIONS;
    const fields = type === 'batter'
        ? window.BATTER_INPUT_FIELDS
        : window.PITCHER_INPUT_FIELDS;

    diffRows.forEach((row, ri) => {
        const idx = posList.indexOf(row.pos);
        if (idx === -1) return;
        const target = targetArray[idx];
        if (row.name) target.name = row.name;
        fields.forEach(f => {
            if (row[f] !== undefined && row[f] !== '') target[f] = row[f];
        });
    });

    // 오늘의 raw 누적값 저장 (다음 요일 차분 계산에 사용)
    if (todayRawRows) {
        window.setDayRaw(day, type, todayRawRows);
    }

    if (window.saveData) window.saveData();
    if (window.render) window.render();
}

// ── UI 헬퍼 ──
function showOCRProgress(pct) {
    const wrap = document.getElementById('ocrProgressWrap');
    const bar = document.getElementById('ocrProgressBar');
    if (wrap) wrap.style.display = 'block';
    if (bar) bar.style.width = pct + '%';
}
function hideOCRProgress() {
    const wrap = document.getElementById('ocrProgressWrap');
    if (wrap) wrap.style.display = 'none';
}
function showOCRStatus(msg) {
    const el = document.getElementById('ocrStatusText');
    if (el) el.textContent = msg;
}
function showOCRError(msg) {
    alert('⚠️ ' + msg);
}

window.runOCRPipeline = runOCRPipeline;
