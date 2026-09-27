# DECISIONS

One section per decision that a reviewer might reasonably have made differently. Every section has
the same four parts, and the third and fourth are the ones we weigh most.

Rules, from `DISCOVERY-BRIEF.md`:

- cite something real in `Why` — a commit, a test, an error string, a file and line
- do not restate what a document says; describe what you did when the documents ran out
- six to twelve decisions is the expected range

---

### The org-level view means "allowed on at least one device" — a deny on one device does not remove it org-wide

**What I chose:** `resolve()` with no device (nav and page gating) uses a `union` scope in
`server/permissions.js`: an org-wide deny still wins everywhere, but a device-scoped deny only
removes the permission on that device. The org-level answer is `allow` if the role baseline or an
org-wide allow covers it, or if some device-scoped allow exists on a device that doesn't also
deny it.
**Why:** `PERMISSIONS.md` §3 calls the org-level view "the union across all devices in the org".
Checked on the fixture: the Acme viewer is denied `device:view` on kiosk-lobby-01 only; per device
that is `explicit_deny`, but org-level `device:view` stays `allow` (`role:viewer`), because she can
still view the other four devices. `check-permissions.js` 35/35.
**What I rejected:** applying every grant, device-scoped ones included, to the org-level question
with deny-wins. Then a deny on one device would switch the permission off org-wide — the viewer
would lose `device:view` everywhere because of one kiosk.
**What would change my mind:** a nav item or page that should disappear when the permission is
denied on any single device. I haven't found one in `UI-INVENTORY.md`; per-row buttons are
resolved per device anyway.

### No laundering: an org-wide grant needs org-wide authority

**What I chose:** `assertMayGrant` checks an org-wide grant against the caller's `orgWide` scope,
where only org-wide grants and the role baseline count — not the org-level union.
**Why:** with the union, Dana (a viewer in Globex with `device:control` on globex-desk-01 only)
reads as holding `device:control` org-level. Checked: `assertMayGrant` refuses her org-wide
`device:control` (403 `missing_permission`) and allows it scoped to globex-desk-01.
**What I rejected:** reusing the org-level union for the laundering check. It would let a
one-device allow be handed out across the whole org — exactly the escalation D9 forbids.
**What would change my mind:** a case where the documents expect a device-scoped holder to grant
org-wide. I found none.

### The no-laundering check applies to allow grants, not to deny grants

**What I chose:** `POST /grants` calls `assertMayGrant` only when `effect` is `allow`
(`server/routes/devices.js`).
**Why:** laundering means handing out authority you don't have. A deny only takes authority
away. Checked: an Acme admin (no `org:delete`) is refused `allow org:delete` and `allow *` (403), and may create `deny org:delete` for a viewer (201).
**What I rejected:** checking denies too, the literal reading of `AUTH-DATA-MODEL.md` §8 ("the caller holds every permission being granted"). It would stop an admin from restricting a viewer's `org:delete` — a harmless restriction — for no security gain.
**What would change my mind:** a way a deny grant can increase someone's authority. Deny always wins and never allows, so I can't construct one.

### The audit log records refused changes, not refused reads

**What I chose:** `auditDenials` wraps the permission check on routes that change something
(and sign-in); plain `GET` routes call `assertCan` without it. Success rows are written inside the same transaction as the change.
**Why:** the console opens several gated pages; logging every refused GET would fill the log with noise and hide "who tried to change what". `check-api.js` "audit records DENIED attempts too" passes: the viewer's refused session start is there with `reason_code = missing_permission`.
**What I rejected:** auditing every 403. Complete, but one page load could write several rows.
**What would change my mind:** a requirement to know who tried to *read* something they
couldn't — then GETs on sensitive resources (audit, members) would be wrapped too.

### An invite never changes an existing account's password

**What I chose:** accepting an invite for an email that already has an account attaches the
membership and ignores `name`/`password`. Only a brand-new account takes them.
**Why:** the invite token is a bearer credential. If accept could set the password, anyone
holding an invite link for an existing user could take over that user's account in every org. Checked: viewer removed → re-invited → accepted with an empty body → same user id, old password still works.
**What I rejected:** always writing the submitted password (simpler form handling).
**What would change my mind:** a flow where the existing user is signed in when accepting — then the account is proven and a password isn't needed at all.

### Routes that ask no permission question still refuse a suspended member

**What I chose:** `POST /v1/orgs` checks that the caller's membership is active before creating an org.
**Why:** a suspended member gets through `context.js` on purpose (see the TOKEN_STALE decision), and the engine refuses them — but only on routes that ask it. Creating an org asks no permission, so without an explicit check a suspended member could still create orgs.
**What I rejected:** relying on the engine alone.
**What would change my mind:** nothing about the principle; the risk is a route I missed. The other ungated routes (`/auth/me`, `/auth/token`, leave, your own session, your own effective permissions) only read, switch away, or reduce your access.

---

### A hidden button explains itself somewhere else: the "why not?" panel

**What I chose:** buttons are present or absent, exactly as the contract says. The header has a collapsible "You hold N of M permissions here — why not the rest?" list (`web/components/Access.jsx`) showing each permission you don't hold with the server's reason, worded from `reason`/`source`:`implicit` → "not part of your role, and nobody granted it"; `explicit_deny` → "taken away by grant:…"; `suspended` → "your membership is suspended".
**Why:** an absent element can't tell you why it's absent, and "nobody gave you this" needs a different conversation from "someone took this away". The wording comes from the server's provenance, not from any rule in the browser.
**What I rejected:** a disabled button with a tooltip — the contract forbids a disabled state, and a greyed-out Control button advertises an action you can't take.
**What would change my mind:** users missing per-device reasons. This panel is org-level; the per-device reason is in each row's data but isn't shown.

### Two endpoints beyond the contract: `GET /v1/roles` and `POST /v1/auth/logout`

**What I chose:** added both (`server/routes/orgs.js`, `server/routes/auth.js`).
**Why:** the invite and role-change dropdowns need the role list, and writing the five
documented roles into `web/` would miss any role that exists only in the database (my fixture has `reviewer`). And without a logout route, "sign out" can't revoke the refresh cookie — a reload signs you straight back in. Both are additions; no contracted endpoint changed, and `check-api.js` is still 66/66.
**What I rejected:** hardcoding roles in the console (breaks on the personalised fixture);
sign-out that only forgets the in-memory token (not really signing out).
**What would change my mind:** if graders require the API surface to be exactly the table.
Then roles could come from `GET /effective` responses and logout would be documented as a gap.

## Where this repo argues with itself

The documents contradict each other, or contradict the schema, in at least one place. Name each
one you found. For each: quote both statements, say which you built against, and say why.

Building against the written rule and arguing in writing is a **full-marks** answer. Silently
working around it, or quietly picking one and saying nothing, scores zero on the section — we
cannot tell the difference between a decision and an oversight.

### A suspended member's token: `401 TOKEN_STALE` or `403 suspended`?

`AUTH-DATA-MODEL.md` §1: *"It goes up whenever something authorization-relevant changes: a role
change, a grant created or revoked, a suspension, a removal."* and *"A token whose `pv` no longer
matches gets `401 TOKEN_STALE`."*

`AUTH-DATA-MODEL.md` §10: *"a token for a suspended membership → `403` with an empty permission
set"*.

Both cannot hold: suspending bumps `perm_version`, so every token the member already holds is
stale, and the freshness check would answer 401 before anything could answer 403.

**What I chose:** keep the version bump, but skip the freshness check for a `suspended`
membership only (`server/context.js`, the `if (membership.status !== 'suspended')` line). The
request then reaches the permission engine, which denies everything for a suspended membership
with reason `suspended` → 403.
**Why:** the 403 tells the user and the console the real cause ("you are suspended"); a 401 only
says "refresh your token", and refreshing cannot fix it. Checked with a scratch test against a
copy of `app.db`: suspended + old token passes `context.js`; removed → 401; stale `pv` on an
active member → 401 `TOKEN_STALE`.
**What I rejected:** always checking freshness (one rule, simpler). It makes the §10 behaviour
unreachable — a suspended user would only ever see `TOKEN_STALE`.
**What would change my mind:** if skipping the check let a suspended member do anything. It
must not, and it doesn't: `permissions.js` denies every permission for a `suspended` membership with reason `suspended` (`check-permissions.js` "suspended: device:list denied / reason=suspended").

### The schema's end reasons have no value for decommissioning or deleting an org

`PERMISSIONS.md` §7 lists `device_transferred` for *"the device is transferred or
decommissioned"*, and nothing for deleting an org. `db/schema.sql` allows only `user_stopped, user_suspended, membership_removed, device_transferred, admin_terminated, session_expired, superseded` — anything else fails the CHECK constraint.

**What I chose:** decommission ends sessions as `device_transferred` (as §7 says); deleting an org ends them as `admin_terminated`, the closest existing value.
**Why:** I can't edit the schema, and a new value would be a database error.
**What I'd argue for:** separate `device_decommissioned` and `org_deleted` values, so the session history says what actually happened.

## Sources and tools

- **Claude Code :** used to read and explain the specification, diagnose the
  Windows setup failures (`rm -f`, `URL.pathname` paths), run setup commands, review
  `verifyAccessToken`, run the length-check experiment, and write `server/context.js`, `server/permissions.js`, `server/lifecycle.js`, `server/audit.js`, `server/routes/*`, the whole console under `web/`, and their scratch tests (including the Edge-based Playwright run). The decisions on suspended members, deny grants and audit scope were mine. Logged in `BUILD-LOG.md` Phases 0–7.
- **React, Vite, better-sqlite3, Playwright:** the libraries the starter ships with; nothing else was added.

## Deliberately not built

- **Real remote access** — no screen capture, input or shell. Sessions are records; that is a hard
  rule of the brief, not a scope choice. The "Transfer files" button only explains this.
- **Email delivery for invites** — the API returns the invite link once and the console shows it
  to copy. Sending mail needs an external service and credentials the task doesn't provide.
- **Password reset / change password** — not in the endpoint table, and a reset flow is its own
  security problem (tokens, expiry, enumeration). Out of scope for two days.
- **Rate limiting on sign-in** — it matters for production (see Open threads), but it needs state
  per IP/account and a policy; I spent the time on the permission model instead.
- **Pagination except on the audit log** — members, devices, grants and sessions are small in any
  org this build will see (the device list is 36 ms at 505 devices). The audit log grows without
  bound, so it is the one list that pages (limit 1–200, out-of-range is a 400, not clamped).
- **Search and bulk actions** — useful at scale, but they add surface without touching the
  permission model, which is what this task is about.
- **A device-transfer button** — the API endpoint exists and is tested; the console has no form
  for it yet.
- **Caching of resolved permissions** — every request resolves fresh from the database (4 queries
  for a whole device list). There is nothing to invalidate, so nothing can serve stale authority.
  A cache would have to be keyed by (user, org) and checked against `perm_version`, and at these
  timings it isn't needed.
