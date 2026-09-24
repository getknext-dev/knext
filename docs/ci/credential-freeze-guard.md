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

- `date` / `expires` — `YYYY-MM-DD`. `expires` must be strictly after `date`,
  and `expires - date` is capped at **14 days** — a single reviewed PR
  cannot license months of future frozen-file edits (#1370 review).
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

## The guard runs from a base-commit checkout of its own code

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
