// Shared domain rules: who may modify whom, last-owner protection, ending sessions.
//
// `roles.rank` is used here and NOWHERE ELSE. It answers "may this person change that
// person's membership?" — never "may this person do X?". That question belongs to
// permissions.js, which does not look at ranks at all.
//
// Sessions: a permission change never ends a session in flight (they are grandfathered
// until their own expiry). Account and tenancy events do: suspension, removal, device
// transfer or decommission. endActiveSessions is the one place that ends them.

import { newId, nowIso } from './db.js';
import { badRequest, forbidden, lastOwner } from './http.js';

const OWNER = 'owner';

export function roleRanks(db) {
  return Object.fromEntries(db.prepare('SELECT key, rank FROM roles').all().map((r) => [r.key, r.rank]));
}

export function assertRoleExists(db, role) {
  if (typeof role !== 'string' || !db.prepare('SELECT 1 FROM roles WHERE key = ?').get(role)) {
    throw badRequest(`unknown role: ${role}`, 'unknown_role');
  }
}

// May a caller with `callerRole` act on a member whose role is `targetRole`?
// Owners may act on anyone (including another owner). Everyone else only on a strictly
// lower rank, so an admin cannot touch another admin.
export function assertCanModify(db, callerRole, targetRole) {
  if (callerRole === OWNER) return;
  const ranks = roleRanks(db);
  if (!(ranks[callerRole] > ranks[targetRole])) {
    throw forbidden('you can only change members ranked below you', 'insufficient_rank');
  }
}

// May the caller hand out `newRole` (by invite or role change)? Only an owner confers
// owner; anyone else only a role strictly below their own.
export function assertCanAssign(db, callerRole, newRole) {
  if (newRole === OWNER && callerRole !== OWNER) {
    throw forbidden('only an owner can make someone an owner', 'cannot_confer_owner');
  }
  assertCanModify(db, callerRole, newRole);
}

// Throws LAST_OWNER if taking `userId` out of the owner role (or out of the org) would
// leave `orgId` with no active owner. Call it inside the same transaction as the change.
export function assertNotLastOwner(db, orgId, userId) {
  const target = db.prepare('SELECT role, status FROM memberships WHERE org_id = ? AND user_id = ?').get(orgId, userId);
  if (target?.role !== OWNER || target.status !== 'active') return;

  const others = db.prepare(
    `SELECT count(*) AS n FROM memberships
      WHERE org_id = ? AND role = ? AND status = 'active' AND user_id != ?`
  ).get(orgId, OWNER, userId).n;
  if (others === 0) throw lastOwner();
}

// End every active session matching the filter. `reason` must be one of the values the
// sessions.end_reason CHECK allows. Returns the ids that were ended.
export function endActiveSessions(db, { orgId, userId = null, deviceId = null, reason }) {
  const at = nowIso();
  const ended = db.prepare(
    `UPDATE sessions SET state = 'ended', ended_at = ?, end_reason = ?
      WHERE org_id = ? AND state = 'active'
        AND (? IS NULL OR user_id = ?)
        AND (? IS NULL OR device_id = ?)
      RETURNING id`
  ).all(at, reason, orgId, userId, userId, deviceId, deviceId);
  return ended.map((r) => r.id);
}

// Sessions past their TTL are ended lazily, before anything reads or starts sessions.
// Without this an expired `control` session would hold its device forever.
export function sweepExpiredSessions(db, orgId) {
  db.prepare(
    `UPDATE sessions SET state = 'ended', ended_at = expires_at, end_reason = 'session_expired'
      WHERE org_id = ? AND state = 'active' AND expires_at <= ?`
  ).run(orgId, nowIso());
}

// What authorised a session, frozen at start. Sessions are grandfathered, so this — not
// the live permission state — is the session's authority for its whole life.
export function snapshotAuthority(db, { userId, orgId, deviceId, permissions }) {
  const role = db.prepare('SELECT role FROM memberships WHERE org_id = ? AND user_id = ?').get(orgId, userId)?.role ?? null;
  const sources = [...new Set(permissions.map((e) => e.source).filter(Boolean))];
  return JSON.stringify({ role, deviceId, sources, snapshotAt: nowIso() });
}

export function sessionExpiry(db, orgId) {
  const minutes = db.prepare('SELECT max_session_minutes AS m FROM organizations WHERE id = ?').get(orgId)?.m ?? 60;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export { newId, nowIso };
