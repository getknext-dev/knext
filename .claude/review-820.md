ISSUES_FOUND

# Adversarial review — PR #820, the `kn-next` alias package

Branch `feat/kn-next-alias-package` (77ddd98) vs origin/main. Method: clean-worktree checkout
(`/Users/banna/alpheya/pocs/knext-wt/review-820`), full test runs, live CI log for the PR head,
and the real shim executed against (a) the workspace-linked core, (b) a hand-built faithful pnpm
nested-store layout with a controlled fake core, (c) signal experiments, (d) an isolated copy with
no resolvable core. Registry checked live: `kn-next` 404s on npm (premise holds); `@getknext/core`
is published at 0.3.0.

## Blocking

### 1. The PR's own CI is red — the repo's standing release guards reject the package as wired (5 failures)

`Lint & Test` on the PR head fails (run 32481334066), and every failure is caused by this PR:

- `tests/release-policy-matrix.test.ts` — "exactly the three policy packages are publishable — a
  fourth fails here" and "each released package publishes publicly, with provenance". The alias is
  non-private, so it enters the publishable set; it has no `publishConfig`
  (`access`/`provenance: true` — the trio all carry it).
- `packages/kn-next/src/__tests__/ci-typecheck-contract.test.ts` — 3 failures: every non-private
  package must have a `typecheck` script, its own ci.yml typecheck step, or a documented exclusion.
  The alias has none of the three.

The PR body says the release-flow wiring is "stated not snuck" — but the guards exist precisely so
that deferral is not an option: a fourth publishable package must be wired (or documented-excluded)
in the same PR that creates it. Per the repo's own rule ("never merge past a red gate"), this is
disqualifying as-is. This also answers brief item 5: yes, guards break from the package merely
existing unpublished.

Fix in-PR: `publishConfig: { access: "public", provenance: true }`, a `typecheck` script + ci.yml
step (or documented exclusion — it is one 54-line JS file), update the release-policy matrix to
expect four, and add `kn-next` to the changesets `fixed` group (see finding 3).

### 2. SIGTERM/SIGINT to the shim orphans the real CLI — proven, and it contradicts the PR body's "signal passthrough" claim

The `child.on('exit')` re-kill pattern only covers **child dies first** (that direction is correct:
SIGINT'ing the child made the parent exit 130 = 128+2 in my test). The other direction is absent:
nothing forwards a signal received by the *parent* to the child. Experiment (real shim, fake core
bin that sleeps): `kill -TERM <shim-pid>` → parent dead (143), **child still alive, orphaned**,
stdio still attached to the caller's terminal.

Terminal Ctrl-C works by accident (same foreground process group), but the non-TTY case is exactly
the deploy case: `timeout 300 npx kn-next deploy`, a CI runner or supervisor signalling the direct
process — the wrapper dies, the underlying deploy keeps mutating the cluster invisibly. For a
cluster-mutating CLI that is a correctness bug, not a nicety. Fix is three lines:
`for (const sig of ['SIGINT','SIGTERM','SIGHUP']) process.on(sig, () => child.kill(sig));`

## Should fix

### 3. The version-lockstep test bites, but only as unexplained friction — the guard shape that actually works is the changesets `fixed` group

`.changeset/config.json` has `fixed: [["@getknext/core", "@getknext/lib", "@getknext/db"]]` and
`kn-next` is in neither `fixed` nor `ignore`. Consequence: the next changeset that bumps core will
NOT bump the alias (`workspace:^` stays satisfied, so `updateInternalDependencies: "patch"` never
fires for a minor), the repo files drift, and the lockstep test reds the Version Packages PR. So
the test does fail before publish — brief item 3's "can never fail" is not quite right — but it
fails as a mystery someone must hand-patch every release. Adding `kn-next` to the `fixed` group
makes lockstep automatic and keeps the test as the backstop. Genuinely unguarded either way:
partial publish (core succeeds, alias 404s/fails) — same exposure the trio already accepts.

### 4. No LICENSE file — the published tarball would carry no license text, breaking the repo's licensing claim

`git ls-files packages/kn-next-alias/` → README, bin, package.json only. CLAUDE.md §9's "Apache-2.0
everywhere and consistently" rests on "npm always includes LICENSE in a tarball" — which is true
only when the file exists; here it doesn't. `"license": "Apache-2.0"` metadata with no license text
in the artifact. Copy the per-package LICENSE like the trio.

### 5. `engines.node: ">=20"` promises a floor its only dependency contradicts

Core requires `>=22.18`. A Node 20/21 user installs the alias warning-free, then the shim spawns
core's bin under a runtime core does not support. The alias should declare core's floor: `>=22.18`.

## Minor / recorded

### 6. The NOTE about the deliberately-absent isolation test is honest about the gap but wrong about the reason

Judged as the brief asked. Claim: isolating a copied shim is "environment-dependent" because Node
resolution walks every ancestor. Their failed attempt almost certainly copied within the repo,
where the walk finds the workspace root's `node_modules`. I copied the shim to an OS temp dir
outside any `node_modules` ancestry: deterministic exit 1 with the exact message, every run. A
`mkdtemp(os.tmpdir())` test is ~6 lines and would pin the catch branch behaviourally instead of
grepping the source for its own error message (the current "message test" passes even if the catch
branch is deleted, since it only asserts the strings exist in the file — the string is its own
subject). Not blocking, but the NOTE should be corrected and the test added.

### 7. Latent: a future `dist/package.json` in core breaks resolution with a misleading error

The walk-up stops at the FIRST package.json above the root export. Core ships none under `dist/`
today, so pnpm nested store, npm, and symlinked installs all resolve correctly (all tested — the
pnpm store layout forwards argv and preserves exit codes, including a non-zero 7). But if tsup ever
emits the common `{"type":"module"}` stub into `dist/`, the walk stops there, `corePkg.bin` is
undefined, the throw is swallowed by the catch, and the user is told core "is not installed" — a
misdiagnosis. Cheap hardening: continue the walk until `package.json` has
`name === '@getknext/core'`.

## What held under attack

- pnpm nested-store layout (`.pnpm/…/node_modules/@getknext/core`): resolution finds core's own
  package.json, argv forwarding and exit codes intact — proven with a faithful hand-built layout.
- Child-killed-by-signal → parent exit code 128+n: correct (130 observed).
- The five tests pass on the PR head once core's dist exists (CI builds core before vitest, so
  their dist-dependence is safe in the main gate's sequencing).
- The bare name is genuinely free on npm; `repository.directory` is set; the `files` allowlist
  carries the bin.

## Session hazard (not a PR finding)

Mid-review, another session switched the shared main working tree from this PR's branch to
`measure/ledger-row5`, making the PR's files vanish under me — an initial "the new test file is
never collected by vitest" finding was an artifact of that switch, killed before filing. Review
completed from a dedicated worktree per workflow.md. The worktree has been removed.

# Round 2 — ba3feac

ISSUES_FOUND — one trivial, PR-introduced blocker. All five round-1 findings are substantively
fixed and re-proven; the fix commit then broke the lint gate with a formatting change.

## The one blocker: `.changeset/config.json` fails Biome format — introduced by round 2 itself

`Lint & Test` at ba3feac is red (run 32488316854, fails in 25s at the lint step). Isolated
locally: `biome check . --diagnostic-level=error` reports exactly one error — the round-2 commit
reformatted the `fixed`/`ignore` arrays multi-line, and the formatter wants them back inline. The
`noConsole` output in the CI log is pre-existing warning noise (749 warnings, none failing;
`apps/docs/scripts/validate-config.ts` is byte-identical on green main). Fix:
`pnpm exec biome format --write .changeset/config.json`. Nothing else is wrong.

## Round-1 findings — all five verified fixed, by wiring not weakening

1. **Release guards (was blocking).** `tests/kn-next-alias.test.ts` +
   `tests/release-policy-matrix.test.ts` + `ci-typecheck-contract.test.ts`: **33/33 pass** in a
   clean worktree at ba3feac (lib/db/core built first). The matrix test still *scans the
   workspace* and compares against the grown four-name `RELEASE_SET` — growing the expected
   constant is the legitimate move, the scan half is intact. `publishConfig` carries
   `access: public` + `provenance: true`; the typecheck contract is satisfied by a real
   `node --check bin/kn-next.js` script plus its own ci.yml step (`pnpm --filter kn-next
   typecheck` runs clean).
2. **Signal orphaning (was blocking) — orphan experiment re-run verbatim, plus the re-raise
   check.** SIGTERM to the parent alone: child receives the forwarded SIGTERM
   (`CHILD_GOT_SIGTERM` logged), **zero orphans**, parent propagates 143. The re-raise fix is
   real, not cosmetic: with a child that has NO handler (dies by signal), a `spawn` observer sees
   the shim die `code=null signal=SIGTERM` — genuine default disposition, so `timeout`/systemd/CI
   read a killed deploy as killed, never as exit 0. `removeAllListeners(signal)` before the
   re-raise is what makes that work, as claimed. Child-killed-by-SIGINT still yields parent
   exit 130 (128+n preserved). New angle probed and cleared: terminal Ctrl-C now delivers a
   second, forwarded SIGINT to the child (process group + forwarding), but core's CLI installs no
   SIGINT handlers (`grep SIGINT src/cli/` — none), so double delivery is harmless today. If core
   ever adds a graceful-SIGINT path with a second-signal fast-abort, revisit.
3. **Changesets fixed group — proven to bite, and the tooling accepts four.** `changeset status`
   parses the config without complaint, and a throwaway `changeset version` run with a core-patch
   changeset bumped **all four** packages 0.3.0 → 0.3.1 in lockstep, `kn-next` included
   (worktree restored afterward). The lockstep test is now backstop rather than friction.
4. **LICENSE** — 201-line Apache-2.0 file present, added to the `files` allowlist explicitly.
5. **engines** — `>=22.18`, matching core.

## Still open from round 1, minor, deliberately not blocking

The round-1 minor items were not addressed and don't need to be for merge: the test-file NOTE
still claims the isolation test is environment-dependent (it isn't — an OS-tmpdir copy is
deterministic), and the walk-up still trusts the first package.json above the root export (a
future `dist/package.json` stub in core would misdiagnose as "not installed"). Both stand as
recorded follow-ups.

## Verdict

One `biome format --write .changeset/config.json` away from APPROVE. Every substantive round-1
defect is fixed and behaviourally proven; the sole remaining red is self-inflicted formatting.
