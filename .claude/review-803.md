APPROVE

<!-- Final verdict at 5bed28f. Round 1 (47387d4) and round 2 (47e2d38) were
     ISSUES_FOUND; both rounds' findings are closed on the merits — see Round 3. -->

# Adversarial code+spec review — PR #803 (`feat/fm-slow-dependency-timing`)

Reviewed at head `47387d4` in worktree `agent-a3020afda6f4b4249`. Read every changed file in
full plus `cache-handler.js` §waitForReady/getRedis, `health/index.ts`, `packages/db/src/index.ts`,
`apps/file-manager/src/app/dashboard/page.tsx`, both biome configs, and `.claude/rules/{security,
architecture,workflow}.md`.

## What I verified green (so the findings below are the whole list)

- **Gates at head.** `biome check .` → exit 0 (749 pre-existing warnings, no new errors; the
  `kn-next` nested config is `indentWidth: 4` + default double quotes, so the parity test's style
  *is* biome-clean, not drift). `tsc -p packages/lib` → 0. `vitest`: lib 102/102, kn-next
  1435/1435, fm api 81/81, the six new files 37/37.
- **Mutation-proved with my own exit-code harness** (anchor asserted `== 1`, restore verified by
  byte-comparison, branch on exit code never on output): 10/10 RED — `cold` field removed,
  `>` → `>=`, both `sanitize()` copies neutered, `ensureDialable` removed from the route, the
  `instrumentConnectTiming` call removed from `waitForReady`, `attachQuietErrorListener` removed
  from health, the core emitter's prefix changed, `lazyConnect` removed, retry unbounded.
  **Harness proved able to see green first**: an inert comment-only mutation → GREEN. Tree clean
  after every run.
- **e0cdd5f is honest.** The pre-fix tests emitted `new Error('connect ETIMEDOUT')` with no DSN;
  my `lib-sanitize`/`app-sanitize` mutations go RED only against the fixed tests. Real decoration,
  really fixed.
- **Discriminator sufficiency.** `/dashboard` reaches Postgres through `getDbPool()` directly
  (`page.tsx:1,7`), so reading 1 is on the instrumented seam. Reading 2 emits: ioredis's `connect`
  fires before `connectTimeout` (5000 ms) so a 1–2 s SYN-retransmit window is well inside
  `500 < d < 5000`. Reading 3 emits: the ready-check `INFO` is bounded by `commandTimeout`
  (2000 ms), so `500 < d < 2000` — proved against a real socket with a 250 ms-delayed `INFO` and
  an asserted *absence* of `failing open`. Listener order is load-bearing and correct:
  `instrumentConnectTiming` registers `ready` before `waitForReady`'s own `ready`, so the timing
  line is emitted before `cleanup()` detaches.
- **`cold` is per-POD, not per-module-copy.** `isDbWoken()` reads the `Symbol.for(
  'knext.lib.clients.dbWakeSingleflight')` globalThis cell, so a second webpack copy of
  `@getknext/lib/clients` (#352 class) shares the latch. No double-wrap either: each copy owns its
  own `pgPool` and wraps it exactly once.
- **Wrapping order (ADR-0027 comment) is preserved.** `timePoolOps` does only `Date.now()` +
  `isDbWoken()` before calling `run()`, so `markDbActivity()` still stamps before gating/retry —
  the #348 invariant holds. The #310/#339/#348 suites are all still green.
- **No public-API / CRD trigger.** `packages/lib/package.json` gains no subpath; `redis/quiet` and
  `slow-dep` stay internal, exactly as the PR body claims.
- **Auth intact.** `DELETE /api/cache/events` still checks `isAuthorized(...)` *before* touching
  Redis (`route.ts:99-101`); `ensureDialable` is inside the authorized branch.
- **No credential path.** DSN/SQL never reach a log line: `logSlowDep` drops `://`/`@` strings and
  all non-scalars; `sanitize()` strips URL/userinfo tokens from the error message; the pg observer
  logs `op`, never the SQL text. All asserted with a real DSN and a real `victim@example.com` query.

## Issues

1. `docs/runbooks/troubleshooting.md:300` — **`kubectl set env ksvc/<app> SLOW_DEP_LOG_MS=100`
   instructs an out-of-band mutation of a resource the operator owns.** ADR-0001 /
   `architecture.md` §4: "The Go operator is the single source of truth for cluster state. Nothing
   else may mutate cluster resources out-of-band." The reconciler will revert this, so the operator
   following the runbook silently loses the knob mid-incident — and the repo's own recorded hazard
   is worse: a merge-patch on a ksvc container drops env/resources/probes while the revision still
   goes Ready, i.e. an incident-time debug step that produces a mis-configured pod which is then
   measured. Every other runbook uses the CR (`rollback.md:57`, `incident.md:176`:
   `kubectl patch nextapp <app> -n <ns> --type merge -p …`); this is the only `set env ksvc/` in
   `docs/`. Fix: patch the `NextApp` CR's env. **This is an incident-path instruction, so it is the
   highest-severity item here.**

2. `packages/lib/src/clients.ts:476-483` — **the observer is not purity-neutral: it suppresses
   `unhandledRejection` for the caller-visible promise**, contradicting the in-code claim at
   `:466-468` ("success/error propagation … bit-for-bit unchanged") and the PR body's "Pure
   observers". Attaching `.then(onOk, onErr)` marks the promise handled. On the *warm* path
   (`sf.woken === true`) `singleflightWake` attaches nothing, so before this PR the promise
   returned by `retryWake`'s `attempt()` reached the caller unhandled; an unawaited
   `pool.query()` rejection therefore raised `unhandledRejection` (Node ≥15 default: crash). It no
   longer does. Reproduced in isolation against the exact wrapper shapes: **2 unhandled events on
   main's shape, 1 on head's.** The delta arguably makes things safer, but it is undisclosed and it
   is exactly the claim I was asked to attack. Fix: correct the claim in the comment and PR body
   (workflow.md: "re-read your own claims against the current tree before merging"), or restore the
   signal deliberately.

3. `apps/file-manager/src/lib/redis-quiet.ts` ↔ `packages/lib/src/redis/quiet.ts` — **the two
   copies are byte-identical in code (only comments differ) and have NO parity guard**, while the
   emitter pair got one (`slow-dep-format-parity.test.ts`). The PR body discloses this as accepted;
   I don't think it should be, because the duplicated `sanitize()` **is** the DSN-stripping security
   control this very PR just found to be decoration in *both* copies. They were decoration together
   and were fixed together only because someone edited both by hand — a one-copy fix is precisely
   the drift mode, and `security.md` treats "secrets never in logs" as non-negotiable. The PR
   already establishes the precedent that duplication is acceptable *with* a parity guard; apply it
   to the pair that carries the security invariant. I verified the copies are code-identical today,
   so the guard is cheap to write now and expensive to write after they diverge.

4. `packages/lib/src/redis/quiet.ts:106` — **`ensureDialable`'s re-dial branch is never exercised in
   the lib copy.** `health-redis-client.test.ts`'s `FakeRedis` has no `status` property, so
   `client.status === 'end' || 'close'` is always false and the function is a no-op in every health
   test. Only the app copy's recovery is proven (`redis-client.test.ts:143,156`, both halves). So
   the "bounding must not strand the client" contract — the thing that stops `#802`'s fix from
   trading a reconnect loop for a permanently-blind deep-health check — is unproven on the deep-health
   path. Combined with (3), neither the lib copy's re-dial nor its parity is guarded.

5. `packages/lib/src/clients.ts:692` / `docs/runbooks/troubleshooting.md` — **`getDbPoolRO` is not
   instrumented, but the runbook states "If you see nothing at all, the stall was not in these three
   places."** For file-manager today that is safe (`DATABASE_URL_RO` is unset anywhere in the app, and
   `/dashboard` uses the writer), so **row 3 is not affected** — but the runbook is a general
   operator doc and an app using the RO gateway gets a confidently wrong "not the database" verdict.
   Same paragraph: the table advertises `role` as a per-Postgres field, yet with only the writer
   instrumented it is a constant `"writer"`. Either instrument the RO pool or scope the sentence to
   the writer pool.

## Test quality

Genuinely strong and not tautological: every threshold guard asserts **both halves**, reading 3 is
reproduced against a real delayed socket with an asserted *absence* of `failing open`, the
"connects promptly" negative filters by port so a sibling test's retry noise can't satisfy it, and
the DSN guards now deliver the secret the way ioredis actually would (inside the error message) —
the one weakened/vacuous test in the set was caught by the author's own mutation run and fixed in
e0cdd5f. My independent 10-mutation harness reproduced red on all of them; the only coverage hole
is finding 4 (the lib copy's `ensureDialable`).

---

# Round 2 — re-review at `47e2d38`

Verified **by tree**, not by commit, as instructed (the interleaved-split caveat is disclosed in
`47e2d38`'s message and in the PR body; I confirmed the net tree independently and did not read the
per-finding commits as authoritative).

## Round-1 findings: all five genuinely closed

| # | Fix | Verified |
|---|---|---|
| 1 | Runbook now patches the **`NextApp` CR** | `spec.env` really is `Env map[string]string` (`nextapp_types.go:91`), so the merge-patch shape is valid; `SLOW_DEP_LOG_MS` passes both CEL rules (C_IDENTIFIER, not reserved). The prohibition text explains *why* (ADR-0001 revert + merge-patch drops env/resources/probes while the revision goes `Ready`), and the new revision-roll caveat is one I did **not** ask for and is correct. `grep -rn "set env ksvc" docs/` → 1 hit, and it is the **prohibition**, not an instruction. |
| 2 | Purity claim corrected | The `clients.ts:465-482` comment now names the delta, states the measurement (2 → 1) that I made independently, and narrows precisely what *is* unchanged. The PR body carries the same. Suppression kept — lead's call, and defensible. |
| 3 | `redis-quiet-parity.test.ts` added | See the judgement below — it is **stronger** than the byte-compare I asked for. |
| 4 | Health fake carries ioredis's state machine | `connect()` now increments `connectCalls` and moves `status`; both halves asserted on the **real `checkDeepHealth` path** (`end` → 1 dial, `ready` → 0), not on the helper in isolation. Exactly the hole closed. |
| 5 | RO pool instrumented | `timePoolOps(pgPoolRO, 'reader')` at `clients.ts:723`; `cold` is `role === 'writer' ? !isDbWoken() : undefined`, and `safeExtra` drops `undefined`, so a reader line **omits** the field rather than carrying a wrong one. `expect(fields).not.toHaveProperty('cold')` asserts the omission. Runbook scope now matches, and it goes further than I asked by disclaiming an app's own direct clients. |

**Judgement you asked for — does behavioural parity cover `sanitize()`, or does a byte-compare
catch a hole it misses?** Behavioural parity is **strictly stronger here**, and I proved it rather
than argued it. The test carries *absolute* assertions (`not.toContain('hunter2'/'s3cr3t'/'://')`)
applied to **both** copies' output, not merely a relative `appLines === libLines`. So:

- one-sided drift → RED (proved, app copy and lib copy independently);
- **both copies drifting identically → still RED** (proved) — which a byte-compare would let
  through green, because identical bytes means identical drift.

It also exercises both branches of the filter (`://` scheme *and* bare `userinfo@` with no scheme),
the 200-char truncation, the class-suppression split and the full 12-point retry curve. Residual
gaps a byte-compare would catch: the two `try/catch` fail-open blocks and `quietRedisOptions`'
unused `overrides` spread are unexercised by parity — **neither is security-relevant**, and neither
has any caller today. Net: this closes finding 3 better than the fix I proposed.

## Gates and mutation proof at `47e2d38`

- `biome check .` exit 0 (612 files, 749 pre-existing warnings, no new errors); `tsc -p packages/lib` 0.
- vitest across `packages/lib` + `packages/kn-next/src/__tests__` + `apps/file-manager`:
  **1912 passed / 3 files skipped**, with one flake (see obs. 3).
- **My own harness, 11 mutations, all as expected** (anchor asserted `== 1`, byte-verified restore,
  exit-code branching, **plus a GREEN control** that stayed green):
  RO instrumentation removed → RED · `cold` made unconditional → RED · `cold` forced `undefined`
  → RED · sanitize broken in app copy only → RED · in lib copy only → RED · **in both copies
  identically → RED** · retry curve drifted in one copy → RED · `ensureDialable` status split
  drifted → RED · class-suppression removed in one copy → RED · `ensureDialable` removed from
  `checkDeepHealth` → RED · comment-only edit → **GREEN**. Tree clean after every run.

## Round-2 issues (both minor, both cheap)

1. `apps/file-manager/src/app/api/cache/events/redis-client.test.ts:151,161,191` — **three real
   `TS2554` errors: `Expected 0 arguments, but got 1`.** `route.GET` is
   `withRedMetrics('/api/cache/events', async () => {…})` with a zero-parameter handler, so
   `withRedMetrics<A extends unknown[]>` infers `A = []` and `route.GET(new Request(...))` does not
   typecheck. Runtime-harmless (the extra arg is ignored, which is why the tests pass), but the
   `Request` those three call sites appear to exercise is decorative — the handler never receives it.
   It is invisible today only because **`apps/file-manager` is not in CI's typecheck matrix**
   (`ci.yml:161-179` covers `@getknext/{lib,db,core,ui}` + `db-demo`; the root gate at
   `tsconfig.typecheck.json` explicitly excludes `apps`), and the app has no `typecheck` script.
   Baseline check: the other 8 errors under `tsc -p apps/file-manager` are in `next-adapter.test.ts`
   and `standalone-seam-alive.test.ts`, both untouched by this PR; these 3 are in a file this PR
   creates, so they are new. Fix is `await route.GET();`. **This is my round-1 miss** — I typechecked
   only `packages/lib` — recorded as mine rather than as a round-2 regression.

2. **PR body is now stale on its own fix.** The disclosure bullet still reads "The emitter pair
   carries a byte-identical-output parity guard; **the quiet-client pair has only per-copy tests**."
   That was true at round 1 and is false at `47e2d38` — `redis-quiet-parity.test.ts` exists. This is
   the same claim-vs-tree class as round-1 finding 2, and `workflow.md` names it explicitly
   ("re-read your own claims against the current tree before merging"). It matters here because the
   stale sentence understates a **security** guard, so a later reader could re-file finding 3.

## Observations (not blocking, not this PR's)

3. **Pre-existing flake:** `packages/kn-next/src/__tests__/image-cache-sync-watch.test.ts >
   "watches the cache dir and pushes a newly-written variant to the store"` failed 2 of 6 full-suite
   runs (`expected false to be true`, an `fs.watch` race). That file is untouched by this PR, and
   the PR's own timing-sensitive files (`cache-handler-slow-dep`, `clients-slow-dep`,
   `redis-quiet-parity`, `health-redis-client`) were **0/12 flaky** under stress. Not attributable
   to #803 — worth its own ticket.
4. **Nit:** `BACKOFF_CAP_MS = 2000` is unreachable in both quiet copies — with
   `MAX_RECONNECT_ATTEMPTS = 5` the largest reachable backoff is `5 × 200 = 1000`, so the
   `Math.min(..., 2000)` cap never binds. Harmless dead constant, now duplicated *and* parity-locked.

## Verdict

**ISSUES_FOUND (minor).** Nothing architectural is open: all five round-1 findings are properly
closed, the runbook fix is correct against the actual CRD, finding 3's fix is better than what I
asked for, and the round-2 mutation set (including the both-sided-drift case and a green control)
holds. Both remaining items are mechanical — a three-line test edit and one stale PR-body sentence
— and per `workflow.md` they get a round rather than a judgement call about whether they matter.

## Test quality (round 2)

Improved. The parity guard is the strongest test added by this PR: table-driven over the inputs
that matter, relative *and* absolute assertions, explicitly non-vacuous
(`expect(appLines.length).toBeGreaterThan(0)`), and it catches the failure mode a byte-compare
cannot. The health fake gaining a real state machine converts finding 4 from "structurally
unreachable branch" to "both halves proven on the production call path". No test was weakened to
pass in either round.

---

# Round 3 (final) — re-review at `5bed28f`

Scope of the delta: three lines, one file
(`apps/file-manager/src/app/api/cache/events/redis-client.test.ts`,
`route.GET(new Request(...))` → `route.GET()`). Verified by tree.

## Both round-2 items closed

1. **`TS2554` gone, and the fix is the right one — not the silencing one.** `tsc -p
   apps/file-manager/tsconfig.json` now reports errors in exactly two files, `next-adapter.test.ts`
   (7) and `standalone-seam-alive.test.ts` (1) — both untouched by this PR. **This PR now contributes
   zero type errors to the app.** The fix drops the argument rather than widening the handler's
   type, so `withRedMetrics<A extends unknown[]>` still infers `A = []` and the honest signature is
   preserved. I re-proved the guard survives the edit: deleting `ensureDialable(redisClient)` from
   `getEvents` still reds `redis-client.test.ts` (9/9 green before, RED after, restored clean) — the
   re-dial contract did not become decorative when its `Request` did.
2. **PR body now accurate on both pairs**, and it states *why* the quiet-client guard is behavioural
   ("deliberately not byte-level, since the copies' comments differ by design") rather than leaving
   the asymmetry to be re-litigated. That is the right record: as proved in round 2, behavioural is
   the stronger of the two here, not the weaker.

Both observations were promoted rather than absorbed: **#804** (apps/file-manager in no typecheck
gate) and **#805** (fs.watch flake). #804 is now better-evidenced than my report was — a one-off
`tsc` surfaced a further pre-existing error in `next-adapter.test.ts:40` that no gate has ever seen,
so the gap is demonstrated twice over rather than argued once. Correctly out of scope for this PR.

## Final gate + mutation state at `5bed28f`

- `biome check .` → 0. `tsc -p packages/lib` → 0. The PR's own suites: **135/135 green**.
- **Full round-2 mutation set re-run at final head: 11/11 as expected, GREEN control still green**
  — RO instrumentation, `cold` writer-only (both directions), one-sided sanitize drift (app and lib
  independently), **both-sided identical drift**, retry-curve drift, `ensureDialable` status-split
  drift, class-suppression drift, `ensureDialable` removed from `checkDeepHealth`. Plus the
  route-level re-dial mutation above. Tree byte-clean after every run.

## Verdict: **APPROVE**

Every finding I raised across two rounds is closed on the merits, and three of them are closed
*better* than I proposed: the runbook gained a revision-roll caveat I did not ask for, the parity
guard is strictly stronger than the byte-compare I suggested (it reds on both-sided drift, which a
byte-compare passes), and the type-error report became a tracked gate gap with fresh evidence rather
than a one-line patch. Nothing architectural is open; no escalation trigger is live (no new public
subpath, no CRD or CLI surface, no ADR contradiction — the ADR-0001 one is now *reinforced* by the
runbook's prohibition text).

Two things I want on the record, neither blocking:

- **The disclosed observer delta is a real behaviour change, kept by lead decision.** It is
  correctly documented in the code, the commit and the PR body, with the measurement (2 → 1). It is
  not "pure observation", and the tree no longer claims it is. Anyone reading this later should read
  `timePoolOps`'s header, not the PR title.
- **The commit split does not match the messages** (§5's edits ride in §1/§2's commits). Disclosed
  in `47e2d38` rather than rewritten, which is the correct call under the no-history-rewrite policy.
  Squash-merge makes it moot for `main`; review-by-commit on this branch would mislead, which is why
  I verified by tree throughout.

## Test quality (final)

Strong, and stronger than when it arrived. Every threshold guard asserts both halves; reading 3 is
reproduced against a real socket with an asserted *absence* of `failing open`; the negative case is
port-filtered so a sibling's retry noise cannot satisfy it; the DSN guards deliver the secret the
way ioredis actually would. Two tests that were decoration were caught and fixed — one by the
author's own mutation run (e0cdd5f), one by this review (the `Request` that was never received).
Nothing was weakened to pass in any round, and I could not construct a mutation the suite fails to
catch.
