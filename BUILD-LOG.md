# BUILD-LOG

Append to this as you go. Commit it with the code it describes — the timestamps are part of the
evidence, and a log that arrives in one commit at the end reads as what it is.

Five lines is a real entry. Short and dated is better than long and reconstructed.

The categories we look for are listed in `DISCOVERY-BRIEF.md`. The example below shows the
*shape* of a good entry; it is a recreation of something already printed in `README.md`, so it
gives nothing away.

---

## Phase 0 — orientation

### 2026-09-26 · setup on Windows

Expected `npm run db:reset` to just work. It did not, for two reasons, both in the provided
plumbing rather than the files I write:

- `db:reset` was `rm -f app.db ... && npm run db:load`. `rm -f` does not exist in cmd/PowerShell.
  `scripts/load-db.js` already deletes the old database files itself, so I changed the script
  to just `node scripts/load-db.js`.
- `load-db.js` built file paths with `new URL(p, import.meta.url).pathname`. On Windows that
  gives `/C:/Users/ashutosh%20yadav/...` — a leading slash and `%20` for the space in my user
  folder — so `schema.sql` was "not found". Changed it to `fileURLToPath(new URL(...))`. The
  same pattern builds `DIST` in `server/index.js`, which the UI tests use in production mode,
  so I fixed it there too. The other `url.pathname` uses in `server/index.js` (lines 43, 79,
  114) are request URLs, not file paths, and are correct as they are.

After the fix `db:reset` seeds 3 orgs, 8 users, 20 permissions, 27 patterns. The third org is
the personalised one: extra role `reviewer` (rank 35), extra permission `device:reboot`,
allowed on `dev_p_bb3398_a` and denied on `dev_p_bb3398_b`. 20 permissions, not the 19 the
documents list — so the catalogue has to come from the `permissions` table, not from the docs.

Starting line against the untouched skeleton:
- `check-jwt.js`: 0 passed, 43 failed (verifyAccessToken is a stub)
- `check-permissions.js` and `npm run personalisation`: crash on the permissions.js stub

Open: `npx playwright install chromium` timed out downloading (network). Retry before the
console phase. `npm start` still uses Unix-only `NODE_ENV=production ...`; not needed yet.

Tooling: the Windows diagnosis and setup commands were done with Claude Code (cited in
DECISIONS.md).

## Phase 1 — token verification

### 2026-09-26 · verifyAccessToken

`check-jwt.js`: 43/43 on the first run. No test failed, so the suite gave me nothing to fix —
which also means the suite alone can't tell me which of my checks are actually load-bearing.

Design: every check throws a plain `Error`, and one outer `catch` in `verifyAccessToken`
turns all of them into `401 invalid access token`. So a header that decodes to `null`, bad
base64, or any unexpected throw becomes a 401 instead of a 500, and every rejection reads the
same (no hint to an attacker about which check failed). Cost: a bug in my own code would also
surface as "invalid token", which is harder to debug.

Experiment: removed `actual.length !== expected.length ||` in front of `timingSafeEqual`
(auth.js:106) and re-ran. Still 43/43 — including "signature truncated" and "signature empty".
Reason: `timingSafeEqual` throws `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` when the lengths differ,
and my outer `catch` turns that throw into the same 401. So in my code the length check is not
what rejects a short signature — the catch-all is. Put it back anyway: it makes the rejection
explicit instead of relying on an exception from a library, and it keeps working if the outer
catch is ever narrowed. Lesson: a green suite doesn't prove each line matters; removing one
does.

Open: the payload is parsed before the signature is checked (auth.js:87). Nothing reads the
claims until the signature passes, but verifying the signature first would be stricter.

Re-ran the experiment myself: commented out the length check, still 43/43, restored it.

## Phase 2 — caller context and the resolution engine

### 2026-09-26 · context.js

Wrote `authenticate()` with Claude Code. Order of checks: bearer header → `verifyAccessToken`
→ membership joined with its org → removed/deleted → freshness → URL org must equal token org. Found a contradiction in AUTH-DATA-MODEL.md: suspension bumps `perm_version` (§1), which makes the member's token stale → 401, but §10 says a suspended member gets 403. I chose 403: skip the freshness check only for `suspended`. Written up in DECISIONS.md.
Scratch test against a copy of app.db, 10 cases: valid → caller; no/garbage token → 401; Acme token on a Globex URL → 404 (invisible, not 403); stale pv → 401 TOKEN_STALE; removed → 401;
deleted org → 404; suspended with its old token → passes through. That last one is only safe if permissions.js denies everything for `suspended` — must check that next.
Can't run check-api.js yet: it needs the routes (Phase 3).

### 2026-09-26 · permissions.js

Written with Claude Code. Reads the catalogue, baseline, membership and grants from the database on every call; nothing about roles is in the code. Precedence per permission: explicit deny > role baseline > allow grant > implicit deny.

Results: `check-permissions.js` 35/35, `npm run personalisation` 18/18 — so the undocumented `reviewer` role and `device:reboot` permission resolve with no special code, just from the tables. The suspended case from context.js is now closed: suspended → every permission denied, reason `suspended`.

Question the docs left open: what does the org-level (no device) answer mean when a permission is denied on ONE device? If every device-scoped grant applies with deny-wins, the Acme viewer's deny on kiosk-lobby-01 would switch `device:view` off for the whole org. Chose "allowed on at least one device" instead: org-level `device:view` for her = allow (role:viewer), on the kiosk = explicit_deny. Knock-on: that union makes Dana (Globex viewer, control on one device) look like
she holds `device:control` org-level — so the laundering check uses org-wide authority only.
Checked: she can't grant it org-wide (403), can grant it on globex-desk-01. Both in DECISIONS.md.

## Phase 3 — orgs, members, invites

### 2026-09-26 · all routes + lifecycle.js + audit.js

Written with Claude Code, in one pass: lifecycle.js, audit.js and the five route files. I made two calls when asked (deny grants skip the laundering check; only refused changes are audited — see Phase 4 and 6). `check-api.js`: 66/66 on the first run. The earlier suites still pass (43, 35, 18).

Because the public suite passed first time, it can't tell me much. So a scratch test with 21 awkward cases the suite doesn't cover, all passing. The ones worth remembering:

- Re-inviting a removed member. `memberships` is UNIQUE(org_id, user_id) and removal only sets
  status='removed', so the row is still there — accept has to UPDATE it back to active, an
  INSERT would hit the constraint. Checked: remove viewer → re-invite → accept → same user id.
- An invite for someone who already has an account must NOT set their password: otherwise
  whoever holds the invite link could take over the account. Existing accounts are attached and
  keep their password (checked: old password still works after accept).
- POST /orgs asks no permission question, so the engine's "suspended = deny everything" never
  runs there. Added an explicit active-membership check on that route.
- Owners: the rank rule says you can only change members ranked below you, but check-api expects
  an owner to demote another owner (200). So owners are exempt from the rank rule; the
  last-owner check still protects the org.

## Phase 4 — devices and grants

Laundering: an admin cannot grant `org:delete` or `*` (403 — she doesn't hold org:delete), but CAN create a deny of `org:delete`: my choice was that taking authority away is not escalation.
A grant naming another org's device → 404, not 403.
Transfer: grants that named the device are revoked (revoked_at), not deleted, so the history survives. Checked: viewer-in-target → 403; owner-in-target → 200 and the device is 404 in the old org; target org she isn't in → 404.

## Phase 5 — sessions

Race test: 4 `control` starts on one device fired in parallel → exactly one 201 and three 409 DEVICE_BUSY. There is no "is the device free?" check in the code; the INSERT hits the partial unique index `one_exclusive_session_per_device`, and the 409 comes from catching that error.
Order in assertCanStartSession: session:start first (reason missing_permission), then the mode permission (reason missing_device_permission), so the caller can tell "you can't open sessions here" from "not in this mode". Expired sessions are ended lazily before a start, otherwise an expired control session would hold its device forever.

## Phase 6 — audit

My call: record every successful change and every REFUSED change or sign-in, but not refused reads. A refused GET is usually the console probing a page, and would bury the attempts that matter. Success rows are written inside the same transaction as the change, so a change that rolls back leaves no audit row. Failed sign-in for a real account is recorded in each of that user's orgs; an unknown email can't be — audit rows need an org.

## Phase 7 — the console

### 2026-09-26 · web/

Written with Claude Code: App.jsx (shell, org switcher, nav), api.js (token in memory only),one component per card, styles.css with one colour set per org theme.

Presence: every gated button goes through one component (`Gate` in components/common.jsx)
that renders nothing unless the server's entry is `allow`. The nav table in App.jsx names
permissions, never roles. Device buttons read `device.permissions` from each row, so Dana sees Control on globex-desk-01 and not on globex-kiosk-02 with no logic in the browser.

Instinct vs server: a hidden button can't explain why it's missing. So the header has a "why not the rest?" panel listing every permission you don't hold with the server's reason 
"nobody granted it" (implicit) vs "taken away by grant:…" (explicit_deny).

Things the API didn't have that the console needed:
- a list of roles for the invite / role-change dropdowns. Hardcoding the five documented roles
  would miss the personalised `reviewer`, so added `GET /v1/roles` (reads the table).
- sign-out. With no logout route, the refresh cookie signs you straight back in on reload.
  Added `POST /v1/auth/logout`: revokes the cookie's token family and clears the cookie.
- a stale token (someone changed my permissions) used to mean "refresh", and refresh always
  returns the alphabetically first org — so I'd be thrown out of the org I was in. api.js now refreshes and re-mints a token for the same org, then retries once.

Testing: `npx playwright install chromium` still times out on this network, so I ran the
unchanged suite in the Microsoft Edge that ships with Windows (a scratch Playwright config with `channel: 'msedge'`; the repo's config is untouched). First run: 24/25 — the one failure was Edge failing to launch on the first test, before any page loaded. Re-ran it alone: pass. Full re-run: 25/25. All suites together: UI 25, API 66, JWT 43, engine 35, personalisation 18.

## Phase 8 — hardening

_What did you measure, what did you fix, and what did you deliberately leave alone? Anything you
chose not to build belongs here with its reason._

## Open threads

_Things you know are wrong, unfinished, or that you would do differently with another day. Listing
these honestly is worth more than pretending they do not exist — we will find them anyway._
