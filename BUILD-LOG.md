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

_What did you expect each failure mode to look like before you ran it? Which one behaved
differently from your expectation, and what did that tell you?_

## Phase 2 — caller context and the resolution engine

_This is where most people's first model is wrong. Write down the model you started with, the
observation that broke it, and the model you moved to. Be specific about the observation._

## Phase 3 — orgs, members, invites

_Anything you had to work out that no document states. Invite lifecycle states are a common
source of this._

## Phase 4 — devices and grants

_What happens at the boundary where two grants disagree, or where a grant's scope and the
question's scope differ? Say what you predicted and what you got._

## Phase 5 — sessions

_Two permissions, one device. What did you have to resolve, and in what order, to keep the two
failure reasons distinguishable?_

## Phase 6 — audit

_What did you decide counts as an auditable event, and what pushed you to that line?_

## Phase 7 — the console

_Where did the server's answer and your instinct disagree about what should be on screen?_

## Phase 8 — hardening

_What did you measure, what did you fix, and what did you deliberately leave alone? Anything you
chose not to build belongs here with its reason._

## Open threads

_Things you know are wrong, unfinished, or that you would do differently with another day. Listing
these honestly is worth more than pretending they do not exist — we will find them anyway._
