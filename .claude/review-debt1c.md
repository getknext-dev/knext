# Adversarial code review — debt1c / #805 "fs.watch flake fix"

**Verdict: ISSUES_FOUND**

Branch `fix/image-cache-sync-watch-flake` @ `0a5463e`, worktree `/Users/banna/alpheya/pocs/knext-wt/debt1c`, base `origin/main` @ `c1b962d`. Platform: macOS (FSEvents).

Diff: `image-cache-sync.ts` (+104/-2), `image-cache-sync-watch.test.ts` (+34), `image-cache-sync-watch-gap.test.ts` (+187, new).

Implementer's verdict: **(b) real implementation bug**. My judgement: **partly supported** — the *production* gap is real and well-proven; the causal link to the *#805 flake* is not established, and the half of the fix that would address the flake is untested.

---

## Harness integrity

All counts are by **exit code** (`$?`), never by grepping vitest output. Harness red-proof first:

```
/tmp/loop.sh 2 harnessproof src/__tests__/does-not-exist.test.ts
→ LABEL=harnessproof N=2 PASS=0 FAIL=2 FAILRUNS= 1(rc=1) 2(rc=1)
```

Harness can see red. All mutations done with a python script asserting the anchor occurs **exactly once**, aborting otherwise (no `perl`). Full restore verified: `git status --porcelain` clean except untracked `.claude/impl-debt1c-report.md`.

---

## Attack 1 — Re-reproduce the ORIGINAL flake on origin/main

Setup: in the worktree, `git checkout origin/main -- image-cache-sync.ts image-cache-sync-watch.test.ts`, new gap test moved aside. Anchor checks confirmed `WATCH_PROBE_KEY` count = 0 and `pre-attach gap` count = 0 before running.

| Condition | Command | Result |
|---|---|---|
| Solo, 20× | `/tmp/loop.sh 20 mainsolo src/__tests__/image-cache-sync-watch.test.ts` | **PASS=20 FAIL=0** |
| 8 concurrent × 6 rounds | `/tmp/par.sh 6 8 mainpar …` | **TOTAL=48 PASS=48 FAIL=0** |
| 16 concurrent × 3 rounds | `/tmp/par.sh 3 16 mainpar16 …` | **TOTAL=48 PASS=48 FAIL=0** |
| Full kn-next suite × 3 (JSON per-file status) | `/tmp/full.sh 3 mainfull` | watch test **passed 3/3** |

**116 targeted runs + 3 full-suite runs on origin/main: the #805 flake did NOT reproduce once.**

The implementer reported 1/40 under the same parallel-pressure condition. I ran that condition to 96 runs and got zero. A fix for a flake reproducible at best once in ~150 runs has correspondingly weak evidence for its *mechanism*.

### Attack-1 side finding: a DIFFERENT test is reproducibly flaky on origin/main

Full-suite runs 1 and 2 exited **rc=1**, and it was never the watch test:

```
src/__tests__/cli-build-bun-bytecode.test.ts => failed
  :: "cleans up its temp dirs (969-file trees must not litter tmpdir)"
  AssertionError: expected +0 to be 1  (cli-build-bun-bytecode.test.ts:248)
run 3 => 0 failed files
```

2/3 red on origin/main. **If #805 was filed off a red full-suite run, this — not the fs.watch test — is the flake that is actually reproducible here.** Worth confirming the ticket's provenance before calling #805 closed.

---

## Attack 2 — Fixed tests 50× by exit code

```
/tmp/loop.sh 50 fixed50 src/__tests__/image-cache-sync-watch.test.ts src/__tests__/image-cache-sync-watch-gap.test.ts
→ LABEL=fixed50 N=50 PASS=50 FAIL=0 FAILRUNS=
```

**50/50 green. PASS.**

---

## Attack 3 — Verdict-dependent proof (verdict = (b), so: mutation-prove the red-first test)

### M1 — full impl revert to origin/main → PARTIALLY KILLED

`git checkout origin/main -- packages/kn-next/src/adapters/image-cache-sync.ts` (verified `WATCH_PROBE_KEY` count = 0), then both watch files:

```
M1_RC=1
 ✓ src/__tests__/image-cache-sync-watch.test.ts (8 tests) 1382ms     <-- ALL GREEN
     × pushes a pre-attach variant via the reconcile even with zero watch events
     × reconcile pushes only variants missing from the store (no blanket re-upload)
     × warns when the readiness probe cannot confirm event delivery
 Test Files  1 failed | 1 passed (2)
      Tests  3 failed | 9 passed (12)
```

The **mocked gap file is genuinely red-first** — 3 of its 4 tests die. Good.

But `image-cache-sync-watch.test.ts` **passed in full with the entire fix removed**, including the test the implementer added there specifically for #805. Confirmed systematic, not a one-off:

```
/tmp/loop.sh 10 revert_realfs src/__tests__/image-cache-sync-watch.test.ts
→ N=10 PASS=10 FAIL=0
```

**10/10 green with the fix deleted.** → **ISSUE 1** below.

### M3 — remove ONLY the readiness-probe wait, keep the reconcile → SURVIVED

Anchor asserted exactly once, then `while (!probeSeen && Date.now() < probeDeadline) {` → `while (false) {`:

```
anchor occurrences: 1
mutated: probe wait removed (reconcile untouched)

/tmp/loop.sh 10 m3 <both watch files>   → N=10 PASS=10 FAIL=0
npx vitest run src/__tests__/image-cache-sync  → M3_ALL_RC=0, 4 files / 22 tests passed
```

**The readiness probe survives mutation across all 22 image-cache-sync tests.** → **ISSUE 2** below.

Restored: `grep -c "while (!probeSeen && Date.now() < probeDeadline)"` = 1, `git status --porcelain` clean.

### Handshake characterization (the mechanism is sound, where it runs)

Read of `image-cache-sync.ts:327-343`: the probe is a **real readiness handshake, not a lengthened sleep** — it writes a dot-prefixed sentinel in a retry loop and waits for the watcher's own callback to observe it (`probeSeen`), i.e. it synchronizes on the actual event stream going live. Credit where due: this is the right shape.

Caveat (**ISSUE 4**): it is best-effort with a 2 s deadline, after which it warns and proceeds regardless.

---

## Attack 4 — Non-race path unchanged

Full `packages/kn-next` suite on the branch, 2 runs, per-file status parsed from JSON:

```
/tmp/full.sh 2 branchfull
run 1 suite_rc=0   image-cache-sync-watch-gap.test.ts => passed / image-cache-sync-watch.test.ts => passed
run 2 suite_rc=0   (same)
```

**2/2 full-suite green.** Also: `TSC_RC=0`, `BIOME_RC=0` (`biome check --diagnostic-level=error` on all three changed files).

Behaviour delta on the non-race path, from reading the diff:
- Watch callback: the inline `pending.add`/`setTimeout` pair was extracted verbatim into `enqueue()`; the only added branch is the `WATCH_PROBE_KEY` early-return, which cannot collide (dot-prefixed; Next cacheKeys are hex). **No behavioural change for normal events.**
- `watchAndPushImageCache` now **resolves later** — up to 2 s of probe plus one `store.list` + a `readdir` per variant dir. In production this is inside deferred init (verified: `node-server.ts:161` imports `startImageCacheSync`, reached via `deferredInit.ensureStarted` at `:342`), so it does not block serving. Callers that awaited the handle synchronously now wait longer.
- `startImageCacheSync` now issues **two `store.list` calls** per start (restore + reconcile). Minor, noted in the implementer's report.

**Production-gap claim verified independently.** `node-server.ts:161`/`:342` confirm the sync starts after the Next child is serving, so variants genuinely can land on disk with no watcher attached and never be pushed. That is a real user-facing cache-sync hole, and the reconcile is a correct fix for it, deterministically tested.

---

## Attack 5 — Same racy pattern elsewhere

```
git grep -n "fs\.watch\|watchFile\|chokidar\|FSWatcher\|{ watch }" -- '*.ts' '*.tsx' '*.js' '*.mjs'
```

9 hits, all in `image-cache-sync.ts` + its two test files (6 of the 9 are comments). Independent grep of `*.test.ts(x)` across `packages/` and `apps/` for watcher construction: **no hits.**

**`image-cache-sync.ts` is the only `fs.watch` consumer in the repo. No other test exhibits the start-watcher-then-immediately-write pattern.** Nothing to flag. Clean result.

---

## Issues

| # | Location | Problem | Why it matters |
|---|---|---|---|
| 1 | `packages/kn-next/src/__tests__/image-cache-sync-watch.test.ts:102` — "pushes a variant already on disk before the watcher attaches (pre-attach gap, #805)" | **Decoration.** Passes 10/10 with the entire fix reverted to origin/main. macOS FSEvents replays pre-attach writes, so the real watcher pushes the variant with no reconcile present — the implementer's own report documents this replay behaviour, then adds the test anyway. | A guard that stays green when its subject is removed is worse than none: it reads as regression protection for the #805 fix and provides zero. Repo rule: "mutation-prove every new guard." Either delete it or make it deterministic (it is already covered deterministically in the gap file). |
| 2 | `packages/kn-next/src/adapters/image-cache-sync.ts:327-343` (readiness probe) | **The probe is entirely unguarded.** Mutating the wait to `while (false)` leaves all 22 image-cache-sync tests green and 10/10 loop runs green. The one probe-related test ("warns when the readiness probe cannot confirm") asserts only the **failure-branch log line** under an inert watcher — it never asserts that the function *waits* for readiness. | This is the classic "guard asserts only one half" defect (repo memory: knext's most common PR defect). It is also the *only* half of this PR that can affect the #805 flake — the reconcile cannot, since the flaky test writes after `watchAndPushImageCache` resolves. The PR's headline behaviour has no test. Needs a test that the promise does not resolve until an event has been observed (e.g. mock `watch` to fire only after N ms and assert ordering). |
| 3 | Root-cause verdict, `.claude/impl-debt1c-report.md` | **Verdict (b) conflates two defects.** The reconcile fixes a real, code-verified production gap — solid, deterministically tested, keep it. But the report presents it as the cause of the #805 *flake*, and it cannot be: the flaky test writes after watch resolves, so no rescan sees it. Meanwhile the flake did not reproduce in 116 targeted + 3 full-suite runs here (implementer: 1/40). | Closing #805 on this evidence risks the flake recurring with the ticket marked fixed. Recommend splitting the claim: "fixes a production cache-sync gap (proven)" + "adds a readiness handshake that should reduce the attach race (unproven, flake not reliably reproducible)". |
| 4 | `image-cache-sync.ts:328,340-343` | Probe is best-effort: after 2 s it warns and continues with a possibly-dead watcher. Under exactly the load that allegedly causes the flake, the deadline is what gets hit. | The flake is *reduced*, not eliminated. Do not claim elimination in the PR description or changelog. |
| 5 | `image-cache-sync.ts:389-392` (`stop()`) | `stop()` within `FLUSH_MS` (500 ms) of start calls `clearTimeout(timer)`, silently dropping every variant the reconcile just enqueued. | A pod that gets SIGTERM shortly after a cold start loses the reconcile's entire upload batch — the exact scale-to-zero scenario this module exists for. Low severity (uploads are idempotent and the next pod retries), but it makes the reconcile a no-op on short-lived pods. |
| 6 | `image-cache-sync.ts` (`startImageCacheSync`) | Two `store.list` round-trips per start (restore then reconcile). | Cold-start latency on the path this module is meant to optimize. Trivially avoidable by threading restore's listing into the reconcile. |
| 7 | `packages/kn-next/src/__tests__/cli-build-bun-bytecode.test.ts:248` | **Unrelated, pre-existing:** flaked 2/3 on origin/main full-suite runs (`expected +0 to be 1`). | Not this PR's defect, but it is the only *reproducible* suite flake I found — see Attack 1. Should be filed separately, and #805's provenance re-checked against it. |

---

## Test quality

Mixed and, critically, **inverted**: the new mocked `image-cache-sync-watch-gap.test.ts` is genuinely good work — deterministic, red-first-verified (3/4 die on M1), and its no-blanket-re-upload test uses a positive wait to make the negative assertion ordering-deterministic rather than window-based — but it tests only the reconcile, while the PR's actual flake fix (the readiness probe) survives mutation untouched, and the one real-fs test added for #805 is proven decoration.

---

## Final judgement on the root-cause verdict

**Partly supported.** Verdict (b) is correct that there is a real implementation bug, and the reconcile is the right fix for it — I independently verified the deferred-init production gap at `node-server.ts:161`/`:342` and the gap tests are honestly red-first. But the evidence does **not** support (b) as the explanation of the *#805 flake*: the flake did not reproduce in 116 targeted runs across three pressure regimes plus 3 full-suite runs, the reconcile is mechanically incapable of fixing the flaky test's ordering, and the probe that could is best-effort and has no test at all. Not a blocker on the production fix — a blocker on the claim that #805 is closed.

**Requested before merge:** issue 2 (test the readiness handshake) and issue 1 (delete or fix the decorative test). Issues 3-4 are wording/scoping. Issues 5-7 can be follow-ups.

---

# Round 2

**Verdict: APPROVE**

Head `51686d3` ("fix(image-cache-sync): review round — guard the readiness handshake, drop the
decorative test, single store.list per start"), on top of round-1's `0a5463e`. Worktree
`/Users/banna/alpheya/pocs/knext-wt/debt1c`, branch `fix/image-cache-sync-watch-flake`.
Diff vs round 1: `image-cache-sync.ts` +32/-3, `image-cache-sync-watch.test.ts` +58/-58 (net rewrite
of two tests), `image-cache-sync-watch-gap.test.ts` +45/-3.

All counts by **exit code** (`$?`), never by grepping vitest output. Harness re-proved red first:

```
/tmp/loop_r2.sh 2 harnessproof src/__tests__/does-not-exist.test.ts
→ LABEL=harnessproof N=2 PASS=0 FAIL=2 FAILRUNS= 1(rc=1) 2(rc=1)
```

All mutations applied by a python script (no `perl`) that asserts the anchor occurs **exactly
once** and aborts otherwise, then re-reads the file to confirm the substitution landed.

---

## Item 1 — Mutation now reds. **PASS**

Baseline first: `npx vitest run src/__tests__/image-cache-sync` → `BASELINE_RC=0`,
**4 files / 23 tests passed** (was 22 in round 1).

Mutation M3-redux, `while (!probeSeen && Date.now() < probeDeadline) {` → `while (false) {`:

```
anchor occurrences: 1
post-mutation anchor count: 0 / 'while (false) {' count: 1 → MUTATED_OK
npx vitest run src/__tests__/image-cache-sync  → MUTATED_RC=1
 × does not resolve until the watcher has demonstrably delivered an event (readiness ordering)  6ms
 FAIL src/__tests__/image-cache-sync-watch-gap.test.ts
 Test Files  1 failed | 3 passed (4)
```

**Round 1's surviving mutation is now KILLED**, and the killer is exactly the demanded new test.
Failure is the ordering assertion, not a timing window:

```
AssertionError: expected 0 to be greater than 0
 ❯ src/__tests__/image-cache-sync-watch-gap.test.ts:207:29
   207|  expect(deliveredAt).toBeGreaterThan(0);
```

Not a fluke and not load-sensitive — it dies in **6 ms** (the mutated impl resolves instantly, long
before the scripted 250 ms delivery), and repeated:

```
mutated gap file × 5 → MUTATION_REPEAT N=5 PASS=0 FAIL=5
```

**The new test read** — `image-cache-sync-watch-gap.test.ts:182` *"does not resolve until the
watcher has demonstrably delivered an event (readiness ordering)"*. The `node:fs` mock was
refactored so the fake `watch` captures the impl's real listener and hands it to a per-test
`watchBehavior` hook (default inert, reset in `beforeEach` — no cross-test leakage). The test
scripts delivery at `EVENT_DELAY_MS = 250`, records `deliveredAt` inside the listener and
`resolvedAt` after `await watchAndPushImageCache(...)`, then asserts `deliveredAt > 0` and
`resolvedAt >= deliveredAt`. That is a genuine **ordering/waiting** assertion against the promise —
not a log line, not an elapsed-window heuristic. Round-1 issue 2 is closed.

Restored fully afterwards:

```
git checkout -- packages/kn-next/src/adapters/image-cache-sync.ts
anchor count = 1, 'while (false)' count = 0
git status --porcelain → only "?? .claude/impl-debt1c-report.md"
git diff --stat HEAD   → empty
```

### Item-1 residual (minor, non-blocking, NOT a regression from round 1)

A second, weaker mutation **survives**: dropping only the early exit —
`while (!probeSeen && Date.now() < probeDeadline)` → `while (Date.now() < probeDeadline)` — leaves
all 4 files / 23 tests green (`MUT2_RC=0`). So the suite proves the promise *waits for* an event,
but not that it **stops waiting when the event arrives**: a regression turning the handshake into an
unconditional 2 s sleep on every cold start would ship undetected — on the very path this module
exists to make fast. Cheap to close (assert `resolvedAt - deliveredAt` is well under
`watchReadyTimeoutMs`, which is already injectable). Recorded as a follow-up, not a merge blocker:
what round 1 demanded — that the probe be guarded at all — is delivered. Restored; anchor count = 1,
`while (Date.now() < probeDeadline)` count = 0, tree clean.

## Item 2 — Decorative test deleted. **PASS**

Repo-wide, at `51686d3`:

```
git grep -n "pre-attach gap"                → rc=1 (no match)
git grep -n "pushes a variant already on disk" → rc=1 (no match)
```

**Deleted outright**, not weakened or relocated — so the "make it deterministic" branch of round-1
issue 1 does not apply. The deterministic coverage of the same behaviour remains in the mocked gap
file ("pushes a pre-attach variant via the reconcile even with zero watch events"), which round 1
independently confirmed is red-first. The slot it occupied in `image-cache-sync-watch.test.ts` was
reused for two real tests (restore-then-stop-handle; list-called-once).

## Item 3 — Report verdict split. **PASS**

`.claude/impl-debt1c-report.md` (worktree, untracked; no separate addendum — the fix round was
folded into the same file). It now leads with *"Root-cause verdict — re-scoped after adversarial
review (was: '(b)', stated too broadly)"* and splits the claim in two, quoting:

> **1. A proven production cache-sync gap (solid — this is the (b) part).** … The **post-attach
> reconcile** fixes this, deterministically tested (inert-watch mock, red-first, mutation-proved).

> **2. The #805 flake itself: the readiness handshake SHOULD reduce the attach race — unproven.**
> The flaky test writes *after* `watchAndPushImageCache` resolves, so the reconcile mechanically
> cannot fix it; only the handshake can. … it is **best-effort: after a 2 s deadline it warns and
> proceeds with a possibly-dead watcher**, and the flake itself is too rare to prove against
> (implementer: 1/40 …; reviewer: 0 in 116 targeted + 3 full-suite runs on origin/main). The race
> is *reduced*, not provably eliminated.

And the no-closure requirement is explicit:

> **The PR/merge description must NOT claim it closes #805.** Honest framing: "fixes a proven
> production cache-sync gap on the image-cache path; adds a tested readiness handshake that should
> reduce (not provably eliminate) the #805 attach-race flake."

It also carries forward the Attack-1 side finding (`cli-build-bun-bytecode.test.ts:248`, 2/3 red on
origin/main) and asks for #805's provenance to be re-checked before the ticket is closed. Issues 3
and 4 are addressed; **no over-claim remains in the report.**

## Item 4 — Issues 5 and 6. **PASS**

**Issue 5 (`stop()` drops the reconcile batch) — recorded as a follow-up, not silently dropped.**
In the report's fix-round table: *"**Follow-up, not fixed here.** Low severity (uploads idempotent,
next pod retries); candidate fix: flush synchronously in `stop()` or make `stop()` await a final
flush. File it."* — and repeated under "Follow-ups to file" item 1. Code confirms it is unchanged
(`image-cache-sync.ts:400-403`: `stop()` still `clearTimeout(timer)` then `watcher.close()`).
Accepting this as a follow-up is reasonable: uploads are idempotent and the next pod re-reconciles.

**Issue 6 (double `store.list`) — actually fixed, and the fix is guarded.** Read of the code: a new
`@internal preListedKeys?: readonly string[]` option (`:80-86`); `startImageCacheSync` fetches the
listing once (`:440-449`, wrapped in try/catch so a list failure degrades to per-phase listing
rather than throwing) and threads it into both consumers — `restoreImageCache:168-169`
(`opts.preListedKeys ?? (await store.list(...))`) and the watch reconcile `:364-367`. Store
resolution also moved up to `startImageCacheSync:432` (`deps.store ?? (await defaultStore()) ??
undefined`), which is what makes one shared listing possible; the `?? undefined` fallback preserves
the old per-phase `defaultStore()`-then-warn behaviour when no client is available. Staleness is a
non-issue in the intended order: restore's downloads are exactly the keys in the listing, so the
reconcile correctly treats them as `known` and does not re-upload a freshly-restored cache.

Not taken on trust — mutation-proved (anchor `if (opts.store) {` asserted exactly once, disabled the
prefetch):

```
MUTATED_OK (prefetch threading disabled)
npx vitest run src/__tests__/image-cache-sync → MUT6_RC=1
 × startImageCacheSync lists the store exactly once for restore + reconcile combined  71ms
 Test Files  1 failed | 3 passed (4)
```

Restored; `if (opts.store) {` count = 1, `if (false) {` count = 0, tree clean.

## Item 5 — 50× loop + full suite on the final head. **PASS**

```
/tmp/loop_r2.sh 50 fixed50r2 src/__tests__/image-cache-sync-watch.test.ts \
                             src/__tests__/image-cache-sync-watch-gap.test.ts
→ LABEL=fixed50r2 N=50 PASS=50 FAIL=0 FAILRUNS=
```

**50/50 green, zero failures, counted by exit code only.**

Full package suite, once:

```
cd packages/kn-next && npx vitest run  → FULL_SUITE_RC=0
 Test Files  153 passed (153)
```

Note: the `cli-build-bun-bytecode.test.ts:248` flake (round-1 issue 7, 2/3 red on origin/main) did
**not** fire in this run. It remains unrelated to this PR and still worth filing separately.

Additional gates on the final head: `TSC_RC=0`, `BIOME_RC=0`
(`biome check --diagnostic-level=error` on all three changed files).

**Final state verified:** `git rev-parse --short HEAD` = `51686d3`; `git diff --stat HEAD` empty;
`git status --porcelain` shows only the untracked `.claude/impl-debt1c-report.md`. **No mutation
left in place.**

---

## Round 2 summary

| Round-1 issue | Status |
|---|---|
| 1 — decorative real-fs pre-attach test | **Fixed** — deleted repo-wide |
| 2 — readiness probe entirely unguarded | **Fixed** — new ordering test kills `while(false)` 5/5, in 6 ms |
| 3 — verdict conflation | **Fixed** — report splits proven gap vs unproven mitigation |
| 4 — elimination over-claim | **Fixed** — report forbids claiming #805 closed |
| 5 — `stop()` drops reconcile batch | **Recorded** as follow-up (accepted) |
| 6 — double `store.list` | **Fixed** — single threaded listing, mutation-proved |
| 7 — unrelated bun-bytecode flake | Out of scope, filed as follow-up |
| *new* — probe early-exit unguarded (`while (Date.now() < probeDeadline)` survives) | **Follow-up** (minor: cold-start-latency guard gap, not a correctness regression) |

**Test quality:** materially better than round 1 and no longer inverted — the PR's headline
behaviour (the readiness handshake) now has a real ordering test that dies deterministically when
the wait is removed, the proven-decorative test is gone rather than papered over, and the new
list-once test is itself mutation-proved; the only remaining softness is that the suite proves the
probe *waits* without proving it *stops waiting* once the event lands.

**Merge condition (unchanged from round 1, item 3):** the merge/PR description must use the
report's honest framing and must not close #805.
