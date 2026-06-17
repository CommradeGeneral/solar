/* ═══════════════════════════════════════════════
   SOLAR SYSTEM MONITOR — PING-based connection status
   ═══════════════════════════════════════════════
   Every device box in the SVG shows a NOSIGNAL icon (and dims/blurs) when its
   IP fails to PING. This is fully independent of the SCADA (Modbus/IEC) server.

   Source of truth: the standalone ping-server (server/ping-server.js), which
   reads config/ping_devices.xlsx and pings each device's IP.
     GET http://<host>:5001/api/ping  → { data: [{ group_id, name, ip, up }] }

   ┌─────────────────────────────────────────────────────────────────┐
   │  WHERE TO CONFIGURE DEVICES:  config/ping_devices.xlsx            │
   │    • Sheet "Devices":  group_id | name | ip_address | enabled     │
   │    • group_id = the SVG box id (already filled for every box).    │
   │    • ip_address = the device IP to ping. BLANK = not monitored.   │
   │    • The page is fully data-driven from that file — no device     │
   │      list is hard-coded here.                                     │
   └─────────────────────────────────────────────────────────────────┘
*/

(function () {
  'use strict';

  // Where the standalone ping-server is reachable. Uses the same host the page
  // was opened from, on the ping-server port.
  const PING_PORT = 5001;
  const PING_URL = `${location.protocol}//${location.hostname}:${PING_PORT}/api/ping`;

  // How often to refresh status from the ping-server.
  const POLL_MS = 3000;
  // Consecutive failed requests before we treat the ping-server as down and
  // flag every known box (avoids flicker on a single hiccup).
  const MAX_FAILS = 2;

  // State (keyed by SVG group id)
  const offlineGroups = new Set();     // groups currently showing NOSIGNAL
  const overlayElements = {};          // group_id -> overlay <g>
  const knownGroups = new Set();       // every group_id the server has reported
  let fails = 0;

  // ─── Initialize ───
  function init() {
    injectSVGFilters();
    pollPing();
    setInterval(pollPing, POLL_MS);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();   // DOM already parsed (script at end of body) → run now
  }

  // ─── Poll the ping-server and reconcile every box ───
  async function pollPing() {
    let list = null;
    try {
      const res = await fetch(PING_URL, { cache: 'no-store' });
      const json = await res.json();
      fails = 0;
      list = Array.isArray(json.data) ? json.data : [];
    } catch (e) {
      // ping-server unreachable → only flag everything once we are sure.
      fails++;
      console.warn(`[solar] cannot reach ping-server at ${PING_URL} (fail ${fails}):`, e.message);
      if (fails < MAX_FAILS) return;            // transient blip → keep last state
      knownGroups.forEach(g => safe(setOffline, g));  // mark all known boxes NOSIGNAL
      return;
    }

    const seen = new Set();
    let offline = 0, notFound = 0;
    for (const d of list) {
      const g = String(d.group_id || '');
      if (!g) continue;
      seen.add(g);
      knownGroups.add(g);
      if (!document.getElementById(g)) notFound++;
      if (d.up === false) { offline++; safe(setOffline, g); }
      else safe(setOnline, g);
    }
    // A box that dropped out of the list (ip blanked / row removed) → clear it.
    knownGroups.forEach(g => { if (!seen.has(g) && offlineGroups.has(g)) safe(setOnline, g); });
    console.debug(`[solar] ping ok: ${list.length} devices, ${offline} offline${notFound ? `, ${notFound} group_id(s) not found in SVG` : ''}`);
  }

  // Run a per-box update without letting one failure stop the whole sweep.
  function safe(fn, g) {
    try { fn(g); } catch (e) { console.error(`[solar] error updating ${g}:`, e); }
  }

  // ─── Inject SVG blur filter (used to dim disconnected devices) ───
  function injectSVGFilters() {
    const svg = document.querySelector('svg');
    if (!svg) return;

    const defs = svg.querySelector('defs') || document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    if (!defs.parentNode) svg.insertBefore(defs, svg.firstChild);

    const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
    filter.setAttribute('id', 'blur-filter');
    filter.setAttribute('x', '-20%');
    filter.setAttribute('y', '-20%');
    filter.setAttribute('width', '140%');
    filter.setAttribute('height', '140%');

    const blur = document.createElementNS('http://www.w3.org/2000/svg', 'feGaussianBlur');
    blur.setAttribute('stdDeviation', '2');
    filter.appendChild(blur);
    defs.appendChild(filter);
  }

  // ─── Get Bounding Box of a Device Group ───
  function getDeviceBBox(groupId) {
    const el = document.getElementById(groupId);
    if (!el) return null;
    try {
      return el.getBBox();
    } catch {
      return null;
    }
  }

  // ─── Mark a box Disconnected (NOSIGNAL) ───
  function positionHtmlOverlay(groupId, overlay) {
    const groupEl = document.getElementById(groupId);
    const container = document.querySelector('.svg-container');
    if (!groupEl || !container || !overlay) return false;

    const deviceRect = groupEl.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const availableSize = Math.min(deviceRect.width, deviceRect.height);
    if (availableSize <= 0) return false;

    const iconSize = Math.min(Math.max(availableSize * 0.55, 28), 72);
    const centerX = deviceRect.left - containerRect.left + container.scrollLeft + deviceRect.width / 2;
    const centerY = deviceRect.top - containerRect.top + container.scrollTop + deviceRect.height / 2;
    overlay.style.left = `${centerX - iconSize / 2}px`;
    overlay.style.top = `${centerY - iconSize / 2}px`;
    overlay.style.width = `${iconSize}px`;
    overlay.style.height = `${iconSize}px`;
    return true;
  }

  function setOffline(groupId) {
    const groupEl = document.getElementById(groupId);
    if (!groupEl) return;                        // unknown id in the Excel → ignore

    offlineGroups.add(groupId);
    groupEl.classList.add('disconnected');
    groupEl.classList.remove('connected');

    if (overlayElements[groupId]) {
      positionHtmlOverlay(groupId, overlayElements[groupId]);
      return;
    }

    const container = document.querySelector('.svg-container');
    if (!container) return;
    const htmlImage = document.createElement('img');
    htmlImage.src = '/images/nosignal.png';
    htmlImage.alt = '';
    htmlImage.className = 'nosignal-icon nosignal-html-icon';
    htmlImage.dataset.overlayFor = groupId;
    if (!positionHtmlOverlay(groupId, htmlImage)) return;
    container.appendChild(htmlImage);
    overlayElements[groupId] = htmlImage;
    return;

    // The device can be marked offline before its SVG transform is ready.
    // Keep retrying on later polls until the overlay has actually been added.
    if (overlayElements[groupId]) return;

    // Overlay the no-signal icon, centred on the device
    const bbox = getDeviceBBox(groupId);
    if (bbox) {
      const svg = document.querySelector('svg');
      const overlayGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      overlayGroup.classList.add('device-overlay-group');
      overlayGroup.setAttribute('data-overlay-for', groupId);

      const ctm = groupEl.getCTM();
      const svgCtm = svg.getCTM();
      if (ctm && svgCtm) {
        const relMatrix = svgCtm.inverse().multiply(ctm);
        const corners = [
          [bbox.x, bbox.y],
          [bbox.x + bbox.width, bbox.y],
          [bbox.x, bbox.y + bbox.height],
          [bbox.x + bbox.width, bbox.y + bbox.height]
        ].map(([pointX, pointY]) => {
          const point = svg.createSVGPoint();
          point.x = pointX;
          point.y = pointY;
          return point.matrixTransform(relMatrix);
        });

        const xs = corners.map(point => point.x);
        const ys = corners.map(point => point.y);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        const w = Math.max(...xs) - x;
        const h = Math.max(...ys) - y;

        const pad = 4;
        const maxIconSize = Math.max(0, Math.min(w - pad * 2, h - pad * 2));
        const iconSize = Math.min(Math.max(maxIconSize * 0.6, 16), 48, maxIconSize);
        if (iconSize <= 0) return;
        const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
        img.setAttribute('href', '../images/nosignal.png');
        img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '../images/nosignal.png');
        img.setAttribute('x', x + (w - iconSize) / 2);
        img.setAttribute('y', y + (h - iconSize) / 2);
        img.setAttribute('width', iconSize);
        img.setAttribute('height', iconSize);
        img.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        img.classList.add('nosignal-icon');
        overlayGroup.appendChild(img);

        svg.appendChild(overlayGroup);
        overlayElements[groupId] = overlayGroup;
      }
    }
  }

  // ─── Mark a box Reconnected (clear NOSIGNAL) ───
  function setOnline(groupId) {
    if (!offlineGroups.has(groupId)) return;     // already clear

    const groupEl = document.getElementById(groupId);
    if (groupEl) {
      groupEl.classList.remove('disconnected');
      groupEl.classList.add('connected');
    }

    if (overlayElements[groupId]) {
      overlayElements[groupId].remove();
      delete overlayElements[groupId];
    }

    offlineGroups.delete(groupId);
  }

  // Keep the NOSIGNAL icons glued to their devices whenever the layout shifts —
  // menu open/close, scrolling, or window resize — instead of waiting for the
  // next poll (which caused the ~1s lag).
  function repositionAll() {
    offlineGroups.forEach(groupId => {
      const ov = overlayElements[groupId];
      if (ov) positionHtmlOverlay(groupId, ov);
    });
  }

  const containerEl = document.querySelector('.svg-container');
  const svgEl = document.querySelector('svg');

  window.addEventListener('resize', repositionAll);
  if (containerEl) containerEl.addEventListener('scroll', repositionAll, { passive: true });

  // The menu toggle animates .svg-container's padding-left over ~0.28s, which
  // continuously resizes the inner <svg>. A ResizeObserver on the <svg> fires on
  // every frame of that animation, so the icons follow it in real time (no lag).
  if (svgEl && 'ResizeObserver' in window) {
    new ResizeObserver(repositionAll).observe(svgEl);
  }
})();
