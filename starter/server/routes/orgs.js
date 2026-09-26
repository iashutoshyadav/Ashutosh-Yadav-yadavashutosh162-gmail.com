// Orgs, members, effective permissions, and the audit log.
//
// Every route here that names an org has already passed context.js, so `params.org` is
// always the caller's own org — another org's id never reaches these handlers (404 first).

import { newId, nowIso, bumpPermVersion } from '../db.js';
import { send, badRequest, notFound, conflict, forbidden, selfRoleChange } from '../http.js';
import { assertCan, resolve } from '../permissions.js';
import { audit, auditDenials } from '../audit.js';
import {
  assertRoleExists, assertCanModify, assertCanAssign, assertNotLastOwner, endActiveSessions,
} from '../lifecycle.js';

const THEMES = ['cobalt', 'amber', 'moss', 'plum', 'rust', 'teal'];
const MAX_PAGE = 200;

function orgName(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 1 || name.length > 200) throw badRequest('name must be 1-200 characters');
  return name;
}

// limit/offset outside the defined range are a 400, not silently clamped.
function pagination(query) {
  const limit = query.has('limit') ? Number(query.get('limit')) : 50;
  const offset = query.has('offset') ? Number(query.get('offset')) : 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
    throw badRequest(`limit must be an integer from 1 to ${MAX_PAGE}`);
  }
  if (!Number.isInteger(offset) || offset < 0) throw badRequest('offset must be a non-negative integer');
  return { limit, offset };
}

// A member that can still be acted on: exists in this org and was not removed.
function requireMember(db, orgId, userId) {
  const m = db.prepare('SELECT * FROM memberships WHERE org_id = ? AND user_id = ?').get(orgId, userId);
  if (!m || m.status === 'removed') throw notFound();
  return m;
}

export function register(router, { db }) {
  const record = (ctx, action, targetType, targetId) =>
    audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action, targetType, targetId, result: 'allow', requestId: ctx.requestId });

  // --- roles ----------------------------------------------------------------------

  // Not in the endpoint table: the console needs the role list for invites and role
  // changes, and must not hardcode it (the database can hold roles no document mentions).
  // Reference data only — who may assign which role is still decided server-side.
  router.get('/v1/roles', (_ctx, _p, res) => {
    const roles = db.prepare('SELECT key, label, rank FROM roles ORDER BY rank DESC').all();
    send(res, 200, { roles });
  });

  // --- orgs -----------------------------------------------------------------------

  router.get('/v1/orgs', (ctx, _p, res) => {
    const orgs = db.prepare(
      `SELECT o.id, o.name, o.theme, m.role
         FROM memberships m JOIN organizations o ON o.id = m.org_id
        WHERE m.user_id = ? AND m.status = 'active' AND o.deleted_at IS NULL
        ORDER BY o.name, o.id`
    ).all(ctx.userId);
    send(res, 200, { orgs });
  });

  // Any signed-in user may start an org and becomes its owner — unless the token they are
  // using belongs to a membership that is suspended. This route asks no permission question,
  // so the engine's "suspended = deny everything" would never be consulted here.
  router.post('/v1/orgs', (ctx, _p, res) => {
    if (ctx.membership.status !== 'active') throw forbidden('your membership is suspended', 'suspended');
    const name = orgName(ctx.body);
    const theme = THEMES.includes(ctx.body.theme)
      ? ctx.body.theme
      : THEMES[db.prepare('SELECT count(*) AS n FROM organizations').get().n % THEMES.length];

    const id = newId('org');
    db.transaction(() => {
      db.prepare('INSERT INTO organizations (id, name, theme) VALUES (?,?,?)').run(id, name, theme);
      db.prepare(
        `INSERT INTO memberships (id, org_id, user_id, role, status, joined_at) VALUES (?,?,?,'owner','active',?)`
      ).run(newId('mem'), id, ctx.userId, nowIso());
      audit(db, { orgId: id, actorId: ctx.userId, action: 'org.create', targetType: 'org', targetId: id,
        result: 'allow', requestId: ctx.requestId });
    })();
    send(res, 201, { id, name, theme, role: 'owner' });
  });

  router.patch('/v1/orgs/:org', (ctx, params, res) => {
    auditDenials(db, ctx, { action: 'org.update', targetType: 'org', targetId: params.org },
      () => assertCan(db, ctx, 'org:update'));
    const name = orgName(ctx.body);
    db.transaction(() => {
      db.prepare('UPDATE organizations SET name = ? WHERE id = ?').run(name, params.org);
      record(ctx, 'org.update', 'org', params.org);
    })();
    send(res, 200, { id: params.org, name });
  });

  // Soft delete. Every token scoped to the org stops working (context.js 404s a deleted
  // org), and its live sessions end. There is no 'org_deleted' end_reason in the schema's
  // closed list, so they end as admin_terminated.
  router.delete('/v1/orgs/:org', (ctx, params, res) => {
    auditDenials(db, ctx, { action: 'org.delete', targetType: 'org', targetId: params.org },
      () => assertCan(db, ctx, 'org:delete'));
    db.transaction(() => {
      db.prepare('UPDATE organizations SET deleted_at = ? WHERE id = ?').run(nowIso(), params.org);
      endActiveSessions(db, { orgId: params.org, reason: 'admin_terminated' });
      record(ctx, 'org.delete', 'org', params.org);
    })();
    send(res, 204);
  });

  // --- members --------------------------------------------------------------------

  router.get('/v1/orgs/:org/members', (ctx, params, res) => {
    assertCan(db, ctx, 'user:read');
    const members = db.prepare(
      `SELECT u.id, u.email, u.name, m.role, m.status, m.joined_at
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = ? AND m.status IN ('active', 'suspended')
        ORDER BY u.name, u.id`
    ).all(params.org);
    send(res, 200, { members });
  });

  // Leave. Registered before '/members/:userId' so 'me' is not read as a user id.
  router.delete('/v1/orgs/:org/members/me', (ctx, params, res) => {
    db.transaction(() => {
      assertNotLastOwner(db, params.org, ctx.userId);
      endMembership(db, params.org, ctx.userId, 'removed', 'membership_removed');
      record(ctx, 'member.leave', 'user', ctx.userId);
    })();
    send(res, 204);
  });

  router.patch('/v1/orgs/:org/members/:userId', (ctx, params, res) => {
    const { userId } = params;
    const role = ctx.body.role;
    if (userId === ctx.userId) throw selfRoleChange();
    assertRoleExists(db, role);

    auditDenials(db, ctx, { action: 'member.role.update', targetType: 'user', targetId: userId }, () => {
      assertCan(db, ctx, 'user:role:update');
      const target = requireMember(db, params.org, userId);
      assertCanModify(db, ctx.role, target.role);
      assertCanAssign(db, ctx.role, role);
    });

    // Grandfathered: a role change does not end the member's live sessions; it only makes
    // their current token stale, so the next request sees the new role.
    db.transaction(() => {
      if (role !== 'owner') assertNotLastOwner(db, params.org, userId);
      db.prepare('UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?').run(role, params.org, userId);
      bumpPermVersion(db, { orgId: params.org, userId });
      record(ctx, 'member.role.update', 'user', userId);
    })();
    send(res, 200, { id: userId, role });
  });

  router.post('/v1/orgs/:org/members/:userId/suspend', (ctx, params, res) => {
    const target = gateMemberChange(db, ctx, params, 'member.suspend');
    if (target.status === 'suspended') throw conflict('member is already suspended');
    db.transaction(() => {
      assertNotLastOwner(db, params.org, params.userId);
      endMembership(db, params.org, params.userId, 'suspended', 'user_suspended');
      record(ctx, 'member.suspend', 'user', params.userId);
    })();
    send(res, 200, { id: params.userId, status: 'suspended' });
  });

  router.delete('/v1/orgs/:org/members/:userId/suspend', (ctx, params, res) => {
    const target = gateMemberChange(db, ctx, params, 'member.reinstate');
    if (target.status !== 'suspended') throw conflict('member is not suspended');
    db.transaction(() => {
      db.prepare("UPDATE memberships SET status = 'active' WHERE org_id = ? AND user_id = ?").run(params.org, params.userId);
      bumpPermVersion(db, { orgId: params.org, userId: params.userId });
      record(ctx, 'member.reinstate', 'user', params.userId);
    })();
    send(res, 200, { id: params.userId, status: 'active' });
  });

  // Removal is a membership change. The user row, their other orgs and every audit row
  // that names them stay exactly as they were.
  router.delete('/v1/orgs/:org/members/:userId', (ctx, params, res) => {
    gateMemberChange(db, ctx, params, 'member.remove');
    db.transaction(() => {
      assertNotLastOwner(db, params.org, params.userId);
      endMembership(db, params.org, params.userId, 'removed', 'membership_removed');
      record(ctx, 'member.remove', 'user', params.userId);
    })();
    send(res, 204);
  });

  // --- effective permissions ---------------------------------------------------------

  router.get('/v1/orgs/:org/users/:userId/effective', (ctx, params, res) => {
    if (params.userId !== ctx.userId) assertCan(db, ctx, 'user:read');
    requireMember(db, params.org, params.userId);

    const deviceId = ctx.query.get('deviceId');
    if (deviceId && !db.prepare('SELECT 1 FROM devices WHERE id = ? AND org_id = ? AND deleted_at IS NULL').get(deviceId, params.org)) {
      throw notFound();
    }
    const resolved = resolve(db, { userId: params.userId, orgId: params.org, deviceId: deviceId || null });
    send(res, 200, { userId: params.userId, orgId: params.org, deviceId: deviceId || null, ...resolved });
  });

  // --- audit -----------------------------------------------------------------------------

  router.get('/v1/orgs/:org/audit', (ctx, params, res) => {
    assertCan(db, ctx, 'audit:read');
    const { limit, offset } = pagination(ctx.query);
    const events = db.prepare(
      'SELECT * FROM audit_events WHERE org_id = ? ORDER BY at DESC, id DESC LIMIT ? OFFSET ?'
    ).all(params.org, limit, offset);
    send(res, 200, { events, limit, offset });
  });
}

// Suspend / reinstate / remove share one gate: user:remove, not yourself (use leave), the
// target exists, and the caller outranks them. A refusal is audited.
function gateMemberChange(db, ctx, params, action) {
  let target;
  auditDenials(db, ctx, { action, targetType: 'user', targetId: params.userId }, () => {
    assertCan(db, ctx, 'user:remove');
    if (params.userId === ctx.userId) throw forbidden('use leave to remove yourself', 'self');
    target = requireMember(db, params.org, params.userId);
    assertCanModify(db, ctx.role, target.role);
  });
  return target;
}

// Suspension and removal are tenancy events: status changes, the member's tokens go stale,
// and their live sessions in this org end.
function endMembership(db, orgId, userId, status, endReason) {
  db.prepare('UPDATE memberships SET status = ? WHERE org_id = ? AND user_id = ?').run(status, orgId, userId);
  bumpPermVersion(db, { orgId, userId });
  endActiveSessions(db, { orgId, userId, reason: endReason });
}
