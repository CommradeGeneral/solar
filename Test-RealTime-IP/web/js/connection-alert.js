(() => {
  // Connection status banner — shows exact device names that are disconnected.
  // Included in every page via: <script src="js/connection-alert.js"></script>

  const STYLE_ID = 'connection-alert-style';
  const BANNER_ID = 'connection-alert-banner';
  const TOGGLE_ID = 'connection-alert-toggle';
  const COLLAPSE_KEY = 'connectionAlertCollapsed';

  let lastHadAlert = false;

  function isCollapsed() {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  }

  function setCollapsed(v) {
    localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0');
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${BANNER_ID} {
        position: fixed;
        left: 12px;
        bottom: 12px;
        z-index: 99999;
        padding: 12px 18px;
        border-radius: 12px;
        font: 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        color: #fff;
        background: rgba(231, 76, 60, 0.95);
        box-shadow: 0 8px 22px rgba(0,0,0,0.4);
        display: none;
        max-width: 420px;
        backdrop-filter: blur(8px);
        transition: all 0.3s ease;
      }
      #${BANNER_ID}.ok { background: rgba(46, 204, 113, 0.95); }
      #${BANNER_ID}.warn { background: rgba(243, 156, 18, 0.95); }
      #${BANNER_ID}.error { background: rgba(231, 76, 60, 0.95); }
      #${BANNER_ID} .alert-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
      }
      #${BANNER_ID} .alert-title {
        font-weight: bold;
        font-size: 14px;
        margin-bottom: 6px;
      }
      #${BANNER_ID} .alert-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-left: 10px;
      }
      #${BANNER_ID} .alert-btn {
        -webkit-appearance: none;
        appearance: none;
        border: none;
        border-radius: 8px;
        padding: 0 8px;
        height: 26px;
        line-height: 26px;
        font-weight: 800;
        font-size: 16px;
        cursor: pointer;
        color: #fff;
        background: rgba(0,0,0,0.18);
      }
      #${BANNER_ID} .alert-btn:hover { background: rgba(0,0,0,0.26); }
      #${BANNER_ID} .alert-devices {
        font-size: 12px;
        opacity: 0.95;
        line-height: 1.5;
      }
      #${BANNER_ID} .alert-device {
        padding: 2px 0;
      }
      #${BANNER_ID} .alert-device .dev-type {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: bold;
        margin-right: 4px;
        background: rgba(255,255,255,0.2);
      }

      #${TOGGLE_ID} {
        position: fixed;
        left: 12px;
        bottom: 12px;
        z-index: 99999;
        display: none;
        width: 34px;
        height: 34px;
        border-radius: 12px;
        border: none;
        cursor: pointer;
        color: #fff;
        font: 700 20px/34px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        box-shadow: 0 8px 22px rgba(0,0,0,0.4);
        backdrop-filter: blur(8px);
        background: rgba(231, 76, 60, 0.95);
      }
      #${TOGGLE_ID}.warn { background: rgba(243, 156, 18, 0.95); }
      #${TOGGLE_ID}.error { background: rgba(231, 76, 60, 0.95); }
      #${TOGGLE_ID}:hover { filter: brightness(1.06); }
    `;
    document.head.appendChild(style);
  }

  function ensureBanner() {
    let banner = document.getElementById(BANNER_ID);
    if (banner) return banner;
    banner = document.createElement('div');
    banner.id = BANNER_ID;
    document.body.appendChild(banner);

    // Delegate click for collapse button (banner content is re-rendered)
    banner.addEventListener('click', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('.alert-collapse')) {
        setCollapsed(true);
        banner.style.display = 'none';
        syncToggleVisibility();
      }
    });

    return banner;
  }

  function ensureToggle() {
    let btn = document.getElementById(TOGGLE_ID);
    if (btn) return btn;
    btn = document.createElement('button');
    btn.id = TOGGLE_ID;
    btn.type = 'button';
    btn.textContent = '+';
    btn.title = 'Show connection alerts';
    btn.addEventListener('click', () => {
      setCollapsed(false);
      syncToggleVisibility();
    });
    document.body.appendChild(btn);
    return btn;
  }

  function syncToggleVisibility() {
    const banner = ensureBanner();
    const toggle = ensureToggle();

    if (!lastHadAlert) {
      banner.style.display = 'none';
      toggle.style.display = 'none';
      return;
    }

    if (isCollapsed()) {
      banner.style.display = 'none';
      toggle.style.display = 'block';
    } else {
      toggle.style.display = 'none';
      // banner display is controlled by showBanner()
    }
  }

  function showBanner(state, titleText, devicesHtml) {
    const banner = ensureBanner();
    banner.classList.remove('ok', 'warn', 'error');
    if (state) banner.classList.add(state);

    const actionsHtml = `<div class="alert-actions">
      <button type="button" class="alert-btn alert-collapse" title="Hide">−</button>
    </div>`;

    let html = `<div class="alert-header">
      <div class="alert-title">${titleText}</div>
      ${actionsHtml}
    </div>`;
    if (devicesHtml) html += `<div class="alert-devices">${devicesHtml}</div>`;
    banner.innerHTML = html;

    lastHadAlert = true;
    const toggle = ensureToggle();
    toggle.classList.remove('warn', 'error');
    if (state === 'warn') toggle.classList.add('warn');
    if (state === 'error') toggle.classList.add('error');

    if (isCollapsed()) {
      banner.style.display = 'none';
      toggle.style.display = 'block';
    } else {
      toggle.style.display = 'none';
      banner.style.display = 'block';
    }
  }

  function hideBanner() {
    const banner = ensureBanner();
    banner.style.display = 'none';
    const toggle = ensureToggle();
    toggle.style.display = 'none';
    lastHadAlert = false;
  }

  async function checkHealth() {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      const data = await res.json();

      if (data.allConnected) {
        hideBanner();
        return;
      }

      // Build device list HTML
      const devices = data.disconnectedDevices || [];
      if (devices.length === 0) {
        hideBanner();
        return;
      }

      let devHtml = '';
      devices.forEach(dev => {
        const statusText = dev.gaveUp 
          ? '⛔ Gave up' 
          : `🔄 Retry ${dev.attempts || 0}`;
        devHtml += `<div class="alert-device">` +
          `<span class="dev-type">${dev.type}</span>` +
          `<strong>${dev.name}</strong> — ${statusText}` +
          `</div>`;
      });

      const hasGaveUp = devices.some(d => d.gaveUp);
      const state = hasGaveUp ? 'error' : 'warn';
      const title = `⚠️ ${devices.length} device${devices.length > 1 ? 's' : ''} disconnected`;

      showBanner(state, title, devHtml);

    } catch (e) {
      // Server itself is unreachable
      showBanner('error', '🔴 Server unreachable', null);
    }
  }

  function start() {
    ensureStyle();
    ensureBanner();
    ensureToggle();
    checkHealth();
    setInterval(checkHealth, 4000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
