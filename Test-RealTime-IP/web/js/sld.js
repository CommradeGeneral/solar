/**
 * SLD (Single Line Diagram) - Real-time value updater
 * Connects to SCADA server via Socket.IO and updates SVG text elements
 *
 * Convention:  tag_name  in Excel  must match  data-tag  in SVG
 *   e.g.  tag_name = "Voltage_K01"  maps to  data-tag="Voltage_K01"
 *
 * Set the "page" column in tags_config.xlsx to "sld" for these tags.
 */

(function () {
    'use strict';

    // Config
    var DEFAULT_VALUE = '0.0';
    var STALE_TIMEOUT = 15000;
    // Very dark colors (requested)
    var BREAKER_OPEN_COLOR = '#1919dc00';    // dark red
    var BREAKER_CLOSED_COLOR = '#006400';  // dark green

    // State
    var socket = null;
    var connected = false;
    var lastUpdate = 0;
    var staleTimer = null;
    var tagMap = {};  // tag_name -> [el, el, ...]
    var breakerMap = {};  // tag_name -> [el, el, ...]

    // Closed-state indicator <g> per BRK tag: shown when value=1, hidden when value=0.
    // These groups draw the "closed" triangle/arrow markers and are otherwise untagged
    // in the exported SVG, so we drive them by element id.
    var BREAKER_CLOSED_INDICATOR_IDS = {
        BRK_K01: 'g1690',
        BRK_K02: 'g5264',
        BRK_K03: 'g3592',
        BRK_K04: 'g7142',
        BRK_K05: 'g9056',
        BRK_K06: 'g10882',
        BRK_K07: 'g23666',
        BRK_K09: 'g22002',
        BRK_K10: 'g14770',
        BRK_K11: 'g18280',
        BRK_K12: 'g20186',
        BRK_K13: 'g12896',
        BRK_K14: 'g16428'
    };
    var closedIndicatorMap = {};  // tag_name -> element

    // Earth-switch closed indicator <path> per BRKE tag: shown when value=1, hidden when 0.
    var EARTH_CLOSED_INDICATOR_IDS = {
        BRKE_K01: 'path1526',
        BRKE_K02: 'path5158',
        BRKE_K03: 'path3428',
        BRKE_K04: 'path6978',
        BRKE_K05: 'path8892',
        BRKE_K06: 'path10776',
        BRKE_K07: 'path23580',
        BRKE_K09: 'path21896',
        BRKE_K10: 'path14606',
        BRKE_K11: 'path18116',
        BRKE_K12: 'path20022',
        BRKE_K13: 'path12732',
        BRKE_K14: 'path16322'
    }; 
    var earthIndicatorMap = {};  // tag_name -> element

    // Zoom/Pan state (SLD page only)
    var svgEl = null;
    var baseViewBox = null;   // {x,y,w,h}
    var viewBox = null;       // mutable current viewBox
    var isPanning = false;
    var panStart = null;      // {x,y,vx,vy}
    var panPending = null;    // {cx,cy}
    var panRaf = 0;

    // ── Recolor SVG: replace black lines & text with visible dark-theme colors ──
    function recolorSVG() {
        var LINE_COLOR = '#f1990093';  // amber — visible on dark bg, not green/blue
        var LABEL_COLOR = '#e0ddd8';  // warm near-white for text & solid fills
        var COMP_BG = '#1e2040';  // dark navy for white component bodies

        var svg = document.querySelector('#sld-container svg');
        if (svg) {
            svg.removeAttribute('width');
            svg.removeAttribute('height');
            svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        }

        // Performance: scan only elements that need changes, and do it in chunks so UI doesn't freeze.
        var strokeEls = document.querySelectorAll('#sld-container [style*=\"stroke:#000000\"]');
        var fillBlackEls = document.querySelectorAll('#sld-container [style*=\"fill:#000000\"]');
        var fillWhiteEls = document.querySelectorAll('#sld-container [style*=\"fill:#ffffff\"]');

        var CHUNK = 600;
        var processed = 0;

        function hasBreakerTag(el) {
            // Some elements are tagged directly; others are children of a tagged group.
            for (var n = el; n && n !== document.body; n = n.parentElement) {
                if (n.getAttribute && n.getAttribute('data-breaker-tag')) return true;
            }
            return false;
        }

        function patchStyle(el) {
            // Do NOT recolor breaker/earth parts to yellow; they are driven by tag colors (red/green).
            if (hasBreakerTag(el)) return;
            var s = el.getAttribute('style');
            if (!s) return;
            var ns = s;
            if (ns.indexOf('stroke:#000000') !== -1) ns = ns.replace(/stroke:#000000/g, 'stroke:' + LINE_COLOR);
            if (ns.indexOf('fill:#000000') !== -1) ns = ns.replace(/fill:#000000/g, 'fill:' + LABEL_COLOR);
            if (ns.indexOf('fill:#ffffff') !== -1) ns = ns.replace(/fill:#ffffff/g, 'fill:' + COMP_BG);
            if (ns !== s) el.setAttribute('style', ns);
        }

        function processList(list, idx, done) {
            var end = Math.min(list.length, idx + CHUNK);
            for (var i = idx; i < end; i++) {
                patchStyle(list[i]);
                processed++;
            }
            if (end >= list.length) return done();
            requestAnimationFrame(function () { processList(list, end, done); });
        }

        processList(strokeEls, 0, function () {
            processList(fillBlackEls, 0, function () {
                processList(fillWhiteEls, 0, function () {
                    console.log('[SLD] SVG recolored (processed=' + processed +
                        ', stroke=' + strokeEls.length +
                        ', fillBlack=' + fillBlackEls.length +
                        ', fillWhite=' + fillWhiteEls.length + ')');
                });
            });
        });
    }

    // ── Build tagMap from data-tag attributes ──
    function readViewBox(svg) {
        if (!svg) return null;
        var vb = svg.getAttribute('viewBox');
        if (vb) {
            var parts = vb.trim().split(/[\s,]+/).map(Number);
            if (parts.length === 4 && parts.every(function (n) { return !isNaN(n); })) {
                return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
            }
        }
        var w = Number(svg.getAttribute('width'));
        var h = Number(svg.getAttribute('height'));
        if (!isNaN(w) && !isNaN(h) && w > 0 && h > 0) return { x: 0, y: 0, w: w, h: h };
        return null;
    }

    function writeViewBox(svg, vb) {
        if (!svg || !vb) return;
        svg.setAttribute('viewBox', vb.x + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h);
    }

    function getSvgPoint(svg, clientX, clientY) {
        var pt = svg.createSVGPoint();
        pt.x = clientX;
        pt.y = clientY;
        var ctm = svg.getScreenCTM();
        if (!ctm) return null;
        return pt.matrixTransform(ctm.inverse());
    }

    function clampViewBox(vb) {
        if (!baseViewBox) return vb;
        var minW = baseViewBox.w / 25;
        // Max zoom-out is the initial view: can't show more area than baseViewBox.
        var maxW = baseViewBox.w;
        var minH = baseViewBox.h / 25;
        var maxH = baseViewBox.h;
        vb.w = Math.max(minW, Math.min(maxW, vb.w));
        vb.h = Math.max(minH, Math.min(maxH, vb.h));

        // When fully zoomed out, lock back to the initial framing so the SVG
        // doesn't drift/move while scrolling out at the limit.
        if (vb.w >= maxW) vb.x = baseViewBox.x;
        if (vb.h >= maxH) vb.y = baseViewBox.y;
        return vb;
    }

    function zoomAt(factor, center) {
        if (!svgEl || !viewBox) return;
        if (!center) center = { x: viewBox.x + viewBox.w / 2, y: viewBox.y + viewBox.h / 2 };

        var newW = viewBox.w * factor;
        var newH = viewBox.h * factor;
        var cx = center.x;
        var cy = center.y;
        var relX = (cx - viewBox.x) / viewBox.w;
        var relY = (cy - viewBox.y) / viewBox.h;

        var next = { x: cx - relX * newW, y: cy - relY * newH, w: newW, h: newH };
        next = clampViewBox(next);
        viewBox = next;
        writeViewBox(svgEl, viewBox);
        // Keep breaker/earth colors stable even if other code/themes touch stroke styles.
        requestAnimationFrame(refreshBreakerColors);
    }

    function resetZoom() {
        if (!svgEl || !baseViewBox) return;
        viewBox = { x: baseViewBox.x, y: baseViewBox.y, w: baseViewBox.w, h: baseViewBox.h };
        writeViewBox(svgEl, viewBox);
        requestAnimationFrame(refreshBreakerColors);
    }

    // ── Resolve K cell number from a right-clicked SVG element ──
    // Returns 1-14 (excluding 8), or null if not on a K cell.
    // Checks two sources as the click may land on a label OR a live-value tspan:
    //   1. data-tag attribute: "Voltage_K03" → 3
    //   2. text content: "K03" static label → 3
    function resolveKCell(target) {
        var el = target;
        for (var depth = 0; depth < 15 && el && el !== document.body; depth++) {
            // Source 1: live-value tag  e.g. data-tag="Current_K07"
            var tag = el.getAttribute && el.getAttribute('data-tag');
            if (tag) {
                var m = tag.match(/_K(\d{1,2})$/i);
                if (m) {
                    var n = parseInt(m[1], 10);
                    if (n >= 1 && n <= 14 && n !== 8) return n;
                }
            }
            // Source 2: static label tspan  e.g. textContent === "K03" or "K3"
            var txt = (el.textContent || '').trim();
            if (/^K\d{1,2}$/.test(txt)) {
                var n = parseInt(txt.slice(1), 10);
                if (n >= 1 && n <= 14 && n !== 8) return n;
            }
            el = el.parentElement;
        }
        return null;
    }

    function initZoom() {
        svgEl = document.querySelector('#sld-container svg');
        if (!svgEl) return;

        // Disable text selection and drag
        svgEl.addEventListener('selectstart', function (ev) { ev.preventDefault(); });
        svgEl.addEventListener('dragstart', function (ev) { ev.preventDefault(); });

        // Right-click on K cell → open EnergyMeter.html?index=N
        svgEl.addEventListener('contextmenu', function (ev) {
            ev.preventDefault();
            var kNum = resolveKCell(ev.target);
            if (kNum === null) return;

            var target = '/EnergyMeter.html?index=' + kNum;
            // Show the loading overlay for 2s, then navigate. The overlay stays
            // visible until the new page replaces it (no hide-then-navigate flash).
            if (window.LoadingOverlay) {
                window.LoadingOverlay.show(0, 'Loading EnergyMeter ' + kNum);
                setTimeout(function () { window.location.href = target; }, 2000);
            } else {
                window.location.href = target;
            }
        });

        baseViewBox = readViewBox(svgEl);
        if (!baseViewBox) return;

        // Apply initial view: zoom in 12% + shift right 5% of width.
        // Uses the original SVG viewBox directly — deterministic on every refresh.
        var zf = 0.88;                        // 0.88 → content 14% bigger
        var rightShift = baseViewBox.w * -0.08;       // 5% of width shifted left
        var cx = baseViewBox.x + baseViewBox.w / 2 + rightShift;
        var cy = baseViewBox.y + baseViewBox.h / 2;
        baseViewBox = {
            x: cx - baseViewBox.w * zf / 2,
            y: cy - baseViewBox.h * zf / 2,
            w: baseViewBox.w * zf,
            h: baseViewBox.h * zf
        };
        viewBox = { x: baseViewBox.x, y: baseViewBox.y, w: baseViewBox.w, h: baseViewBox.h };
        writeViewBox(svgEl, viewBox);

        svgEl.addEventListener('wheel', function (ev) {
            ev.preventDefault();
            var pt = getSvgPoint(svgEl, ev.clientX, ev.clientY);
            var factor = ev.deltaY > 0 ? 1.12 : 0.88;
            zoomAt(factor, pt);
        }, { passive: false });

        // Middle-button double-click → reset zoom & pan
        var lastMiddleClick = 0;
        svgEl.addEventListener('pointerdown', function (ev) {
            if (ev.button !== 1) return;
            ev.preventDefault();
            var now = Date.now();
            if (now - lastMiddleClick < 350) {
                resetZoom();
                lastMiddleClick = 0;
            } else {
                lastMiddleClick = now;
            }
        });
        // Prevent browser auto-scroll cursor on middle click
        svgEl.addEventListener('mousedown', function (ev) {
            if (ev.button === 1) ev.preventDefault();
        });

        svgEl.addEventListener('pointerdown', function (ev) {
            if (!viewBox) return;
            // Only handle left button — right-click must reach contextmenu handler
            if (ev.button !== undefined && ev.button !== 0) return;
            ev.preventDefault();
            isPanning = true;
            svgEl.classList.add('is-panning');
            var rect = svgEl.getBoundingClientRect();
            panStart = {
                cx: ev.clientX,
                cy: ev.clientY,
                vx: viewBox.x,
                vy: viewBox.y,
                vw: viewBox.w,
                vh: viewBox.h,
                rw: rect.width || 1,
                rh: rect.height || 1
            };
            panPending = { cx: ev.clientX, cy: ev.clientY };
            try { svgEl.setPointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
        });

        svgEl.addEventListener('pointermove', function (ev) {
            // Dynamic cursor: context-menu over K cells, grab elsewhere
            if (!isPanning) {
                svgEl.style.cursor = resolveKCell(ev.target) !== null ? 'context-menu' : '';
            }
            if (!isPanning || !panStart || !viewBox) return;
            panPending = { cx: ev.clientX, cy: ev.clientY };
            if (panRaf) return;
            panRaf = requestAnimationFrame(function () {
                panRaf = 0;
                if (!isPanning || !panStart || !panPending || !viewBox) return;
                // Convert pixel deltas to viewBox units (stable — avoids CTM feedback jitter)
                var scaleX = panStart.vw / (panStart.rw || 1);
                var scaleY = panStart.vh / (panStart.rh || 1);
                var dxPx = panPending.cx - panStart.cx;
                var dyPx = panPending.cy - panStart.cy;
                viewBox.x = panStart.vx - dxPx * scaleX;
                viewBox.y = panStart.vy - dyPx * scaleY;
                writeViewBox(svgEl, viewBox);
            });
        });

        function endPan() {
            isPanning = false;
            panStart = null;
            panPending = null;
            if (panRaf) { cancelAnimationFrame(panRaf); panRaf = 0; }
            if (svgEl) svgEl.classList.remove('is-panning');
        }

        svgEl.addEventListener('pointerup', endPan);
        svgEl.addEventListener('pointercancel', endPan);

        window.addEventListener('keydown', function (ev) {
            if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA')) return;
            if (ev.key === '+' || ev.key === '=') zoomAt(0.85);
            else if (ev.key === '-' || ev.key === '_') zoomAt(1.15);
            else if (ev.key === '0') resetZoom();
        });

        console.log('[SLD] Zoom/Pan enabled');
    }

    function buildTagMap() {
        var els = document.querySelectorAll('tspan[data-tag]');
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            var tag = el.getAttribute('data-tag');
            if (!tag) continue;
            if (!tagMap[tag]) tagMap[tag] = [];
            tagMap[tag].push(el);

        }
        console.log('[SLD] tagMap built: ' + Object.keys(tagMap).length +
            ' tags, ' + els.length + ' elements');
    }

    function buildBreakerMap() {
        var els = document.querySelectorAll('[data-breaker-tag]');
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            var tag = el.getAttribute('data-breaker-tag');
            if (!tag) continue;
            if (!breakerMap[tag]) breakerMap[tag] = [];
            breakerMap[tag].push(el);
        }
        console.log('[SLD] breakerMap built: ' + Object.keys(breakerMap).length +
            ' tags, ' + els.length + ' elements');
    }

    function buildClosedIndicatorMap() {
        var found = 0;
        for (var tag in BREAKER_CLOSED_INDICATOR_IDS) {
            if (!Object.prototype.hasOwnProperty.call(BREAKER_CLOSED_INDICATOR_IDS, tag)) continue;
            var id = BREAKER_CLOSED_INDICATOR_IDS[tag];
            var el = document.getElementById(id);
            if (el) {
                closedIndicatorMap[tag] = el;
                found++;
            } else {
                console.warn('[SLD] closed-indicator element not found: ' + id + ' for ' + tag);
            }
        }
        console.log('[SLD] closedIndicatorMap built: ' + found + ' / ' +
            Object.keys(BREAKER_CLOSED_INDICATOR_IDS).length);
    }

    function updateClosedIndicator(tagName, value) {
        var el = closedIndicatorMap[tagName];
        if (!el) return;
        var v = normalizeBreakerValue(value);
        // value=1 → breaker closed → show the closed-state marker
        // value=0 → breaker open   → hide it
        el.style.display = (v === 1) ? '' : 'none';
    }

    function buildEarthIndicatorMap() {
        var found = 0;
        for (var tag in EARTH_CLOSED_INDICATOR_IDS) {
            if (!Object.prototype.hasOwnProperty.call(EARTH_CLOSED_INDICATOR_IDS, tag)) continue;
            var id = EARTH_CLOSED_INDICATOR_IDS[tag];
            var el = document.getElementById(id);
            if (el) {
                earthIndicatorMap[tag] = el;
                found++;
            } else {
                console.warn('[SLD] earth-indicator element not found: ' + id + ' for ' + tag);
            }
        }
        console.log('[SLD] earthIndicatorMap built: ' + found + ' / ' +
            Object.keys(EARTH_CLOSED_INDICATOR_IDS).length);
    }

    function updateEarthIndicator(tagName, value) {
        var el = earthIndicatorMap[tagName];
        if (!el) return;
        var v = normalizeBreakerValue(value);
        el.style.display = (v === 1) ? '' : 'none';
    }

    // ── Update value in SVG ──
    function updateValue(tagName, value) {
        var elements = tagMap[tagName];
        if (!elements || elements.length === 0) return;

        var display;
        if (value === null || value === undefined || value === '') {
            display = DEFAULT_VALUE;
        } else if (typeof value === 'number') {
            display = value.toFixed(1);
        } else {
            display = String(value);
        }

        for (var i = 0; i < elements.length; i++) {
            try {
                var el = elements[i];
                // FIX: remove per-character x positions
                // Original x="0 6.08 9.1" breaks when text length changes.
                // Single x="0" lets SVG auto-space characters by font metrics.
                el.setAttribute('x', '0');
                el.textContent = display;
            } catch (e) {
                console.warn('[SLD] update error', tagName, e);
            }
        }
    }

    function normalizeBreakerValue(value) {
        if (value === null || value === undefined || value === '') return null;
        if (typeof value === 'boolean') return value ? 1 : 0;
        if (typeof value === 'number') return value ? 1 : 0;
        var s = String(value).trim().toLowerCase();
        if (s === '1' || s === 'true' || s === 'on' || s === 'closed' || s === 'close') return 1;
        if (s === '0' || s === 'false' || s === 'off' || s === 'open') return 0;
        var n = Number(s);
        if (!isNaN(n)) return n ? 1 : 0;
        return null;
    }

    function applyStrokeColor(el, color) {
        if (!el) return;
        try {
            el.style.stroke = color;
            // Some SVG exports set color via style="stroke:..."; explicitly overriding is safest.
            if (el.getAttribute && el.getAttribute('style')) {
                var s = el.getAttribute('style');
                if (s && s.indexOf('stroke:') !== -1) {
                    el.setAttribute('style', s.replace(/stroke:[^;]+/g, 'stroke:' + color));
                }
            }
        } catch (_) { /* ignore */ }
    }

    function updateBreaker(tagName, value) {
        var elements = breakerMap[tagName];
        if (!elements || elements.length === 0) return;

        var v = normalizeBreakerValue(value);
        // Semantics requested: value=1 → green, value=0 → red (for both breaker and earth tags).
        var color = (v === 1) ? BREAKER_CLOSED_COLOR : BREAKER_OPEN_COLOR;

        for (var i = 0; i < elements.length; i++) {
            var el = elements[i];
            try {
                // If this is a group/container, color all drawable descendants.
                if (el.querySelectorAll) {
                    var kids = el.querySelectorAll('path,line,polyline,polygon,circle,ellipse,rect');
                    if (kids && kids.length) {
                        for (var k = 0; k < kids.length; k++) applyStrokeColor(kids[k], color);
                        continue;
                    }
                }
                applyStrokeColor(el, color);
            } catch (e) {
                console.warn('[SLD] breaker update error', tagName, e);
            }
        }
    }

    function updateAllBreakersFromLastTags() {
        if (!window.__sldLastTags) return;
        try {
            var names = Object.keys(breakerMap);
            for (var i = 0; i < names.length; i++) {
                var name = names[i];
                if (Object.prototype.hasOwnProperty.call(window.__sldLastTags, name)) {
                    updateBreaker(name, window.__sldLastTags[name]);
                }
            }
        } catch (_) { /* ignore */ }
    }

    function refreshBreakerColors() {
        try {
            var names = Object.keys(breakerMap);
            for (var i = 0; i < names.length; i++) {
                var name = names[i];
                // Use latest tag value if available; otherwise skip.
                if (window.__sldLastTags && Object.prototype.hasOwnProperty.call(window.__sldLastTags, name)) {
                    updateBreaker(name, window.__sldLastTags[name]);
                }
            }
        } catch (_) { /* ignore */ }
    }

    // ── Stale monitor ──
    function resetStaleTimer() {
        lastUpdate = Date.now();
        clearTimeout(staleTimer);
        staleTimer = setTimeout(function () {
            if (Date.now() - lastUpdate >= STALE_TIMEOUT) {
                var els = document.querySelectorAll('tspan[data-tag]');
                for (var i = 0; i < els.length; i++) {
                    els[i].style.fill = '#999';
                    els[i].style.opacity = '0.5';
                }
            }
        }, STALE_TIMEOUT);
    }

    function clearStale() {
        var els = document.querySelectorAll('tspan[data-tag]');
        for (var i = 0; i < els.length; i++) {
            els[i].style.fill = '';
            els[i].style.opacity = '';
        }
    }

    // ── Server URL (same logic as main.js) ──
    function getServerUrl() {
        var host = window.location.hostname || '192.168.1.2';
        return window.location.protocol + '//' + host + ':5000';
    }

    // ── Socket.IO connection ──
    function connect() {
        try {
            var url = getServerUrl();
            console.log('[SLD] Connecting to ' + url);

            socket = io(url, {
                transports: ['websocket', 'polling'],
                reconnection: true,
                reconnectionAttempts: Infinity,
                reconnectionDelay: 3000,
                reconnectionDelayMax: 10000,
                timeout: 20000
            });

            socket.on('connect', function () {
                connected = true;
                console.log('[SLD] Connected  id=' + socket.id);
                socket.emit('subscribe', 'sld');
            });

            socket.on('disconnect', function (reason) {
                connected = false;
                console.warn('[SLD] Disconnected: ' + reason);
            });

            socket.on('connect_error', function (err) {
                console.warn('[SLD] Connection error: ' + (err && err.message ? err.message : err));
            });

            socket.io.on('reconnect_attempt', function (attempt) {
                console.log('[SLD] Reconnect attempt #' + attempt);
            });

            socket.io.on('reconnect', function () {
                console.log('[SLD] Reconnected');
            });

            // ── Init ──
            socket.on('init', function (data) {
                try {
                    console.log('[SLD] init received');
                    if (data && data.tags && typeof data.tags === 'object') {
                        // stash last values for redraws (e.g. after recolor)
                        window.__sldLastTags = data.tags;
                        var matched = 0;
                        var names = Object.keys(data.tags);
                        for (var i = 0; i < names.length; i++) {
                            var n = names[i];
                            if (tagMap[n]) updateValue(n, data.tags[n]);
                            if (breakerMap[n]) {
                                updateBreaker(n, data.tags[n]);
                                matched++;
                            }
                            if (closedIndicatorMap[n]) updateClosedIndicator(n, data.tags[n]);
                            if (earthIndicatorMap[n]) updateEarthIndicator(n, data.tags[n]);
                        }
                        console.log('[SLD] init matched ' + matched + '/' + names.length + ' tags');
                    }
                    clearStale();
                    resetStaleTimer();
                } catch (e) {
                    console.error('[SLD] init error:', e);
                }
            });

            // ── Live updates (array) ──
            socket.on('tag_updates', function (updates) {
                try {
                    if (!updates || !updates.length) return;
                    var matched = 0;
                    for (var i = 0; i < updates.length; i++) {
                        var u = updates[i];
                        if (!u || !u.tag_name) continue;
                        if (!window.__sldLastTags) window.__sldLastTags = {};
                        window.__sldLastTags[u.tag_name] = u.value;
                        if (tagMap[u.tag_name]) { updateValue(u.tag_name, u.value); matched++; }
                        if (breakerMap[u.tag_name]) { updateBreaker(u.tag_name, u.value); matched++; }
                        if (closedIndicatorMap[u.tag_name]) updateClosedIndicator(u.tag_name, u.value);
                        if (earthIndicatorMap[u.tag_name]) updateEarthIndicator(u.tag_name, u.value);
                    }
                    if (matched > 0) {
                        clearStale();
                        resetStaleTimer();
                    }
                } catch (e) {
                    console.error('[SLD] tag_updates error:', e);
                }
            });

            // ── Single update ──
            socket.on('tag_update', function (update) {
                try {
                    if (update && update.tag_name) {
                        if (!window.__sldLastTags) window.__sldLastTags = {};
                        window.__sldLastTags[update.tag_name] = update.value;
                        if (tagMap[update.tag_name]) updateValue(update.tag_name, update.value);
                        if (breakerMap[update.tag_name]) updateBreaker(update.tag_name, update.value);
                        if (closedIndicatorMap[update.tag_name]) updateClosedIndicator(update.tag_name, update.value);
                        if (earthIndicatorMap[update.tag_name]) updateEarthIndicator(update.tag_name, update.value);
                        clearStale();
                        resetStaleTimer();
                    }
                } catch (e) {
                    console.error('[SLD] tag_update error:', e);
                }
            });

        } catch (e) {
            console.error('[SLD] connect failed:', e);
        }
    }

    // ── Init ──
    function init() {
        console.log('[SLD] Initializing...');
        initZoom();
        buildTagMap();
        buildBreakerMap();
        buildClosedIndicatorMap();
        buildEarthIndicatorMap();
        connect();
        // Run recolor after we connect so it won't delay live updates on slow machines,
        // then re-apply breaker/earth colors so zoom/pan never leaves them in default theme colors.
        requestAnimationFrame(function () {
            recolorSVG();
            // Re-apply after recolor batch changes styles.
            setTimeout(refreshBreakerColors, 0);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
