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

---

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

## Sources and tools

- **Claude Code :** used to read and explain the specification, diagnose the
  Windows setup failures (`rm -f`, `URL.pathname` paths), run setup commands, review
  `verifyAccessToken`, run the length-check experiment, and write `server/context.js`, `server/permissions.js` and their scratch tests (the suspended-member choice was mine). Logged in `BUILD-LOG.md` Phases 0–2.

## Deliberately not built

What you chose not to build, and the reason. A scope cut with a stated reason is a senior
judgement. An unmentioned gap is a gap.
