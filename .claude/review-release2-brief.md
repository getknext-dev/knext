# Adversarial review — PR #849, `fix/release-lane-never-completes` @ `a343997`

Worktree `/Users/banna/alpheya/pocs/knext-wt/release2`. CI is green (29 success, 2 skipped) and the
PR is mergeable — that is the starting point, not the verdict. **Your job is to defeat this.**

This branch rewrites `release.yml`, the workflow that holds a live npm publish credential. A defect
here is not a test failure, it is a bad publish or a lane that silently stops working again.

## The claim under review

`impl-release2` established that run `30207128316` has sat in `waiting` since 2026-07-26 on the
`npm-publish` environment's required-reviewer rule, that a **workflow-level** concurrency group is
held by a `waiting` run, and that this cancelled 99 of the last 100 release runs. Its fix moves to
**job-level** concurrency groups and separates the Version-PR path from the publish path. The full
argument is `<worktree>/.claude/impl-release2-report.md`.

## Attack it on these axes

1. **Does the new grouping actually free the lane?** Re-derive the mechanism yourself from the run
   records — do not accept the report's table. Then reason about the *new* YAML: can any job in the
   rewritten lane still park in a state that holds a group other jobs need? A fix that moves the
   deadlock rather than removing it looks identical from the outside until it happens again.
2. **Can the Version-PR path now fire a publish?** The whole safety argument rests on those two
   paths being separate. Try to construct an input where the PR-opening job publishes, or where the
   publish job runs without the approval gate. `changesets/action` publishes when no changesets
   remain — check what happens on a push to main with zero pending changesets.
3. **Is the approval gate still load-bearing?** Confirm the publish job still requires the
   `npm-publish` environment. If the rewrite dropped or weakened `environment:`, the credential is
   in scope without a gate — that is a `security.md` violation and a blocking finding.
4. **Action pinning.** `tests/release-action-pins.test.ts` changed by 85 lines. Verify it still
   asserts form and scope on the credential-bearing path, that it was not weakened to accommodate
   the rewrite, and that every action in the changed workflow is pinned to a 40-hex SHA with an
   auditable version comment.
5. **The new guards must bite.** `scripts/mutation-prove-release-lane.mjs`,
   `tests/release-lane-liveness.test.ts`, `tests/publish-preflight.test.ts`. Run the implementer's
   mutation prover, then **write your own** and kill each new guard independently. Any guard that
   stays green when its subject is removed is decoration. Prove your harness can see red first.
6. **`scripts/publish-preflight.mjs` talks to the live registry.** What does it do when the registry
   is unreachable? A preflight that goes green when it cannot reach npm is worse than none.

## Discipline (non-negotiable)
- **Branch on exit codes, never grep output.**
- **Never mutate with `perl`** — use a script asserting the anchor occurs exactly once, aborting
  otherwise. Restore byte-identically and verify `git status --porcelain` is clean, then grep the
  changed sources for residue.
- **Assert both halves** of any invariant.
- Do **not** trigger, approve, or cancel any workflow run, and do **not** publish anything.
- Note: the branch's commits are unsigned (`--no-gpg-sign`, locked keychain). Flag it; it is not
  yours to re-sign.

## Verdict
Write `.claude/review-release2.md` in the worktree, first line `# APPROVE` or `# ISSUES_FOUND`.
List blocking findings with exact reproduction and the one-line fix. Say which claims you verified
by running and which you only read.
