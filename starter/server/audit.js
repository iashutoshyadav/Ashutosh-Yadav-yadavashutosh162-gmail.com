// Append-only audit writes. audit_events has BEFORE UPDATE / BEFORE DELETE triggers, so
// this module only ever INSERTs.
//
// What is recorded (see DECISIONS.md): every successful change, written by the route in the
// same transaction as the change, and every REFUSED change or sign-in. Refused reads (a 403
// on a GET) are not recorded — the console probes pages, and that noise would bury the
// attempts the log exists to show.

import { newId, nowIso } from './db.js';

export function audit(db, { orgId, actorId = null, action, targetType = null, targetId = null,
  result, reasonCode = null, requestId = null }) {
  db.prepare(
    `INSERT INTO audit_events
       (id, org_id, actor_id, action, target_type, target_id, result, reason_code, request_id, at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(newId('aud'), orgId, actorId, action, targetType, targetId, result, reasonCode, requestId, nowIso());
}

// Run fn(); if it refuses with a permission error (403), record the refusal, then rethrow.
// Only the refusal is written here — the success row belongs to the route, so one action
// never produces two rows.
export function auditDenials(db, ctx, meta, fn) {
  try {
    return fn();
  } catch (err) {
    if (err?.status === 403) {
      audit(db, {
        orgId: ctx.orgId,
        actorId: ctx.userId,
        result: 'deny',
        reasonCode: err.reason ?? 'missing_permission',
        requestId: ctx.requestId,
        ...meta,
      });
    }
    throw err;
  }
}
