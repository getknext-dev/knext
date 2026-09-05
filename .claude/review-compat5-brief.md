# Adversarial review — PR #848, `fix/compat-honesty-gate` @ `8a805bb`

Worktree `/Users/banna/alpheya/pocs/knext-wt/compat5`. CI is green (29 success, 2 skipped) and the
PR is mergeable — that is the starting point, not the verdict. **Your job is to defeat this.**

This PR is release checklist step 5, "the last honesty gate." Its output is a set of **claims about
evidence**, and it recommends closing #545. A wrong claim here does not fail a test — it ships a
false statement about the project's own compatibility record, which is the exact failure mode the
release audit exists to prevent.

## The claims under review (full argument in `<worktree>/.claude/impl-compat5-report.md`)

1. **#545's premise does not hold.** Over 32 scheduled runs with retained ledgers (2026-07-28 →
   08-24; 28 node, 4 bun): 0 distinct node-lane tests flake, 0 runs went red-then-green on re-run,
   0 re-runs of the workflow at all — the last asserted twice, from the ledger's `runAttempt` and
   from the API's `run_attempt`. The single node red (`30790778590`) is called infrastructure loss.
2. **#710 is a real Bun runtime incompatibility, not flake.** Deterministic across 4/4 ledgered and
   6/6 job-level runs, same two shards back to 07-19; node lane 778/0 on 28 of 28 nights on
   identical infra; `kind: timeout` at exactly 60000 ms argued to be a per-*case* hang.
3. **Not a release blocker**, because the published claim is the Node row and the Bun row is
   already ❌; and not a quarantine candidate, because ADR-0007 §c.2's bar is a *flake* bar.
4. **The live residual is harness-fingerprint churn**, filed as #850: 27 fingerprinted nights, 11
   distinct fingerprints, 10 window restarts, longest stable streak 7 of the required 14.

## Attack it

- **Re-derive the numbers yourself** from the ledger and the API. Do not accept the report's tables.
  A count that cannot be reproduced is the finding.
- **Survivorship bias is the obvious hole.** The claims range over runs *with retained ledgers*.
  How many scheduled runs happened in that window **in total**? If runs were dropped, expired, or
  never wrote a ledger, then "0 flakes across 32" may be 0 flakes across the runs that survived —
  a different and much weaker claim. Establish the denominator.
- **Check the two independent sources really are independent.** If the ledger's `runAttempt` is
  written *from* the same API field, "asserted twice" is one assertion wearing two hats.
- **Attack the #710 discriminator.** Does `kind: timeout` at exactly 60000 ms actually distinguish a
  per-case hang from runner loss, or is that the report's interpretation? It cites
  `30790778590` as having the opposite signature — verify that from the run, not the prose.
- **Attack claim 3 on the documents.** Read `docs/compat-matrix.md` and ADR-0007 §c.2 yourself.
  Is the published claim really Node-only, in terms? Is the Bun row really already ❌? If the matrix
  says anything stronger, "not a release blocker" is wrong and that is blocking.
- **Verify #850 exists and states what the report says it does.**
- **Check what closing #545 would silently drop.** The report says closing it without #850 would
  have lost the only live problem. Confirm #545's own acceptance criteria are genuinely met, one by
  one, rather than met-in-spirit.
- **Any new guard must bite.** Mutation-prove each independently; a guard that stays green when its
  subject is removed is decoration. Prove your harness can see red first.

## Discipline (non-negotiable)
- **Branch on exit codes, never grep output.**
- **Never mutate with `perl`** — use a script asserting the anchor occurs exactly once, aborting
  otherwise. Restore byte-identically, verify `git status --porcelain` clean, grep for residue.
- **Assert both halves** of any invariant.
- Do **not** trigger, approve, or cancel any workflow run, and do not close any issue.

## Verdict
Write `.claude/review-compat5.md` in the worktree, first line `# APPROVE` or `# ISSUES_FOUND`.
List blocking findings with exact reproduction and the one-line fix. Say which claims you verified
by running and which you only read.
