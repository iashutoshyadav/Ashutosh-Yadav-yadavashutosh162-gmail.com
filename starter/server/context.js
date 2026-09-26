// Per-request context: turn a bearer token into an authenticated caller.
//
// What it has to do (BRIEF.md §3, PERMISSIONS.md §5):
//   - read the bearer token, verify it with verifyAccessToken() from ./auth.js
//   - look the membership up and refuse a token whose org or membership is gone
//   - THE TOKEN'S org CLAIM IS THE ONLY ORG THE CALLER MAY ADDRESS. A request that
//     names a different org is INVISIBLE — 404, never 403. Isolation is structural:
//     the caller cannot name another org, rather than being filtered afterwards.
//   - check freshness against memberships.perm_version (AUTH-DATA-MODEL.md §3), so a
//     role or grant change takes effect on the NEXT request, not at token expiry
//   - throw through the one error path in ./http.js
//
// authenticate(db, secret) returns (req, params) => caller, where caller carries
// { userId, orgId, role, membership, claims }.
import { verifyAccessToken, assertFresh } from './auth.js';
import { unauthenticated, notFound } from './http.js';

const MEMBERSHIP_SQL = `
  SELECT m.*, o.deleted_at AS org_deleted_at
    FROM memberships m
    JOIN organizations o ON o.id = m.org_id
   WHERE m.org_id = ? AND m.user_id = ?`;

function bearerToken(req) {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
}

export function authenticate(db, secret) {
  const findMembership = db.prepare(MEMBERSHIP_SQL);

  return function buildContext(req, params) {
    const token = bearerToken(req);
    if (!token) throw unauthenticated('missing bearer token');

    const claims = verifyAccessToken(token, secret);

    const membership = findMembership.get(claims.org, claims.sub);
    if (!membership) throw unauthenticated('not a member of this org');
    // A deleted org is invisible, same as one that never existed.
    if (membership.org_deleted_at) throw notFound();
    if (membership.status === 'removed') throw unauthenticated('membership removed');

    // Suspension bumps perm_version, so a suspended member's token is always stale.
    // Checking freshness here would answer 401 TOKEN_STALE and hide the real reason.
    // Instead the request goes on to the permission engine, which denies everything
    // for a suspended membership with reason 'suspended' (403). See DECISIONS.md.
    if (membership.status !== 'suspended') assertFresh(claims, membership);

    if (params.org && params.org !== claims.org) throw notFound();

    return {
      userId: claims.sub,
      orgId: claims.org,
      role: membership.role,
      membership,
      claims,
    };
  };
}
