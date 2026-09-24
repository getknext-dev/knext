# The compat credential freeze guard (#1302)

## What this is

ADR-0056 freezes the compat harness for the life of a release-candidate
window: `.github/compat-credential-ref.json`'s `rcTag` pins the ref a
credential night runs against, and a scheduled night's fingerprint step
(`scripts/compat-window-fingerprint.mjs`) DETECTS a mismatch — but only
after the fact, restarting the 14-night streak on the next scheduled run.

`.github/workflows/compat-credential-freeze-guard.yml` is the PR-time half:
while a window is live (`rcTag` is non-null), it refuses any PR that touches
a file the credential harness actually executes, unless the pin file also
carries a dated, reviewed `rcBumpMarker`.

## The protected file set is derived, never hardcoded (plus a small self-protection list)

`scripts/compat-credential-freeze-guard.mjs`'s `frozenFileSet()` calls
`collectHarness()` — exported from `scripts/compat-window-fingerprint.mjs`
for exactly this reuse — once per `CREDENTIAL_CELLS` entry
(`scripts/compat-window-audit.mjs`) that has a `workflowFile`. This is the
SAME function a real credential night's fingerprint step calls to compute
what it freezes. A cell added to `CREDENTIAL_CELLS`, a script newly reached
by the import/source closure, or a renamed workflow file all move this
guard's protected set with no edit to the guard or the workflow — there is
no second, hand-maintained file list to keep in sync (see the #1301 review's
identical complaint about an earlier version of the cron/concurrency guards,
generalised as a design principle here from the start).

`frozenFileSet()` also unions in `GUARD_SELF_FILES` — the guard's own
script and workflow. This part IS hardcoded, necessarily: a guard cannot
derive its own protected identity from harness cells it is not part of.
It exists because a #1370 review round found a PR could otherwise weaken
`evaluateFreezeGuard`/`frozenFileSet`/`collectHarness` itself with nothing
stopping it — none of those files were in the derived closure. Being in the
frozen set is defense in depth on top of the primary defense below, not the
only defense.

## The `rcBumpMarker`

```json
{
  "rcTag": "v1.0.0-rc.2",
  "rcBumpMarker": {
    "date": "2026-09-24",
    "expires": "2026-10-08",
    "reason": "re-cutting the RC after the packaging fix in #NNNN"
  }
}
```

- `date` / `expires` — `YYYY-MM-DD`, and both must be REAL calendar dates,
  not merely digit-shaped. **(#1370 review round 3)** `Date.parse` alone is
  not enough: `9999-99-99` and `2026-10-99` parse to `NaN`, but
  `2026-02-30` (no such day) does not — V8 silently rolls it forward to
  `2026-03-02` instead of refusing it. The guard round-trips both fields
  through `toISOString` and requires the exact string back, which catches
  every one of these. This matters because the span-cap comparison below
  would otherwise silently ADMIT a `NaN`-producing date: `NaN > 14` is
  `false`, so a naive `>` check treats an impossible date as "under the
  cap" — a PERMANENT exemption (`{expires: "9999-99-99"}` would read
  "valid through 9999-99-99" and never expire). The comparison itself is
  also written fail-closed (`!(span <= MAX)`, not `span > MAX`) as a second
  line of defense against the same `NaN` failure mode.
- `expires` must be strictly after `date`.
- `date` must not be later than **today** — a marker records when it was
  actually added, so it cannot be post-dated into the future. **(#1370
  review round 2)** This is required, not optional: an `expires - date` cap
  alone is defeated by a future-dated marker — `{date: "2099-12-20",
  expires: "2099-12-31"}` is an 11-day span, under a naive 14-day cap, yet
  authorizes nothing today and everything the instant the clock reaches
  2099.
- `expires - today` is capped at **14 days**, evaluated at guard run time.
  **Correction (#1370 review round 3):** an earlier version of this doc
  claimed this was "provably equivalent" to an `expires - date` cap — that
  was wrong. It is not equivalent: a BACKDATED `date` (allowed by the
  `date <= today` check above) with `expires` within 14 days of today can
  have `expires - date` far exceed 14 days, and the guard still accepts it
  — deliberately. The actual invariant enforced is **"an exemption reaches
  at most 14 days past the run time"**, not "the marker's own span is at
  most 14 days"; measuring from `today` is what makes that literally what
  gets checked, independent of how old `date` is.
- `reason` — free text, non-empty.
- Validity is `today <= expires` (inclusive), evaluated at guard run time.

**What the guard checks, and what it does not.** Mechanically, the guard
checks ONLY structural validity and non-expiry — same as every dated
exception elsewhere in this repo. It does **not**, and cannot, verify WHO
added the marker: this repo has no mechanism for that, the same way
`rcTag` itself has no cryptographic proof that a founder pushed the tag.
"Founder-approved" is enforced the way every other reviewed-PR gate in this
repo enforces authorship — GitHub PR review on the PR that adds or renews
the marker — and the marker is the dated, mechanical EVIDENCE that review
happened, not a substitute for it. An expired marker is invalid, full stop:
there is no accidental-evergreen failure mode. **Honesty note (#1370
review):** this repo has no `CODEOWNERS` file, so "reviewed" here means only
"some collaborator with write access approved the PR" — the same bar every
other reviewed-PR gate in this repo clears today, not a narrower one scoped
to the pin file specifically.

## Which pin state is read — base for freeze, head for the marker

The guard reads `.github/compat-credential-ref.json`'s `rcTag` **as of the
PR's base commit**, not the PR's own head/working copy, to decide
freeze/unfrozen. This is deliberate: "was a credential window already live
before this PR" is the property being protected. It is also what makes the
very first PR that ever sets `rcTag` (from `null` to a real tag) land
unrestricted — its own base still reads `rcTag: null` — while every
subsequent PR, once the tag is live on `main`, sees `frozen: true` at its
own base and is gated accordingly.

The `rcBumpMarker`, by contrast, is read **at the PR's head** (amended
#1370 review — reading it from base deadlocks the PR that adds it: the pin
file is itself in the frozen set, so a PR authorized only by a marker it
introduces in the same diff could never pass a base-pin check, since base
never has the marker the PR is adding).

**Pin-only diffs** — a PR that touches the pin file and no other frozen
file — are evaluated against their own resulting (head) freeze state, but
only in the direction that CLOSES a window: a pin-only diff that resolves to
unfrozen (`rcTag` cleared) is exempt unconditionally, since ending a freeze
cannot corrupt bytes already frozen. A pin-only diff that resolves to STILL
frozen (an unchanged or bumped `rcTag`) is not exempt — it falls through to
the same head-marker check as any other frozen-file touch, so a PR cannot
silently re-tag or extend a window through the pin file alone without
carrying a marker ("exempt a pin-only diff, but keep it honest").

## The guard runs from a base-commit checkout of its own code — the SCRIPT, not the workflow YAML

A PR must not be able to weaken `evaluateFreezeGuard`/`frozenFileSet`/
`collectHarness` and have this SAME run execute the PR's own edited copy
against itself (#1370 review, "the PR can rewrite its own gate"). The
workflow adds a second git worktree at the PR's base commit
(`git worktree add --detach base-checkout "${BASE_SHA}"`) and runs the guard
FROM there (`node base-checkout/scripts/compat-credential-freeze-guard.mjs
--repo-root base-checkout ...`) — the frozen-file derivation and the
decision logic both execute as of base, never as of this PR's head. Being in
`GUARD_SELF_FILES` (above) is defense in depth on top of this, not the
primary defense.

**Known limitation, stated honestly (#1370 review round 2): this closes the
hole for the SCRIPT only, not for the WORKFLOW YAML that invokes it.**
GitHub evaluates `.github/workflows/compat-credential-freeze-guard.yml`
itself from the PR's OWN ref for both `pull_request` and `merge_group` —
that is how GitHub Actions works, and this workflow does nothing to change
it. A PR is therefore free to edit the YAML directly — replace the whole job
body with a single `run: exit 0` step, drop the `merge_group:` trigger,
widen `permissions:`, or skip the base-checkout step entirely — and that
edited YAML is exactly what runs on that PR's own check. The base-checkout
indirection only protects the `.mjs` LOGIC once the (unmodified) YAML gets
around to invoking it; it does nothing if the YAML itself is what changed.
Relatedly, the base-checkout script still resolves its `typescript` import
from the `node_modules` tree the SAME PR's own `bun install
--frozen-lockfile` step populated (from that PR's own `package.json` /
`bun.lock`) — a PR that ships a poisoned `typescript` (or a same-named
shadow module reachable first in Node's resolution) can subvert the
base-checkout script's behavior even though its own `.mjs` bytes are
unmodified. **Do not read `GUARD_SELF_FILES` or the base-checkout step as
"the self-rewrite hole is closed"** — they raise the bar for the common
case (a PR quietly editing `frozenFileSet`/`evaluateFreezeGuard`/
`collectHarness` in the script) without closing it against a PR that edits
the workflow file or its dependency closure instead.
Closing this properly needs one of two things this repo does not have
today, and both are founder decisions, not something an agent working this
issue can add on its own behalf:
- a **CODEOWNERS** file requiring a trusted reviewer's approval specifically
  on `GUARD_SELF_FILES` and the pin file, so editing the guard (or the
  YAML that runs it) cannot merge on an ordinary collaborator's review
  alone; or
- redesigning the workflow around **`pull_request_target`**, which runs
  using the workflow definition on the BASE ref rather than the PR's head —
  the YAML itself would then be immune to a PR editing it, at the cost of
  `pull_request_target`'s own well-known hazard (the job gets elevated,
  base-ref-scoped credentials while still being triggerable by an untrusted
  PR), which needs its own careful design before adopting it here.

## merge_group

This workflow also triggers on `merge_group`, even though it is not a
required status check yet (see below). A required check that never triggers
on `merge_group` stalls every PR in `AWAITING_CHECKS` on the GitHub merge
queue's temporary ref — wiring the trigger now means making it required
later needs only the Settings change, not a follow-up workflow change too.

## Mutation-proved, not merely asserted

`tests/compat-credential-freeze-guard.test.ts` covers, at both the pure-function
and CLI-subprocess level, the four required scenarios:

- **red** when frozen (`rcTag` set) and the PR touches a frozen file, with no marker;
- **green** when unfrozen (`rcTag: null`), even if the touched files would
  otherwise be frozen;
- **green** when frozen, the PR touches a frozen file, and a **valid**
  `rcBumpMarker` is present;
- **red** when frozen, the PR touches a frozen file, and the `rcBumpMarker`
  is **expired**.

The `#1370 review` deadlock/self-rewrite/honesty scenarios are also
mutation-proved, at both levels: a pin-only diff that adds a marker while
staying frozen (green, marker read from head), a pin-only diff that clears
`rcTag` (green, no marker needed), a pin-only diff that bumps `rcTag` while
staying frozen with **no** marker (red — the exemption stays honest), the
same bump WITH a valid head marker (green), a non-pin-only diff that also
clears `rcTag` but still touches real harness bytes (red — the pin-only
exemption does not leak into a combined diff), and `GUARD_SELF_FILES`
actually landing in `frozenFileSet()`'s real output.

`tests/compat-credential-freeze-guard-workflow.test.ts` covers the workflow's
own shape: no `${{ }}` interpolated inline into any `run:` script (PR-controlled
values flow through `env:` only), job-level `permissions: contents: read`
restated (never inherited from the workflow-level block alone), `fetch-depth: 0`
on checkout (required for both the base-commit diff and the base-commit pin
read), and the base-commit pin read degrading to the unfrozen shape rather
than failing the job when the pin predates the PR's base.

## The one step this cannot do itself — for the founder

**This workflow is not a required status check.** Making it one is a
GitHub repository **Settings** change (branch protection rules), which no
agent working in this repo makes on its own behalf (`.claude/rules/security.md`
— agents may push branches and open PRs, never touch repo settings). Until a
human takes this step, the freeze guard runs and reports on every PR, but a
red run does not by itself block a merge.

**The one manual step:** on `getknext-dev/knext`, go to
**Settings → Branches → Branch protection rules → (the rule for `main`) →
Require status checks to pass before merging**, and add
`Freeze guard — .github/compat-credential-ref.json` (the job name in
`compat-credential-freeze-guard.yml`) to the required list. No other
settings change is needed — the workflow already runs on every PR
(`branches: ['**']`) and needs no additional trigger configuration.
