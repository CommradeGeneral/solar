/* ═══════════════════════════════════════════════════════════════
   Historical Multi-Trend  (prefix: trh-)
   - Same tag tree as the live Multi-Trend page.
   - Pick up to MAX_TAGS tags + a date range, press "Load Data".
   - Each tag is fetched SEQUENTIALLY (one /history call after another);
     a failed tag is reported by name and the rest still load.
   - All raw points are cached in memory (binary transport), then drawn
     overlaid in one chart, each tag a different color. Zoom / pan are
     done locally from the cache (LTTB decimation), no extra requests.
   - Cache is cleared on every Load Data and when the page is closed.
   ═══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    /* ── Config ─────────────────────────────────────────────── */
    var MAX_TAGS = 5;                  // max overlaid tags (changeable in UI)
    var MAX_DISPLAY_POINTS = 3000;     // LTTB cap per tag while drawing
    var MIN_WINDOW_MS = 5 * 60 * 1000; // deepest zoom-in window

    var COLORS = [
        '#00d4ff', '#2ecc71', '#e74c3c', '#f39c12', '#9b59b6',
        '#1abc9c', '#e67e22', '#ff6b6b', '#c8d83f', '#3498db'
    ];

    var CATEGORIES = [
        { key: 'INV', label: 'Inverters',        deviceLabel: 'Inverter' },
        { key: 'EM',  label: 'Energy Meters',    deviceLabel: 'Energy Meter' },
        { key: 'WS',  label: 'Weather Station',  deviceLabel: 'Weather Station' },
        { key: 'PR',  label: 'Protection Relays', deviceLabel: 'Protection Relay' }
    ];

    /* ── History API base (the historian server, :3000 in dev) ── */
    function inferApiBase() {
        try {
            var l = window.location;
            if (l.hostname === '192.168.1.2') {
                return l.protocol + '//' + l.hostname + ':3000';
            }
            return l.origin;
        } catch (e) { return window.location.origin; }
    }
    var API_BASE = window.API_BASE_URL || inferApiBase();

    /* ── State ──────────────────────────────────────────────── */
    var socket;
    var tagMeta = {};
    var colorPool = COLORS.slice();
    // name -> { color, unit, actualTagId, fullData:{timestamps,values,loaded}, failed }
    var selected = new Map();
    var chart = null;
    var isLoading = false;
    var loadToken = 0;       // bumped to invalidate an in-flight load
    var loadAbort = null;    // AbortController for the current fetch

    var fullRange = { start: null, end: null };
    var viewport  = { start: null, end: null };

    /* ── DOM refs ───────────────────────────────────────────── */
    var elTree, elSearch, elStat, elChips, elCount, elCanvas, elEmpty;
    var elStart, elStartT, elEnd, elEndT, elLoad, elStatus, elMaxTags, elReset, elClear, elSnap;
    var elDays, elPts, elNavBar, elViewportRect, elNavStart, elNavEnd;

    /* ── Prefix helper (mirrors server regex) ───────────────── */
    function extractPrefix(name) {
        var m = String(name).toUpperCase().match(/^(INV|EM|PR|WS)(\d{3})_/);
        return m ? { prefix: m[0], cat: m[1], index: parseInt(m[2], 10) } : null;
    }
    function shortName(name) {
        var p = extractPrefix(name);
        return p ? name.slice(p.prefix.length) : name;
    }
    function cssEscape(s) { return String(s).replace(/"/g, '\\"'); }
    function pad2(n) { return ('0' + n).slice(-2); }
    function pad3(n) { return ('00' + n).slice(-3); }

    function fmtAxis(ms) {
        var d = new Date(ms);
        return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + ' ' +
               pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }
    function fmtFull(ms) {
        var d = new Date(ms);
        return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' +
               pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    }

    /* ── Socket: only used to load tag metadata + build the tree ── */
    function connect() {
        socket = io();
        socket.on('init', function (data) {
            tagMeta = data.tagMeta || {};
            buildTree();
        });
    }

    /* ── Build tree from metadata (same shape as multitrend.js) ── */
    function buildTree() {
        var groups = {};
        var chartableCount = 0;

        Object.keys(tagMeta).forEach(function (name) {
            var meta = tagMeta[name];
            if (!meta || !meta.chartable) return;
            var p = extractPrefix(name);
            if (!p) return;
            chartableCount++;
            if (!groups[p.cat]) groups[p.cat] = {};
            if (!groups[p.cat][p.index]) groups[p.cat][p.index] = [];
            groups[p.cat][p.index].push({
                name: name,
                short: name.slice(p.prefix.length),
                unit: meta.unit || ''
            });
        });

        renderTree(groups);
        if (elStat) elStat.textContent = chartableCount + ' chartable tags · click a device to expand';
    }

    function renderTree(groups) {
        elTree.innerHTML = '';
        CATEGORIES.forEach(function (cat) {
            var byIndex = groups[cat.key];
            if (!byIndex) return;
            var indices = Object.keys(byIndex).map(Number).sort(function (a, b) { return a - b; });

            var catEl = document.createElement('div');
            catEl.className = 'tr-cat';
            catEl.dataset.cat = cat.key;

            var head = document.createElement('button');
            head.type = 'button';
            head.className = 'tr-cat-head';
            head.innerHTML =
                '<span class="tr-caret">▶</span>' +
                '<span class="tr-cat-name">' + cat.label + '</span>' +
                '<span class="tr-badge">' + indices.length + '</span>';
            head.addEventListener('click', function () { catEl.classList.toggle('tr-open'); });

            var body = document.createElement('div');
            body.className = 'tr-cat-body';

            indices.forEach(function (idx) {
                var tags = byIndex[idx];
                var devEl = document.createElement('div');
                devEl.className = 'tr-dev';
                devEl.dataset.search = (cat.deviceLabel + ' ' + cat.key + pad3(idx)).toLowerCase();

                var devHead = document.createElement('button');
                devHead.type = 'button';
                devHead.className = 'tr-dev-head';
                devHead.innerHTML =
                    '<span class="tr-caret">▶</span>' +
                    '<span class="tr-dev-name">' + cat.deviceLabel + ' ' + pad3(idx) + '</span>' +
                    '<span class="tr-badge">' + tags.length + '</span>';

                var devBody = document.createElement('div');
                devBody.className = 'tr-dev-body';
                devEl._tags = tags;
                devEl._body = devBody;

                devHead.addEventListener('click', function () {
                    ensureLeaves(devEl);
                    devEl.classList.toggle('tr-open');
                });

                devEl.appendChild(devHead);
                devEl.appendChild(devBody);
                body.appendChild(devEl);
            });

            catEl.appendChild(head);
            catEl.appendChild(body);
            elTree.appendChild(catEl);
        });
    }

    function ensureLeaves(devEl) {
        if (devEl._rendered) return;
        renderLeaves(devEl._body, devEl._tags);
        devEl._rendered = true;
    }

    function renderLeaves(container, tags) {
        tags.sort(function (a, b) { return a.short.localeCompare(b.short); });
        tags.forEach(function (t) {
            var leaf = document.createElement('div');
            leaf.className = 'tr-tag';
            leaf.dataset.tag = t.name;
            leaf.dataset.search = (t.name + ' ' + t.short).toLowerCase();
            leaf.innerHTML =
                '<span class="tr-tag-dot"></span>' +
                '<span class="tr-tag-name" title="' + t.name + '">' + t.short + '</span>' +
                (t.unit ? '<span class="tr-tag-unit">' + t.unit + '</span>' : '');
            if (selected.has(t.name)) markLeaf(leaf, true);
            leaf.addEventListener('click', function () { toggleTag(t.name); });
            container.appendChild(leaf);
        });
    }

    function markLeaf(leaf, on) {
        leaf.classList.toggle('is-selected', on);
        var dot = leaf.querySelector('.tr-tag-dot');
        var info = selected.get(leaf.dataset.tag);
        if (dot) dot.style.background = (on && info) ? info.color : '';
    }
    function refreshLeafByName(name, on) {
        var leaf = elTree.querySelector('.tr-tag[data-tag="' + cssEscape(name) + '"]');
        if (leaf) markLeaf(leaf, on);
    }

    /* ── Search ─────────────────────────────────────────────── */
    function onSearch() {
        var q = elSearch.value.trim().toLowerCase();
        elTree.querySelectorAll('.tr-cat').forEach(function (catEl) {
            var anyDevVisible = false;
            catEl.querySelectorAll('.tr-dev').forEach(function (devEl) {
                var devMatch = devEl.dataset.search.indexOf(q) !== -1;
                var tagMatch = false;
                if (q) {
                    tagMatch = (devEl._tags || []).some(function (t) {
                        return (t.name + ' ' + t.short).toLowerCase().indexOf(q) !== -1;
                    });
                }
                var visible = !q || devMatch || tagMatch;
                devEl.style.display = visible ? '' : 'none';
                if (visible) anyDevVisible = true;
                if (q && visible) { ensureLeaves(devEl); devEl.classList.add('tr-open'); }
                else if (q) { devEl.classList.remove('tr-open'); }
            });
            catEl.style.display = anyDevVisible ? '' : 'none';
            catEl.classList.toggle('tr-open', !!q && anyDevVisible);
        });
    }

    /* ── Color pool ─────────────────────────────────────────── */
    function takeColor() { return colorPool.length ? colorPool.shift() : COLORS[selected.size % COLORS.length]; }
    function returnColor(c) { if (COLORS.indexOf(c) !== -1 && colorPool.indexOf(c) === -1) colorPool.push(c); }

    /* ── Selection ──────────────────────────────────────────── */
    function toggleTag(name) { if (selected.has(name)) removeTag(name); else addTag(name); }

    function addTag(name) {
        if (selected.has(name)) return;
        if (selected.size >= MAX_TAGS) { toast('Maximum ' + MAX_TAGS + ' tags reached'); return; }
        var meta = tagMeta[name] || {};
        selected.set(name, {
            color: takeColor(),
            unit: meta.unit || '',
            actualTagId: (meta.actual_tag_id != null ? parseInt(meta.actual_tag_id, 10) : null),
            fullData: { timestamps: [], values: [], loaded: false },
            failed: false,
            hidden: false   // legend visibility, preserved across zoom/pan
        });
        refreshLeafByName(name, true);
        renderChips();
        updateCount();
    }

    function removeTag(name) {
        var info = selected.get(name);
        if (!info) return;
        returnColor(info.color);
        // free its cached arrays
        info.fullData = { timestamps: [], values: [], loaded: false };
        selected.delete(name);
        refreshLeafByName(name, false);
        renderChips();
        updateCount();
        rebuildChart();
        updateNavigatorBadges();
    }

    function clearAll() { Array.from(selected.keys()).forEach(removeTag); }

    function updateCount() { if (elCount) elCount.textContent = selected.size + '/' + MAX_TAGS; }

    function renderChips() {
        if (!elChips) return;
        if (selected.size === 0) {
            elChips.innerHTML = '<span class="tr-hint">Pick up to ' + MAX_TAGS +
                ' tags, set a date range, then press Load Data</span>';
            return;
        }
        elChips.innerHTML = '';
        selected.forEach(function (info, name) {
            var chip = document.createElement('span');
            chip.className = 'trh-chip' + (info.failed ? ' is-failed' : '') + (info.fullData.loaded ? ' is-loaded' : '');
            chip.innerHTML =
                '<span class="trh-chip-dot" style="background:' + info.color + '"></span>' +
                '<span class="trh-chip-name" title="' + name + '">' + shortName(name) + '</span>' +
                (info.failed ? '<span class="trh-chip-warn" title="Failed to load">⚠</span>' : '') +
                '<button class="trh-chip-x" type="button" aria-label="remove">×</button>';
            chip.querySelector('.trh-chip-x').addEventListener('click', function () { removeTag(name); });
            elChips.appendChild(chip);
        });
    }

    /* ── Load Data (sequential, per-tag) ────────────────────── */
    async function loadData() {
        if (isLoading) return;
        if (selected.size === 0) { alert('Select at least one tag from the tree first.'); return; }

        var sd = elStart.value, st = elStartT.value || '00:00';
        var ed = elEnd.value,   et = elEndT.value || '23:59';
        if (!sd || !ed) { alert('Please select a start and end date.'); return; }

        var startObj = new Date(sd + 'T' + st + ':00');
        var endObj   = new Date(ed + 'T' + et + ':59');
        var now = new Date();
        if (endObj > now) endObj = now;
        if (!(startObj < endObj)) { alert('Start must be before end.'); return; }

        fullRange.start = new Date(startObj);
        fullRange.end   = new Date(endObj);
        viewport.start  = new Date(startObj);
        viewport.end    = new Date(endObj);

        // New load: invalidate any previous one and set up a fresh abort signal.
        var myToken = ++loadToken;
        if (loadAbort) { try { loadAbort.abort(); } catch (e) {} }
        loadAbort = new AbortController();
        var signal = loadAbort.signal;

        isLoading = true;
        if (elLoad) { elLoad.disabled = true; elLoad.classList.add('is-busy'); }

        var names = Array.from(selected.keys());
        var failures = [];

        for (var i = 0; i < names.length; i++) {
            if (myToken !== loadToken) return;   // cancelled (page closing / new load)

            var name = names[i];
            var info = selected.get(name);
            if (!info) continue;

            info.failed = false;
            info.fullData = { timestamps: [], values: [], loaded: false }; // clear old
            renderChips();
            setStatus('Loading ' + (i + 1) + '/' + names.length + ': ' + name + ' …');

            try {
                var tagId = info.actualTagId;
                if (tagId == null) tagId = await fetchActualTagId(name, signal);
                if (myToken !== loadToken) return;
                if (tagId == null) throw new Error('no historian tag id');
                info.actualTagId = tagId;

                var parsed = await fetchHistory(tagId, startObj, endObj, signal);
                if (myToken !== loadToken) return;   // cancelled while fetching
                info.fullData.timestamps = parsed.timestamps;
                info.fullData.values = parsed.values;
                info.fullData.loaded = true;

                console.log('[MultiTrendHistory] ' + name + ' (tag_id=' + tagId + '): cached ' +
                    parsed.values.length.toLocaleString() + ' raw points');
            } catch (err) {
                if (myToken !== loadToken) return;   // aborted → bail silently
                info.failed = true;
                failures.push(name + ' — ' + err.message);
                console.error('[MultiTrendHistory] load failed:', name, err);
            }
            renderChips();
        }

        if (myToken !== loadToken) return;   // cancelled just before finishing
        loadAbort = null;
        isLoading = false;
        if (elLoad) { elLoad.disabled = false; elLoad.classList.remove('is-busy'); }

        rebuildChart();
        updateNavigatorBadges();
        updateNavigator();

        var ok = names.length - failures.length;
        var totalPts = 0;
        selected.forEach(function (i) { if (i.fullData.loaded) totalPts += i.fullData.values.length; });
        console.log('[MultiTrendHistory] Done: ' + ok + ' tag(s) loaded, ' +
            totalPts.toLocaleString() + ' total points cached' +
            (failures.length ? (', ' + failures.length + ' failed') : ''));

        if (failures.length) {
            setStatus(ok + ' loaded, ' + failures.length + ' failed.', true);
            alert('These tags failed to load:\n\n- ' + failures.join('\n- '));
        } else {
            setStatus('Loaded ' + ok + ' tag(s) successfully.');
        }
    }

    async function fetchActualTagId(name, signal) {
        try {
            var r = await fetch('/api/tag/' + encodeURIComponent(name), { credentials: 'include', signal: signal });
            var j = await r.json();
            if (j && j.success && j.data && j.data.actual_tag_id != null) {
                return parseInt(j.data.actual_tag_id, 10);
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    // Fetch one tag's full raw history (binary, with JSON fallback).
    async function fetchHistory(tagId, startObj, endObj, signal) {
        var url = API_BASE + '/history?' +
            'tag_id=' + tagId +
            '&start_day=' + startObj.getDate() + '&start_month=' + (startObj.getMonth() + 1) +
            '&start_year=' + startObj.getFullYear() + '&start_hour=' + startObj.getHours() +
            '&start_minute=' + startObj.getMinutes() +
            '&end_day=' + endObj.getDate() + '&end_month=' + (endObj.getMonth() + 1) +
            '&end_year=' + endObj.getFullYear() + '&end_hour=' + endObj.getHours() +
            '&end_minute=' + endObj.getMinutes() +
            '&format=bin';

        console.log('[MultiTrendHistory] API Request (tag_id=' + tagId + '): ' + url);

        var resp = await fetch(url, { method: 'GET', credentials: 'include', signal: signal });
        if (!resp.ok) {
            if (resp.status === 401) throw new Error('not authenticated');
            throw new Error('HTTP ' + resp.status);
        }

        var ct = resp.headers.get('content-type') || '';
        if (ct.indexOf('application/octet-stream') !== -1) {
            var buf = await resp.arrayBuffer();
            var arr = new Float64Array(buf);
            var k = arr.length >> 1;
            var ts = new Array(k), vals = new Array(k);
            for (var i = 0; i < k; i++) { ts[i] = arr[2 * i]; vals[i] = arr[2 * i + 1]; }
            return { timestamps: ts, values: vals };
        }

        // JSON fallback
        var data = await resp.json();
        var hist = Array.isArray(data) ? data : (data.data || []);
        var n = hist.length, ts2 = new Array(n), v2 = new Array(n), kk = 0;
        for (var j = 0; j < n; j++) {
            var p = hist[j];
            var dt = p.DateTime || p.datetime;
            var vv = (p.Value !== undefined) ? p.Value : p.value;
            if (!dt) continue;
            var t = new Date(dt).getTime();
            if (Number.isNaN(t)) continue;
            ts2[kk] = t; v2[kk] = parseFloat(vv) || 0; kk++;
        }
        ts2.length = kk; v2.length = kk;
        return { timestamps: ts2, values: v2 };
    }

    /* ── Slicing + LTTB decimation (returns [{x,y}]) ────────── */
    function lowerBound(arr, t) { var lo = 0, hi = arr.length; while (lo < hi) { var m = (lo + hi) >> 1; if (arr[m] < t) lo = m + 1; else hi = m; } return lo; }
    function upperBound(arr, t) { var lo = 0, hi = arr.length; while (lo < hi) { var m = (lo + hi) >> 1; if (arr[m] <= t) lo = m + 1; else hi = m; } return lo; }

    function lttb(ts, vals, lo, hi, threshold) {
        var out = [];
        var count = hi - lo;
        if (count <= 0) return out;
        if (count <= threshold || threshold <= 2) {
            for (var i = lo; i < hi; i++) out.push({ x: ts[i], y: vals[i] });
            return out;
        }
        var bucketSize = (count - 2) / (threshold - 2);
        var a = lo;
        out.push({ x: ts[lo], y: vals[lo] });
        for (var b = 0; b < threshold - 2; b++) {
            var rangeStart = lo + 1 + Math.floor(b * bucketSize);
            var rangeEnd   = lo + 1 + Math.floor((b + 1) * bucketSize);
            var nextStart  = lo + 1 + Math.floor((b + 1) * bucketSize);
            var nextEnd    = lo + 1 + Math.floor((b + 2) * bucketSize);
            var cRangeEnd  = Math.min(rangeEnd, hi - 1);
            var cNextStart = Math.min(nextStart, hi - 1);
            var cNextEnd   = Math.min(nextEnd, hi);

            var avgX = 0, avgY = 0, ac = cNextEnd - cNextStart;
            if (ac > 0) { for (var j = cNextStart; j < cNextEnd; j++) { avgX += ts[j]; avgY += vals[j]; } avgX /= ac; avgY /= ac; }
            else { avgX = ts[hi - 1]; avgY = vals[hi - 1]; }

            var ax = ts[a], ay = vals[a], maxArea = -1, sel = rangeStart;
            for (var c = rangeStart; c < cRangeEnd; c++) {
                var area = Math.abs((ax - avgX) * (vals[c] - ay) - (ax - ts[c]) * (avgY - ay));
                if (area > maxArea) { maxArea = area; sel = c; }
            }
            out.push({ x: ts[sel], y: vals[sel] });
            a = sel;
        }
        out.push({ x: ts[hi - 1], y: vals[hi - 1] });
        return out;
    }

    /* ── Chart ──────────────────────────────────────────────── */
    function buildDatasets() {
        var datasets = [];
        var vStart = viewport.start.getTime();
        var vEnd = viewport.end.getTime();
        selected.forEach(function (info, name) {
            if (!info.fullData.loaded) return;
            var ts = info.fullData.timestamps;
            var vals = info.fullData.values;
            var lo = lowerBound(ts, vStart);
            var hi = upperBound(ts, vEnd);
            datasets.push({
                label: name,
                data: lttb(ts, vals, lo, hi, MAX_DISPLAY_POINTS),
                borderColor: info.color,
                backgroundColor: info.color,
                borderWidth: 1.3,
                pointRadius: 0,
                tension: 0,
                fill: false,
                spanGaps: true,
                hidden: !!info.hidden   // keep manual hide across re-render
            });
        });
        return datasets;
    }

    function anyLoaded() {
        var any = false;
        selected.forEach(function (i) { if (i.fullData.loaded) any = true; });
        return any;
    }

    function rebuildChart() {
        var loaded = anyLoaded();
        if (elEmpty) elEmpty.style.display = loaded ? 'none' : 'flex';
        if (chart) { chart.destroy(); chart = null; }
        if (!loaded) return;

        var ctx = elCanvas.getContext('2d');
        chart = new Chart(ctx, {
            type: 'line',
            data: { datasets: buildDatasets() },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                parsing: false,      // data already in {x,y}
                normalized: true,
                interaction: { mode: 'nearest', axis: 'x', intersect: false },
                plugins: {
                    legend: {
                        display: true,
                        labels: { color: '#e6edf5', font: { size: 12, weight: '600' } },
                        // Remember hide state per tag so it survives zoom/pan re-renders.
                        onClick: function (e, legendItem, legend) {
                            var ci = legend.chart;
                            var idx = legendItem.datasetIndex;
                            var ds = ci.data.datasets[idx];
                            var info = ds ? selected.get(ds.label) : null;
                            var nowHidden = !ci.isDatasetVisible(idx);
                            // toggle
                            ci.setDatasetVisibility(idx, nowHidden);
                            if (info) info.hidden = !nowHidden;
                            ci.update();
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(0,0,0,0.85)',
                        callbacks: {
                            title: function (items) { return items.length ? fmtFull(items[0].parsed.x) : ''; },
                            label: function (it) { return it.dataset.label + ': ' + it.parsed.y.toFixed(2); }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'linear',
                        min: viewport.start.getTime(),
                        max: viewport.end.getTime(),
                        ticks: { color: '#cfe0f0', maxTicksLimit: 10, maxRotation: 0, callback: function (v) { return fmtAxis(v); } },
                        grid: { color: 'rgba(255,255,255,0.08)' },
                        title: { display: true, text: 'Time', color: '#00d4ff' }
                    },
                    y: {
                        ticks: { color: '#cfe0f0', callback: function (v) { return Number(v).toFixed(2); } },
                        grid: { color: 'rgba(255,255,255,0.08)' },
                        title: { display: true, text: 'Value', color: '#00d4ff' }
                    }
                }
            }
        });
    }

    // Re-decimate for the current viewport and update (no destroy).
    function refreshChart() {
        if (!chart) { rebuildChart(); updateNavigator(); return; }
        chart.data.datasets = buildDatasets();
        chart.options.scales.x.min = viewport.start.getTime();
        chart.options.scales.x.max = viewport.end.getTime();
        chart.update('none');
        updateNavigator();
    }

    /* ── Zoom / Pan (local, from cache) ─────────────────────── */
    function onWheel(e) {
        if (!fullRange.start || !chart) return;
        e.preventDefault();
        var cs = viewport.start.getTime(), ce = viewport.end.getTime();
        var dur = ce - cs, center = (cs + ce) / 2;
        var nd = (e.deltaY < 0) ? dur / 1.2 : dur * 1.2;
        var maxDur = fullRange.end.getTime() - fullRange.start.getTime();
        nd = Math.max(MIN_WINDOW_MS, Math.min(nd, maxDur));
        var ns = center - nd / 2, ne = center + nd / 2;
        var fs = fullRange.start.getTime(), fe = fullRange.end.getTime();
        if (ns < fs) { ns = fs; ne = fs + nd; }
        if (ne > fe) { ne = fe; ns = fe - nd; }
        viewport.start = new Date(ns);
        viewport.end = new Date(ne);
        refreshChart();
    }

    var panning = false, panX = 0, panS = 0, panE = 0;
    function onCanvasDown(e) {
        if (e.button !== 0 || !fullRange.start || !chart) return;
        panning = true;
        panX = e.clientX;
        panS = viewport.start.getTime();
        panE = viewport.end.getTime();
        elCanvas.style.cursor = 'grabbing';
    }
    function onDocMove(e) {
        if (!panning) return;
        var w = elCanvas.getBoundingClientRect().width || 1;
        var dur = panE - panS;
        var shift = -((e.clientX - panX) / w) * dur;
        var ns = panS + shift, ne = panE + shift;
        var fs = fullRange.start.getTime(), fe = fullRange.end.getTime();
        if (ns < fs) { ns = fs; ne = fs + dur; }
        if (ne > fe) { ne = fe; ns = fe - dur; }
        viewport.start = new Date(ns);
        viewport.end = new Date(ne);
        refreshChart();
    }
    function onDocUp() { if (panning) { panning = false; elCanvas.style.cursor = ''; } }

    function resetZoom() {
        if (!fullRange.start) return;
        viewport.start = new Date(fullRange.start);
        viewport.end = new Date(fullRange.end);
        refreshChart();
    }

    /* ── Timeline navigator ─────────────────────────────────── */
    function updateNavigatorBadges() {
        if (elDays) {
            elDays.textContent = fullRange.start
                ? ((fullRange.end - fullRange.start) / 86400000).toFixed(1) + ' days'
                : '—';
        }
        var total = 0;
        selected.forEach(function (i) { if (i.fullData.loaded) total += i.fullData.values.length; });
        if (elPts) elPts.textContent = total.toLocaleString() + ' pts';
    }

    function updateNavigator() {
        if (!elViewportRect || !fullRange.start) return;
        var fs = fullRange.start.getTime(), fe = fullRange.end.getTime();
        var total = fe - fs || 1;
        var left = ((viewport.start.getTime() - fs) / total) * 100;
        var width = ((viewport.end.getTime() - viewport.start.getTime()) / total) * 100;
        elViewportRect.style.left = Math.max(0, left) + '%';
        elViewportRect.style.width = Math.max(0.5, width) + '%';
        if (elNavStart) elNavStart.textContent = fmtAxis(fs);
        if (elNavEnd) elNavEnd.textContent = fmtAxis(fe);
    }

    var navDragging = false, navStartX = 0, navStartLeft = 0;
    function onNavDown(e) {
        if (!fullRange.start) return;
        navDragging = true;
        navStartX = e.clientX;
        navStartLeft = parseFloat(elViewportRect.style.left) || 0;
        e.preventDefault();
    }
    function onNavMove(e) {
        if (!navDragging) return;
        var barW = elNavBar.getBoundingClientRect().width || 1;
        var deltaPct = ((e.clientX - navStartX) / barW) * 100;
        var width = parseFloat(elViewportRect.style.width) || 1;
        var newLeft = Math.min(Math.max(navStartLeft + deltaPct, 0), 100 - width);

        var fs = fullRange.start.getTime(), fe = fullRange.end.getTime();
        var total = fe - fs;
        var dur = viewport.end.getTime() - viewport.start.getTime();
        var ns = fs + (total * newLeft / 100);
        viewport.start = new Date(ns);
        viewport.end = new Date(ns + dur);
        refreshChart();
    }
    function onNavUp() { navDragging = false; }

    /* ── Misc UI ────────────────────────────────────────────── */
    // Save the current chart as a PNG (composited onto the panel background so
    // the transparent canvas doesn't export as a black/checkered image).
    function snapshot() {
        if (!chart) { alert('Load data first, then take a snapshot.'); return; }
        var src = chart.canvas;
        var tmp = document.createElement('canvas');
        tmp.width = src.width;
        tmp.height = src.height;
        var ctx = tmp.getContext('2d');
        ctx.fillStyle = '#0f1626';
        ctx.fillRect(0, 0, tmp.width, tmp.height);
        ctx.drawImage(src, 0, 0);

        var a = document.createElement('a');
        a.href = tmp.toDataURL('image/png');
        a.download = 'multitrend_history_' + Date.now() + '.png';
        a.click();
        toast('Chart image saved');
    }

    function setStatus(msg, isErr) {
        if (!elStatus) return;
        elStatus.textContent = msg || '';
        elStatus.classList.toggle('is-error', !!isErr);
    }

    function toast(msg, color) {
        var t = document.createElement('div');
        t.className = 'trh-toast';
        t.textContent = msg;
        if (color) t.style.borderLeftColor = color;
        document.body.appendChild(t);
        setTimeout(function () { t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 300); }, 2500);
    }

    function setDefaultDates() {
        var now = new Date();
        var today = now.toISOString().split('T')[0];
        var yesterday = new Date(now.getTime() - 86400000).toISOString().split('T')[0];
        if (elStart) elStart.value = yesterday;
        if (elEnd) elEnd.value = today;
    }

    function teardown() {
        // Cancel any in-flight load: invalidate the loop and abort the fetch.
        var freed = 0;
        selected.forEach(function (i) { if (i.fullData.loaded) freed += i.fullData.values.length; });
        console.log('[MultiTrendHistory] page closing → aborting load + clearing cache (freed ' +
            freed.toLocaleString() + ' points' + (isLoading ? ', a load was in progress' : '') + ')');

        loadToken++;
        if (loadAbort) { try { loadAbort.abort(); } catch (e) {} loadAbort = null; }
        isLoading = false;
        if (elLoad) { elLoad.disabled = false; elLoad.classList.remove('is-busy'); }

        if (socket) { try { socket.disconnect(); } catch (e) {} socket = null; }
        if (chart) { chart.destroy(); chart = null; }
        selected.forEach(function (info) { info.fullData = { timestamps: [], values: [], loaded: false }; });
        selected.clear();
        tagMeta = {};
        colorPool = COLORS.slice();
    }

    /* ── Boot ───────────────────────────────────────────────── */
    function boot() {
        elTree    = document.getElementById('trTree');
        elSearch  = document.getElementById('trSearch');
        elStat    = document.getElementById('trTreeStat');
        elChips   = document.getElementById('trChips');
        elCount   = document.getElementById('trCount');
        elCanvas  = document.getElementById('trhCanvas');
        elEmpty   = document.getElementById('trhEmpty');

        elStart   = document.getElementById('trhStartDate');
        elStartT  = document.getElementById('trhStartTime');
        elEnd     = document.getElementById('trhEndDate');
        elEndT    = document.getElementById('trhEndTime');
        elLoad    = document.getElementById('trhLoad');
        elStatus  = document.getElementById('trhStatus');
        elMaxTags = document.getElementById('trhMaxTags');
        elReset   = document.getElementById('trhReset');
        elClear   = document.getElementById('trhClear');
        elSnap    = document.getElementById('trhSnap');

        elDays         = document.getElementById('trhDays');
        elPts          = document.getElementById('trhPts');
        elNavBar       = document.getElementById('trhNavBar');
        elViewportRect = document.getElementById('trhViewport');
        elNavStart     = document.getElementById('trhNavStart');
        elNavEnd       = document.getElementById('trhNavEnd');

        if (elSearch) elSearch.addEventListener('input', onSearch);
        if (elLoad) elLoad.addEventListener('click', loadData);
        if (elReset) elReset.addEventListener('click', resetZoom);
        if (elClear) elClear.addEventListener('click', clearAll);
        if (elSnap) elSnap.addEventListener('click', snapshot);

        if (elMaxTags) {
            elMaxTags.value = MAX_TAGS;
            elMaxTags.addEventListener('change', function () {
                var v = parseInt(elMaxTags.value, 10);
                if (!Number.isFinite(v) || v < 1) v = 1;
                if (v > 20) v = 20;
                MAX_TAGS = v;
                elMaxTags.value = v;
                updateCount();
                renderChips();
            });
        }

        if (elCanvas) {
            elCanvas.addEventListener('wheel', onWheel, { passive: false });
            elCanvas.addEventListener('mousedown', onCanvasDown);
        }
        document.addEventListener('mousemove', onDocMove);
        document.addEventListener('mouseup', onDocUp);

        if (elViewportRect) elViewportRect.addEventListener('mousedown', onNavDown);
        document.addEventListener('mousemove', onNavMove);
        document.addEventListener('mouseup', onNavUp);

        setDefaultDates();
        updateCount();
        renderChips();
        connect();

        window.addEventListener('pagehide', teardown);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
