// Sessions are records: opened, watched, ended. Nothing streams.
//
// Starting one needs session:start AND the mode's permission, both on the same device.
// `control` and `terminal` are exclusive per device; the partial unique index
// one_exclusive_session_per_device decides that, so two simultaneous requests cannot both win.
// Every session has an expiry; expired ones are ended lazily before sessions are read or started.

import { newId } from '../db.js';
import { send, badRequest, notFound, conflict, deviceBusy } from '../http.js';
import { assertCan, assertCanStartSession, resolve, MODE_PERMISSION } from '../permissions.js';
import { audit, auditDenials } from '../audit.js';
import { snapshotAuthority, sessionExpiry, sweepExpiredSessions } from '../lifecycle.js';

export function register(router, { db }) {
  // A session in the caller's org, or 404. Sessions of another org are invisible.
  const findSession = (ctx, id) => {
    sweepExpiredSessions(db, ctx.orgId);
    const s = db.prepare('SELECT * FROM sessions WHERE id = ? AND org_id = ?').get(id, ctx.orgId);
    if (!s) throw notFound();
    return s;
  };

  // POST { deviceId, mode }
  router.post('/v1/orgs/:org/sessions', (ctx, params, res) => {
    const { deviceId, mode } = ctx.body;
    if (!Object.hasOwn(MODE_PERMISSION, mode)) {
      throw badRequest(`mode must be one of: ${Object.keys(MODE_PERMISSION).join(', ')}`);
    }
    const device = typeof deviceId === 'string'
      ? db.prepare('SELECT id FROM devices WHERE id = ? AND org_id = ? AND deleted_at IS NULL').get(deviceId, params.org)
      : null;
    if (!device) throw notFound();

    auditDenials(db, ctx, { action: 'session.start', targetType: 'device', targetId: device.id },
      () => assertCanStartSession(db, ctx, mode, device.id));

    sweepExpiredSessions(db, params.org);
    const { permissions } = resolve(db, { userId: ctx.userId, orgId: params.org, deviceId: device.id });
    const id = newId('ses');
    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO sessions (id, org_id, user_id, device_id, mode, state, authorized_by, expires_at)
           VALUES (?,?,?,?,?,'active',?,?)`
        ).run(id, params.org, ctx.userId, device.id, mode,
          snapshotAuthority(db, {
            userId: ctx.userId, orgId: params.org, deviceId: device.id,
            permissions: [permissions['session:start'], permissions[MODE_PERMISSION[mode]]],
          }),
          sessionExpiry(db, params.org));
        audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'session.start', targetType: 'session',
          targetId: id, result: 'allow', requestId: ctx.requestId });
      })();
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const holder = db.prepare(
          "SELECT id FROM sessions WHERE device_id = ? AND state = 'active' AND mode IN ('control','terminal')"
        ).get(device.id);
        throw deviceBusy(`device is held by session ${holder?.id ?? '(unknown)'}`);
      }
      throw err;
    }
    send(res, 201, { id, deviceId: device.id, mode, state: 'active' });
  });

  router.get('/v1/orgs/:org/sessions', (ctx, params, res) => {
    assertCan(db, ctx, 'session:view');
    sweepExpiredSessions(db, params.org);
    const sessions = db.prepare(
      `SELECT s.id, s.user_id, u.name AS user_name, s.device_id, d.name AS device_name,
              s.mode, s.state, s.end_reason, s.started_at, s.expires_at, s.ended_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN devices d ON d.id = s.device_id
        WHERE s.org_id = ?
        ORDER BY s.started_at DESC, s.id
        LIMIT 200`
    ).all(params.org);
    send(res, 200, { sessions });
  });

  // Your own session, or anyone's with session:view. session:* permissions are not device
  // permissions, so this is the org-level answer.
  router.get('/v1/sessions/:id', (ctx, params, res) => {
    const session = findSession(ctx, params.id);
    if (session.user_id !== ctx.userId) assertCan(db, ctx, 'session:view');
    send(res, 200, { ...session, authorized_by: JSON.parse(session.authorized_by) });
  });

  // Your own session, or anyone's with session:terminate.
  router.delete('/v1/sessions/:id', (ctx, params, res) => {
    const session = findSession(ctx, params.id);
    const own = session.user_id === ctx.userId;
    if (!own) {
      auditDenials(db, ctx, { action: 'session.terminate', targetType: 'session', targetId: session.id },
        () => assertCan(db, ctx, 'session:terminate'));
    }

    db.transaction(() => {
      const ended = db.prepare(
        `UPDATE sessions SET state = 'ended', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), end_reason = ?
          WHERE id = ? AND state = 'active'`
      ).run(own ? 'user_stopped' : 'admin_terminated', session.id);
      if (ended.changes !== 1) throw conflict('session has already ended');
      audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: own ? 'session.stop' : 'session.terminate',
        targetType: 'session', targetId: session.id, result: 'allow', requestId: ctx.requestId });
    })();
    send(res, 204);
  });
}
