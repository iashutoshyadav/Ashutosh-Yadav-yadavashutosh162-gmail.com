// The console's only way to talk to the server.
//
// The access token lives in this module's memory and nowhere else — never localStorage or
// sessionStorage. A reload restores the session from the httpOnly refresh cookie, which
// JavaScript cannot read. Each browser tab has its own copy of this module, so two tabs can
// sit in two different orgs.

let token = null;
let orgId = null;   // the org the token is scoped to, so a stale token can be re-minted for it

export class ApiError extends Error {
  constructor(status, body) {
    const e = body?.error ?? {};
    super(e.message || `request failed (HTTP ${status})`);
    this.status = status;
    this.code = e.code ?? `HTTP_${status}`;
    this.reason = e.reason ?? null;
  }
}

// A server that cannot be reached at all.
export class NetworkError extends Error {
  constructor() {
    super('Could not reach the server. Check that it is running, then try again.');
    this.code = 'NETWORK';
  }
}

async function send(method, path, body) {
  let res;
  try {
    res = await fetch(`/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new NetworkError();
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

function adopt(session) {
  token = session.token;
  orgId = session.orgId;
  return session;
}

// A permission change elsewhere makes our token stale (401 TOKEN_STALE). Get a new one for
// the SAME org and retry once, so the user stays where they were.
async function request(method, path, body) {
  try {
    return await send(method, path, body);
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'TOKEN_STALE' || !orgId) throw err;
    const wanted = orgId;
    adopt(await send('POST', '/auth/refresh'));
    if (orgId !== wanted) adopt(await send('POST', '/auth/token', { orgId: wanted }));
    return send(method, path, body);
  }
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  patch: (path, body = {}) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),

  login: async (email, password) => adopt(await send('POST', '/auth/login', { email, password })),
  switchOrg: async (id) => adopt(await request('POST', '/auth/token', { orgId: id })),
  me: () => request('GET', '/auth/me'),

  // Restore a session from the refresh cookie. null = no session (the server said 401).
  // Anything else means the server is up but broken, and the caller must say so.
  async restore() {
    try {
      return adopt(await send('POST', '/auth/refresh'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  },

  signOut() { token = null; orgId = null; },
};

// Is this permission entry, straight from the server, an allow?
export const allowed = (entry) => entry?.effect === 'allow';

// Turn any failure into something a person can read: { code, message }.
export function explain(err) {
  if (err instanceof NetworkError) return { code: err.code, message: err.message };
  if (err instanceof ApiError) {
    if (err.status >= 500) {
      return {
        code: err.code,
        message: 'The server failed to handle that request. If this is a fresh checkout, the database '
          + 'may not be built yet — run `npm run db:reset` and try again.',
      };
    }
    const reason = err.reason ? ` (${err.reason})` : '';
    return { code: err.code, message: `${err.message}${reason}` };
  }
  return { code: 'UNKNOWN', message: String(err?.message ?? err) };
}

// Why a permission is not held, in words, from the server's own provenance.
export function whyNot(entry) {
  switch (entry?.reason) {
    case 'explicit_deny': return `taken away by ${entry.source}`;
    case 'implicit': return 'not part of your role, and nobody granted it';
    case 'suspended': return 'your membership is suspended';
    case 'not_a_member': return 'you are not a member of this organization';
    default: return entry?.reason ?? 'not held';
  }
}

export const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
