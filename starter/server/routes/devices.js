// Devices and grants.
//
// Device rows carry the caller's permission set FOR THAT DEVICE, resolved in one batch for
// the whole list. The console renders buttons straight from it and never computes a rule.
// device:list gates the endpoint; device:view decides whether a row is included at all.

import { newId, nowIso, bumpPermVersion } from '../db.js';
import { send, badRequest, notFound, forbidden, normalizeTs, HttpError } from '../http.js';
import { assertCan, assertMayGrant, resolve, resolveDevices } from '../permissions.js';
import { audit, auditDenials } from '../audit.js';
import { endActiveSessions } from '../lifecycle.js';

const KINDS = ['macos', 'windows', 'linux', 'android', 'ios'];

function deviceName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length < 1 || name.length > 200) throw badRequest('name must be 1-200 characters');
  return name;
}

// A live device in this org, or 404 — "another org's device" and "no such device" look the same.
function requireDevice(db, orgId, deviceId) {
  const device = db.prepare('SELECT * FROM devices WHERE id = ? AND org_id = ? AND deleted_at IS NULL').get(deviceId, orgId);
  if (!device) throw notFound();
  return device;
}

const deviceOut = (d, permissions) => ({
  id: d.id, name: d.name, kind: d.kind, online: d.online === 1, created_at: d.created_at, permissions,
});

export function register(router, { db }) {
  const record = (ctx, action, targetType, targetId) =>
    audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action, targetType, targetId, result: 'allow', requestId: ctx.requestId });

  // --- devices ---------------------------------------------------------------------

  router.get('/v1/orgs/:org/devices', (ctx, params, res) => {
    assertCan(db, ctx, 'device:list');
    const rows = db.prepare(
      'SELECT * FROM devices WHERE org_id = ? AND deleted_at IS NULL ORDER BY name, id'
    ).all(params.org);
    const { byDevice } = resolveDevices(db, { userId: ctx.userId, orgId: params.org, deviceIds: rows.map((d) => d.id) });

    const devices = rows
      .filter((d) => byDevice[d.id]['device:view'].effect === 'allow')   // absent, not redacted
      .map((d) => deviceOut(d, byDevice[d.id]));
    send(res, 200, { devices });
  });

  router.get('/v1/orgs/:org/devices/:id', (ctx, params, res) => {
    const device = requireDevice(db, params.org, params.id);
    const { permissions } = resolve(db, { userId: ctx.userId, orgId: params.org, deviceId: device.id });
    if (permissions['device:view'].effect !== 'allow') throw notFound();   // can't see it -> invisible
    send(res, 200, deviceOut(device, permissions));
  });

  router.post('/v1/orgs/:org/devices', (ctx, params, res) => {
    auditDenials(db, ctx, { action: 'device.create', targetType: 'device' },
      () => assertCan(db, ctx, 'device:provision'));
    const name = deviceName(ctx.body.name);
    if (!KINDS.includes(ctx.body.kind)) throw badRequest(`kind must be one of: ${KINDS.join(', ')}`);

    const id = newId('dev');
    db.transaction(() => {
      db.prepare('INSERT INTO devices (id, org_id, name, kind, online) VALUES (?,?,?,?,?)')
        .run(id, params.org, name, ctx.body.kind, ctx.body.online ? 1 : 0);
      record(ctx, 'device.create', 'device', id);
    })();
    send(res, 201, { id, name, kind: ctx.body.kind, online: Boolean(ctx.body.online) });
  });

  router.patch('/v1/orgs/:org/devices/:id', (ctx, params, res) => {
    const device = requireDevice(db, params.org, params.id);
    auditDenials(db, ctx, { action: 'device.update', targetType: 'device', targetId: device.id },
      () => assertCan(db, ctx, 'device:update', device.id));

    const name = ctx.body.name === undefined ? device.name : deviceName(ctx.body.name);
    const online = ctx.body.online === undefined ? device.online : (ctx.body.online ? 1 : 0);
    db.transaction(() => {
      db.prepare('UPDATE devices SET name = ?, online = ? WHERE id = ?').run(name, online, device.id);
      record(ctx, 'device.update', 'device', device.id);
    })();
    send(res, 200, { id: device.id, name, online: online === 1 });
  });

  // Decommission: soft delete. It is a per-row action, so device:provision is checked on
  // this device. Live sessions end — the closest value the schema allows is
  // 'device_transferred' (there is no 'device_decommissioned').
  router.delete('/v1/orgs/:org/devices/:id', (ctx, params, res) => {
    const device = requireDevice(db, params.org, params.id);
    auditDenials(db, ctx, { action: 'device.decommission', targetType: 'device', targetId: device.id },
      () => assertCan(db, ctx, 'device:provision', device.id));

    db.transaction(() => {
      db.prepare('UPDATE devices SET deleted_at = ? WHERE id = ?').run(nowIso(), device.id);
      endActiveSessions(db, { orgId: params.org, deviceId: device.id, reason: 'device_transferred' });
      record(ctx, 'device.decommission', 'device', device.id);
    })();
    send(res, 204);
  });

  // POST { targetOrgId } — needs device:provision on the device here AND device:provision in
  // the target org. The target is resolved separately: the caller's token only covers this org.
  router.post('/v1/orgs/:org/devices/:id/transfer', (ctx, params, res) => {
    const device = requireDevice(db, params.org, params.id);
    const targetOrgId = ctx.body.targetOrgId;
    if (typeof targetOrgId !== 'string' || !targetOrgId) throw badRequest('targetOrgId is required');
    if (targetOrgId === params.org) throw badRequest('the device is already in that organization');

    auditDenials(db, ctx, { action: 'device.transfer', targetType: 'device', targetId: device.id }, () => {
      assertCan(db, ctx, 'device:provision', device.id);
      // Not an active member of a live target org -> the target is invisible.
      const target = db.prepare(
        `SELECT 1 FROM memberships m JOIN organizations o ON o.id = m.org_id
          WHERE m.org_id = ? AND m.user_id = ? AND m.status = 'active' AND o.deleted_at IS NULL`
      ).get(targetOrgId, ctx.userId);
      if (!target) throw notFound();
      const there = resolve(db, { userId: ctx.userId, orgId: targetOrgId }).permissions['device:provision'];
      if (there.effect !== 'allow') {
        throw forbidden('you need device:provision in the target organization', 'missing_permission');
      }
    });

    db.transaction(() => {
      db.prepare('UPDATE devices SET org_id = ? WHERE id = ?').run(targetOrgId, device.id);
      // Grants that named this device belonged to the old org. Revoke (not delete) them so
      // the history survives, and make their holders' tokens stale.
      const holders = db.prepare(
        'UPDATE grants SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL RETURNING org_id, user_id'
      ).all(nowIso(), device.id);
      for (const h of holders) bumpPermVersion(db, { orgId: h.org_id, userId: h.user_id });
      endActiveSessions(db, { orgId: params.org, deviceId: device.id, reason: 'device_transferred' });
      record(ctx, 'device.transfer', 'device', device.id);
      audit(db, { orgId: targetOrgId, actorId: ctx.userId, action: 'device.transfer_in', targetType: 'device',
        targetId: device.id, result: 'allow', requestId: ctx.requestId });
    })();
    send(res, 200, { id: device.id, orgId: targetOrgId });
  });

  // --- grants ------------------------------------------------------------------------

  router.get('/v1/orgs/:org/grants', (ctx, params, res) => {
    assertCan(db, ctx, 'user:read');
    const userId = ctx.query.get('userId');
    const rows = db.prepare(
      `SELECT g.id, g.user_id, g.device_id, g.effect, g.starts_at, g.expires_at, g.created_by, g.created_at,
              json_group_array(gp.permission) AS permissions
         FROM grants g JOIN grant_permissions gp ON gp.grant_id = g.id
        WHERE g.org_id = ? AND g.revoked_at IS NULL AND (? IS NULL OR g.user_id = ?)
        GROUP BY g.id
        ORDER BY g.created_at DESC, g.id`
    ).all(params.org, userId, userId);
    send(res, 200, { grants: rows.map((g) => ({ ...g, permissions: JSON.parse(g.permissions) })) });
  });

  // POST { userId, deviceId?, effect, permissions[], startsAt?, expiresAt? }
  router.post('/v1/orgs/:org/grants', (ctx, params, res) => {
    const { userId, effect, permissions } = ctx.body;
    const deviceId = ctx.body.deviceId ?? null;

    auditDenials(db, ctx, { action: 'grant.create', targetType: 'user', targetId: String(userId ?? '') }, () => {
      assertCan(db, ctx, 'grant:create');
      if (userId === ctx.userId) throw forbidden('you cannot create a grant for yourself', 'self_grant');
    });

    if (typeof userId !== 'string' || !userId) throw badRequest('userId is required');
    if (deviceId !== null && typeof deviceId !== 'string') throw badRequest('deviceId must be a string or null');
    if (effect !== 'allow' && effect !== 'deny') throw badRequest("effect must be 'allow' or 'deny'");
    if (!Array.isArray(permissions) || permissions.length === 0 || !permissions.every((p) => typeof p === 'string' && p)) {
      throw badRequest('permissions must be a non-empty array of strings');
    }
    const wanted = [...new Set(permissions)];

    if (!db.prepare("SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ? AND status = 'active'").get(params.org, userId)) {
      throw notFound();
    }
    if (deviceId !== null) requireDevice(db, params.org, deviceId);

    const now = nowIso();
    const startsAt = normalizeTs(ctx.body.startsAt ?? null, 'startsAt');
    const expiresAt = normalizeTs(ctx.body.expiresAt ?? null, 'expiresAt');
    if (expiresAt !== null && expiresAt <= now) {
      throw new HttpError(400, 'GRANT_EXPIRED', 'expiresAt is not in the future', 'expired_grant');
    }
    if (startsAt !== null && expiresAt !== null && expiresAt <= startsAt) throw badRequest('expiresAt must be after startsAt');

    // No laundering, for allow grants only: you cannot hand out authority you lack at this
    // scope. A deny only takes authority away, so it is not escalation (DECISIONS.md).
    if (effect === 'allow') {
      auditDenials(db, ctx, { action: 'grant.create', targetType: 'user', targetId: userId },
        () => assertMayGrant(db, ctx, wanted, deviceId));
    }

    const id = newId('grt');
    db.transaction(() => {
      db.prepare(
        `INSERT INTO grants (id, org_id, user_id, device_id, effect, starts_at, expires_at, created_by)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(id, params.org, userId, deviceId, effect, startsAt, expiresAt, ctx.userId);

      // The foreign key to permission_patterns rejects an unknown string such as
      // 'device:teleport' (foreign_keys is ON in db.js). Throwing rolls the grant back.
      const insert = db.prepare('INSERT INTO grant_permissions (grant_id, permission) VALUES (?,?)');
      for (const p of wanted) {
        try {
          insert.run(id, p);
        } catch (err) {
          if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') throw badRequest(`unknown permission: ${p}`, 'unknown_permission');
          throw err;
        }
      }
      // The grantee's token goes stale, so the change applies on their next request.
      // Live sessions are grandfathered and keep running.
      bumpPermVersion(db, { orgId: params.org, userId });
      record(ctx, 'grant.create', 'grant', id);
    })();

    send(res, 201, { id, userId, deviceId, effect, permissions: wanted, startsAt, expiresAt });
  });

  router.delete('/v1/orgs/:org/grants/:id', (ctx, params, res) => {
    auditDenials(db, ctx, { action: 'grant.revoke', targetType: 'grant', targetId: params.id },
      () => assertCan(db, ctx, 'grant:revoke'));

    db.transaction(() => {
      const revoked = db.prepare(
        'UPDATE grants SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL RETURNING user_id'
      ).get(nowIso(), params.id, params.org);
      if (!revoked) throw notFound();   // already revoked looks the same as never existed
      bumpPermVersion(db, { orgId: params.org, userId: revoked.user_id });
      record(ctx, 'grant.revoke', 'grant', params.id);
    })();
    send(res, 204);
  });
}
