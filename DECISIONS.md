# DECISIONS

One section per decision that a reviewer might reasonably have made differently. Every section has
the same four parts, and the third and fourth are the ones we weigh most.

Rules, from `DISCOVERY-BRIEF.md`:

- cite something real in `Why` — a commit, a test, an error string, a file and line
- do not restate what a document says; describe what you did when the documents ran out
- six to twelve decisions is the expected range

---

### <the decision, as a claim — not "permissions", but "the org-level view counts device-scoped grants">

**What I chose:**
**Why:** _(evidence: test, log line, commit)_
**What I rejected:** _(the plausible alternative, and the specific reason it fails)_
**What would change my mind:**

<!-- Copy the block above per decision. The two stubs below show the required shape and contain no
     engineering content — replace or delete them. -->

---

### Stub — the shape of a weak "Why"

**What I chose:** the obvious thing.
**Why:** it is what the brief says to do.
**What I rejected:** nothing, the alternative seemed worse.
**What would change my mind:** I do not know.

_Reads as a memory of the document, not a model of the system. Scores nothing._

---

### Stub — the shape of a strong "Why"

**What I chose:** X.
**Why:** I implemented Y first, because Y is the intuitive precedence rule. `node scripts/check-
permissions.js` reported `<the actual reason string it reported>` on the case where the two grants
disagree. That is only reachable if the two are evaluated in a different order than Y assumes.
Moved to X in `<commit>` and the case passed. Logged in `BUILD-LOG.md` under Phase 2.
**What I rejected:** Y, and also "resolve the narrower one last" — both fail the same case for the
same reason.
**What would change my mind:** a case where a narrower grant is expected to survive a broader
refusal. I could not construct one, which is itself evidence for X.

_Shows what you believed, what disproved it, and what you did next._

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
must not: that depends on `permissions.js` denying every permission for `suspended`, which I
still have to build and test.

## Sources and tools

- **Claude Code (AI assistant):** used to read and explain the specification, diagnose the
  Windows setup failures (`rm -f`, `URL.pathname` paths), run setup commands, review
  `verifyAccessToken`, run the length-check experiment, and write `server/context.js` and its scratch test (the suspended-member choice was mine). Logged in `BUILD-LOG.md` Phases 0–2.

## Deliberately not built

What you chose not to build, and the reason. A scope cut with a stated reason is a senior
judgement. An unmentioned gap is a gap.
