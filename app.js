// =============================================
//  컴투스 프로야구 V25 - 랭킹챌린지 기록 관리
// =============================================

const STORAGE_KEY = 'comtus_rc_data';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABELS = { mon: '월요일', tue: '화요일', wed: '수요일', thu: '목요일', fri: '금요일', sat: '토요일', sun: '일요일', cumulative: '📊 누적기록' };

// ── 타자 포지션 & 기본 선수명 ──
const BATTER_POSITIONS = [
    { pos: '포수', key: 'C' },
    { pos: '1루수', key: '1B' },
    { pos: '2루수', key: '2B' },
    { pos: '3루수', key: '3B' },
    { pos: '유격수', key: 'SS' },
    { pos: '좌익수', key: 'LF' },
    { pos: '중견수', key: 'CF' },
    { pos: '우익수', key: 'RF' },
    { pos: '지명타자', key: 'DH' },
];

// ── 투수 포지션 ──
const PITCHER_POSITIONS = ['SP1', 'SP2', 'SP3', 'SP4', 'SP5', 'RP1', 'RP2', 'RP3', 'RP4', 'CP'];

// ── 타자 기록 필드 (입력 가능) ──
const BATTER_INPUT_FIELDS = ['경기', '타수', '안타', '2루타', '3루타', '홈런', '볼넷', '사구', '희생플라이', '득점권타수', '득점권안타'];

// ── 투수 기록 필드 (입력 가능) ──
const PITCHER_INPUT_FIELDS = ['경기', '승', '패', '이닝', '자책점'];

// =========== STATE ===========
let currentDay = 'cumulative';
let currentSection = 'batter';
let isDirty = false;
let data = loadData();

// =========== UTILS ===========
function loadData() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw);
    } catch (e) { }
    return buildDefaultData();
}

function buildDefaultData() {
    const obj = {};
    DAYS.forEach(day => {
        obj[day] = {
            batters: BATTER_POSITIONS.map(p => ({ pos: p.pos, name: '', ...Object.fromEntries(BATTER_INPUT_FIELDS.map(f => [f, ''])) })),
            pitchers: PITCHER_POSITIONS.map(p => ({ pos: p, name: '', ...Object.fromEntries(PITCHER_INPUT_FIELDS.map(f => [f, ''])) })),
            // 스크린샷에서 나온 누적 원시값 (OCR diff 계산용)
            rawBatters: null,
            rawPitchers: null,
        };
    });
    return obj;
}

function saveData() {
    // 월요일이 아닌 경우, 누적값을 전날과 비교하여 차이만 저장
    const dayIdx = DAYS.indexOf(currentDay);
    if (dayIdx > 0 && currentDay !== 'cumulative') {
        const prevDay = DAYS[dayIdx - 1];

        // 타자 차분 계산
        data[currentDay].batters.forEach((row, i) => {
            const prevRow = data[prevDay].batters[i];
            BATTER_INPUT_FIELDS.forEach(field => {
                const currentVal = parseNum(row[field]);
                const prevVal = parseNum(prevRow[field]);
                const diff = Math.max(0, currentVal - prevVal);
                row[field] = String(diff);
            });
        });

        // 투수 차분 계산
        data[currentDay].pitchers.forEach((row, i) => {
            const prevRow = data[prevDay].pitchers[i];
            PITCHER_INPUT_FIELDS.forEach(field => {
                if (field === '이닝') {
                    const currentVal = parseInning(row[field]);
                    const prevVal = parseInning(prevRow[field]);
                    const diff = Math.max(0, currentVal - prevVal);
                    row[field] = formatInning(diff);
                } else {
                    const currentVal = parseNum(row[field]);
                    const prevVal = parseNum(prevRow[field]);
                    const diff = Math.max(0, currentVal - prevVal);
                    row[field] = String(diff);
                }
            });
        });
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    isDirty = false;
    hideSaveBar();
    showToast('저장되었습니다 ✓');
    render(); // 차분 계산 후 재렌더링
}

// =========== CALCULATIONS ===========
function parseNum(v) {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
}

// 타율 = 안타 / 타수
function calcAVG(row) {
    const ab = parseNum(row['타수']);
    const h = parseNum(row['안타']);
    if (ab === 0) return '-';
    return (h / ab).toFixed(3);
}

// 출루율 = (안타 + 볼넷 + 사구) / (타수 + 볼넷 + 사구 + 희생플라이)
function calcOBP(row) {
    const h = parseNum(row['안타']);
    const bb = parseNum(row['볼넷']);
    const hb = parseNum(row['사구']);
    const ab = parseNum(row['타수']);
    const sf = parseNum(row['희생플라이']);
    const denom = ab + bb + hb + sf;
    if (denom === 0) return '-';
    return ((h + bb + hb) / denom).toFixed(3);
}

// 장타율 = (안타 + 2루타 + 2*3루타 + 3*홈런) / 타수
function calcSLG(row) {
    const ab = parseNum(row['타수']);
    if (ab === 0) return '-';
    const h = parseNum(row['안타']);
    const d = parseNum(row['2루타']);
    const t = parseNum(row['3루타']);
    const hr = parseNum(row['홈런']);
    const tb = h + d + 2 * t + 3 * hr;
    return (tb / ab).toFixed(3);
}

// OPS = OBP + SLG
function calcOPS(row) {
    const obp = calcOBP(row);
    const slg = calcSLG(row);
    if (obp === '-' || slg === '-') return '-';
    return (parseFloat(obp) + parseFloat(slg)).toFixed(3);
}

// 득점권타율 = 득점권안타 / 득점권타수
function calcRISP(row) {
    const ab = parseNum(row['득점권타수']);
    const h = parseNum(row['득점권안타']);
    if (ab === 0) return '-';
    return (h / ab).toFixed(3);
}

// ERA = (자책점 * 9) / 이닝
function calcERA(row) {
    const inning = parseInning(row['이닝']);
    const er = parseNum(row['자책점']);
    if (inning === 0) return '-';
    return ((er * 9) / inning).toFixed(2);
}

// 이닝 파싱: "10 1/3" => 10.333, "69 1/3" => 69.333
function parseInning(v) {
    if (!v && v !== 0) return 0;
    const s = String(v).trim();
    const frac = { '1/3': 1 / 3, '2/3': 2 / 3 };
    const m = s.match(/^(\d+)\s+(1\/3|2\/3)$/);
    if (m) return parseInt(m[1]) + frac[m[2]];
    const plain = parseFloat(s);
    return isNaN(plain) ? 0 : plain;
}

// ── 특정 요일까지의 누적값 계산 ──
function getCumulativeUpToDay(targetDay, type, playerIdx, field) {
    const targetIdx = DAYS.indexOf(targetDay);
    if (targetIdx < 0) return 0;

    let sum = 0;
    for (let i = 0; i <= targetIdx; i++) {
        const day = DAYS[i];
        const row = type === 'batter' ? data[day].batters[playerIdx] : data[day].pitchers[playerIdx];
        if (field === '이닝') {
            sum += parseInning(row[field]);
        } else {
            sum += parseNum(row[field]);
        }
    }
    return sum;
}

// ── 누적 계산 ──
function getCumulativeBatters() {
    return BATTER_POSITIONS.map((p, i) => {
        const merged = { pos: p.pos, name: '', ...Object.fromEntries(BATTER_INPUT_FIELDS.map(f => [f, 0])) };
        // 이름은 첫 번째 요일에서 가져오기
        DAYS.forEach(day => {
            const row = data[day].batters[i];
            if (!merged.name && row.name) merged.name = row.name;
            BATTER_INPUT_FIELDS.forEach(f => {
                if (f === '이닝') {
                    merged[f] += parseInning(row[f]);
                } else {
                    const n = parseNum(row[f]);
                    merged[f] += n;
                }
            });
        });
        return merged;
    });
}

function getCumulativePitchers() {
    return PITCHER_POSITIONS.map((pos, i) => {
        const merged = { pos, name: '', ...Object.fromEntries(PITCHER_INPUT_FIELDS.map(f => [f, 0])) };
        DAYS.forEach(day => {
            const row = data[day].pitchers[i];
            if (!merged.name && row.name) merged.name = row.name;
            PITCHER_INPUT_FIELDS.forEach(f => {
                if (f === '이닝') {
                    merged[f] += parseInning(row[f]);
                } else {
                    merged[f] += parseNum(row[f]);
                }
            });
        });
        // 이닝을 표시용으로 변환
        merged['이닝'] = formatInning(merged['이닝']);
        return merged;
    });
}

function formatInning(val) {
    const total = typeof val === 'number' ? val : parseInning(val);
    const full = Math.floor(total);
    const frac = total - full;
    if (Math.abs(frac - 1 / 3) < 0.01) return `${full} 1/3`;
    if (Math.abs(frac - 2 / 3) < 0.01) return `${full} 2/3`;
    return `${full}`;
}

// =========== RENDER ===========
function render() {
    if (currentSection === 'batter') {
        renderBatters();
    } else {
        renderPitchers();
    }
    updateCurrentLabel();
}

function renderBatters() {
    const tbody = document.getElementById('batterBody');
    tbody.innerHTML = '';

    const isCumulative = (currentDay === 'cumulative');
    const rows = isCumulative ? getCumulativeBatters() : data[currentDay].batters;

    // 전날 누적 데이터 조회 (월요일 제외)
    const dayIdx = DAYS.indexOf(currentDay);
    const hasPrevDay = dayIdx > 0 && !isCumulative;
    const prevDayData = hasPrevDay ? data[DAYS[dayIdx - 1]].batters : null;

    rows.forEach((row, rowIdx) => {
        const tr = document.createElement('tr');

        // 포지션
        const tdPos = document.createElement('td');
        tdPos.className = 'col-pos';
        tdPos.textContent = row.pos;
        tr.appendChild(tdPos);

        // 선수명 (항상 편집 가능)
        const tdName = document.createElement('td');
        tdName.className = 'col-name';
        if (isCumulative) {
            tdName.textContent = row.name || '-';
            tdName.classList.add('readonly-cell');
        } else {
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'name-input';
            nameInput.placeholder = '선수명';
            nameInput.value = row.name;
            nameInput.addEventListener('input', e => {
                data[currentDay].batters[rowIdx].name = e.target.value;
                markDirty();
            });
            tdName.appendChild(nameInput);
        }
        tr.appendChild(tdName);

        // 파생 지표 (읽기 전용)
        const derivedCols = [
            { label: 'OPS', val: calcOPS(row) },
            { label: '출루율', val: calcOBP(row) },
            { label: '장타율', val: calcSLG(row) },
            { label: '타율', val: calcAVG(row) },
            { label: '득점권타율', val: calcRISP(row) },
        ];
        derivedCols.forEach(d => {
            const td = document.createElement('td');
            td.className = 'derived-cell';
            td.textContent = d.val;
            tr.appendChild(td);
        });

        // 입력 필드
        BATTER_INPUT_FIELDS.forEach(field => {
            const td = document.createElement('td');
            if (isCumulative) {
                td.className = 'readonly-cell';
                const v = row[field];
                td.textContent = (v === 0 || v === '') ? '0' : v;
                tr.appendChild(td);
            } else {
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'stat-input';
                input.placeholder = hasPrevDay ? '누적값' : '0';
                input.title = hasPrevDay ? '오늘까지의 누적값을 입력하세요 (저장 시 전날과의 차이로 자동 계산됩니다)' : '기록을 입력하세요';

                // 화~일: 전날 누적 + 오늘 차이를 표시 (입력값은 누적값처럼 보이게)
                let displayValue = row[field];
                if (hasPrevDay && prevDayData) {
                    const prevCumulative = getCumulativeUpToDay(DAYS[dayIdx - 1], 'batter', rowIdx, field);
                    const todayDiff = parseNum(row[field]);
                    displayValue = String(prevCumulative + todayDiff);
                }

                input.value = displayValue;
                input.addEventListener('input', e => {
                    // 사용자가 입력한 누적값을 임시로 저장
                    data[currentDay].batters[rowIdx][field] = e.target.value;
                    markDirty();
                    // 파생 지표 실시간 업데이트 (누적값 기준)
                    const tempRow = { ...data[currentDay].batters[rowIdx] };
                    updateDerivedCells(tr, tempRow);
                });
                td.appendChild(input);
                tr.appendChild(td);
            }
        });

        tbody.appendChild(tr);
    });
}

function updateDerivedCells(tr, row) {
    const derivedTds = tr.querySelectorAll('.derived-cell');
    const vals = [calcOPS(row), calcOBP(row), calcSLG(row), calcAVG(row), calcRISP(row)];
    derivedTds.forEach((td, i) => { td.textContent = vals[i]; });
}

function renderPitchers() {
    const tbody = document.getElementById('pitcherBody');
    tbody.innerHTML = '';

    const isCumulative = (currentDay === 'cumulative');
    const rows = isCumulative ? getCumulativePitchers() : data[currentDay].pitchers;

    // 전날 누적 데이터 조회 (월요일 제외)
    const dayIdx = DAYS.indexOf(currentDay);
    const hasPrevDay = dayIdx > 0 && !isCumulative;
    const prevDayData = hasPrevDay ? data[DAYS[dayIdx - 1]].pitchers : null;

    rows.forEach((row, rowIdx) => {
        const tr = document.createElement('tr');

        // 포지션
        const tdPos = document.createElement('td');
        tdPos.className = 'col-pos';
        tdPos.textContent = row.pos;
        tr.appendChild(tdPos);

        // 선수명
        const tdName = document.createElement('td');
        tdName.className = 'col-name';
        if (isCumulative) {
            tdName.textContent = row.name || '-';
            tdName.classList.add('readonly-cell');
        } else {
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'name-input';
            nameInput.placeholder = '선수명';
            nameInput.value = row.name;
            nameInput.addEventListener('input', e => {
                data[currentDay].pitchers[rowIdx].name = e.target.value;
                markDirty();
            });
            tdName.appendChild(nameInput);
        }
        tr.appendChild(tdName);

        // ERA (파생)
        const tdERA = document.createElement('td');
        tdERA.className = 'derived-cell era-cell';
        tdERA.textContent = calcERA(row);
        tr.appendChild(tdERA);

        // 입력 필드
        PITCHER_INPUT_FIELDS.forEach(field => {
            const td = document.createElement('td');
            if (isCumulative) {
                td.className = 'readonly-cell';
                td.textContent = (row[field] === 0 || row[field] === '') ? '0' : row[field];
                tr.appendChild(td);
            } else {
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'stat-input';
                input.placeholder = hasPrevDay ? '누적값' : (field === '이닝' ? '0' : '0');
                input.title = hasPrevDay
                    ? '오늘까지의 누적값을 입력하세요 (저장 시 전날과의 차이로 자동 계산됩니다)'
                    : (field === '이닝' ? '예: 7, 69 1/3, 147 2/3' : '');

                // 화~일: 전날 누적 + 오늘 차이를 표시
                let displayValue = row[field];
                if (hasPrevDay && prevDayData) {
                    const prevCumulative = getCumulativeUpToDay(DAYS[dayIdx - 1], 'pitcher', rowIdx, field);
                    if (field === '이닝') {
                        const todayDiff = parseInning(row[field]);
                        displayValue = formatInning(prevCumulative + todayDiff);
                    } else {
                        const todayDiff = parseNum(row[field]);
                        displayValue = String(prevCumulative + todayDiff);
                    }
                }

                input.value = displayValue;
                input.addEventListener('input', e => {
                    data[currentDay].pitchers[rowIdx][field] = e.target.value;
                    markDirty();
                    // ERA 실시간 업데이트 (누적값 기준)
                    const tempRow = { ...data[currentDay].pitchers[rowIdx] };
                    tempRow[field] = e.target.value;
                    const eraCell = tr.querySelector('.era-cell');
                    if (eraCell) eraCell.textContent = calcERA(tempRow);
                });
                td.appendChild(input);
                tr.appendChild(td);
            }
        });

        tbody.appendChild(tr);
    });
}

function updateCurrentLabel() {
    const label = document.getElementById('currentLabel');
    const dayIdx = DAYS.indexOf(currentDay);
    const hasPrevDay = dayIdx > 0 && currentDay !== 'cumulative';

    if (currentDay === 'cumulative') {
        label.textContent = '📊 누적기록 (전체 요일 합산)';
    } else if (hasPrevDay) {
        const prevDay = DAYS[dayIdx - 1];
        label.textContent = `📅 ${DAY_LABELS[currentDay]} (누적값 입력 → 전날과 차이로 자동 계산)`;
    } else {
        label.textContent = `📅 ${DAY_LABELS[currentDay]} (첫 요일)`;
    }
}

// =========== UI CONTROLS ===========
function markDirty() {
    isDirty = true;
    document.getElementById('saveBar').style.display = 'flex';
}

function hideSaveBar() {
    document.getElementById('saveBar').style.display = 'none';
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
}

// =========== Export ===========
function exportCSV() {
    const lines = [];

    DAYS.forEach(day => {
        lines.push(`\n=== ${DAY_LABELS[day]} - 타자 ===`);
        lines.push(['포지션', '선수명', 'OPS', '출루율', '장타율', '타율', '득점권타율', ...BATTER_INPUT_FIELDS].join(','));
        data[day].batters.forEach(row => {
            const derived = [calcOPS(row), calcOBP(row), calcSLG(row), calcAVG(row), calcRISP(row)];
            const inputVals = BATTER_INPUT_FIELDS.map(f => row[f] || '0');
            lines.push([row.pos, row.name, ...derived, ...inputVals].join(','));
        });

        lines.push(`\n=== ${DAY_LABELS[day]} - 투수 ===`);
        lines.push(['포지션', '선수명', 'ERA', ...PITCHER_INPUT_FIELDS].join(','));
        data[day].pitchers.forEach(row => {
            const inputVals = PITCHER_INPUT_FIELDS.map(f => row[f] || '0');
            lines.push([row.pos, row.name, calcERA(row), ...inputVals].join(','));
        });
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `랭킹챌린지_기록_${new Date().toLocaleDateString('ko-KR').replace(/\. /g, '-').replace('.', '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('CSV로 내보냈습니다 📋');
}

// =========== INIT ===========
function init() {
    // Day tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            // Save if dirty when switching tabs
            if (isDirty && currentDay !== 'cumulative') {
                saveData();
            }
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentDay = btn.dataset.day;
            // Show/hide OCR bar (only on weekday tabs)
            const ocrBar = document.getElementById('ocrBar');
            ocrBar.style.display = (currentDay !== 'cumulative') ? 'flex' : 'none';
            render();
        });
    });

    // Section tabs
    document.querySelectorAll('.section-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.section-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentSection = btn.dataset.section;
            document.getElementById('batterSection').classList.toggle('hidden', currentSection !== 'batter');
            document.getElementById('pitcherSection').classList.toggle('hidden', currentSection !== 'pitcher');
            render();
        });
    });

    // Save
    document.getElementById('btnSave').addEventListener('click', () => {
        if (currentDay !== 'cumulative') saveData();
    });

    // Export
    document.getElementById('btnExport').addEventListener('click', exportCSV);

    // Reset modal
    document.getElementById('btnReset').addEventListener('click', () => {
        document.getElementById('resetModal').classList.add('open');
    });
    document.getElementById('btnCancelReset').addEventListener('click', () => {
        document.getElementById('resetModal').classList.remove('open');
    });
    document.getElementById('btnConfirmReset').addEventListener('click', () => {
        data = buildDefaultData();
        saveData();
        document.getElementById('resetModal').classList.remove('open');
        render();
        showToast('초기화 완료 🗑');
    });

    // Auto-save on page unload
    window.addEventListener('beforeunload', () => {
        if (isDirty && currentDay !== 'cumulative') {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        }
    });

    // ── OCR file input wiring ──
    document.getElementById('ocrFileBatter').addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        e.target.value = ''; // reset so same file can be uploaded again
        window.runOCRPipeline(file, 'batter', currentDay);
    });
    document.getElementById('ocrFilePitcher').addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        e.target.value = '';
        window.runOCRPipeline(file, 'pitcher', currentDay);
    });

    // Initial render
    render();
}

// =========== GLOBAL EXPORTS (for ocr.js) ===========
window.DAY_LABELS = DAY_LABELS;
window.BATTER_POSITIONS = BATTER_POSITIONS;
window.PITCHER_POSITIONS = PITCHER_POSITIONS;
window.DAYS = DAYS;
window.BATTER_INPUT_FIELDS = BATTER_INPUT_FIELDS;
window.PITCHER_INPUT_FIELDS = PITCHER_INPUT_FIELDS;
window.__appData = () => data;
window.saveData = saveData;
window.render = render;
window.showToast = showToast;

// 이전 요일의 raw 누적값 조회 (OCR diff 계산용)
window.getPrevDayRaw = (day, type) => {
    const idx = DAYS.indexOf(day);
    if (idx <= 0) return null; // 월요일은 이전 요일 없음
    const prevDay = DAYS[idx - 1];
    return type === 'batter' ? data[prevDay].rawBatters : data[prevDay].rawPitchers;
};

// raw 누적값 저장
window.setDayRaw = (day, type, rawArray) => {
    if (type === 'batter') data[day].rawBatters = rawArray;
    else data[day].rawPitchers = rawArray;
};

document.addEventListener('DOMContentLoaded', init);
