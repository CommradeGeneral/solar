async function apiFetch(url, options = {}) {
  const opts = {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    credentials: 'include',
  };
  return fetch(url, opts);
}

async function requireAuth() {
  const res = await apiFetch('/api/auth/me', { method: 'GET' });
  if (!res.ok) {
    window.location.href = '/login';
    return null;
  }
  const data = await res.json();
  return data.user;
}

window.IdsApp = { apiFetch, requireAuth };

