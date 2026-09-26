// Invites: the only way a person joins an org.
//
// The raw token is a bearer credential: returned once from POST, stored only as a hash,
// never logged. The database does the race-sensitive work — `one_live_invite_per_email`
// stops a double invite, and accepting is a conditional UPDATE, so two concurrent accepts
// cannot both succeed.

import { newId, nowIso, bumpPermVersion } from '../db.js';
import { send, badRequest, notFound, conflict, gone } from '../http.js';
import { assertCan } from '../permissions.js';
import { audit, auditDenials } from '../audit.js';
import { assertRoleExists, assertCanAssign } from '../lifecycle.js';
import { hashPassword, hashInviteToken, newInviteToken } from '../auth.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isUniqueViolation = (err) => String(err?.code ?? '').startsWith('SQLITE_CONSTRAINT');

export function register(router, { db }) {
  // --- managing invites (authenticated) ---------------------------------------------

  router.post('/v1/orgs/:org/invites', (ctx, params, res) => {
    const email = typeof ctx.body.email === 'string' ? ctx.body.email.trim().toLowerCase() : '';
    const role = ctx.body.role;
    if (!EMAIL.test(email) || email.length > 320) throw badRequest('a valid email is required');
    assertRoleExists(db, role);

    auditDenials(db, ctx, { action: 'invite.create', targetType: 'email', targetId: email }, () => {
      assertCan(db, ctx, 'user:invite');
      assertCanAssign(db, ctx.role, role);
    });

    const member = db.prepare(
      `SELECT m.status FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = ? AND u.email = ? AND m.status IN ('active', 'suspended')`
    ).get(params.org, email);
    if (member) throw conflict('that person is already a member of this organization');

    const raw = newInviteToken();
    const id = newId('inv');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO invites (id, org_id, email, role, token_hash, invited_by, expires_at)
           VALUES (?,?,?,?,?,?,?)`
        ).run(id, params.org, email, role, hashInviteToken(raw), ctx.userId, expiresAt);
        audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'invite.create', targetType: 'invite',
          targetId: id, result: 'allow', requestId: ctx.requestId });
      })();
    } catch (err) {
      // one_live_invite_per_email: there is already a pending invite for this address.
      if (isUniqueViolation(err)) throw conflict('there is already a pending invite for that email');
      throw err;
    }

    send(res, 201, { id, email, role, expiresAt, inviteToken: raw });
  });

  router.get('/v1/orgs/:org/invites', (ctx, params, res) => {
    assertCan(db, ctx, 'user:invite');
    const invites = db.prepare(
      `SELECT id, email, role, invited_by, expires_at, created_at FROM invites
        WHERE org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
        ORDER BY created_at DESC`
    ).all(params.org);
    send(res, 200, { invites });
  });

  router.delete('/v1/orgs/:org/invites/:id', (ctx, params, res) => {
    auditDenials(db, ctx, { action: 'invite.revoke', targetType: 'invite', targetId: params.id },
      () => assertCan(db, ctx, 'user:invite'));

    // Only a pending invite can be cancelled; an accepted or cancelled one is not visible here.
    const changed = db.transaction(() => {
      const r = db.prepare(
        'UPDATE invites SET revoked_at = ? WHERE id = ? AND org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL'
      ).run(nowIso(), params.id, params.org);
      if (r.changes === 1) {
        audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'invite.revoke', targetType: 'invite',
          targetId: params.id, result: 'allow', requestId: ctx.requestId });
      }
      return r.changes;
    })();
    if (changed !== 1) throw notFound();
    send(res, 204);
  });

  // --- redeeming (PUBLIC: the token is the credential) ----------------------------------

  // Just enough to render "You've been invited to <org> as <role>". No ids, no org data.
  router.get('/v1/invites/:token', (ctx, params, res) => {
    const invite = findUsableInvite(db, params.token);
    send(res, 200, { email: invite.email, role: invite.role, orgName: invite.org_name, expiresAt: invite.expires_at });
  });

  // POST { name, password }. A new person gets an account; an existing account is attached
  // and keeps its own name and password — the invite token must not be a way to reset
  // someone's password. A previously removed member's row is reactivated, because
  // memberships are UNIQUE(org_id, user_id) and removal never deletes the row.
  router.post('/v1/invites/:token/accept', (ctx, params, res) => {
    const invite = findUsableInvite(db, params.token);
    const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(invite.email);

    const name = typeof ctx.body.name === 'string' ? ctx.body.name.trim() : '';
    const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
    if (!existing) {
      if (name.length < 1 || name.length > 200) throw badRequest('name must be 1-200 characters');
      if (password.length < 8) throw badRequest('password must be at least 8 characters');
    }

    const result = db.transaction(() => {
      const now = nowIso();
      // The claim. Exactly one concurrent accept can flip accepted_at from NULL.
      const claim = db.prepare(
        `UPDATE invites SET accepted_at = ?
          WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`
      ).run(now, invite.id, now);
      if (claim.changes !== 1) throw conflict('this invite has already been used');

      let userId = existing?.id;
      if (!userId) {
        userId = newId('usr');
        db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)')
          .run(userId, invite.email, name, hashPassword(password));
      }

      const membership = db.prepare('SELECT * FROM memberships WHERE org_id = ? AND user_id = ?').get(invite.org_id, userId);
      if (membership && ['active', 'suspended'].includes(membership.status)) {
        throw conflict('you are already a member of this organization');
      }
      if (membership) {
        db.prepare(
          `UPDATE memberships SET status = 'active', role = ?, invited_by = ?, joined_at = ? WHERE id = ?`
        ).run(invite.role, invite.invited_by, now, membership.id);
        bumpPermVersion(db, { orgId: invite.org_id, userId });
      } else {
        db.prepare(
          `INSERT INTO memberships (id, org_id, user_id, role, status, invited_by, joined_at)
           VALUES (?,?,?,?,'active',?,?)`
        ).run(newId('mem'), invite.org_id, userId, invite.role, invite.invited_by, now);
      }

      db.prepare('UPDATE invites SET accepted_by = ? WHERE id = ?').run(userId, invite.id);
      audit(db, { orgId: invite.org_id, actorId: userId, action: 'invite.accept', targetType: 'invite',
        targetId: invite.id, result: 'allow', requestId: ctx.requestId });
      return { userId, orgId: invite.org_id, role: invite.role };
    })();

    send(res, 200, result);
  });
}

// Raw token -> invite row, refusing every state in which it cannot be used.
function findUsableInvite(db, raw) {
  if (typeof raw !== 'string' || raw.length < 16) throw notFound();
  const invite = db.prepare(
    `SELECT i.*, o.name AS org_name, o.deleted_at AS org_deleted_at
       FROM invites i JOIN organizations o ON o.id = i.org_id
      WHERE i.token_hash = ?`
  ).get(hashInviteToken(raw));

  if (!invite || invite.org_deleted_at) throw notFound();
  if (invite.accepted_at) throw conflict('this invite has already been used');
  if (invite.revoked_at) throw gone('this invite was cancelled');
  if (invite.expires_at <= nowIso()) throw gone('this invite has expired');
  return invite;
}
