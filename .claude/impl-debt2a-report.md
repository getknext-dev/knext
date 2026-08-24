# Debt 2a — #835 report: the cli-build-bun-bytecode leak-check flake

Branch `fix/bun-bytecode-test-flake` (from origin/main @ 8f032bc), worktree
`/Users/banna/alpheya/pocs/knext-wt/fix-bun-bytecode-test-flake`.
Commits: `05b46ca` (fix), `28425d6` (first guard), `f2a82a4` (review F1 — guard
both mkdtemp sites).

## Verdict: (a) — test bug. The implementation does not leak.

`cli-build-bun-bytecode.test.ts:248` asserted `tempDirCount()` (a count of
`knext-bc-*` dirs in the **shared** `os.tmpdir()`) unchanged across the pass.
Three test files drive the real `precompileBunBytecode` — `cli-build-bun-bytecode`,
`standalone-bun-bytecode-pass` (injected fake bun), `build-run` — and vitest's
default pool forks per **file** with `fileParallelism` on, so foreign workers
create and remove same-prefix dirs in that shared root concurrently. The prefix
also matches the probe's `knext-bc-probe-*`. Both `before` and `after` sample a
root nobody owns.

**What certifies "no leak" is the path audit, not the failure signature.** Both
`mkdtempSync` sites sit in `try/finally` with `rmSync(recursive, force)`;
`force` swallows ENOENT; a `buildOne` throw still runs the per-file `finally`,
and the probe's `finally` runs on every path. Only an `rmSync` that itself
throws leaves residue, and that aborts loudly via the outer catch. Mutation C1
confirms the positive direction: remove the cleanup, residue appears.

*(An earlier draft argued the count-**decrease** signature alone proved a foreign
deleter. The reviewer reproduced failures in **both** directions under churn —
`expected 29 to be 30` and `expected 30 to be 29`. The increase flavour is
signature-indistinguishable from a genuine leak, so the argument certifies only
"that particular failure was not a leak", never "no leak exists". Corrected.)*

## Reproduction (pre-fix, tree = origin/main @ 8f032bc, pristine worktree)

| context | runs | leak-test failures |
|---|---|---|
| test file solo, quiet | 3 | 0 |
| test file solo + tmpdir churner | 6 | 6 — all at :248 |
| full suite, quiet machine | 12 (6+6) | 0 |
| **full suite + tmpdir churner** | 3 | **2/3** — the issue's exact rate, at :248 |

The churner is one shell loop mkdir/rmdir-ing `knext-bc-churn*` dirs in
`os.tmpdir()` — a stand-in for what parallel workers do on a loaded machine.
Solo-plus-churner rates are churner-aggressiveness-dependent (the reviewer
measured 5/12 with a gentler one); the defensible ledger statement is
**load-dependent: reproduces readily under tmpdir churn, 0/12 quiet.** #835's
own 2/3 was measured without an artificial churner, inside a busy session.

## Fix (real isolation — no sleep, no retry)

- `standalone-bun-bytecode.ts`: `BytecodePassOptions.tmpRoot?` (defaults to
  `os.tmpdir()`), threaded into **both** scratch sites — the capability probe
  (`:184`) and the per-file scratch dir (`:238`). Internal module, not a
  `package.json` export subpath → no public-API/CLI/CRD trigger.
- The test injects a **private** `tmpRoot` and asserts `readdirSync(tmpRoot)` is
  empty afterwards — any residue there is provably ours, and the check got
  *stronger* (it now also catches probe-dir leaks).
- **Both sites guarded independently (review F1).** `os.tmpdir()` reads `TMPDIR`
  at **call time**, so the test poisons `TMPDIR` to a nonexistent path while
  passing a valid `tmpRoot`. An un-threaded site then throws ENOENT instead of
  silently working, and the two fail through **distinct channels**: an
  un-threaded probe sets `disabled`, an un-threaded per-file scratch lands in
  `skipped`. Each is asserted separately.

## Mutation proof — per site, by exit code

Anchors asserted exactly-once (abort otherwise), restore via `git checkout`
(fix committed first), implementation verified residue-free afterwards.

| mutation | expectation | result | assertion that caught it |
|---|---|---|---|
| baseline | GREEN | **GREEN** | — |
| C1 control — per-file `rmSync` deleted | RED | **RED** | `readdirSync(tmpRoot)` residue (`[ 'knext-bc-7my2ol' ]`) |
| M4 — **per-file site only** → `tmpdir()` | RED | **RED** | `skipped` non-empty |
| M5 — **probe site only** → `tmpdir()` | RED | **RED** | `disabled` set |
| restored | GREEN | **GREEN** | — |

`PER-SITE MUTATION-PROOF: PASS`. Three distinct assertions catch three distinct
mutations — no composite hiding a surviving half.

**What the first round got wrong, recorded so it is not repeated.** The original
M3 reverted *both* sites together and passed, which is precisely how the
unguarded per-file site hid; the reviewer's M4 (per-file alone) was **green** on
`28425d6`. That was a net **coverage regression** against the racy count it
replaced, which would at least have gone red — noisily — on a per-file leak into
the global tmpdir. Determinism had been bought with a real hole. Per-site
mutation is the rule this repo already writes down; a composite mutation is not
a proof. `28425d6`'s message ("prove tmpRoot is actually threaded") overstated
what it proved at the time — `f2a82a4` makes that wording true rather than
rewriting history.

## Proof (post-fix)

- Solo + churner: **8/8 green** (was 0/6). Reviewer, independently: **30/30**
  solo + churner, **12/12** with both sibling pass-driving files in parallel.
- **Full suite × 20 under the churner, by exit code: 18/20 exit 0, and
  `cli-build-bun-bytecode` failures = 0/20.** The two non-zero exits were
  unrelated flakes in other files (below) — the bytecode leak check did not fire
  once. *(This fills the `PENDING_LOOP_RESULT` placeholder that shipped unfilled
  in the first draft — the claim was made before the loop returned. It should
  not have been written until it had.)*
- **Post-F1 full suite × 10 under the churner: 9/10 exit 0, `cli-build-bun-bytecode`
  failures = 0/10.** The single non-zero exit was flake (2) below, same 5000ms
  timeout signature. Combined across both loops: **0 bytecode-leak failures in 30
  full-suite runs under adversarial tmpdir churn**, against 2/3 pre-fix.
- Gates: `pnpm run typecheck` exit 0; `biome check . --diagnostic-level=error`
  exit 0; `node scripts/scan-mutation-residue.mjs` exit 0. Reviewer additionally
  ran a full `vitest run`: exit 0, 4128 passed / 0 failed.

## Two OTHER flakes surfaced by the 20-run loop (ledger candidates, not fixed here)

Both are distinct classes from the tmpdir one, with distinct signatures:

1. `packages/kn-next/src/__tests__/image-cache-sync-defaultstore.test.ts:115`
   — 1/20. `expected [] to include 'image-cache/vk/a.avif'`: a bounded
   poll-with-`setTimeout(25)` loop over a watch flush that gives up before the
   upload lands. **This is a genuine `fs.watch`-race flake in the #805 family,
   observed directly.** Relevant to #835's own filing note that "#805's rate
   claim should be re-checked": the re-check says the image-cache-sync flake is
   *real and independent*, ~1/20 under load — not merely a misattribution of the
   bytecode flake. Two separate flakes, not one.
2. `tests/bun-exec-example-suite-collection.test.ts:106` — **2/30 across both
   loops** (1/20 pre-F1, 1/10 post-F1), identical signature each time. `Test
   timed out in 5000ms` on a test that shells out to collect files;
   timing-sensitive under load, wants a larger `testTimeout` rather than a logic
   fix. The most frequent surviving suite flake now that #835 is closed.

## Environment facts needed to run the full suite (side findings, not fixed here)

1. **A *fresh* checkout with no prior build cannot pass the full suite**:
   `apps/file-manager/next-adapter.test.ts` (8 tests) imports
   `@getknext/core/adapter`, which resolves to `packages/kn-next/dist/` — absent
   until `@getknext/lib` → `@getknext/db` → `@getknext/core` are built. The
   vitest alias block resolves `@getknext/core/validate` to source but not
   `./adapter`. *Re-scoped per review*: this is **not** an unconditional claim
   about `main` — any worktree with a built `dist/` is green, which is why the
   reviewer did not reproduce it. It bites fresh clones/worktrees only. A
   `pretest` build step or an `./adapter` alias would close it.
2. `tests/mutation-residue-scan.test.ts` and `tests/compat-window-fingerprint.test.ts`
   shell out to `git commit` in fixture repos and inherit the user's global
   `commit.gpgsign=true` — headless runs red on gpg-agent timeout. Neutralized
   for these runs with a minimal `GIT_CONFIG_GLOBAL` (identity + `gpgsign=false`);
   the durable fix is `git -c commit.gpgsign=false` in the fixtures.
3. `examples/bun-exec` needs its own `bun install` (not a pnpm workspace member;
   `srvx` missing otherwise).
