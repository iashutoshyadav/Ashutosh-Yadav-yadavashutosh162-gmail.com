// The permission resolution engine. THE ONLY PLACE allow-vs-deny is decided.
//
// Everything is read from the database on every call: the catalogue (`permissions`), the
// role baseline (`role_permissions`), the membership and the grants. Nothing about roles or
// permissions is written into this file, so a role or permission that exists only in the
// database (the personalised fixture) resolves exactly like a documented one.
//
// Three scopes, one decision function (`decide`):
//   device  — the exact question for one device: org-wide grants + that device's grants
//   union   — the org-level view used for nav and page gating: "can you do this on at
//             least one device?" (deviceId === null in resolve())
//   orgWide — only org-wide grants count; used by assertMayGrant for an org-wide grant, so a
//             device-scoped allow cannot be laundered into an org-wide one
//
// Precedence inside a scope: explicit deny > role baseline > allow grant > implicit deny.

import { forbidden, badRequest } from './http.js';

export const MODE_PERMISSION = { view: 'device:view', control: 'device:control', terminal: 'device:terminal' };

const allow = (source) => ({ effect: 'allow', source, reason: null });
const deny = (source, reason) => ({ effect: 'deny', source, reason });

// A grant pattern is '*', '<resource>:*' or an exact key.
function matches(pattern, key) {
  if (pattern === '*' || pattern === key) return true;
  return pattern.endsWith(':*') && key.startsWith(pattern.slice(0, -1));
}

// --- loading ----------------------------------------------------------------------

// Everything a decision needs, in four queries, whatever the number of devices.
function loadInputs(db, { userId, orgId, now }) {
  const at = now.toISOString();
  const catalogue = db.prepare('SELECT key FROM permissions ORDER BY key').all().map((r) => r.key);
  const membership = db.prepare('SELECT role, status FROM memberships WHERE org_id = ? AND user_id = ?')
    .get(orgId, userId) ?? null;

  if (!membership || membership.status !== 'active') {
    return { catalogue, membership, baseline: new Set(), grants: [] };
  }

  const baseline = new Set(
    db.prepare('SELECT permission FROM role_permissions WHERE role = ?').all(membership.role).map((r) => r.permission)
  );

  // Half-open window: starts_at <= now < expires_at. Timestamps are stored as ISO-8601
  // UTC strings, so string comparison is time comparison.
  const rows = db.prepare(
    `SELECT g.id, g.device_id, g.effect, gp.permission
       FROM grants g
       JOIN grant_permissions gp ON gp.grant_id = g.id
      WHERE g.org_id = ? AND g.user_id = ? AND g.revoked_at IS NULL
        AND (g.starts_at IS NULL OR g.starts_at <= ?)
        AND (g.expires_at IS NULL OR g.expires_at > ?)
      ORDER BY g.created_at, g.id`
  ).all(orgId, userId, at, at);

  return { catalogue, membership, baseline, grants: rows };
}

// Why a membership that is not active has no permissions at all.
function inactiveReason(membership) {
  if (!membership) return 'not_a_member';
  if (membership.status === 'suspended') return 'suspended';
  return 'inactive_membership';
}

// --- deciding ----------------------------------------------------------------------

const firstGrant = (grants, effect, key, where = () => true) =>
  grants.find((g) => g.effect === effect && matches(g.permission, key) && where(g));

function decideKey(key, { baseline, role, grants }, scope) {
  const orgWide = (g) => g.device_id === null;

  if (scope.kind === 'device') {
    const applies = (g) => g.device_id === null || g.device_id === scope.deviceId;
    const denied = firstGrant(grants, 'deny', key, applies);
    if (denied) return deny(`grant:${denied.id}`, 'explicit_deny');
    if (baseline.has(key)) return allow(`role:${role}`);
    const allowed = firstGrant(grants, 'allow', key, applies);
    return allowed ? allow(`grant:${allowed.id}`) : deny(null, 'implicit');
  }

  // Org-wide rules are the same for 'union' and 'orgWide'.
  const deniedOrgWide = firstGrant(grants, 'deny', key, orgWide);
  if (deniedOrgWide) return deny(`grant:${deniedOrgWide.id}`, 'explicit_deny');
  if (baseline.has(key)) return allow(`role:${role}`);
  const allowedOrgWide = firstGrant(grants, 'allow', key, orgWide);
  if (allowedOrgWide) return allow(`grant:${allowedOrgWide.id}`);

  if (scope.kind === 'union') {
    // Allowed on SOME device: a device-scoped allow whose own device does not also deny it.
    const usable = firstGrant(grants, 'allow', key, (g) =>
      g.device_id !== null && !firstGrant(grants, 'deny', key, (d) => d.device_id === g.device_id));
    if (usable) return allow(`grant:${usable.id}`);
  }

  return deny(null, 'implicit');
}

function decide(inputs, scope) {
  const { catalogue, membership } = inputs;
  const permissions = {};

  if (!membership || membership.status !== 'active') {
    const reason = inactiveReason(membership);
    for (const key of catalogue) permissions[key] = deny(null, reason);
    return { role: membership?.role ?? null, permissions };
  }

  const facts = { ...inputs, role: membership.role };
  for (const key of catalogue) permissions[key] = decideKey(key, facts, scope);
  return { role: membership.role, permissions };
}

const scopeFor = (deviceId) => (deviceId == null ? { kind: 'union' } : { kind: 'device', deviceId });

// --- public API ----------------------------------------------------------------------

// One user's permission set in one org. deviceId === null means the org-level view.
export function resolve(db, { userId, orgId, deviceId = null, now = new Date() }) {
  return decide(loadInputs(db, { userId, orgId, now }), scopeFor(deviceId));
}

// Batched form for list endpoints: the same answer as resolve() per device, from one load.
export function resolveDevices(db, { userId, orgId, deviceIds, now = new Date() }) {
  const inputs = loadInputs(db, { userId, orgId, now });
  const byDevice = {};
  for (const id of deviceIds) byDevice[id] = decide(inputs, { kind: 'device', deviceId: id }).permissions;
  return { role: inputs.membership?.role ?? null, byDevice };
}

export function can(db, ctx, permission, deviceId = null) {
  const { permissions } = resolve(db, { userId: ctx.userId, orgId: ctx.orgId, deviceId });
  return permissions[permission]?.effect === 'allow';
}

// The 403 reason for a denied entry. `implicit` means "nobody granted it".
function refusalReason(entry) {
  switch (entry?.reason) {
    case 'explicit_deny': return 'explicit_deny';
    case 'suspended': return 'suspended';
    case 'not_a_member':
    case 'inactive_membership': return 'not_a_member';
    default: return 'missing_permission';
  }
}

// Throws 403 carrying the reason code, so a refusal is debuggable.
export function assertCan(db, ctx, permission, deviceId = null) {
  const { permissions } = resolve(db, { userId: ctx.userId, orgId: ctx.orgId, deviceId });
  const entry = permissions[permission];
  if (entry?.effect !== 'allow') {
    throw forbidden(`missing permission: ${permission}`, refusalReason(entry));
  }
}

// No privilege laundering: you may only grant authority you hold at that scope. For an
// org-wide grant only your org-wide authority counts — holding a permission on one device
// does not let you hand it out across the whole org.
export function assertMayGrant(db, ctx, patterns, deviceId = null) {
  const inputs = loadInputs(db, { userId: ctx.userId, orgId: ctx.orgId, now: new Date() });
  const scope = deviceId == null ? { kind: 'orgWide' } : { kind: 'device', deviceId };
  const { permissions } = decide(inputs, scope);

  for (const pattern of patterns) {
    // An unknown pattern matches nothing here; the grant_permissions foreign key rejects it.
    for (const key of inputs.catalogue.filter((k) => matches(pattern, k))) {
      if (permissions[key].effect !== 'allow') {
        throw forbidden(`you cannot grant a permission you do not hold at this scope: ${key}`,
          refusalReason(permissions[key]));
      }
    }
  }
}

// The compound check: session:start AND the mode's permission, both on the same device.
// session:start is checked first; each failure has its own reason.
export function assertCanStartSession(db, ctx, mode, deviceId) {
  const modePermission = MODE_PERMISSION[mode];
  if (!modePermission) throw badRequest(`unknown session mode: ${mode}`);

  const { permissions } = resolve(db, { userId: ctx.userId, orgId: ctx.orgId, deviceId });

  const start = permissions['session:start'];
  if (start?.effect !== 'allow') {
    throw forbidden('you cannot start sessions on this device', refusalReason(start));
  }
  if (permissions[modePermission]?.effect !== 'allow') {
    throw forbidden(`${mode} sessions also require ${modePermission} on this device`, 'missing_device_permission');
  }
}
