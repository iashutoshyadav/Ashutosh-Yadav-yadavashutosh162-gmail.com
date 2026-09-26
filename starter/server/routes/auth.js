// Sign-in, token refresh, switching org, and "who am I".
//
// Access token: short-lived JWT held in the console's memory. Refresh token: opaque random
// value in an httpOnly cookie, stored only as a hash, rotated on every use. Reusing an
// already-rotated refresh token revokes its whole family (someone copied it).

import { newId, nowIso } from '../db.js';
import { send, badRequest, unauthenticated, forbidden, notFound } from '../http.js';
import {
  issueAccessToken, verifyPassword, newRefreshToken, hashRefreshToken,
  ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS,
} from '../auth.js';
import { resolve } from '../permissions.js';
import { audit } from '../audit.js';

const COOKIE = 'rt';

function setRefreshCookie(res, raw) {
  res.setHeader('set-cookie',
    `${COOKIE}=${raw}; HttpOnly; SameSite=Strict; Path=/v1/auth; Max-Age=${REFRESH_TTL_SECONDS}`);
}

function readRefreshCookie(req) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

// The orgs a user may act in, alphabetical. The first one is the default after sign-in.
function activeOrgs(db, userId) {
  return db.prepare(
    `SELECT o.id, o.name, o.theme, m.role, m.perm_version
       FROM memberships m JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = ? AND m.status = 'active' AND o.deleted_at IS NULL
      ORDER BY o.name, o.id`
  ).all(userId);
}

const publicOrgs = (orgs) => orgs.map(({ id, name, theme, role }) => ({ id, name, theme, role }));

function tokenFor(userId, org, secret) {
  return issueAccessToken({ userId, orgId: org.id, role: org.role, permVersion: org.perm_version }, secret);
}

function storeRefreshToken(db, userId, familyId) {
  const raw = newRefreshToken();
  db.prepare(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at) VALUES (?,?,?,?,?)'
  ).run(newId('rft'), userId, hashRefreshToken(raw), familyId,
    new Date(Date.now() + REFRESH_TTL_SECONDS * 1000).toISOString());
  return raw;
}

function sessionBody(token, org, orgs) {
  return { token, expiresIn: ACCESS_TTL_SECONDS, orgId: org.id, role: org.role, orgs: publicOrgs(orgs) };
}

export function register(router, { db, secret }) {
  // POST /v1/auth/login  { email, password, orgId? }
  router.post('/v1/auth/login', (ctx, _p, res) => {
    const { email, password, orgId } = ctx.body;
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
      throw badRequest('email and password are required');
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
    if (!user || !verifyPassword(password, user.password_hash)) {
      // Same answer for "no such account" and "wrong password" — no account enumeration.
      // A failed sign-in for a real account is recorded in each org it belongs to; an
      // unknown email belongs to no org, and audit rows are org-scoped.
      if (user) {
        for (const org of activeOrgs(db, user.id)) {
          audit(db, { orgId: org.id, actorId: user.id, action: 'auth.login', result: 'deny',
            reasonCode: 'bad_credentials', requestId: ctx.requestId });
        }
      }
      throw unauthenticated('invalid email or password');
    }

    const orgs = activeOrgs(db, user.id);
    if (orgs.length === 0) throw forbidden('this account is not an active member of any organization', 'no_active_membership');

    const org = orgId === undefined ? orgs[0] : orgs.find((o) => o.id === orgId);
    if (!org) throw notFound();

    setRefreshCookie(res, storeRefreshToken(db, user.id, newId('fam')));
    audit(db, { orgId: org.id, actorId: user.id, action: 'auth.login', result: 'allow', requestId: ctx.requestId });
    send(res, 200, {
      ...sessionBody(tokenFor(user.id, org, secret), org, orgs),
      user: { id: user.id, email: user.email, name: user.name },
    });
  });

  // POST /v1/auth/refresh — rotate the cookie, hand back a fresh access token.
  router.post('/v1/auth/refresh', (ctx, _p, res) => {
    const raw = readRefreshCookie(ctx.req);
    if (!raw) throw unauthenticated('no refresh token');

    const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(hashRefreshToken(raw));
    if (!row) throw unauthenticated('unknown refresh token');

    if (row.revoked_at) {
      db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL')
        .run(nowIso(), row.family_id);
      throw unauthenticated('refresh token was already used; please sign in again');
    }
    if (row.expires_at <= nowIso()) throw unauthenticated('refresh token expired');

    const orgs = activeOrgs(db, row.user_id);
    if (orgs.length === 0) throw forbidden('this account is not an active member of any organization', 'no_active_membership');

    // Rotate: the old token is spent, the new one continues the same family.
    const next = db.transaction(() => {
      db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?').run(nowIso(), row.id);
      return storeRefreshToken(db, row.user_id, row.family_id);
    })();

    setRefreshCookie(res, next);
    send(res, 200, sessionBody(tokenFor(row.user_id, orgs[0], secret), orgs[0], orgs));
  });

  // POST /v1/auth/logout — not in the endpoint table, but without it "sign out" cannot end
  // anything: the refresh cookie would sign the browser straight back in. Revokes the
  // cookie's whole family and clears the cookie. Public: it needs only the cookie.
  router.post('/v1/auth/logout', (ctx, _p, res) => {
    const raw = readRefreshCookie(ctx.req);
    if (raw) {
      const row = db.prepare('SELECT family_id FROM refresh_tokens WHERE token_hash = ?').get(hashRefreshToken(raw));
      if (row) {
        db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL')
          .run(nowIso(), row.family_id);
      }
    }
    res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/v1/auth; Max-Age=0`);
    send(res, 204);
  });

  // POST /v1/auth/token  { orgId } — switch org. A token names exactly one org, so switching
  // mints a new token rather than changing anything server-side.
  router.post('/v1/auth/token', (ctx, _p, res) => {
    const { orgId } = ctx.body;
    if (typeof orgId !== 'string' || !orgId) throw badRequest('orgId is required');

    const orgs = activeOrgs(db, ctx.userId);
    const org = orgs.find((o) => o.id === orgId);
    if (!org) throw notFound();

    send(res, 200, sessionBody(tokenFor(ctx.userId, org, secret), org, orgs));
  });

  // GET /v1/auth/me — the caller, their active org, and the ORG-LEVEL permission set the
  // console uses for navigation. Per-device answers come with each device row instead.
  router.get('/v1/auth/me', (ctx, _p, res) => {
    const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(ctx.userId);
    const org = db.prepare('SELECT id, name, theme, max_session_minutes FROM organizations WHERE id = ?').get(ctx.orgId);
    const { role, permissions } = resolve(db, { userId: ctx.userId, orgId: ctx.orgId });
    send(res, 200, {
      user,
      org,
      role,
      status: ctx.membership.status,
      orgs: publicOrgs(activeOrgs(db, ctx.userId)),
      permissions,
    });
  });
}
