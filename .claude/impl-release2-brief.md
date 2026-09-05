# Brief — release blocker 2's premise is wrong: the release lane never completes

Repo `/Users/banna/alpheya/pocs/knext`. Work in a **worktree**, not the main checkout.

## The finding you are chasing down and fixing

`docs/release/public-release-readiness.md` records **Blocker 2** as *"nothing is published to npm"*
with the remedy assigned to a **human**: *"`npm publish` the four packages"*, on the stated premise
that it needs an interactive `npm login`. **That premise appears to be wrong.** Measured just now:

- **`NPM_TOKEN` is already set as a repo secret** (`gh secret list` → `NPM_TOKEN`, 2026-07-25).
- The publish lane **has worked before**: `@getknext/core@0.3.0`, `@getknext/lib@0.2.0`,
  `@getknext/db@0.2.1` are all live on npm, published 2026-07-26 by merging Version PR **#523**
  (*"chore: version packages … (MERGE THIS TO PUBLISH)"*). #268 did the same on 2026-07-13.
- `kn-next` is genuinely absent — `npm view kn-next version` → **E404**, not an auth artifact
  (`npm view @getknext/core version` succeeds from the same shell, whose npmjs token is otherwise
  401 for `whoami`).
- `.changeset/config.json` has `"fixed": [["@getknext/core","@getknext/lib","@getknext/db","kn-next"]]`
  and `kn-next` is **not** in `ignore` — so a changeset on any member versions and publishes
  **all four**, including the alias.
- Two changesets are pending (`.changeset/lucky-pugs-shave.md`, `.changeset/tidy-moons-brake.md`).

**So the missing piece is not a login. It is that `release.yml` never completes.** Of the last 20
runs: **19 `cancelled`, 1 `pending`, zero successes.** No "Version Packages" PR has opened since
#523 on 2026-07-26. No Version PR ⇒ no publish ⇒ `kn-next` stays 404 and the three live packages
stay a month stale.

## What to establish (measure, do not assume)

1. **Why is every run cancelled?** `release.yml:40-42` is
   `concurrency: {group: release-${{ github.ref }}, cancel-in-progress: false}`. GitHub cancels a
   *pending* run in a group when a newer one is queued behind an in-progress one — with this
   session's merge rate that plausibly starves the lane. Confirm or refute that mechanism against
   the actual run records; do not stop at the plausible story.
2. **Why is the newest run (`32779529246`) `pending` with no jobs?** Candidates: the concurrency
   queue, or the `npm-publish` **environment** gate (`release.yml:95-108` notes NPM_TOKEN lives as
   an environment secret). If it is an environment protection rule with a required reviewer, that is
   a **one-click human action** — and it must be reported as such, precisely and with the URL,
   because it replaces a wrong human step with a right one.
3. **Is `NPM_TOKEN` still valid?** It was set 2026-07-25. A token can be present and expired. Say
   which you established and how — do not report presence as validity.

## What to deliver

1. **Fix the lane** if the cause is in-repo (concurrency config, gating logic, a `needs` edge).
   TDD where a test is possible; `tests/` already guards this workflow
   (`tests/release-action-pins.test.ts`). Push a branch, open a PR.
2. **Correct `docs/release/public-release-readiness.md`** — Blocker 2's premise, its owner
   (agent vs human), and the real remedy. This is the same class as Blocker 3, which was cleared by
   disproving its premise rather than by doing the work it asked for. Be equally honest here: if it
   turns out a human step **is** still required, say exactly which one and why, with the URL.
3. **Do NOT publish to npm yourself, and do not merge a Version PR.** Publishing to the public
   registry is irreversible and is the founder's call. Your job is to make the lane work and to
   report accurately what remains. Prepare it; do not fire it.

## Discipline (non-negotiable — each has burned this project)
- **Branch on exit codes, never grep output.**
- **Mutation-prove every new guard**: delete the behaviour it protects, watch it go red. Never
  mutate with `perl`; use a script asserting the anchor occurs **exactly once**, aborting otherwise.
- **Assert both halves** of any invariant.
- Compute run ages against `datetime.now(timezone.utc)`; GitHub timestamps are UTC and a local
  wall-clock comparison has already produced a false "stuck for hours" call here.
- Never push to `main`, never force-push, never rewrite history. Feature branch + PR only.

## Report
Write `.claude/impl-release2-report.md` in your worktree: the established mechanism, the run IDs
that prove it, what you fixed, what remains and who must do it.
