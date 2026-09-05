# Review — #835 bun-bytecode test flake (adversarial)

Branch `fix/bun-bytecode-test-flake` (2 commits, 2 files) vs `origin/main`.
Worktree `/Users/banna/alpheya/pocs/knext-wt/fix-bun-bytecode-test-flake`.
Everything below was run by the reviewer, exit-code-branched. Tree left pristine.

## Verdict: ISSUES_FOUND — one finding (F1), fix proven, ~4 lines.

The **core verdict (a) is CONFIRMED**: the implementation does not leak, and the fix is real
isolation — no sleep, no retry, no weakened assertion. But the new guard fails this repo's own
"assert both halves" rule on the very site the test is named after, and the report's mutation
round did not catch it because M3 was **composite**.

---

## F1 (blocking) — the guard covers the probe's mkdtemp, not the per-file one

`standalone-bun-bytecode.ts` has **two** `mkdtempSync` sites now threaded through `tmpRoot`:
the capability probe (`:184`) and the per-file scratch dir (`:238`). Mutating them
**independently** (anchor asserted exactly-once, restore via `git checkout`, branch on exit code):

| mutation | expectation | result |
|---|---|---|
| C1 control — delete the per-file `rmSync` (`:250`) | RED (harness can see red) | **RED** (`expected [ 'knext-bc-L7xLtF' ] to deeply equal []`) |
| M5 — revert **probe** site to `tmpdir()` | RED | **RED** |
| **M4 — revert **per-file** site to `tmpdir()`** | RED | **GREEN — 12/12 tests passed** |

M4 survives because the negative half (`missingRoot` → `disabled`) is satisfied by the **probe**
failing first, and the positive half (`readdirSync(tmpRoot)` empty) is satisfied by a per-file dir
that went to the global tmpdir and was cleaned up there. The test's own title is *"969-file trees
must not litter tmpdir"* — the per-file site **is** its subject, and it is unguarded.

This is a **net coverage regression**, not merely a missing guard: the racy `tempDirCount()` it
replaced *would* have gone red on a per-file leak into the global tmpdir (noisily). The new one
cannot see that case at all. Determinism was bought with a real hole.

Two consequences to correct with it:
- `28425d6`'s message — *"prove tmpRoot is actually threaded"* — overstates; it proves the probe is.
- The report's M3 (§Proof) reverted **both** sites together, which is exactly how the surviving
  half hid. Per-site mutation is the rule this repo already writes down.

### Proven fix (validated by the reviewer, clean GREEN / M4 RED / M5 RED)

No mocks, no races, ~4 lines, guards both sites at once. `os.tmpdir()` reads `TMPDIR` **at call
time**, so poisoning it makes *any* un-threaded site throw `ENOENT` instead of silently working:

```ts
const savedTmp = process.env.TMPDIR;
process.env.TMPDIR = join(projectDir, "poisoned-no-such-dir");
try { result = precompileBunBytecode({ standaloneDir, bunBin: "bun", tmpRoot }); }
finally { savedTmp === undefined ? delete process.env.TMPDIR : (process.env.TMPDIR = savedTmp); }
expect(result.disabled).toBeUndefined();
expect(result.skipped).toEqual([]);   // ← this is what M4 trips
expect(result.compiled).toBe(1);
```

Under M4 the per-file mkdtemp lands in the poisoned root, the per-file `catch` records it, and
`skipped` names the file (`ENOENT … mkdtemp '…/poisoned-no-such-dir/knext-bc-XXXXXX'`); under M5
the probe fails and `disabled` is set. `bun build` runs fine with `TMPDIR` poisoned (verified).
Keep the existing `readdirSync(tmpRoot)` residue check — C1 shows it is the one that catches an
actual `rmSync` removal.

*(Rejected alternatives, so they are not re-tried: `vi.spyOn(fs, "mkdtempSync")` →
`Cannot spy on export … Module namespace is not configurable in ESM`; `vi.mock("node:fs", …)` →
`No "default" export is defined` / `real.mkdtempSync is not a function`. Module-mocking `node:fs`
is not viable here. A structural alternative also works: collapse both sites into **one**
pass-scoped scratch root, leaving a single anchor the existing negative test already guards.)*

---

## Attack 1 — the verdict itself ((a) vs (b)). CONFIRMED (a), with one caveat on the reasoning.

Mechanism, established independently: `tempDirCount()` counted `knext-bc-*` in the **shared**
`os.tmpdir()` — a prefix that also matches `knext-bc-probe-*`. **Three** test files drive the real
`precompileBunBytecode` (`cli-build-bun-bytecode`, `standalone-bun-bytecode-pass`, `build-run`);
vitest's default pool forks per **file** with `fileParallelism` on, so foreign workers create and
remove same-prefix dirs in that shared root concurrently — including with an injected fake bun,
since `mkdtempSync` precedes `buildOne`. Both `before` and `after` sample a root nobody owns.

No implementation leak exists: both `mkdtempSync` sites are wrapped in `try/finally` with
`rmSync(recursive, force)`; `force` swallows ENOENT; a per-file `buildOne` throw still runs the
`finally` (`:249`), and the probe's `finally` (`:191`) runs on every path. Only an `rmSync` that
itself throws (EACCES) leaves residue, and that aborts the pass loudly via the outer catch.
C1 confirms the positive direction empirically: remove the cleanup, residue appears.

**Caveat on the report's "the signature itself certifies the interaction" argument (§lines 18-22).**
Under churn I reproduced failures in *both* directions — `expected 29 to be 30` (decrease) **and**
`expected 30 to be 29` (increase). The increase flavour of this same flake is indistinguishable by
signature from a genuine leak. The filed `expected +0 to be 1` is a decrease and so is still sound
evidence *for that run*, but the argument certifies only "that failure was not a leak" — it cannot
certify "no leak exists." What actually certifies the no-leak claim is the path audit + C1 above.
Recommend the report say so rather than lean on the signature.

## Attack 2 — reproduce the ORIGINAL on origin/main under load. REPRODUCED; rate re-stated.

Both files checked out at `origin/main`, solo file, tmpdir churner running:
**5 failures / 12 runs (42%)**, all at `cli-build-bun-bytecode.test.ts:248` — the exact line and
file in #835's title. The report's "solo + churner 6/6" is churner-aggressiveness-dependent; the
defensible statement for the ledger is **load-dependent, reproduces readily under tmpdir churn,
0/12 quiet** — which is what the report already concludes. #835's own 2/3 was measured without an
artificial churner inside a busy session; that framing in the report (§lines 36-38) is honest.

## Attack 3 — the FIXED test under the same load. 0 failures.

| profile | runs | failures |
|---|---|---|
| fixed test solo + churner | **30** | **0** |
| fixed test + both sibling pass-driving files, parallel workers + churner | **12** | **0** |

## Attack 4 — fix shape. Clean.

No `setTimeout`, no retry-until-pass, no `waitFor`, no lowered expectation. The assertions moved
from a racy global count to `readdirSync(tmpRoot) === []` plus two new ones (`compiled === 1`, and
the `missingRoot` negative) — net **stronger**, except for the F1 axis above. `tmpRoot` is an
optional field defaulting to `tmpdir()`, so runtime behaviour is unchanged.
`standalone-bun-bytecode` is **not** a `package.json` export subpath (only `cli/build.ts` imports
it) → no public-API/CLI/CRD trigger, no ADR or hard-rule contradiction. Sprint-model escalation
not required.

## Attack 5 — same class elsewhere. None found.

No remaining `readdirSync(tmpdir(…))`, no `startsWith("knext-bc` prefix counting, no other test
asserting on shared-`os.tmpdir()` population. The five fixed-name `join(tmpdir(), "…")` hits
(`cli-build-bun-bytecode:109`, `compile-cache-shadow:101,261,277,278`) are all deliberately
*nonexistent* paths — benign, no collision class.

## Attack 6 — gates, run by the reviewer.

| gate | result |
|---|---|
| `pnpm run typecheck` | exit 0 |
| `biome check . --diagnostic-level=error` | exit 0 (636 files) |
| `node scripts/scan-mutation-residue.mjs` | exit 0 |
| `node scripts/check-ts-import-extensions.mjs` | exit 0 |
| **full `vitest run`** | **exit 0 — 304 files passed / 3 skipped, 4128 tests passed / 20 skipped, 0 failed** |

This closes the report's **`PENDING_LOOP_RESULT`** (§line 61), which shipped unfilled — the claim
"full suite × 20 under the churner" was never substantiated. One clean full-suite run is
substantiated here; either fill the loop result or drop the claim.

Also note the report's environment finding #1 ("a clean checkout of main **cannot** pass the full
suite" — 8 deterministic reds in `apps/file-manager/next-adapter.test.ts`) **did not reproduce**:
the suite is fully green in this worktree, which has a built `dist/`. Re-scope that ledger
candidate to "a *fresh* checkout with no prior build", not an unconditional claim.

## Required for clearance

1. Close F1 — guard the per-file `mkdtempSync` site, and mutation-prove the two sites
   **independently** (M4 and M5 must each go red on their own).
2. Reword `28425d6`'s claim to what it proves, or let the F1 fix make the original wording true.
3. Fill or drop `PENDING_LOOP_RESULT`; re-scope environment finding #1.

---

# Round 2 — APPROVE

`f2a82a4` (test) + `d523c11` (report) on `fix/bun-bytecode-test-flake`. Everything below re-run by
the reviewer against the round-2 tree; worktree left pristine (`git status` clean, index clean).

## F1 is closed — each site now fails through its own channel

Re-ran my own matrix, per site, independently. Anchors asserted exactly-once (abort otherwise),
restore via `git checkout`, branched on **exit code**:

| mutation | expected | result | assertion that caught it |
|---|---|---|---|
| baseline | GREEN | **GREEN** (exit 0) | — |
| C1 — per-file `rmSync` deleted | RED | **RED** | `readdirSync(tmpRoot)` → `[ 'knext-bc-4fdrxP' ]` |
| C2 — **probe** `rmSync` deleted *(new control)* | RED | **RED** | `readdirSync(tmpRoot)` → `[ 'knext-bc-probe-U8rxPm' ]` |
| **M4 — per-file site ONLY → `tmpdir()`** | RED | **RED** *(was GREEN in round 1)* | `skipped` non-empty |
| M5 — probe site ONLY → `tmpdir()` | RED | **RED** | `disabled` set |
| M6 — both sites → `tmpdir()` (composite) | RED | **RED** | `disabled` set |
| restored | GREEN | **GREEN** (exit 0) | — |

Three mutations, three *distinct* assertions — no composite can hide a surviving half again. C2 is
mine, not the implementer's: it proves the probe's cleanup is guarded too, which neither round had
shown. The adopted mechanism is the one I validated in round 1 (`os.tmpdir()` reads `TMPDIR` at
call time; an un-threaded probe surfaces as `disabled`, an un-threaded per-file scratch as
`skipped`), wired correctly.

## No assertion weakened — strictly additive

`expect()` calls in the leak test: **origin/main 1 → `28425d6` 4 → HEAD 6**. Whole file 37 → 42.
Every earlier assertion survives verbatim (`compiled === 1`, `readdirSync(tmpRoot) === []`,
`missingRoot.disabled` truthy, `missingRoot.compiled === 0`); the two new ones are additions. No
sleep, no retry, no `waitFor`, no widened matcher. The only edit to the pre-existing block is a
reworded comment. No other test in the file changed.

## Harness spot-check of "0 failures in 30 full-suite runs under churn"

The claim is a **negative**, so the only thing worth checking is whether the harness could have
seen a positive. Phase 1 establishes that it can:

| phase | tree | runs | leak test | suite |
|---|---|---|---|---|
| 1 | **pre-fix** (`origin/main` for both files) + churn | 1 | **FAILED** — `× … 969-file trees must not litter tmpdir` | 4 files failed |
| 2 | fixed + churn | 2 | **PASSED both** (verbose `✓` line present each run — it ran, it was not skipped) | **exit 0, 304 passed / 3 skipped / 0 failed** |

So the full-suite-plus-churn profile *does* reproduce the flake, and the post-fix zero is a real
zero rather than a test that never executed. Reviewer totals for the round-2 tree: **30/30** solo +
churn, **2/2** full suite + churn, plus round 1's 12/12 trio and one clean full suite.

*(Correction to my own method: my first detector grepped the log for the test name, which the
`--reporter=verbose` **pass** line also matches — it reported `bytecode_failed=YES` on runs that
exited 0. Recomputed by discriminating `×`/`FAIL` lines from `✓` lines. The repo's own rule —
branch on exit codes, never output-grep — applies to reviewers too.)*

## One factual addendum to the ledger (not a blocker, not this PR's)

The pre-fix churned full-suite run failed **four** files, not the two the report names:
`cli-build-bun-bytecode` (the subject), `image-cache-sync-watch.test.ts` (the report cites the
sibling `image-cache-sync-defaultstore` — same #805 `fs.watch` family, different file),
`tests/blocking-gate-helper.test.ts` (**not** cited anywhere), and
`tests/bun-exec-example-suite-collection.test.ts` (cited). None recurred in either post-fix run.
The suite therefore has at least one more load-sensitive test than the ledger records; worth a
ledger line, and it does not affect this PR. Both flakes the report *does* cite were verified to
exist as described at the cited lines (a bounded 4000 ms `setTimeout(25)` poll; a 5000 ms shell-out).

## Round-1 items 2 and 3

- `d523c11` fills `PENDING_LOOP_RESULT` with real numbers (20 + 10 runs, 0 bytecode failures) and
  states plainly that the placeholder should not have shipped.
- Environment finding #1 is re-scoped to a *fresh checkout with no prior build* — matching why I
  could not reproduce it.
- `28425d6`'s overstated message is left in history and corrected in the report's body rather than
  rewritten. Correct call.
- Committing `.claude/impl-debt2a-report.md` follows existing convention (`impl-debt1b-report.md`,
  `impl-debt2c-report.md`, `impl-fqdn-report.md`, `impl-ux2-report.md` are all tracked on `main`;
  `.gitignore` excludes only `.claude/verdicts/` and `.claude/worktrees/`). Not a finding.

## Gates (reviewer-run, round-2 tree)

| gate | result |
|---|---|
| `pnpm run typecheck` | exit 0 |
| `biome check . --diagnostic-level=error` | exit 0 |
| `node scripts/scan-mutation-residue.mjs` | exit 0 |
| `node scripts/check-ts-import-extensions.mjs` | exit 0 |
| full `vitest run` (×2, under churn) | exit 0 — 304 passed / 3 skipped / **0 failed** |

## Watch item (non-blocking)

The test now depends on `bun build` tolerating a poisoned `TMPDIR` (it inherits the parent env).
Verified true on Bun 1.3.5. If a future Bun needs `TMPDIR` for its own scratch, this test goes red
**deterministically and loudly** — a legible failure, not a new flake — and the fix would be to
pass an explicit `env` to the `spawnSync`. Recorded so the next reader knows why it broke.

**Verdict: APPROVE.**
