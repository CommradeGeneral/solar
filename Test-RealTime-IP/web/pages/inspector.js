/* global DOMParser */

(function () {
  'use strict';

  const DEFAULT_SRC = 'solar.html';

  function getConfigFromUrl() {
    const params = new URLSearchParams(window.location.search || '');
    const src = (params.get('src') || DEFAULT_SRC).trim();
    const mode = (params.get('mode') || '').trim().toLowerCase(); // '' | 'sld'

    const maxDepthRaw = params.get('depth');
    const maxDepth = Number.isFinite(Number(maxDepthRaw)) ? Math.max(0, Number(maxDepthRaw)) : 3;

    return { src, mode, maxDepth };
  }

  const CONFIG = getConfigFromUrl();
  const SOURCE_PAGE = CONFIG.src || DEFAULT_SRC;

  const searchEl = document.getElementById('search');
  const rowsEl = document.getElementById('rows');
  const previewEl = document.getElementById('preview');
  const metaEl = document.getElementById('meta');
  const selectedNameEl = document.getElementById('selectedName');

  const zoomInBtn = document.getElementById('zoomIn');
  const zoomOutBtn = document.getElementById('zoomOut');
  const zoomResetBtn = document.getElementById('zoomReset');

  let allItems = [];
  let activeId = null;
  let injectedSvg = null;
  let highlightRect = null;
  let lastLoadedSvgMeta = null;

  let zoomScale = 1;
  let panX = 0;
  let panY = 0;
  let isPanning = false;
  let didPan = false;
  let panStartX = 0;
  let panStartY = 0;
  let panOriginX = 0;
  let panOriginY = 0;

  function textOf(el) {
    if (!el) return '';
    return (el.textContent || '').trim();
  }

  function getTitleFor(el) {
    return textOf(el.querySelector(':scope > title')) || textOf(el.querySelector('title'));
  }

  function getDescFor(el) {
    return textOf(el.querySelector(':scope > desc')) || textOf(el.querySelector('desc'));
  }

  function normalize(s) {
    return (s || '').toString().toLowerCase();
  }

  function getDepthFromSvgRoot(el, svgRoot) {
    let depth = 0;
    let cur = el;
    while (cur && cur !== svgRoot) {
      cur = cur.parentNode;
      if (cur && cur !== svgRoot) depth += 1;
    }
    return depth;
  }

  function formatBaseMeta(svg, itemsListed) {
    const viewBox = svg.getAttribute('viewBox') || '(none)';
    const width = svg.getAttribute('width') || '(none)';
    const height = svg.getAttribute('height') || '(none)';

    const totalNodes = svg.querySelectorAll('*').length;

    return (
      `source: ${SOURCE_PAGE}\n` +
      `mode: ${CONFIG.mode || 'default'}\n` +
      `svg viewBox: ${viewBox}\n` +
      `svg size: ${width} × ${height}\n` +
      `nodes: ${totalNodes} (listed: ${itemsListed})`
    );
  }

  function getSelectedMeta(el) {
    if (!el) return '';
    const id = el.getAttribute && el.getAttribute('id');
    const cls = el.getAttribute && el.getAttribute('class');
    const title = getTitleFor(el);

    const parts = [];
    parts.push(`\n\nselected: <${(el.tagName || '').toLowerCase()}>`);
    if (id) parts.push(`id: ${id}`);
    if (cls) parts.push(`class: ${cls}`);
    if (title) parts.push(`title: ${title}`);

    const chain = [];
    let cur = el;
    let hops = 0;
    while (cur && cur !== injectedSvg && hops < 5) {
      if (cur.nodeType === 1) {
        const curId = cur.getAttribute && cur.getAttribute('id');
        chain.push(`${cur.tagName.toLowerCase()}${curId ? `#${curId}` : ''}`);
      }
      cur = cur.parentNode;
      hops += 1;
    }
    if (chain.length) parts.push(`path: ${chain.reverse().join(' > ')}`);

    return parts.join('\n');
  }

  function rebuildMeta(selectedEl) {
    if (!lastLoadedSvgMeta) return;
    metaEl.textContent = lastLoadedSvgMeta + getSelectedMeta(selectedEl);
  }

  function updateSelectedName(el) {
    if (!selectedNameEl) return;
    if (!el) {
      selectedNameEl.textContent = 'selected: (none)';
      return;
    }

    const id = (el.getAttribute && el.getAttribute('id')) || '';
    const title = getTitleFor(el);
    const tag = (el.tagName || '').toLowerCase();

    const name = title || id || '(no id/title)';
    selectedNameEl.textContent = `selected: ${name}\n<${tag}>${id ? `  id=${id}` : ''}`;
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function applyViewTransform() {
    if (!injectedSvg) return;
    const s = clamp(zoomScale, 0.2, 8);
    zoomScale = s;
    injectedSvg.style.transformOrigin = '0 0';
    injectedSvg.style.transform = `translate(${panX}px, ${panY}px) scale(${s})`;
  }

  function setZoom(nextScale, centerClientX, centerClientY) {
    if (!injectedSvg) return;

    const prevScale = zoomScale;
    const s = clamp(nextScale, 0.2, 8);
    if (s === prevScale) return;

    // Zoom around a point in the preview container (client coords -> local coords)
    const rect = previewEl.getBoundingClientRect();
    const cx = typeof centerClientX === 'number' ? centerClientX : rect.left + rect.width / 2;
    const cy = typeof centerClientY === 'number' ? centerClientY : rect.top + rect.height / 2;

    const localX = cx - rect.left;
    const localY = cy - rect.top;

    // Keep the visual point stable when scaling: adjust pan
    const k = s / prevScale;
    panX = localX - (localX - panX) * k;
    panY = localY - (localY - panY) * k;

    zoomScale = s;
    applyViewTransform();
  }

  function zoomIn() {
    setZoom(zoomScale * 1.15);
  }

  function zoomOut() {
    setZoom(zoomScale / 1.15);
  }

  function zoomReset() {
    zoomScale = 1;
    panX = 0;
    panY = 0;
    applyViewTransform();
  }

  function clearRows() {
    while (rowsEl.firstChild) rowsEl.removeChild(rowsEl.firstChild);
  }

  function renderRows(items) {
    clearRows();

    items.forEach((item, idx) => {
      const tr = document.createElement('tr');
      tr.dataset.svgId = item.id || '';
      if (item.id && item.id === activeId) tr.classList.add('active');

      const tdIndex = document.createElement('td');
      tdIndex.textContent = String(idx + 1);

      const tdTag = document.createElement('td');
      if (typeof item.depth === 'number' && item.depth > 0) {
        tdTag.textContent = `${'·'.repeat(Math.min(6, item.depth))}${item.tag}`;
      } else {
        tdTag.textContent = item.tag;
      }

      const tdId = document.createElement('td');
      tdId.textContent = item.id || '';

      const tdTitle = document.createElement('td');
      tdTitle.textContent = item.title || item.desc || item.hint || '';

      tr.appendChild(tdIndex);
      tr.appendChild(tdTag);
      tr.appendChild(tdId);
      tr.appendChild(tdTitle);

      tr.addEventListener('click', () => {
        setActive(item.id);
      });

      rowsEl.appendChild(tr);
    });
  }

  function getElementInSvg(svgId) {
    if (!svgId || !injectedSvg) return null;
    try {
      return injectedSvg.getElementById(svgId);
    } catch {
      return injectedSvg.querySelector(`#${CSS.escape(svgId)}`);
    }
  }

  function ensureHighlightRect(svg) {
    if (highlightRect && highlightRect.ownerSVGElement === svg) return highlightRect;

    highlightRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    highlightRect.setAttribute('class', 'inspector-highlight-rect');
    highlightRect.setAttribute('x', '0');
    highlightRect.setAttribute('y', '0');
    highlightRect.setAttribute('width', '0');
    highlightRect.setAttribute('height', '0');
    highlightRect.style.display = 'none';
    svg.appendChild(highlightRect);
    return highlightRect;
  }

  function setHighlightFor(el) {
    if (!injectedSvg) return;
    const rect = ensureHighlightRect(injectedSvg);

    if (!el) {
      rect.style.display = 'none';
      return;
    }

    let bbox;
    try {
      bbox = el.getBBox();
    } catch {
      rect.style.display = 'none';
      return;
    }

    const ctm = el.getCTM();
    const svgCtm = injectedSvg.getCTM();
    if (!ctm || !svgCtm) {
      rect.style.display = 'none';
      return;
    }

    const p1 = injectedSvg.createSVGPoint();
    p1.x = bbox.x;
    p1.y = bbox.y;

    const p2 = injectedSvg.createSVGPoint();
    p2.x = bbox.x + bbox.width;
    p2.y = bbox.y + bbox.height;

    const relMatrix = svgCtm.inverse().multiply(ctm);
    const tp1 = p1.matrixTransform(relMatrix);
    const tp2 = p2.matrixTransform(relMatrix);

    const x = Math.min(tp1.x, tp2.x);
    const y = Math.min(tp1.y, tp2.y);
    const w = Math.abs(tp2.x - tp1.x);
    const h = Math.abs(tp2.y - tp1.y);

    const pad = 3;
    rect.setAttribute('x', String(x - pad));
    rect.setAttribute('y', String(y - pad));
    rect.setAttribute('width', String(w + pad * 2));
    rect.setAttribute('height', String(h + pad * 2));
    rect.style.display = '';
  }

  function setActive(svgId) {
    activeId = svgId || null;

    rowsEl.querySelectorAll('tr.active').forEach((tr) => tr.classList.remove('active'));
    if (svgId) {
      const row = rowsEl.querySelector(`tr[data-svg-id="${CSS.escape(svgId)}"]`);
      if (row) {
        row.classList.add('active');
        try {
          row.scrollIntoView({ block: 'nearest' });
        } catch {
          // ignore
        }
      }
    }

    const el = getElementInSvg(svgId);
    setHighlightFor(el);
    rebuildMeta(el);
    updateSelectedName(el);

    if (el) {
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      } catch {
        // ignore
      }
    }
  }

  function findInspectableFromEventTarget(target) {
    if (!target || !injectedSvg) return null;
    if (highlightRect && target === highlightRect) return null;

    let el = target;
    while (el && el !== injectedSvg) {
      if (el.nodeType !== 1) {
        el = el.parentNode;
        continue;
      }

      const id = el.getAttribute && el.getAttribute('id');
      const title = getTitleFor(el);
      if (id || title) return el;
      el = el.parentNode;
    }

    return null;
  }

  function setActiveFromElement(el) {
    if (!el) return;
    const id = el.getAttribute('id');
    if (id) {
      setActive(id);
      return;
    }

    let cur = el.parentNode;
    while (cur && cur !== injectedSvg) {
      const pid = cur.getAttribute && cur.getAttribute('id');
      if (pid) {
        setActive(pid);
        return;
      }
      cur = cur.parentNode;
    }
  }

  function applySearch() {
    const q = normalize(searchEl.value);
    if (!q) {
      renderRows(allItems);
      return;
    }

    const filtered = allItems.filter((item) => {
      const hay =
        `${item.tag} ${item.id || ''} ${item.className || ''} ${item.title || ''} ${item.desc || ''} ${
          item.hint || ''
        }`.toLowerCase();
      return hay.includes(q);
    });
    renderRows(filtered);
  }

  function isInDefs(el) {
    if (!el || !el.closest) return false;
    return Boolean(el.closest('defs'));
  }

  function buildItems(svg, mode) {
    const nodes = Array.from(svg.querySelectorAll('*'));

    if (mode === 'sld') {
      const maxDepth = CONFIG.maxDepth;
      return nodes
        .filter((el) => !isInDefs(el))
        .filter((el) => {
          if (!el.tagName || el.tagName.toLowerCase() !== 'g') return false;
          const id = el.getAttribute && el.getAttribute('id');
          if (!id) return false;
          const depth = getDepthFromSvgRoot(el, svg);
          return depth <= maxDepth;
        })
        .map((el) => {
          const title = getTitleFor(el);
          const desc = getDescFor(el);
          const id = el.getAttribute('id') || '';
          const className = el.getAttribute('class') || '';
          const depth = getDepthFromSvgRoot(el, svg);
          const childCount = el.querySelectorAll('*').length;
          const hint = childCount ? `children: ${childCount}` : '';
          return {
            tag: el.tagName.toLowerCase(),
            id,
            className,
            title,
            desc,
            hint,
            depth,
            childCount,
          };
        })
        .sort((a, b) => {
          if (a.depth !== b.depth) return a.depth - b.depth;
          const aIsAuto = /^g\\d+$/i.test(a.id);
          const bIsAuto = /^g\\d+$/i.test(b.id);
          if (aIsAuto !== bIsAuto) return aIsAuto ? 1 : -1;
          return (a.title || a.id).localeCompare(b.title || b.id);
        });
    }

    return nodes
      .map((el) => {
        const title = getTitleFor(el);
        const desc = getDescFor(el);
        const id = el.getAttribute('id') || '';
        const className = el.getAttribute('class') || '';

        return {
          tag: el.tagName.toLowerCase(),
          id,
          className,
          title,
          desc,
        };
      })
      .filter((item) => item.title || item.id)
      .sort((a, b) => {
        const aIsGroup = a.tag === 'g';
        const bIsGroup = b.tag === 'g';
        if (aIsGroup !== bIsGroup) return aIsGroup ? -1 : 1;
        return (a.title || a.id).localeCompare(b.title || b.id);
      });
  }

  async function loadSvg() {
    const res = await fetch(SOURCE_PAGE, { cache: 'no-store' });
    const text = await res.text();

    const doc = new DOMParser().parseFromString(text, 'text/html');
    const svg = doc.querySelector('svg');
    if (!svg) throw new Error(`No <svg> found in ${SOURCE_PAGE}`);

    previewEl.innerHTML = '';
    previewEl.appendChild(document.importNode(svg, true));
    injectedSvg = previewEl.querySelector('svg');

    // Enable CSS transforms for zoom/pan.
    if (injectedSvg) {
      injectedSvg.style.willChange = 'transform';
      zoomReset();
    }

    injectedSvg.addEventListener('click', (e) => {
      if (didPan) {
        didPan = false;
        return;
      }
      const el = findInspectableFromEventTarget(e.target);
      setActiveFromElement(el);
    });

    allItems = buildItems(injectedSvg, CONFIG.mode);
    lastLoadedSvgMeta = formatBaseMeta(injectedSvg, allItems.length);
    rebuildMeta(null);
    updateSelectedName(null);
    renderRows(allItems);
  }

  function init() {
    searchEl.addEventListener('input', applySearch);

    if (zoomInBtn) zoomInBtn.addEventListener('click', zoomIn);
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', zoomOut);
    if (zoomResetBtn) zoomResetBtn.addEventListener('click', zoomReset);

    if (previewEl) {
      // Wheel zoom (trackpad / mouse wheel). Uses cursor position as anchor.
      previewEl.addEventListener(
        'wheel',
        (e) => {
          if (!injectedSvg) return;
          e.preventDefault();
          const delta = e.deltaY;
          const factor = delta > 0 ? 1 / 1.12 : 1.12;
          setZoom(zoomScale * factor, e.clientX, e.clientY);
        },
        { passive: false }
      );

      // Drag-to-pan
      previewEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        // Don't start pan if clicking sidebar overlay controls (buttons are outside previewEl anyway, but safe)
        isPanning = true;
        didPan = false;
        panStartX = e.clientX;
        panStartY = e.clientY;
        panOriginX = panX;
        panOriginY = panY;
      });

      window.addEventListener('mousemove', (e) => {
        if (!isPanning) return;
        const dx = e.clientX - panStartX;
        const dy = e.clientY - panStartY;
        if (!didPan && Math.abs(dx) + Math.abs(dy) > 3) didPan = true;
        panX = panOriginX + dx;
        panY = panOriginY + dy;
        applyViewTransform();
      });

      window.addEventListener('mouseup', () => {
        isPanning = false;
      });

      // Keyboard shortcuts when preview focused/active
      window.addEventListener('keydown', (e) => {
        if (e.key === '+' || e.key === '=') zoomIn();
        else if (e.key === '-' || e.key === '_') zoomOut();
        else if (e.key.toLowerCase() === '0') zoomReset();
      });
    }

    loadSvg().catch((err) => {
      metaEl.textContent = `Failed to load ${SOURCE_PAGE}: ${err && err.message ? err.message : String(err)}`;
    });
  }

  init();
})();
