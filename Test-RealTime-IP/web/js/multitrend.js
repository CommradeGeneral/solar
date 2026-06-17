/* ═══════════════════════════════════════════════════════════════
 * Multi-Trend Page — self-contained real-time multi-tag trending.
 *
 * Stability model
 * ───────────────
 * The SCADA server already polls EVERY field device continuously, so this
 * page adds NO load to Modbus / IEC-104. To stay light on the *socket*, we:
 *   1. read tag metadata once from the `init` event,
 *   2. immediately `use_subscriptions` → leave the broadcast room,
 *   3. only `subscribe_prefix(<device>)` for devices that have a tag on the
 *      chart (reference-counted), and `unsubscribe_prefix` when the last
 *      tag of a device is removed.
 * So the browser only ever receives the handful of devices the user picked.
 *
 * Requires: socket.io client (/socket.io/socket.io.js), Chart.js (vendor).
 * Depends on NOTHING else in the app (no main.js / multi_chart.js).
 * ═══════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    /* ── Config ──────────────────────────────────────────────── */
    var MAX_TAGS   = 9
    var SAMPLE_MS  = 1000;
    var WINDOW_PTS = 300;            // default = 5 min @ 1 s
    var STALE_MS   = 7000;           // no update for this long → treat as disconnected (gap)
                                     // must exceed the server's FULL_REFRESH_MS (5 s) so a
                                     // constant-but-connected tag isn't falsely flagged.

    var COLORS = [
        '#3498db', '#2ecc71', '#e74c3c', '#f39c12', '#9b59b6',
        '#1abc9c', '#e67e22', '#00d4ff', '#ff6b6b', '#c8d83f'
    ];

    // category prefix → display label  (matches server normalizePrefix)
    var CATEGORIES = [
        { key: 'INV', label: 'Inverters',        deviceLabel: 'Inverter' },
        { key: 'EM',  label: 'Energy Meters',    deviceLabel: 'Energy Meter' },
        { key: 'WS',  label: 'Weather Station',  deviceLabel: 'Weather Station' },
        { key: 'PR',  label: 'Protection Relays', deviceLabel: 'Protection Relay' }
    ];

    /* ── State ───────────────────────────────────────────────── */
    var socket;
    var usingSubscriptions = false;
    var tagMeta    = {};             // tagName → { unit, chartable, dataType }
    var valueCache = {};             // tagName → latest numeric value
    var lastSeen   = {};             // tagName → ts of last value update (for staleness)
    var selected   = new Map();      // tagName → { color, unit, data[] }
    var prefixRef  = new Map();      // "INV001_" → refcount
    var colorPool  = COLORS.slice();
    var timeLabels = [];
    var chart      = null;           // combined-mode chart
    var splitCharts = new Map();     // split-mode: tagName → Chart (one panel each)
    var paused     = false;
    var multiAxis  = false;          // false = one combined chart, true = split panels
    var sampler    = null;

    /* ── DOM refs ────────────────────────────────────────────── */
    var elTree, elSearch, elStat, elChips, elCount, elCanvas, elGrid, elEmpty, elConn;

    /* ── Prefix helpers (mirror server's regex) ──────────────── */
    function extractPrefix(name) {
        var m = String(name).toUpperCase().match(/^(INV|EM|PR|WS)(\d{3})_/);
        return m ? { prefix: m[0], cat: m[1], index: parseInt(m[2], 10) } : null;
    }

    /* ── Socket ──────────────────────────────────────────────── */
    function connect() {
        socket = io();   // same-origin (server on :5000 serves this page)

        socket.on('connect',    function () { setConn(true); });
        socket.on('disconnect', function () { setConn(false); });
        socket.on('connect_error', function () { setConn(false); });

        socket.on('init', function (data) {
            tagMeta = data.tagMeta || {};
            // seed snapshot values so chips/chart have something immediately
            if (data.tags) {
                Object.keys(data.tags).forEach(function (n) {
                    var v = data.tags[n];
                    if (typeof v === 'number') valueCache[n] = v;
                });
            }
            buildTree();
            // Opt out of the full broadcast — from now on we pull per device.
            // Runs on every `init` (incl. reconnects, where the server re-adds
            // us to the broadcast room and drops our prefix subscriptions).
            socket.emit('use_subscriptions');
            usingSubscriptions = true;
            // Re-subscribe every device that still has a tag on the chart.
            prefixRef.forEach(function (n, pfx) {
                if (n > 0) socket.emit('subscribe_prefix', pfx);
            });
        });

        socket.on('tag_updates', function (updates) {
            if (!Array.isArray(updates)) return;
            var now = Date.now();
            for (var i = 0; i < updates.length; i++) {
                var u = updates[i];
                if (typeof u.value === 'number') {
                    valueCache[u.tag_name] = u.value;
                    lastSeen[u.tag_name] = now;   // mark fresh
                }
            }
        });
        socket.on('tag_update', function (u) {
            if (u && typeof u.value === 'number') {
                valueCache[u.tag_name] = u.value;
                lastSeen[u.tag_name] = Date.now();
            }
        });
    }

    function setConn(online) {
        if (!elConn) return;
        elConn.classList.toggle('is-online', online);
        elConn.querySelector('.tr-conn-text').textContent = online ? 'Online' : 'Offline';
    }

    /* ── Build tree data from metadata ───────────────────────── */
    function buildTree() {
        // group chartable tags: cat → index → [ {name, short, unit} ]
        var groups = {};   // catKey → { index → [tags] }
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
                short: name.slice(p.prefix.length),   // strip "INV001_"
                unit: meta.unit || ''
            });
        });

        renderTree(groups);
        if (elStat) {
            elStat.textContent = chartableCount + ' chartable tags · click a device to expand';
        }
    }

    function pad3(n) { return ('00' + n).slice(-3); }

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

                // keep the leaf data on the element so search can render lazily too
                devEl._tags = tags;
                devEl._body = devBody;

                // Lazy-render leaves on first expand (keeps DOM tiny for 100+ devices)
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

    /* ── Search / filter ─────────────────────────────────────── */
    function onSearch() {
        var q = elSearch.value.trim().toLowerCase();

        elTree.querySelectorAll('.tr-cat').forEach(function (catEl) {
            var anyDevVisible = false;

            catEl.querySelectorAll('.tr-dev').forEach(function (devEl) {
                var devMatch = devEl.dataset.search.indexOf(q) !== -1;
                var tagMatch = false;

                if (q) {
                    // match against tag names without forcing a full render
                    tagMatch = (devEl._tags || []).some(function (t) {
                        return (t.name + ' ' + t.short).toLowerCase().indexOf(q) !== -1;
                    });
                }

                var visible = !q || devMatch || tagMatch;
                devEl.style.display = visible ? '' : 'none';
                if (visible) anyDevVisible = true;

                // auto-expand (and render) matches while searching
                if (q && visible) { ensureLeaves(devEl); devEl.classList.add('tr-open'); }
                else if (q) { devEl.classList.remove('tr-open'); }
            });

            catEl.style.display = anyDevVisible ? '' : 'none';
            catEl.classList.toggle('tr-open', !!q && anyDevVisible);
        });
    }

    function cssEscape(s) { return String(s).replace(/"/g, '\\"'); }

    /* ── Color pool ──────────────────────────────────────────── */
    function takeColor() {
        return colorPool.length ? colorPool.shift() : COLORS[selected.size % COLORS.length];
    }
    function returnColor(c) {
        if (COLORS.indexOf(c) !== -1 && colorPool.indexOf(c) === -1) colorPool.push(c);
    }

    /* ── Add / remove tag ────────────────────────────────────── */
    function toggleTag(name) {
        if (selected.has(name)) removeTag(name);
        else addTag(name);
    }

    function addTag(name) {
        if (selected.has(name)) return;
        if (selected.size >= MAX_TAGS) {
            toast('Maximum ' + MAX_TAGS + ' tags reached');
            return;
        }
        var meta = tagMeta[name] || {};
        var color = takeColor();

        // pad history so the new line starts "now"
        var data = [];
        for (var i = 0; i < timeLabels.length; i++) data.push(null);

        selected.set(name, { color: color, unit: meta.unit || '', data: data });

        // subscribe to the device (reference counted)
        var p = extractPrefix(name);
        if (p) {
            var c = prefixRef.get(p.prefix) || 0;
            if (c === 0 && socket && socket.connected) socket.emit('subscribe_prefix', p.prefix);
            prefixRef.set(p.prefix, c + 1);
        }

        // grace period: treat as fresh until the first live update (or it goes
        // stale ~STALE_MS later if the device is actually disconnected).
        lastSeen[name] = Date.now();

        // seed an immediate value from REST so the line isn't blank for ~1 s
        seedValue(name);

        refreshLeafByName(name, true);
        rebuildChart();
        renderChips();
        startSampling();
        toast('Added: ' + name, color);
    }

    function removeTag(name) {
        var info = selected.get(name);
        if (!info) return;
        returnColor(info.color);
        selected.delete(name);

        var p = extractPrefix(name);
        if (p) {
            var c = (prefixRef.get(p.prefix) || 1) - 1;
            if (c <= 0) {
                prefixRef.delete(p.prefix);
                if (socket && socket.connected) socket.emit('unsubscribe_prefix', p.prefix);
            } else {
                prefixRef.set(p.prefix, c);
            }
        }

        refreshLeafByName(name, false);
        rebuildChart();
        renderChips();
        if (selected.size === 0) stopSampling();
    }

    function clearAll() {
        Array.from(selected.keys()).forEach(removeTag);
    }

    // Free everything held in memory when the page is being closed / navigated
    // away from: stop the sampler, drop the socket, destroy charts and wipe all
    // the in-memory caches.
    function teardown() {
        stopSampling();
        if (socket) { try { socket.disconnect(); } catch (e) {} socket = null; }
        destroyAllCharts();
        selected.clear();
        prefixRef.clear();
        valueCache = {};
        lastSeen   = {};
        tagMeta    = {};
        timeLabels = [];
        colorPool  = COLORS.slice();
    }

    function seedValue(name) {
        if (typeof valueCache[name] === 'number') return;
        fetch('/api/tag/' + encodeURIComponent(name))
            .then(function (r) { return r.json(); })
            .then(function (j) {
                if (j && j.success && typeof j.data.value === 'number') {
                    valueCache[name] = j.data.value;
                }
            })
            .catch(function () { /* ignore */ });
    }

    /* ── Chips ───────────────────────────────────────────────── */
    function renderChips() {
        elCount.textContent = selected.size + '/' + MAX_TAGS;
        if (selected.size === 0) {
            elChips.innerHTML = '<span class="tr-hint">Click any tag in the tree to plot it here</span>';
            return;
        }
        elChips.innerHTML = '';
        selected.forEach(function (info, name) {
            var stale = isStale(name);
            var v = valueCache[name];
            var vTxt = stale ? '⚠ no signal'
                     : (typeof v === 'number') ? (Number.isInteger(v) ? v : v.toFixed(1)) + (info.unit ? ' ' + info.unit : '')
                     : '--';
            var chip = document.createElement('span');
            chip.className = 'tr-chip' + (stale ? ' is-stale' : '');
            chip.style.borderColor = info.color;
            chip.innerHTML =
                '<span class="tr-chip-dot" style="background:' + info.color + '"></span>' +
                '<span class="tr-chip-name">' + name + '</span>' +
                '<span class="tr-chip-val">' + vTxt + '</span>' +
                '<span class="tr-chip-x" title="Remove">×</span>';
            chip.querySelector('.tr-chip-x').addEventListener('click', function () { removeTag(name); });
            elChips.appendChild(chip);
        });
    }

    /* ── Sampling ────────────────────────────────────────────── */
    function startSampling() {
        if (sampler) return;
        sampler = setInterval(function () {
            if (paused || selected.size === 0) return;
            sample();
        }, SAMPLE_MS);
    }
    function stopSampling() {
        if (sampler) { clearInterval(sampler); sampler = null; }
    }

    function sample() {
        var label = new Date().toLocaleTimeString('en-US', {
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        });
        timeLabels.push(label);
        if (timeLabels.length > WINDOW_PTS) timeLabels.shift();

        selected.forEach(function (info, name) {
            // No live update for STALE_MS → device lost → push null so the line
            // breaks (a real gap) instead of freezing at the last value.
            var v = isStale(name) ? null : valueCache[name];
            info.data.push(typeof v === 'number' ? v : null);
            if (info.data.length > WINDOW_PTS) info.data.shift();
        });

        updateChart();
        renderChips();
    }

    function isStale(name) {
        return (Date.now() - (lastSeen[name] || 0)) > STALE_MS;
    }

    /* ── Chart.js ────────────────────────────────────────────── */
    function destroyAllCharts() {
        if (chart) { chart.destroy(); chart = null; }
        splitCharts.forEach(function (c) { c.destroy(); });
        splitCharts.clear();
        if (elGrid) elGrid.innerHTML = '';
    }

    function showGrid(on) {
        if (elGrid)   elGrid.hidden = !on;
        if (elCanvas) elCanvas.style.display = on ? 'none' : '';
    }

    function lineDataset(name, info) {
        return {
            label: name,
            data: info.data.slice(),
            borderColor: info.color,
            backgroundColor: hexToRgba(info.color, 0.10),
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0.3,
            fill: false,
            spanGaps: false   // show real breaks when a tag goes stale/disconnected
        };
    }

    function tooltipCfg() {
        return {
            mode: 'index', intersect: false,
            backgroundColor: 'rgba(10,14,23,0.94)',
            titleColor: '#00d4ff',
            bodyColor: '#e6edf5',
            borderColor: 'rgba(0,212,255,0.25)',
            borderWidth: 1, padding: 10, cornerRadius: 6,
            callbacks: {
                label: function (c) {
                    var info = selected.get(c.dataset.label);
                    var u = info && info.unit ? ' ' + info.unit : '';
                    var y = c.parsed.y;
                    return ' ' + c.dataset.label + ': ' +
                        (y !== null && y !== undefined ? y.toFixed(2) + u : '--');
                }
            }
        };
    }

    function chartOptions(isSplit) {
        return {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },   // chips / panel titles act as legend
                tooltip: tooltipCfg()
            },
            scales: {
                x: {
                    ticks: { color: '#cfe0f0', maxTicksLimit: isSplit ? 5 : 10, maxRotation: 0,
                             font: { size: isSplit ? 9 : 11 } },
                    grid:  { color: 'rgba(255,255,255,0.08)' }
                },
                y: {
                    ticks: { color: '#cfe0f0', font: { size: isSplit ? 9 : 11 },
                             padding: isSplit ? 2 : 6, maxTicksLimit: isSplit ? 5 : 8 },
                    grid:  { color: 'rgba(255,255,255,0.08)' }
                }
            }
        };
    }

    function rebuildChart() {
        destroyAllCharts();
        toggleEmpty(selected.size === 0);
        if (selected.size === 0) { showGrid(false); return; }
        if (multiAxis) buildSplit();
        else           buildCombined();
    }

    // One combined chart, shared Y axis (all tags overlaid).
    function buildCombined() {
        showGrid(false);
        var datasets = [];
        selected.forEach(function (info, name) { datasets.push(lineDataset(name, info)); });
        chart = new Chart(elCanvas.getContext('2d'), {
            type: 'line',
            data: { labels: timeLabels.slice(), datasets: datasets },
            options: chartOptions(false)
        });
    }

    // N separate mini-trends, one per tag, auto-tiled to fill the area.
    function buildSplit() {
        showGrid(true);
        elGrid.innerHTML = '';

        var n    = selected.size;
        var cols = Math.ceil(Math.sqrt(n));   // 1→1, 2→2, 4→2, 9→3, 10→4 …
        var rows = Math.ceil(n / cols);
        elGrid.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
        elGrid.style.gridTemplateRows    = 'repeat(' + rows + ', 1fr)';

        selected.forEach(function (info, name) {
            var panel = document.createElement('div');
            panel.className = 'tr-panel';
            panel.innerHTML =
                '<div class="tr-panel-title">' +
                    '<span class="tr-panel-dot" style="background:' + info.color + '"></span>' +
                    '<span class="tr-panel-name">' + name +
                        (info.unit ? ' (' + info.unit + ')' : '') + '</span>' +
                '</div>' +
                '<div class="tr-panel-cv"><canvas></canvas></div>';
            elGrid.appendChild(panel);

            var c = new Chart(panel.querySelector('canvas').getContext('2d'), {
                type: 'line',
                data: { labels: timeLabels.slice(), datasets: [lineDataset(name, info)] },
                options: chartOptions(true)
            });
            splitCharts.set(name, c);
        });
    }

    function setAxisMode(multi) {
        multiAxis = multi;
        var btn = document.getElementById('trAxis');
        if (btn) {
            btn.textContent = multiAxis ? 'Split view' : 'Single axis';
            btn.classList.toggle('is-active', multiAxis);
        }
        rebuildChart();
    }

    function updateChart() {
        if (multiAxis) {
            if (splitCharts.size !== selected.size) { rebuildChart(); return; }
            splitCharts.forEach(function (c, name) {
                var info = selected.get(name);
                c.data.labels = timeLabels.slice();
                if (info && c.data.datasets[0]) c.data.datasets[0].data = info.data.slice();
                c.update('none');
            });
            return;
        }
        if (!chart) { rebuildChart(); return; }
        chart.data.labels = timeLabels.slice();
        var i = 0;
        selected.forEach(function (info) {
            if (chart.data.datasets[i]) chart.data.datasets[i].data = info.data.slice();
            i++;
        });
        chart.update('none');
    }

    function toggleEmpty(show) {
        if (elEmpty) elEmpty.classList.toggle('is-hidden', !show);
    }

    function setWindow(pts) {
        WINDOW_PTS = pts;
        // trim existing buffers to the new window
        while (timeLabels.length > WINDOW_PTS) timeLabels.shift();
        selected.forEach(function (info) {
            while (info.data.length > WINDOW_PTS) info.data.shift();
        });
        updateChart();
    }

    /* ── Toast ───────────────────────────────────────────────── */
    function toast(msg, bg) {
        var el = document.createElement('div');
        el.className = 'tr-toast';
        if (bg) el.style.background = bg;
        el.textContent = msg;
        document.body.appendChild(el);
        requestAnimationFrame(function () { el.classList.add('tr-toast-in'); });
        setTimeout(function () {
            el.classList.remove('tr-toast-in');
            setTimeout(function () { el.remove(); }, 300);
        }, 1800);
    }

    function hexToRgba(hex, a) {
        var r = parseInt(hex.slice(1, 3), 16),
            g = parseInt(hex.slice(3, 5), 16),
            b = parseInt(hex.slice(5, 7), 16);
        return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }

    /* ── Boot ────────────────────────────────────────────────── */
    function boot() {
        elTree   = document.getElementById('trTree');
        elSearch = document.getElementById('trSearch');
        elStat   = document.getElementById('trTreeStat');
        elChips  = document.getElementById('trChips');
        elCount  = document.getElementById('trCount');
        elCanvas = document.getElementById('trCanvas');
        elGrid   = document.getElementById('trGrid');
        elEmpty  = document.getElementById('trEmpty');
        elConn   = document.getElementById('trConn');

        elSearch.addEventListener('input', onSearch);
        document.getElementById('trPause').addEventListener('click', function () {
            paused = !paused;
            this.classList.toggle('is-active', paused);
            this.textContent = paused ? '▶' : '⏸';
        });
        document.getElementById('trClear').addEventListener('click', clearAll);
        document.getElementById('trAxis').addEventListener('click', function () {
            setAxisMode(!multiAxis);
        });

        document.getElementById('trWindows').addEventListener('click', function (e) {
            var btn = e.target.closest('.tr-win');
            if (!btn) return;
            this.querySelectorAll('.tr-win').forEach(function (b) { b.classList.remove('is-active'); });
            btn.classList.add('is-active');
            setWindow(parseInt(btn.dataset.pts, 10));
        });

        connect();

        // Clear the cache as soon as the page is closed / navigated away from.
        window.addEventListener('pagehide', teardown);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
