/**
 * Patch UI project (C:\solar_pro\Main Project) to:
 * - Make Logout call API logout then redirect to API login page
 * - Add client-side auth guard on protected pages (handles Back/BFCache)
 * - Add server-side auth guard on HTML routes (prevents URL copy access)
 *
 * Run:
 *   node tools/patch_ui_auth.js
 */

const fs = require('fs');
const path = require('path');

const UI_ROOT = process.env.UI_ROOT || 'C:\\solar_pro\\Main Project';
const API_BASE = process.env.API_BASE || 'http://192.168.1.2:3000';
const LOGIN_URL = process.env.LOGIN_URL || `${API_BASE}/login`;

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function write(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

function ensureOnce(haystack, needle, what) {
  if (!haystack.includes(needle)) {
    throw new Error(`Expected to find ${what}`);
  }
}

function patchDashboardLike(pagePath) {
  let html = read(pagePath);

  // 1) Make Logout link identifiable and not a direct navigation.
  if (html.includes('http://192.168.1.2:3000/login') && !html.includes('id="idsLogout"')) {
    html = html.replace(
      /<a\s+href="http:\/\/192.168.1.2:3000\/login"([^>]*)>/i,
      '<a href="#" id="idsLogout"$1>'
    );
  }

  // 2) Inject guard + logout handler before </body> (idempotent)
  if (!html.includes('/* IDS_AUTH_GUARD */')) {
    const script = `
<script>
/* IDS_AUTH_GUARD */
(function () {
  const API_BASE = ${JSON.stringify(API_BASE)};
  const LOGIN_URL = ${JSON.stringify(LOGIN_URL)};

  async function ensureAuth() {
    try {
      const res = await fetch(API_BASE + '/api/auth/me', { credentials: 'include' });
      if (!res.ok) {
        window.location.replace(LOGIN_URL);
        return false;
      }
      return true;
    } catch (e) {
      window.location.replace(LOGIN_URL);
      return false;
    }
  }

  async function doLogout(e) {
    try { if (e) e.preventDefault(); } catch {}
    try {
      await fetch(API_BASE + '/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {}
    window.location.replace(LOGIN_URL);
    return false;
  }

  document.addEventListener('DOMContentLoaded', function () {
    ensureAuth();
    const btn = document.getElementById('idsLogout');
    if (btn) btn.addEventListener('click', doLogout);
  });

  // BFCache/back-forward: re-check auth on restore
  window.addEventListener('pageshow', function () {
    ensureAuth();
  });
})();
</script>
`;
    html = html.replace(/<\/body>/i, script + '\n</body>');
  }

  write(pagePath, html);
}

function patchServerGuard(serverPath) {
  let s = read(serverPath);

  if (s.includes('External Auth (IndustrialDataServer') && s.includes('requireLoginPage')) {
    // continue: we may still need the pre-static HTML guard middleware
  }

  // Insert HTML guard middleware BEFORE express.static so HTML can’t be served directly from disk.
  if (!s.includes('IDS_HTML_GUARD_MW')) {
    const staticLine = "app.use(express.static(path.join(__dirname, '../web')));";
    ensureOnce(s, staticLine, 'UI server express.static line');

    const guard = `

// IDS_HTML_GUARD_MW
// Guard HTML pages before express.static serves them (prevents URL copy / Back cache bypass after logout).
app.use(async (req, res, next) => {
  try {
    const pth = String(req.path || '');
    const lower = pth.toLowerCase();

    // Never guard API/socket/asset requests
    if (
      lower.startsWith('/api/') ||
      lower.startsWith('/socket.io') ||
      lower.startsWith('/images/') ||
      lower.startsWith('/css/') ||
      lower.startsWith('/js/')
    ) {
      return next();
    }

    const isHtml =
      lower === '/' ||
      lower.endsWith('.html') ||
      (lower.startsWith('/pages/') && lower.endsWith('.html'));

    if (!isHtml) return next();

    _setNoStore(res);

    // Always send login to API server (source of truth)
    if (lower === '/login' || lower === '/login.html') {
      return res.redirect(302, LOGIN_REDIRECT_URL);
    }

    const user = await _fetchAuthMe(req);
    if (!user) return res.redirect(302, LOGIN_REDIRECT_URL);

    // Admin-only page
    if (lower === '/user-interface.html' || lower.endsWith('/user-interface.html')) {
      if (user.role !== 'administrator') return res.redirect(302, '/dashboard.html');
    }

    req.authUser = user;
    return next();
  } catch {
    return res.redirect(302, LOGIN_REDIRECT_URL);
  }
});
`;

    s = s.replace(staticLine, guard + '\n' + staticLine);
  }

  // Insert helpers right after the /images static line (stable marker).
  const marker = "app.use('/images', express.static(path.join(__dirname, '../web/pages/images')));";
  ensureOnce(s, marker, 'UI server static /images line');

  const insert = `

// ==================== External Auth (IndustrialDataServer on :3000) ====================
// This UI server (port 5000) relies on JWT stored in an httpOnly cookie set by the API server.
// We enforce page access server-side so copying URLs / Back button won't bypass auth.
const AUTH_BASE_URL = process.env.AUTH_BASE_URL || ${JSON.stringify(API_BASE)};
const LOGIN_REDIRECT_URL = process.env.LOGIN_REDIRECT_URL || ${JSON.stringify(LOGIN_URL)};

function _setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

async function _fetchAuthMe(req) {
  try {
    const cookie = req.headers.cookie || '';
    const r = await fetch(AUTH_BASE_URL + '/api/auth/me', {
      method: 'GET',
      headers: { cookie, accept: 'application/json' },
    });
    if (!r.ok) return null;
    const data = await r.json().catch(() => null);
    return data && data.user ? data.user : null;
  } catch {
    return null;
  }
}

function requireLoginPage() {
  return async (req, res, next) => {
    _setNoStore(res);
    const user = await _fetchAuthMe(req);
    if (!user) return res.redirect(302, LOGIN_REDIRECT_URL);
    req.authUser = user;
    next();
  };
}

function requireAdminPage() {
  return async (req, res, next) => {
    _setNoStore(res);
    const user = await _fetchAuthMe(req);
    if (!user) return res.redirect(302, LOGIN_REDIRECT_URL);
    if (user.role !== 'administrator') return res.redirect(302, '/dashboard.html');
    req.authUser = user;
    next();
  };
}
`;

  if (!s.includes('External Auth (IndustrialDataServer')) {
    s = s.replace(marker, marker + insert);
  }

  // Guard root "/"
  s = s.replace(
    "app.get('/', (_, res) => res.sendFile(path.join(__dirname, '../web/pages/dashboard.html')));",
    "app.get('/', requireLoginPage(), (_, res) => res.sendFile(path.join(__dirname, '../web/pages/dashboard.html')));"
  );

  // Guard "/:page.html" (admin-only for user-interface.html)
  if (!s.includes('Enforce login for all HTML pages; admin-only for user-interface.html')) {
    const pageRoute = "app.get('/:page.html', (req, res, next) => {";
    ensureOnce(s, pageRoute, 'UI server /:page.html route');

    if (!s.includes("const filePath = path.join(__dirname, '../web/pages', `${req.params.page}.html`);")) {
      throw new Error('Unexpected :page.html route body; patcher needs update');
    }

    s = s.replace(
      pageRoute,
      "app.get('/:page.html', async (req, res, next) => {\n" +
        "    // Enforce login for all HTML pages; admin-only for user-interface.html\n" +
        "    _setNoStore(res);\n" +
        "    const page = String(req.params.page || '').toLowerCase();\n" +
        "    const user = await _fetchAuthMe(req);\n" +
        "    if (!user) return res.redirect(302, LOGIN_REDIRECT_URL);\n" +
        "    if (page === 'user-interface' && user.role !== 'administrator') return res.redirect(302, '/dashboard.html');\n"
    );
  }

  write(serverPath, s);
}

function main() {
  const serverPath = path.join(UI_ROOT, 'server', 'server.js');
  const dashboardPath = path.join(UI_ROOT, 'web', 'pages', 'dashboard.html');
  const monitoringPath = path.join(UI_ROOT, 'web', 'pages', 'monitoring.html');

  patchServerGuard(serverPath);
  patchDashboardLike(dashboardPath);
  patchDashboardLike(monitoringPath);

  console.log('✅ UI patched:', UI_ROOT);
}

main();
