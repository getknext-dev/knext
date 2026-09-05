# Brief — the release lane is alive but the Version PR job fails: action v2 needs Changesets CLI v3

Repo `/Users/banna/alpheya/pocs/knext`. Work in a **worktree**, not the main checkout.

## What just happened

#849 merged (`f8815ce`) and fixed the month-long concurrency deadlock — release runs now actually
start, which they had not done since 2026-07-26. That exposed a **second, independent breakage**
that the deadlock had been hiding.

Run `32850202919`, job **"Version PR (no credential, no approval)"** → `failure`:

```
##[error]This version of the Changesets action is designed to work with Changesets CLI v3.
Changesets CLI v2 is not supported; use Changesets action v1 instead, which is compatible with CLI v2.
```

The repo has `"@changesets/cli": "^2.31.0"` (`package.json:30`) while the workflow runs
`changesets/action@…  # v2.1.0`. So **no Version PR can ever open**, and with no Version PR nothing
can publish. `kn-next` is still `E404` on npm and `@getknext/lib`/`db` are a month stale.

## Your job

Decide between the two remedies **and justify the choice**, then implement it:

- **(a) Upgrade `@changesets/cli` to v3.** Forward path, matches the pinned action. Read v3's
  changelog for breaking changes that touch this repo — especially the `fixed` group
  (`.changeset/config.json` fixes `@getknext/core`, `@getknext/lib`, `@getknext/db`, `kn-next`
  together), `access: public`, and `updateInternalDependencies: patch`. Two changesets are pending;
  they must still version all four as a set.
- **(b) Pin `changesets/action` back to v1**, which is compatible with CLI v2.

Recommend one, say why, and note what you are trading. Do not silently pick the easy one.

**Also check the open PRs first** — #839 ("bump changesets/action from 2.1.0 to 2.1.1") and #749
("take the changesets/action v2 bump with its input migration") are both open and both touch exactly
this. One of them may already be the intended fix, in which case say so rather than duplicating it.
Whatever you land must not conflict with, or silently supersede, a PR someone else opened.

## Constraints that bind here

- `release.yml` is a **credential-bearing** workflow. `security.md` requires third-party actions
  pinned to a **40-hex SHA** with an auditable `# vX.Y.Z` comment, and the pin must be in the
  allowlist. `tests/release-action-pins.test.ts` asserts **form and scope** at PR time; the nightly
  `scripts/verify-action-pins.mjs` resolves SHA↔tag at run time and **dereferences annotated tags**.
  If you change a pin, both must still pass — and note that `changesets/action@v1` is a **branch**,
  not a tag, which is precisely why the SHA pin matters.
- #849 added `scripts/mutation-prove-release-lane.mjs` with **18 declared mutations**. If your
  change alters the lane, the prover must still run 18/18 red, and any new guard gets its own
  mutation graded **independently**.
- Do **not** publish, do **not** merge a Version PR, do **not** approve a deployment. Land the fix;
  the lead runs the publish sequence.

## Verify it actually works
A green test suite is not proof here — the previous breakage was invisible to every spec. After
pushing, the real check is that a release run's Version-PR job **succeeds** and a "Version Packages"
PR appears. Say explicitly what you verified by running versus by reading.

## Discipline (non-negotiable)
- Branch on **exit codes**, never grep output.
- Mutation-prove every new guard **independently**; prove your harness can see red first.
- **Assert both halves** of any invariant.
- Never mutate with `perl` — use a script asserting the anchor occurs exactly once, aborting
  otherwise. Restore byte-identically, verify `git status --porcelain` clean, grep for residue.
- Never push to `main`, never force-push, never rewrite history. Feature branch + PR only.

## Report
Write `.claude/impl-release3-report.md` in your worktree: the remedy you chose and why, what you
rejected, what you verified by running, and what remains.
