/**
 * inverter.js — Inverter monitoring page
 * Connects via Socket.IO, filters tags by prefix INVxxx_,
 * renders analog values + digital LED statuses dynamically.
 *
 * PREFIX is page-specific (this page uses "INV").
 * Other pages can copy this pattern with a different PREFIX (e.g. "PM", "EM").
 */

(() => {
    const PREFIX = 'INV';  // ← change per page type
    const DIGITAL_COLLAPSE_STORAGE_KEY = 'inv_digital_collapsed';

    // ── State ──
    let socket = null;
    let config = null;
    let allTagMeta = {};
    let latestValues = {};
    let currentIndex = 1;
    let minIndex = 1;
    let maxIndex = 75;
    let cssId = null;
    let rendered = false;
    let subscribedPrefix = null;

    // DOM caches for the currently rendered index
    let analogElByTag = null;   // tagName -> element
    let digitalLedByTag = null; // tagName -> element
    let digitalTxtByTag = null; // tagName -> element

    function ensureScadaClientShim() {
        if (window.scadaClient) return;
        window.scadaClient = {
            getTagValue: (name) => latestValues ? latestValues[name] : undefined,
            getActualTagId: (name) => {
                const meta = allTagMeta ? allTagMeta[name] : null;
                const id = meta && meta.actual_tag_id !== undefined && meta.actual_tag_id !== null && meta.actual_tag_id !== '' ? meta.actual_tag_id : null;
                return id !== null ? parseInt(id) : null;
            },
            getTagInfo: (name) => {
                const meta = allTagMeta ? allTagMeta[name] : null;
                if (!meta) return null;
                return {
                    name,
                    value: latestValues ? latestValues[name] : undefined,
                    actual_tag_id: meta.actual_tag_id,
                    chartable: meta.chartable,
                    unit: meta.unit,
                    dataType: meta.dataType
                };
            }
        };
    }

    // ── DOM refs ──
    const $main    = () => document.getElementById('main');
    const $loading = () => document.getElementById('loading');
    const $index   = () => document.getElementById('inv-index');
    const $range   = () => document.getElementById('idx-range');
    const $label   = () => document.getElementById('inv-label');
    const $dot     = () => document.getElementById('conn-dot');
    const $connTxt = () => document.getElementById('conn-text');

    // ═══════════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════════

    /** Pad index to 3 digits → "001", "075" */
    function pad(n) { return String(n).padStart(3, '0'); }

    /** Build prefix string e.g. "INV001_" */
    function buildPrefix(idx) { return `${PREFIX}${pad(idx)}_`; }

    /** Convert PascalCase / camelCase to readable: "ACOvervoltage" → "AC Overvoltage" */
    function humanize(s) {
        return s
            .replace(/([a-z])([A-Z])/g, '$1 $2')    // camelCase split
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // acronym split
            .trim();
    }

    /** Get suffix after prefix: "INV001_ACVoltage" → "ACVoltage" */
    function suffix(tagName, pfx) { return tagName.startsWith(pfx) ? tagName.slice(pfx.length) : tagName; }

    /** Is tag digital (boolean)? */
    function isDigital(meta) {
        if (!meta) return false;
        const dt = (meta.dataType || '').toLowerCase();
        return dt === 'bool' || dt === 'boolean';
    }

    function setDigitalCollapsed(collapsed) {
        const grid = document.querySelector('.digital-grid');
        if (!grid) return;

        const digitalSection = document.querySelector('.digital-section');
        const analogSection = document.querySelector('.analog-section');
        const fab = document.getElementById('btn-digital-fab');

        grid.classList.toggle('is-collapsed', !!collapsed);
        if (digitalSection) digitalSection.classList.toggle('is-collapsed', !!collapsed);
        if (analogSection) analogSection.classList.toggle('digital-collapsed', !!collapsed);

        const btnCollapse = document.getElementById('btn-digital-collapse');
        if (btnCollapse) btnCollapse.classList.toggle('is-hidden', !!collapsed);
        if (fab) fab.classList.toggle('is-hidden', !collapsed);

        try {
            localStorage.setItem(DIGITAL_COLLAPSE_STORAGE_KEY, collapsed ? '1' : '0');
        } catch (e) { /* ignore */ }
    }

    function setupDigitalToggleUI() {
        const btnCollapse = document.getElementById('btn-digital-collapse');
        const fab = document.getElementById('btn-digital-fab');
        const grid = document.querySelector('.digital-grid');
        if (!grid || (!btnCollapse && !fab)) return;

        const stored = (() => {
            try { return localStorage.getItem(DIGITAL_COLLAPSE_STORAGE_KEY); } catch (e) { return null; }
        })();
        const initialCollapsed = stored === '1';
        setDigitalCollapsed(initialCollapsed);

        if (btnCollapse) btnCollapse.addEventListener('click', () => setDigitalCollapsed(true));
        if (fab) fab.addEventListener('click', () => setDigitalCollapsed(false));
    }

    // ═══════════════════════════════════════════════════════════════
    // URL params
    // ═══════════════════════════════════════════════════════════════

    function readURL() {
        const p = new URLSearchParams(window.location.search);
        currentIndex = parseInt(p.get('index')) || 1;
        cssId = parseInt(p.get('css')) || null;
    }

    function updateURL() {
        const u = `inverter.html?index=${currentIndex}${cssId ? '&css=' + cssId : ''}`;
        window.history.replaceState({}, '', u);
    }

    // ═══════════════════════════════════════════════════════════════
    // Index limits from config.json
    // ═══════════════════════════════════════════════════════════════

    function setupLimits() {
        if (!config) return;
        if (cssId) {
            const css = config.css.find(c => c.id === cssId);
            if (css && css.inverters) {
                minIndex = css.inverters.startIndex || 1;
                maxIndex = css.inverters.endIndex || (minIndex + (css.inverters.count || 1) - 1);
            }
        } else {
            minIndex = 1;
            // total inverters across all CSS
            let total = 0;
            (config.css || []).forEach(c => { total += c.inverters?.count || 0; });
            maxIndex = total || 75;
        }

        const inp = $index();
        if (inp) { inp.min = minIndex; inp.max = maxIndex; }
        const rng = $range();
        if (rng) rng.textContent = `(${minIndex} – ${maxIndex})`;
    }

    function clamp(v) { return Math.max(minIndex, Math.min(maxIndex, v)); }

    // ═══════════════════════════════════════════════════════════════
    // Render tags dynamically
    // ═══════════════════════════════════════════════════════════════

    function render() {
        const pfx = buildPrefix(currentIndex);
        const main = $main();
        if (!main) return;

        // Collect matching tags
        const analogTags = [];
        const digitalTags = [];

        Object.entries(allTagMeta).forEach(([tagName, meta]) => {
            if (!tagName.startsWith(pfx)) return;
            const suf = suffix(tagName, pfx);
            const entry = { tagName, suffix: suf, display: humanize(suf), meta, value: latestValues[tagName] };

            if (isDigital(meta)) digitalTags.push(entry);
            else analogTags.push(entry);
        });

        // Sort alphabetically by display name
        analogTags.sort((a, b) => a.display.localeCompare(b.display));
        digitalTags.sort((a, b) => a.display.localeCompare(b.display));

        if (analogTags.length === 0 && digitalTags.length === 0) {
            main.innerHTML = `<div class="no-tags">No tags found for <strong>${PREFIX}${pad(currentIndex)}</strong>.<br>Check the Excel config.</div>`;
            rendered = true;
            return;
        }

        let html = '';

        // ── Analog section ──
        if (analogTags.length > 0) {
            html += '<section class="inv-section analog-section">';
            html += `<div class="section-title analog">📊 Analog Readings (${analogTags.length})</div>`;
            html += '<div class="analog-grid">';
            analogTags.forEach(t => {
                const val = t.value !== null && t.value !== undefined ? formatValue(t.value) : '--';
                const unit = t.meta.unit || '';
                const actualTagId = (t.meta && t.meta.actual_tag_id !== undefined && t.meta.actual_tag_id !== null && t.meta.actual_tag_id !== '')
                    ? parseInt(t.meta.actual_tag_id)
                    : null;
                const isChartable = !!(t.meta && t.meta.chartable && actualTagId);
                const chartAttrs = isChartable
                    ? ` data-tag="${t.tagName}" data-actual-tag-id="${actualTagId}" data-chartable="true"`
                    : '';
                html += `
                    <div class="analog-card" id="card_${t.tagName}">
                        <div class="analog-name" title="${t.suffix}">${t.display}</div>
                        <div class="analog-value ${t.tagName}" id="val_${t.tagName}"${chartAttrs}>${val}</div>
                        <div class="analog-unit">${unit}</div>
                    </div>`;
            });
            html += '</div>';
            html += '</section>';
        }

        // ── Digital section ──
        if (digitalTags.length > 0) {
            html += '<section class="inv-section digital-section">';
            html += `
                <div class="section-title digital">
                    <span class="section-title-text">🔘 Digital Status (${digitalTags.length})</span>
                    <div class="section-toggle">
                        <button class="toggle-btn" id="btn-digital-collapse" type="button" title="Hide Digital Status" aria-label="Hide Digital Status">−</button>
                    </div>
                </div>`;
            html += '<div class="digital-grid">';
            digitalTags.forEach(t => {
                const v = t.value;
                const isKnown = !(v === null || v === undefined);
                const isAlarm = isKnown && (v === 1 || v === true);
                const ledClass = !isKnown ? 'off' : (isAlarm ? 'on-red' : 'on-green');
                const label = !isKnown ? '--' : (isAlarm ? 'ALARM' : 'OK');
                const labelClass = !isKnown ? 'unknown' : (isAlarm ? 'alarm' : 'ok');

                html += `
                    <div class="digital-row" id="row_${t.tagName}">
                        <span class="led ${ledClass}" id="led_${t.tagName}"></span>
                        <span class="digital-name" title="${t.suffix}">${t.display}</span>
                        <span class="digital-value-text ${labelClass}" id="dtxt_${t.tagName}">${label}</span>
                    </div>`;
            });
            html += '</div>';
            html += '</section>';
        }

        if (digitalTags.length > 0) {
            html += `<button class="digital-fab is-hidden" id="btn-digital-fab" type="button" title="Show Digital Status" aria-label="Show Digital Status">+ Digital</button>`;
        }
        main.innerHTML = html;
        rendered = true;

        setupDigitalToggleUI();

        // Re-hook chartability for newly-rendered analog elements
        if (window.ChartSystem && typeof window.ChartSystem.makeChartable === 'function') {
            requestAnimationFrame(() => {
                try { window.ChartSystem.makeChartable(); } catch (e) { /* ignore */ }
            });
        }

        // Cache DOM nodes for fast updates
        buildDomCacheForCurrentIndex();
    }

    function formatValue(v) {
        if (typeof v === 'number') {
            if (Number.isInteger(v)) return v.toLocaleString();
            return v.toFixed(2);
        }
        return String(v);
    }

    // ═══════════════════════════════════════════════════════════════
    // Live updates (only update changed values, don't re-render)
    // ═══════════════════════════════════════════════════════════════

    function applyUpdates(updates) {
        const pfx = buildPrefix(currentIndex);

        updates.forEach(u => {
            if (!u.tag_name.startsWith(pfx)) return;
            latestValues[u.tag_name] = u.value;

            const meta = allTagMeta[u.tag_name];
            if (!meta) return;

            if (isDigital(meta)) {
                // Update LED + text
                const led = digitalLedByTag ? digitalLedByTag[u.tag_name] : document.getElementById(`led_${u.tag_name}`);
                const txt = digitalTxtByTag ? digitalTxtByTag[u.tag_name] : document.getElementById(`dtxt_${u.tag_name}`);
                if (!led || !txt) return;

                if (u.value === null || u.value === undefined) {
                    led.className = 'led off';
                    txt.textContent = '--';
                    txt.className = 'digital-value-text unknown';
                } else {
                    const isOn = u.value === 1 || u.value === true;
                    led.className = `led ${isOn ? 'on-red' : 'on-green'}`;
                    txt.textContent = isOn ? 'ALARM' : 'OK';
                    txt.className = `digital-value-text ${isOn ? 'alarm' : 'ok'}`;
                }
            } else {
                // Update analog value
                const el = analogElByTag ? analogElByTag[u.tag_name] : document.getElementById(`val_${u.tag_name}`);
                if (el) el.textContent = formatValue(u.value);

                // Feed real-time chart system (chart.js expects someone to push updates)
                if (window.ChartSystem && typeof window.ChartSystem.updateData === 'function') {
                    try { window.ChartSystem.updateData(u.tag_name, u.value); } catch (e) { /* ignore */ }
                }
            }
        });
    }

    function buildDomCacheForCurrentIndex() {
        analogElByTag = Object.create(null);
        digitalLedByTag = Object.create(null);
        digitalTxtByTag = Object.create(null);

        const pfx = buildPrefix(currentIndex);
        Object.keys(allTagMeta || {}).forEach((tagName) => {
            if (!tagName.startsWith(pfx)) return;
            const meta = allTagMeta[tagName];
            if (!meta) return;

            if (isDigital(meta)) {
                digitalLedByTag[tagName] = document.getElementById(`led_${tagName}`);
                digitalTxtByTag[tagName] = document.getElementById(`dtxt_${tagName}`);
            } else {
                analogElByTag[tagName] = document.getElementById(`val_${tagName}`);
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // Socket.IO
    // ═══════════════════════════════════════════════════════════════

    // ── Device-signal watchdog ──────────────────────────────────
    // After the server stops broadcasting an offline device's tags, this page
    // stops receiving updates. If no data arrives for SIGNAL_TIMEOUT_MS while the
    // socket is still up, show the device as "No signal" instead of leaving the
    // last (frozen) values looking live. Must exceed the server FULL_REFRESH_MS.
    let lastDataTs = 0;
    let signalTimer = null;
    const SIGNAL_TIMEOUT_MS = 7000;
    function startSignalWatch() {
        if (signalTimer) return;
        signalTimer = setInterval(() => {
            if (!socket || !socket.connected) return; // socket-down handled by 'disconnect'
            const stale = (Date.now() - lastDataTs) > SIGNAL_TIMEOUT_MS;
            const dot = $dot(); const txt = $connTxt();
            if (dot) dot.className = stale ? 'conn-dot' : 'conn-dot online';
            if (txt) { txt.textContent = stale ? 'No signal' : 'Connected'; txt.style.color = stale ? '#e67e22' : '#2ecc71'; }
        }, 1000);
    }

    function connectSocket() {
        socket = io();

        socket.on('connect', () => {
            updateConn(true);
            lastDataTs = Date.now();   // grace before the first data arrives
            startSignalWatch();
            try { socket.emit('use_subscriptions'); } catch (e) { /* ignore */ }
            subscribeToCurrentPrefix();
            console.log('✅ Socket.IO connected');
        });

        socket.on('disconnect', () => {
            updateConn(false);
            // Reconnect re-joins ALL_ROOM and drops our prefix room — clear so
            // 'connect' re-subscribes (else the guard skips it and we get no data).
            subscribedPrefix = null;
        });

        socket.on('init', (data) => {
            // Store tag metadata + initial values
            if (data.tagMeta) allTagMeta = data.tagMeta;
            if (data.tags) latestValues = data.tags;
            ensureScadaClientShim();
            render();
        });

        socket.on('tag_updates', (updates) => {
            lastDataTs = Date.now();   // live data ⇒ device online
            // Store values
            updates.forEach(u => { latestValues[u.tag_name] = u.value; });

            ensureScadaClientShim();
            if (rendered) applyUpdates(updates);
            else render();
        });
    }

    function subscribeToCurrentPrefix() {
        if (!socket) return;
        const next = buildPrefix(currentIndex).toUpperCase();
        if (subscribedPrefix === next) return;

        if (subscribedPrefix) {
            try { socket.emit('unsubscribe_prefix', subscribedPrefix); } catch (e) { /* ignore */ }
        }
        subscribedPrefix = next;
        try { socket.emit('subscribe_prefix', subscribedPrefix); } catch (e) { /* ignore */ }
    }

    function updateConn(ok) {
        const dot = $dot();
        const txt = $connTxt();
        if (dot) dot.className = ok ? 'conn-dot online' : 'conn-dot';
        if (txt) { txt.textContent = ok ? 'Connected' : 'Disconnected'; txt.style.color = ok ? '#2ecc71' : '#e74c3c'; }
    }

    // ═══════════════════════════════════════════════════════════════
    // Index change
    // ═══════════════════════════════════════════════════════════════

    function setIndex(val) {
        val = clamp(val);
        if (val === currentIndex) return;
        currentIndex = val;

        // Show the reusable loading overlay for 2s on every index switch.
        if (window.LoadingOverlay) {
            window.LoadingOverlay.show(2000, `Loading Inverter ${currentIndex}`);
        }

        const inp = $index();
        if (inp) inp.value = currentIndex;
        const lbl = $label();
        if (lbl) lbl.textContent = `#${currentIndex}`;
        updateURL();
        rendered = false;
        subscribeToCurrentPrefix();
        render();
        notify(`Switched to Inverter ${currentIndex}`, 'info');
    }

    // ═══════════════════════════════════════════════════════════════
    // Notification
    // ═══════════════════════════════════════════════════════════════

    function notify(msg, type) {
        document.querySelectorAll('.notification').forEach(n => n.remove());
        const el = document.createElement('div');
        el.className = `notification ${type || 'info'}`;
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2500);
    }

    // ═══════════════════════════════════════════════════════════════
    // Init
    // ═══════════════════════════════════════════════════════════════

    async function init() {
        readURL();

        // Load config
        try {
            const res = await fetch('/api/config');
            config = await res.json();
        } catch (e) {
            console.error('Config load failed', e);
        }

        setupLimits();
        currentIndex = clamp(currentIndex);

        const inp = $index();
        if (inp) inp.value = currentIndex;
        const lbl = $label();
        if (lbl) lbl.textContent = `#${currentIndex}`;

        // Wire up controls
        document.getElementById('btn-inc').addEventListener('click', () => setIndex(currentIndex + 1));
        document.getElementById('btn-dec').addEventListener('click', () => setIndex(currentIndex - 1));
        inp.addEventListener('change', () => setIndex(parseInt(inp.value) || minIndex));
        inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { setIndex(parseInt(inp.value) || minIndex); inp.blur(); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(currentIndex + 1); }
            if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(currentIndex - 1); }
        });

        document.getElementById('btn-back').addEventListener('click', () => {
            window.location.href = cssId ? `monitoring.html?css=${cssId}` : 'dashboard.html';
        });

        connectSocket();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
