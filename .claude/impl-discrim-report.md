DONE

# Slow-dependency discrimination instrument + #802

Branch `feat/fm-slow-dependency-timing`, from `origin/main` (783e0bf). Four commits,
not pushed.

| commit | what |
|---|---|
| `4826e36` | feat: slow-dependency timing (the discriminator) |
| `bdacb2c` | fix(#802): quiet, lazy, bounded module-scope Redis clients |
| `e0cdd5f` | test(#802): a DSN guard that mutation-proving exposed as decoration |
| `47387d4` | docs: runbook section for reading the new lines |

## The three lines a stalled sitting will now emit

Grep anchor: `[slow-dep]`. One line per slow operation, JSON after the anchor.
`kubectl logs <pod> -c user-container | grep '\[slow-dep\]'`

**Reading 1 — PG pool first-connect delay** (`/dashboard`'s three `db.query`
calls through the writer pool):

```
[slow-dep] {"dep":"pg","op":"pool.query","durationMs":2394,"thresholdMs":500,"role":"writer","cold":true,"outcome":"ok"}
```

`cold:true` is the discriminator that matters — it means this was the FIRST
acquisition on the pool this process, i.e. the fresh-pod wake/connect the ledger
means, not a slow warm query (`cold:false`). `op` is `pool.connect` when a caller
took an explicit client. Timed at the shared `getDbPool()` seam and applied as
the OUTERMOST wrapper, so `durationMs` is the wall time the caller waited —
single-flight gating (#339) and wake retries (#310) included, which is the same
quantity the ledger's `lazy` column measures.

**Reading 2 — cache lazy first connect, TCP phase:**

```
[slow-dep] {"dep":"redis-connect","op":"client.connect","durationMs":2400,"thresholdMs":500}
```

Measured from the start of the handler's wait to ioredis's `connect` event, i.e.
the TCP handshake only.

**Reading 3 — slow-but-inside-budget ready check:**

```
[slow-dep] {"dep":"redis-ready","op":"ready-check","durationMs":2390,"thresholdMs":500}
```

Measured from `connect` to `ready`, i.e. the ready-check `INFO` round trip. This
is the reading that was previously invisible: it ends in SUCCESS, so no
`failing open` line is ever printed.

Both Redis lines can appear together — the readings are not exclusive, and the
split says which phase carried the time. **Absence of all three** on a stalled
cycle is itself informative: the stall was not in these three places.

Threshold: `SLOW_DEP_LOG_MS`, default 500 ms, read at CALL time — a suspect
deployment can be re-pointed with `kubectl set env ksvc/<app> SLOW_DEP_LOG_MS=100`,
no rebuild. Strictly-greater comparison (a duration equal to the threshold does
not log).

## What did NOT change

- No timeout, budget, breaker or fail-open path moved. `REDIS_CONNECT_TIMEOUT_MS`
  / `REDIS_COMMAND_TIMEOUT_MS` / `REDIS_RETRY_COOLDOWN_MS` and the pg pool
  timeouts are untouched; nothing new marks the cache unhealthy.
- Readiness is untouched (ADR-0026 / #338 — readiness never gates on a
  dependency).
- The pg wrappers are pure observers: the pool's original promise is returned
  unreplaced and the observer's own rejection handler swallows, so success/error
  propagation is unchanged and no unhandled rejection is manufactured. The Redis
  side adds two listeners, detached when the wait settles.
- Emission is fail-open in both copies — a broken log pipeline cannot propagate
  into the dependency path it observes.

## Security

The line carries the dep CLASS, never the target. URL/userinfo-shaped context is
**dropped, not redacted** (`://` or `@`), SQL text is never logged, and the
credential tests assert the DSN arrives the way it actually can — inside an error
message — after mutation-proving showed the first version was vacuous.

## #802 (second/third commits)

`apps/file-manager/src/app/api/cache/events/route.ts` and
`packages/lib/src/health/index.ts` now build their clients with
`quietRedisOptions()` + `attachQuietErrorListener()`:

- **lazy** (`lazyConnect`) — neither dials at module evaluation; both are
  on-demand paths;
- **listened-to** — one classed line per error class
  (`[redis:cache-events] connection error (ETIMEDOUT): … — further ETIMEDOUT
  errors suppressed`), so ioredis never prints `Unhandled error event`; a NEW
  class still prints;
- **bounded** — `retryStrategy` returns `null` after 5 attempts.

Bounding alone would have traded a loop for a permanently-dead client, so
`ensureDialable()` re-dials on demand (a request that wants the data pays a
bounded burst; nothing loops in the background). Both halves are asserted — a
usable client is NOT re-dialled. Fail-open behaviour is unchanged: the events
route still falls back to the in-memory events, deep health still degrades.

**Honest note on duplication:** the helper exists twice (app copy +
`packages/lib/src/redis/quiet.ts`) because the app cannot import lib internals
and adding a `@getknext/lib` subpath would be a public-API change (a workflow
trigger). Same for the slow-dep emitter (`packages/lib/src/slow-dep.ts` +
`packages/kn-next/src/adapters/slow-dep-log.js`) — lib cannot depend on core, and
the cache handler stays dependency-light. The slow-dep pair is held to one format
by `slow-dep-format-parity.test.ts`, which asserts byte-identical lines; the
quiet-client pair has no cross-copy guard, only a test each — stated as the
weaker of the two.

## Tests added

- `packages/lib/src/__tests__/slow-dep.test.ts` (8)
- `packages/lib/src/__tests__/clients-slow-dep.test.ts` (7)
- `packages/kn-next/src/__tests__/cache-handler-slow-dep.test.ts` (7 — includes a
  REAL socket whose ready-check `INFO` is delayed 250 ms and then answered, i.e.
  reading 3 reproduced end-to-end, no fail-open)
- `packages/kn-next/src/__tests__/slow-dep-format-parity.test.ts` (3)
- `apps/file-manager/src/app/api/cache/events/redis-client.test.ts` (9)
- `packages/lib/src/__tests__/health-redis-client.test.ts` (3)

Every one asserts BOTH halves (slow → exactly one line; fast → none).

## Mutation proof

17 mutations, each anchor-asserted (abort unless the anchor occurs exactly once),
run after commit, exit-code detected, file restored and verified: M1–M7 (timing)
and N1–N10 (#802). All RED. One round found a real defect: **N5 was GREEN** —
the "never logs the Redis URL" tests emitted an error whose message contained no
DSN, so deleting the sanitiser changed nothing. Fixed in `e0cdd5f`; the mutation
now reds. Script + cases: `<scratchpad>/mutate.py`, `cases-timing.json`,
`cases-802.json`.

## Suite state

`npx vitest run packages/lib packages/kn-next apps/file-manager/src` → **182
files / 1840 tests pass**. `npx vitest run tests` → 240 files / 3384 pass.
`biome check` clean on every touched file; `tsc -p tsconfig.typecheck.json`
clean.

**Environmental note (worktree only, not a regression):** the worktree started
with no `node_modules` and no built `dist/`. `pnpm install` plus building
`@getknext/lib` → `@getknext/db` → `@getknext/core` was required; before those
builds, 3 test files failed on missing-dist / unresolved
`@getknext/core/adapters/cache-handler`, and `@getknext/core`'s DTS build failed
on `@getknext/db/migrate` — all pre-existing build-order artifacts of a fresh
worktree, all green afterwards.

## Not done / deferred

- **No OKE verification.** This is a logging change whose value is only proven by
  a stalled cold cycle on the cluster, and cluster work is a queue of one. The
  next ledger sitting IS the verification: run the in-cluster harness, and on the
  stalled cycle capture `kubectl logs <pod> -c user-container | grep '\[slow-dep\]'`
  alongside the conntrack/tcpdump capture row 3 already asks for.
- **No new metric.** Discrimination needs attribution on a ~1-in-8 event, which a
  log line gives cheaply; a histogram is the follow-up if this becomes a standing
  SLI.
- **The reader pool (`getDbPoolRO`) is not instrumented** — the measured page
  uses the writer pool, and widening the diff was not warranted.
- `packages/lib/src/redis/quiet.ts` is internal (no new public subpath), so
  other apps cannot consume it yet — deliberate, to keep the public API trigger
  untouched.
