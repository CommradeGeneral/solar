/* ═══════════════════════════════════════════
   ALARM DASHBOARD  —  alarm.js
   All interactive logic
═══════════════════════════════════════════ */

// ─────────────────────────────────────────
// API CONFIGURATION  ← Edit these values
// ─────────────────────────────────────────


const API_CONFIG = {
    BASE_URL: '192.168.1.2',           // API server IP
    PORT: '3000',                    // API port (Node.js server)
    TOKEN: 'scada_admin_token_12345', // JWT token
    USER: 'operator',               // Default user for ACK
};
// ─────────────────────────────────────────

// ─────────────────────────────────────────
// DEVICE TYPES  ← Edit prefixes/counts to match your tag naming
// A device's alarms are matched when its tag_name contains the device id,
// e.g. type "inverter" (prefix INV, 75 devices) -> INV001 … INV075, and an
// alarm with tag_name "INV003_PowerFactor" belongs to device INV003.
// id = prefix + zero-padded number (pad digits). Adjust as needed.
// ─────────────────────────────────────────
const DEVICE_TYPES = [
    { key: 'inverter', label: 'Inverter', prefix: 'INV', count: 75, pad: 3 },
    { key: 'energy', label: 'Energy Meter', prefix: 'EM', count: 14, pad: 3 },
    { key: 'relay', label: 'Protection Relay', prefix: 'PR', count: 14, pad: 3 },
    { key: 'weather', label: 'Weather Station', prefix: 'WS', count: 1, pad: 3 },
];

function deviceTypeByKey(key) { return DEVICE_TYPES.find(d => d.key === key) || null; }

// Build the list of device ids for a type, e.g. ['INV001', ... 'INV075'].
function deviceIdsForType(key) {
    const dt = deviceTypeByKey(key);
    if (!dt) return [];
    const ids = [];
    for (let i = 1; i <= dt.count; i++) {
        ids.push(dt.prefix + String(i).padStart(dt.pad, '0'));
    }
    return ids;
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Does this tag_name belong to the given device TYPE? (prefix followed by digits)
function tagMatchesType(tagName, typeKey) {
    if (!typeKey) return true;
    const dt = deviceTypeByKey(typeKey);
    if (!dt) return true;
    const re = new RegExp('(^|[^A-Za-z0-9])' + escapeRegex(dt.prefix) + '\\d+', 'i');
    return re.test(String(tagName || ''));
}

// Does this tag_name belong to a SPECIFIC device id (e.g. INV003, not INV0030)?
function tagMatchesDevice(tagName, deviceId) {
    if (!deviceId) return true;
    const re = new RegExp('(^|[^A-Za-z0-9])' + escapeRegex(deviceId) + '([^A-Za-z0-9]|$)', 'i');
    return re.test(String(tagName || ''));
}

const STORAGE_KEY = 'alarm_dash_filters_v2';

// ── State ──
let currentTab = 'online';
let onlineAlarmsData = [];
let onlineAlarmsMap = new Map();     // tag_id → alarm
let historyData = [];
let autoRefreshEnabled = true;
let autoRefreshTimer = null;
let filterPanelOpen = false;
let initialLoadDone = false;
let filtersApplied = false;         // true after "Apply Filters" clicked

// ── Pagination ──
let onlinePage = 1;
const PAGE_SIZE = 50;

let historyPage = 1;
let historyTotal = 0;
let historyPageTotal = 0;

// ══════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
    startClock();
    loadSavedFilters();
    setDefaultDates();
    wireFilterListeners();
    startAutoRefresh();
    loadOnlineAlarms(true);
});

// ══════════════════════════════════════════
// CLOCK
// ══════════════════════════════════════════
function startClock() {
    const tick = () => {
        const now = new Date();
        const timeEl = document.getElementById('currentTime');
        if (timeEl) timeEl.textContent = now.toLocaleTimeString('en-US', { hour12: false });
        // header-clock shows time only; update date only if the element exists.
        const dateEl = document.getElementById('currentDate');
        if (dateEl) {
            dateEl.textContent = now.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
        }
    };
    tick();
    setInterval(tick, 1000);
}

// ══════════════════════════════════════════
// TAB SWITCHING
// ══════════════════════════════════════════
function switchTab(tab) {
    currentTab = tab;

    document.getElementById('onlineTab').classList.toggle('active', tab === 'online');
    document.getElementById('historyTab').classList.toggle('active', tab === 'history');

    document.getElementById('tabOnline').classList.toggle('active', tab === 'online');
    document.getElementById('tabHistory').classList.toggle('active', tab === 'history');

    document.getElementById('ackAllBtn').style.display = tab === 'online' ? '' : 'none';

    if (tab === 'online') {
        loadOnlineAlarms(false);
    } else {

        loadAlarmHistory(true);
    }
}

// ══════════════════════════════════════════
// FILTER PANEL
// ══════════════════════════════════════════
function toggleFilterPanel() {
    filterPanelOpen = !filterPanelOpen;
    const panel = document.getElementById('filterPanel');
    const btn = document.getElementById('filterToggleBtn');
    panel.classList.toggle('open', filterPanelOpen);
    btn.classList.toggle('filter-open', filterPanelOpen);
}

function wireFilterListeners() {
    // Live search (client-side only, no API call)
    document.getElementById('searchFilter').addEventListener('input',
        debounce(() => {
            saveFilters();
            renderCurrentTab();
        }, 180)
    );

    // Device Type: repopulate the Device dropdown, then re-filter live.
    document.getElementById('deviceTypeFilter').addEventListener('change', (e) => {
        populateDeviceDropdown(e.target.value, '');
        saveFilters();
        renderCurrentTab();
    });

    // Device: re-filter live.
    document.getElementById('deviceFilter').addEventListener('change', () => {
        saveFilters();
        renderCurrentTab();
    });
}

// Fill the Device dropdown with the device ids of the selected type.
function populateDeviceDropdown(typeKey, selected = '') {
    const sel = document.getElementById('deviceFilter');
    sel.innerHTML = '<option value="">All Devices</option>';

    const ids = deviceIdsForType(typeKey);
    if (ids.length === 0) {
        sel.disabled = true;
        sel.value = '';
        return;
    }

    for (const id of ids) sel.add(new Option(id, id));
    sel.disabled = false;
    sel.value = ids.includes(selected) ? selected : '';
}

// ══════════════════════════════════════════
// FILTER PERSISTENCE
// ══════════════════════════════════════════
function saveFilters() {
    const f = getFilterValues();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(f)); } catch { }
    updateFilterIndicator(f);
}

function loadSavedFilters() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const f = JSON.parse(raw);
        setFilterValues(f);
        updateFilterIndicator(f);
        filtersApplied = hasAnyFilter(f);
    } catch { }
}

function getFilterValues() {
    return {
        deviceType: document.getElementById('deviceTypeFilter').value,
        device: document.getElementById('deviceFilter').value,
        search: document.getElementById('searchFilter').value.trim(),
        severity: document.getElementById('severityFilter').value,
        limitMode: document.getElementById('limitModeFilter').value,
        class_: document.getElementById('classFilter').value.trim(),
        startDate: document.getElementById('startDateFilter').value,
        endDate: document.getElementById('endDateFilter').value,
    };
}

function setFilterValues(f) {
    document.getElementById('deviceTypeFilter').value = f.deviceType || '';
    // Build the device list for the saved type, then restore the chosen device.
    populateDeviceDropdown(f.deviceType || '', f.device || '');
    document.getElementById('searchFilter').value = f.search || '';
    document.getElementById('severityFilter').value = f.severity || '';
    document.getElementById('limitModeFilter').value = f.limitMode || '';
    document.getElementById('classFilter').value = f.class_ || '';
    if (f.startDate) document.getElementById('startDateFilter').value = f.startDate;
    if (f.endDate) document.getElementById('endDateFilter').value = f.endDate;
}

function hasAnyFilter(f) {
    return !!(f.deviceType || f.device || f.search || f.severity || f.limitMode || f.class_ || f.startDate || f.endDate);
}

function setDefaultDates() {
    const now = new Date();
    const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    if (!document.getElementById('startDateFilter').value)
        document.getElementById('startDateFilter').value = toLocalISO(from);
    if (!document.getElementById('endDateFilter').value)
        document.getElementById('endDateFilter').value = toLocalISO(now);
}

function toLocalISO(date) {
    const pad = n => String(n).padStart(2, '0');
    // Returns a datetime-local string (YYYY-MM-DDTHH:MM:SS) in local time.
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Convert a datetime-local input value ("YYYY-MM-DDTHH:MM" or "YYYY-MM-DDTHH:MM:SS",
 * which the browser always gives in LOCAL time) to a UTC ISO-8601 string suitable
 * for the API. Returns null if the value is empty or invalid.
 */
function localInputToUtcIso(localStr) {
    if (!localStr) return null;
    // new Date(localStr) treats the string as LOCAL time when it has no Z/offset.
    const d = new Date(localStr);
    if (isNaN(d.getTime())) return null;
    return d.toISOString(); // always UTC ("Z")
}

// ── Apply / Reset ──
function applyFilters() {
    saveFilters();
    filtersApplied = true;
    onlinePage = 1;
    historyPage = 1;
    refreshCurrent(true);
    showToast('Filters applied', 'info');
}

function resetFilters() {
    document.getElementById('deviceTypeFilter').value = '';
    populateDeviceDropdown('', '');
    document.getElementById('searchFilter').value = '';
    document.getElementById('severityFilter').value = '';
    document.getElementById('limitModeFilter').value = '';
    document.getElementById('classFilter').value = '';
    setDefaultDates();
    try { localStorage.removeItem(STORAGE_KEY); } catch { }
    filtersApplied = false;
    updateFilterIndicator({});
    onlinePage = 1;
    historyPage = 1;
    refreshCurrent(true);
    showToast('Filters reset', 'success');
}

function updateFilterIndicator(f) {
    const active = hasAnyFilter(f);
    const dot = document.getElementById('filterDot');
    dot.classList.toggle('visible', active);

    const labels = [];
    if (f.device) labels.push(`Device: ${f.device}`);
    else if (f.deviceType) labels.push(`Type: ${(deviceTypeByKey(f.deviceType) || {}).label || f.deviceType}`);
    if (f.severity) labels.push(`Severity: ${f.severity}`);
    if (f.limitMode) labels.push(`Mode: ${f.limitMode}`);
    if (f.class_) labels.push(`Class: ${f.class_}`);
    if (f.search) labels.push(`Search: "${f.search}"`);

    const txt = labels.join('  ·  ');
    document.getElementById('filterStatusText').textContent = active ? `Active: ${txt}` : '';

    ['online', 'history'].forEach(tab => {
        const el = document.getElementById(tab + 'FilterIndicator');
        el.classList.toggle('visible', active);
        el.textContent = active ? `Filters Active` : '';
    });
}

// ── Client-side filter for online data ──
function applyClientFilters(data) {
    const f = getFilterValues();
    let out = [...data];

    if (f.device) out = out.filter(a => tagMatchesDevice(a.tag_name, f.device));
    else if (f.deviceType) out = out.filter(a => tagMatchesType(a.tag_name, f.deviceType));

    if (f.search) {
        const q = f.search.toLowerCase();
        out = out.filter(a =>
            (a.tag_name || '').toLowerCase().includes(q) ||
            (a.alarm_text || '').toLowerCase().includes(q) ||
            (a.alarm_class || '').toLowerCase().includes(q) ||
            String(a.tag_id).includes(q)
        );
    }
    if (f.severity) out = out.filter(a => (a.alarm_severity || '').toLowerCase() === f.severity.toLowerCase());
    if (f.limitMode) out = out.filter(a => (a.limit_mode || '').toLowerCase() === f.limitMode.toLowerCase());
    if (f.class_) out = out.filter(a => (a.alarm_class || '').toLowerCase().includes(f.class_.toLowerCase()));

    // Sort newest first
    out.sort((a, b) => new Date(b.triggered_at || 0) - new Date(a.triggered_at || 0));
    return out;
}

// ── Build server-side query for history ──
function buildHistoryQuery() {
    const f = getFilterValues();
    const p = [];
    p.push(`page=${historyPage}`);
    p.push(`pageSize=${PAGE_SIZE}`);
    if (f.class_ && filtersApplied) p.push(`class=${encodeURIComponent(f.class_)}`);
    // Convert the datetime-local value (local time) to a proper UTC ISO string.
    // The server's isoToDbDate() will then shift it to match locally-stored timestamps.
    const fromUtc = localInputToUtcIso(f.startDate);
    const toUtc = localInputToUtcIso(f.endDate);
    if (fromUtc) p.push(`from=${encodeURIComponent(fromUtc)}`);
    if (toUtc) p.push(`to=${encodeURIComponent(toUtc)}`);
    return p.join('&');
}

// ══════════════════════════════════════════
// API
// ══════════════════════════════════════════
function apiUrl() { return `http://${API_CONFIG.BASE_URL}:${API_CONFIG.PORT}`; }

function normalizeSeverity(sev) {
    if (sev == null) return sev;
    const v = String(sev).trim().toLowerCase();
    if (v === 'waraning') return 'warning';
    return v;
}

function normalizeAlarm(a) {
    if (!a || typeof a !== 'object') return a;
    const tag = a.tag || {};
    const out = { ...a };

    if (out.tag_id == null && out.tagId != null) out.tag_id = out.tagId;
    if (out.alarm_type == null && out.alarmType != null) out.alarm_type = out.alarmType;
    if (out.state_code == null && out.stateCode != null) out.state_code = out.stateCode;
    if (out.state_name == null && out.stateName != null) out.state_name = out.stateName;
    if (out.current_value == null && out.currentValue != null) out.current_value = out.currentValue;
    if (out.raw_value == null && out.rawValue != null) out.raw_value = out.rawValue;
    if (out.triggered_at == null && out.triggeredAt != null) out.triggered_at = out.triggeredAt;
    if (out.acknowledged_by == null && out.acknowledgedBy != null) out.acknowledged_by = out.acknowledgedBy;
    if (out.ended_at == null && out.endedAt != null) out.ended_at = out.endedAt;
    if (out.last_read_at == null && out.lastReadAt != null) out.last_read_at = out.lastReadAt;
    if (out.current_history_id == null && out.currentHistoryId != null) out.current_history_id = out.currentHistoryId;

    if (out.tag_name == null && tag.name != null) out.tag_name = tag.name;
    if (out.alarm_text == null && tag.text != null) out.alarm_text = tag.text;
    if (out.alarm_class == null && tag.class != null) out.alarm_class = tag.class;
    if (out.alarm_severity == null && tag.severity != null) out.alarm_severity = tag.severity;
    if (out.tag_id == null && tag.id != null) out.tag_id = tag.id;

    out.alarm_severity = normalizeSeverity(out.alarm_severity);
    return out;
}

function normalizeHistory(r) {
    if (!r || typeof r !== 'object') return r;
    const out = { ...r };
    if (out.alarm_type == null && out.alarmType != null) out.alarm_type = out.alarmType;
    if (out.tag_id == null && out.tagId != null) out.tag_id = out.tagId;
    if (out.tag_name == null && out.tagName != null) out.tag_name = out.tagName;
    if (out.alarm_text == null && out.alarmText != null) out.alarm_text = out.alarmText;
    if (out.alarm_class == null && out.alarmClass != null) out.alarm_class = out.alarmClass;
    if (out.alarm_severity == null && out.alarmSeverity != null) out.alarm_severity = out.alarmSeverity;
    if (out.limit_mode == null && out.limitMode != null) out.limit_mode = out.limitMode;
    if (out.trigger_value == null && out.triggerValue != null) out.trigger_value = out.triggerValue;
    if (out.limit_value == null && out.limitValue != null) out.limit_value = out.limitValue;
    if (out.triggered_at == null && out.triggeredAt != null) out.triggered_at = out.triggeredAt;
    if (out.acknowledged_at == null && out.acknowledgedAt != null) out.acknowledged_at = out.acknowledgedAt;
    if (out.acknowledged_by == null && out.acknowledgedBy != null) out.acknowledged_by = out.acknowledgedBy;
    if (out.ended_at == null && out.endedAt != null) out.ended_at = out.endedAt;
    if (out.duration_seconds == null && out.durationSeconds != null) out.duration_seconds = out.durationSeconds;
    out.alarm_severity = normalizeSeverity(out.alarm_severity);
    return out;
}

async function apiCall(endpoint, method = 'GET', body = null) {
    const opts = {
        method,
        headers: {
            'Authorization': `Bearer ${API_CONFIG.TOKEN}`,
            'Content-Type': 'application/json',
        },
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${apiUrl()}/api${endpoint}`, opts);

    if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.detail || e.error || `HTTP ${res.status}`);
    }
    return res.json();
}

// ══════════════════════════════════════════
// LOAD ONLINE ALARMS
// ══════════════════════════════════════════
async function loadOnlineAlarms(forceRefresh = false) {
    if (!initialLoadDone || forceRefresh) {
        setTbody('onlineAlarmsTable', 8, '⏳ Loading…');
    }


    try {
        const res = await apiCall('/alarms/active');
        let data = Array.isArray(res.alarms) ? res.alarms : (Array.isArray(res) ? res : []); data = data.map(normalizeAlarm);

        // Exclude state 4 (ENDED / Gone+Acked) from online view
        data = data.filter(a => a.state_code !== 4 && a.state_name !== 'ENDED');

        updateHeaderStats(data);

        if (!initialLoadDone || forceRefresh) {
            onlineAlarmsData = data;
            rebuildOnlineMap(data);
            renderOnlineTable(applyClientFilters(data));
            initialLoadDone = true;
        } else {
            smartUpdate(data);
        }

        updateLastUpdateTime();
    } catch (err) {
        if (!initialLoadDone) {
            setTbody('onlineAlarmsTable', 8, `❌ ${err.message}`, true);
        }
        showToast(`Error: ${err.message}`, 'error');
    }
}

function rebuildOnlineMap(data) {
    onlineAlarmsMap.clear();
    data.forEach(a => onlineAlarmsMap.set(key(a), a));
}

function key(a) { return `${a.alarm_type}:${a.tag_id}`; }

// ── Smart diff update ──
function smartUpdate(newData) {
    const newMap = new Map();
    newData.forEach(a => newMap.set(key(a), a));

    const oldKeys = new Set(onlineAlarmsMap.keys());
    const newKeys = new Set(newMap.keys());

    const removed = [...oldKeys].filter(k => !newKeys.has(k));
    const added = [...newKeys].filter(k => !oldKeys.has(k));
    const existing = [...newKeys].filter(k => oldKeys.has(k));

    // Remove rows
    removed.forEach(k => {
        const row = document.querySelector(`tr[data-key="${k}"]`);
        if (row) {
            row.classList.add('row-removing');
            row.remove();
        }
        onlineAlarmsMap.delete(k);
    });

    // Update changed rows
    existing.forEach(k => {
        const oldA = onlineAlarmsMap.get(k);
        const newA = newMap.get(k);
        if (JSON.stringify(oldA) !== JSON.stringify(newA)) {
            const row = document.querySelector(`tr[data-key="${k}"]`);
            if (row) patchOnlineRow(row, newA);
            onlineAlarmsMap.set(k, newA);
        }
    });

    // Add new rows
    if (added.length > 0) {
        added.forEach(k => onlineAlarmsMap.set(k, newMap.get(k)));
        onlineAlarmsData = newData;
        renderOnlineTable(applyClientFilters(newData));
        setTimeout(() => {
            added.forEach(k => {
                const row = document.querySelector(`tr[data-key="${k}"]`);
                if (row) row.classList.add('row-new');
            });
        }, 30);
    } else {
        onlineAlarmsData = newData;
    }

    updateHeaderStats(newData);
}

// ── Render online table ──
function renderOnlineTable(data) {
    const tbody = document.getElementById('onlineAlarmsTable');
    const count = document.getElementById('onlineCount');
    const badge = document.getElementById('onlineBadge');

    count.textContent = data.length;
    badge.textContent = data.length;

    if (!data.length) {
        tbody.innerHTML = `<tr><td colspan="8" class="cell-empty">✅ No active alarms</td></tr>`;
        return;
    }

    tbody.innerHTML = data.map(a => buildOnlineRow(a)).join('');
}

function buildOnlineRow(a) {
    const k = key(a);
    const sc = a.state_code || 0;
    const rowClass = sc === 1 ? 'row-active' : '';
    const stateName = a.state_name || stateLabel(sc);
    const canAck = sc === 1 || sc === 3;

    return `
    <tr data-key="${k}" class="${rowClass}">
        <td><span class="state-badge state-${sc}">${stateName}</span></td>
        <td class="val-num id-cell">${a.tag_id ?? '—'}</td>
        <td class="ts">${fmtDT(a.triggered_at)}</td>
        <td class="alarm-txt">${esc(a.alarm_text)}</td>
        <td>${sevBadge(a.alarm_severity)}</td>
        <td>${classBadge(a.alarm_class)}</td>
        <td class="val-num">${fmtVal(a.current_value)}</td>
        <td>
            ${canAck
            ? `<button class="ack-btn" onclick="acknowledgeAlarm('${a.alarm_type}',${a.tag_id},this)">ACK</button>`
            : `<span class="ack-done">✓</span>`}
        </td>
    </tr>`;
}

function patchOnlineRow(row, a) {
    const sc = a.state_code || 0;
    const canAck = sc === 1 || sc === 3;
    row.cells[0].innerHTML = `<span class="state-badge state-${sc}">${a.state_name || stateLabel(sc)}</span>`;
    row.cells[2].innerHTML = `<span class="ts">${fmtDT(a.triggered_at)}</span>`;
    row.cells[6].innerHTML = `<span class="val-num">${fmtVal(a.current_value)}</span>`;
    row.cells[7].innerHTML = canAck
        ? `<button class="ack-btn" onclick="acknowledgeAlarm('${a.alarm_type}',${a.tag_id},this)">ACK</button>`
        : `<span class="ack-done">✓</span>`;
    row.classList.remove('row-active');
    if (sc === 1) row.classList.add('row-active');
    row.classList.add('row-updated');
    setTimeout(() => row.classList.remove('row-updated'), 800);
}

function renderCurrentTab() {
    if (currentTab === 'online') renderOnlineTable(applyClientFilters(onlineAlarmsData));
    else renderHistoryTable(historyData);
}

// ── Header stats ──
function updateHeaderStats(data) {
    const active = data.filter(a => a.state_code === 1 || a.state_code === 2).length;
    const unacked = data.filter(a => a.state_code === 1).length;
    const goneUnacked = data.filter(a => a.state_code === 3).length;
    document.getElementById('totalActiveCount').textContent = active;
    document.getElementById('totalUnackedCount').textContent = unacked;
    document.getElementById('totalGoneUnackedCount').textContent = goneUnacked;
}

// ══════════════════════════════════════════
// LOAD HISTORY
// ══════════════════════════════════════════
async function loadAlarmHistory(forceRefresh = false) {
    console.log("-----");
    if (forceRefresh) setTbody('historyAlarmsTable', 12, '⏳ Loading…');

    try {
        // Always keep "to" at current time until user applies filters

        if (!filtersApplied) {
            const now = new Date();
            if (!document.getElementById('startDateFilter').value) {
                const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                document.getElementById('startDateFilter').value = toLocalISO(from);
            }
            document.getElementById('endDateFilter').value = toLocalISO(now);
        }

        const q = buildHistoryQuery();
        const res = await apiCall(`/alarms/history?${q}`);

        console.log(res);


        historyData = (res.alarms || res.data || (Array.isArray(res) ? res : [])).map(normalizeHistory);
        console.log(historyData);
        historyTotal = res.totalCount || historyData.length;
        historyPageTotal = Math.max(1, Math.ceil(historyTotal / PAGE_SIZE));

        renderHistoryTable(historyData);
        renderHistoryPagination();
    } catch (err) {
        setTbody('historyAlarmsTable', 12, `❌ ${err.message}`, true);
        showToast(`Error: ${err.message}`, 'error');
    }
}

function renderHistoryTable(data) {
    const tbody = document.getElementById('historyAlarmsTable');
    const count = document.getElementById('historyCount');
    const badge = document.getElementById('historyBadge');

    // Client-side filter for history (apply only after user clicks Apply Filters)
    const f = getFilterValues();
    let filtered = [...data];
    if (filtersApplied) {
        if (f.device) filtered = filtered.filter(r => tagMatchesDevice(r.tag_name, f.device));
        else if (f.deviceType) filtered = filtered.filter(r => tagMatchesType(r.tag_name, f.deviceType));
        if (f.search) {
            const q = f.search.toLowerCase();
            filtered = filtered.filter(r =>
                (r.tag_name || '').toLowerCase().includes(q) ||
                (r.alarm_text || '').toLowerCase().includes(q) ||
                (r.alarm_class || '').toLowerCase().includes(q) ||
                String(r.id).includes(q)
            );
        }
        if (f.severity) {
            filtered = filtered.filter(r =>
                (r.alarm_severity || '').toLowerCase() === f.severity.toLowerCase()
            );
        }
        if (f.limitMode) {
            filtered = filtered.filter(r =>
                (r.limit_mode || '').toLowerCase() === f.limitMode.toLowerCase()
            );
        }
    }

    count.textContent = historyTotal;
    badge.textContent = historyTotal;

    if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="11" class="cell-empty">No history records found</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(r => {
        const durStr = r.duration_seconds != null ? fmtDuration(r.duration_seconds) : '-';
        return `
        <tr data-id="${r.id}">
            <td class="val-num id-cell">${r.id}</td>
            <td class="alarm-txt">${esc(r.alarm_text)}</td>
            <td>${sevBadge(r.alarm_severity)}</td>
            <td>${classBadge(r.alarm_class)}</td>
            <td>${modeBadge(r.limit_mode)}</td>
            <td class="val-num">${fmtVal(r.trigger_value)}</td>
            <td class="ts">${fmtDT(r.triggered_at)}</td>
            <td class="ts">${fmtDT(r.acknowledged_at)}</td>
            <td class="ts">${esc(r.acknowledged_by) || '-'}</td>
            <td class="ts">${fmtDT(r.ended_at)}</td>
            <td class="duration">${durStr}</td>
        </tr>`;
    }).join('');
}
function renderHistoryPagination() {
    const c = document.getElementById('historyPagination');
    if (historyPageTotal <= 1) { c.innerHTML = ''; return; }

    const prev = historyPage > 1;
    const next = historyPage < historyPageTotal;

    c.innerHTML = `
        <button class="pg-btn" onclick="goHistoryPage(1)" ${prev ? '' : 'disabled'}>⏮</button>
        <button class="pg-btn" onclick="goHistoryPage(${historyPage - 1})" ${prev ? '' : 'disabled'}>◀</button>
        <span class="pg-info">Page ${historyPage} / ${historyPageTotal}  (${historyTotal} records)</span>
        <button class="pg-btn" onclick="goHistoryPage(${historyPage + 1})" ${next ? '' : 'disabled'}>▶</button>
        <button class="pg-btn" onclick="goHistoryPage(${historyPageTotal})" ${next ? '' : 'disabled'}>⏭</button>
    `;
}

function goHistoryPage(p) {
    if (p < 1 || p > historyPageTotal) return;
    historyPage = p;
    loadAlarmHistory(true);
}

// ── ACKNOWLEDGE ──
async function acknowledgeAlarm(type, id, btn) {
    if (btn) { btn.classList.add('loading'); btn.disabled = true; }
    try {
        await apiCall(`/alarms/${type}/${id}/acknowledge`, 'POST', { user: API_CONFIG.USER });
        showToast(`Alarm ${id} acknowledged ✓`, 'success');

        // Optimistic UI update
        const k = `${type}:${id}`;
        const row = document.querySelector(`tr[data-key="${k}"]`);
        const a = onlineAlarmsMap.get(k);
        if (a) {
            a.state_code = 2;
            a.state_name = 'ACTIVE_ACK';
            a.acknowledged_by = API_CONFIG.USER;
            onlineAlarmsMap.set(k, a);
            if (row) patchOnlineRow(row, a);
        }

        setTimeout(() => loadOnlineAlarms(false), 800);
    } catch (err) {
        showToast(`ACK failed: ${err.message}`, 'error');
    } finally {
        if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
    }
}

async function acknowledgeAllVisible() {
    const unacked = onlineAlarmsData.filter(a => a.state_code === 1 || a.state_code === 3);
    if (!unacked.length) { showToast('No unacked alarms', 'info'); return; }
    if (!confirm(`Acknowledge ${unacked.length} alarm(s)?`)) return;

    let ok = 0, fail = 0;
    for (const a of unacked) {
        try {
            await apiCall(`/alarms/${a.alarm_type}/${a.tag_id}/acknowledge`, 'POST', { user: API_CONFIG.USER });
            ok++;
        } catch {
            fail++;
        }
    }

    showToast(`Done: ${ok} OK${fail ? `, ${fail} failed` : ''}`, ok > 0 ? 'success' : 'error');
    setTimeout(() => loadOnlineAlarms(false), 800);
}

// ══════════════════════════════════════════
// AUTO REFRESH
// ══════════════════════════════════════════
function startAutoRefresh() {
    autoRefreshTimer = setInterval(() => {
        if (autoRefreshEnabled && currentTab === 'online') {
            loadOnlineAlarms(false);
        }
    }, 5000);
}

function toggleAutoRefresh() {
    autoRefreshEnabled = !autoRefreshEnabled;
    const btn = document.getElementById('autoRefreshBtn');
    const icon = document.getElementById('arIcon');
    const txt = document.getElementById('arText');
    icon.textContent = autoRefreshEnabled ? '⏸' : '▶';
    txt.textContent = autoRefreshEnabled ? 'Auto: ON' : 'Auto: OFF';
    btn.classList.toggle('paused', !autoRefreshEnabled);
    showToast(`Auto-refresh ${autoRefreshEnabled ? 'enabled' : 'paused'}`, 'info');
}

// ══════════════════════════════════════════
// REFRESH + EXPORT
// ══════════════════════════════════════════
function refreshCurrent(force = true) {
    if (currentTab === 'online') loadOnlineAlarms(force);
    else loadAlarmHistory(force);
}

function exportCurrent() {
    const data = currentTab === 'online' ? onlineAlarmsData : historyData;
    if (!data.length) { showToast('No data to export', 'error'); return; }

    let rows;
    if (currentTab === 'online') {
        rows = data.map(a => ({
            'ID': a.tag_id,
            'Type': a.alarm_type,
            'Tag Name': a.tag_name,
            'Alarm Text': a.alarm_text,
            'Severity': a.alarm_severity,
            'Class': a.alarm_class,
            'Limit Mode': a.limit_mode,
            'State Code': a.state_code,
            'State': a.state_name,
            'Value': a.current_value,
            'Triggered': fmtDT(a.triggered_at),
            'Acked By': a.acknowledged_by || '',
            'Acked At': fmtDT(a.acknowledged_at),
        }));
    } else {
        rows = data.map(r => ({
            'ID': r.id,
            'Type': r.alarm_type,
            'Tag Name': r.tag_name,
            'Alarm Text': r.alarm_text,
            'Severity': r.alarm_severity,
            'Class': r.alarm_class,
            'Limit Mode': r.limit_mode,
            'Trigger Value': r.trigger_value,
            'Limit Value': r.limit_value,
            'Triggered At': fmtDT(r.triggered_at),
            'Acknowledged At': fmtDT(r.acknowledged_at),
            'Acked By': r.acknowledged_by || '',
            'Ended At': fmtDT(r.ended_at),
            'Duration (s)': r.duration_seconds ?? '',
        }));
    }

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, currentTab === 'online' ? 'Online Alarms' : 'History');
    XLSX.writeFile(wb, `Alarms_${currentTab}_${new Date().toISOString().slice(0, 10)}.xlsx`);
    showToast(`Exported ${rows.length} records`, 'success');
}

// ══════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════
function fmtDT(val) {
    if (!val) return '—';
    return new Date(val).toLocaleString('en-US', {
        month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
}

function fmtVal(v) {
    if (v == null || v === '') return '—';
    const n = parseFloat(v);
    return isNaN(n) ? String(v) : n.toFixed(2);
}

function fmtDuration(sec) {
    if (!sec && sec !== 0) return '—';
    sec = Math.round(sec);
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}h ${m}m`;
}

function stateLabel(code) {
    const labels = { 0: 'INACTIVE', 1: 'ACTIVE', 2: 'ACTIVE_ACK', 3: 'INACTIVE_ACK', 4: 'ENDED', 5: 'DISABLED' };
    return labels[code] || `State ${code}`;
}

function esc(v) {
    if (!v) return '—';
    return String(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function sevBadge(sev) {
    if (!sev) return '<span class="sev-badge sev-unknown">—</span>';
    const s = sev.toLowerCase();
    const cls = s === 'error' ? 'sev-error' : s === 'alarm' ? 'sev-alarm' : s === 'warning' ? 'sev-warning' : 'sev-unknown';
    return `<span class="sev-badge ${cls}">${esc(sev)}</span>`;
}

function classBadge(cls) {
    if (!cls) return '<span style="color:var(--text-muted)">—</span>';
    return `<span class="class-tag">${esc(cls)}</span>`;
}

function modeBadge(mode) {
    if (!mode) return '<span style="color:var(--text-muted)">—</span>';
    return `<span class="mode-badge">${esc(mode)}</span>`;
}

function setTbody(id, cols, msg, isError = false) {
    const cls = isError ? 'cell-error' : 'cell-empty';
    document.getElementById(id).innerHTML =
        `<tr><td colspan="${cols}" class="${cls}">${msg}</td></tr>`;
}

function updateLastUpdateTime() {
    // Intentionally left blank to avoid UI flashing
}

function showToast(msg, type = 'info') {
    const c = document.getElementById('toastContainer');
    const div = document.createElement('div');
    div.className = `toast ${type}`;
    div.innerHTML = `<span>${msg}</span>`;
    c.appendChild(div);
    setTimeout(() => {
        div.style.opacity = '0';
        setTimeout(() => div.remove(), 300);
    }, 3000);
}

function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}




