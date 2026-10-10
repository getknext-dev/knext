# ADR-0066: Next 16.4 cache surface and runtime-supervisor changes — one sequenced plan

- **Status:** **Proposed (2026-10-10).** Exit: Accepted at the next sprint-close design review
  (#2103). Design and sequencing only; no code lands with this ADR.
- **Date:** 2026-10-10
- **Trigger class:** ADR + hard rule ("don't rewrite the runtime twice"; "gate every feature on the
  official compatibility suite") + public API (the `'use cache'` backend export and its adapter
  wiring). Reviewed at sprint close per `.claude/rules/workflow.md` (2026-09-22 amendment: not a
  merge gate).
- **Relates to:** ADR-0007 (compat gating — this ADR names the runs that gate the 16.4 floor),
  ADR-0052 (zone functions — Z6 cached reads and Z9 wake-ahead), ADR-0063 (release lines on
  integration branches), ADR-0064 (platform layer — the `'use cache'` backend is a platform default,
  not a recipe).
- **Covers:** #2084 / PR #2100, #2085, K4 #2066, #2083, #2089, Z6 #2050, Z9 #2054, #2090.
- **Evidence:** `.claude/research/next-16-4-impact-2026-10-09.md` (Q2, Q3, Q7, T1–T5),
  `.claude/plans/v2-sprint1-close-architect.md` (§4 task graph),
  `docs/benchmarks/zone-functions-coldstart-kind-2026-10-09.md` (wake-ahead timing).
- **Decision method:** every option choice below was scored with jev (`jev-1.13.0`, 2026-10-10);
  the winning option and the full distribution are quoted where the choice is made, and collected
  in "Options considered".

## Context

### Two runtime surfaces, six queued changes

The v2 Sprint 1 close found six changes queued against the same two runtime surfaces: the Redis cache
handler (`packages/kn-next/src/adapters/cache-handler.js`) and the runtime supervisor
(`packages/kn-next/src/adapters/node-server.ts`, plus the compiled single-exec's preload list in
`standalone-compile.mjs`). Landed as independent PRs, they would edit the same functions in different
orders, each against a different assumption about the Next floor. jev rated the rework risk of that at
0.89 (#2103). The hard rule this ADR exists to keep is "don't rewrite the runtime twice".

| Item | What it changes | Surface |
|---|---|---|
| #2084 / PR #2100 | Treat a PPR `APP_PAGE` entry written by another build as a miss | `cache-handler.js` read path |
| #2085 | Compat harness for 16.4 (flag path, `@gate`, dead exclusion), then a smoke dispatch | CI only |
| K4 #2066 | Next peer floor `>=16.4.0`; delete `standalone-adapter-path.ts` and the 16.0.x ctx branch | `package.json`, `next-adapter.ts`, `cli/build-artifact.ts`, `tsup.config.ts` |
| #2083 | Shared Redis `cacheHandlers` (`'use cache'`) backend, wired by the adapter | new handler, `next-adapter.ts`, `cache-handler.js` (shared key/tag code) |
| #2089 | Return build-scoped `cacheControl` from `get()` (Next #99289); delete the #1888 private seed | `cache-handler.js` |
| Z6 #2050 | Generated `'use cache'` query functions for zone functions | generator; needs a real shared cache to test against |
| Z9 #2054 | Wake bound functions when the zone starts | supervisor |
| #2090 | Cache Components in `knext create`: opt-in on 1.x, default in v2 | templates |

### Verified against `main` (49bfeb68b)

- Peer range is `"next": ">=16.0.0"` (`packages/kn-next/package.json:174`).
- No `cacheHandlers` (plural) exists anywhere in `packages/` or `apps/`. All three scaffolds set
  `cacheMaxMemorySize: 0` (`templates/app/next.config.ts.hbs:69`, `next.config.ts.vinext.hbs:65`,
  `turbo/generators/templates/zone/next.config.ts.hbs:50`). In production Next makes the built-in
  `'use cache'` handler a no-op at size 0, so **`'use cache'` is a silent no-op on every knext
  scaffold today**. At a non-zero size it is per-process and lost on scale-to-zero (measured, research
  Q2).
- Redis keys are app-scoped: `KEY_PREFIX = REDIS_KEY_PREFIX || 'kn-next'` (`cache-handler.js:112`),
  and the operator sets the prefix to the app name. The build id is resolved once
  (`cache-handler.js:1097-1113`, Next's constant id rejected) and today gates only the #1888 seed
  (`:1135`). PR #2100 extends the gate to the read path and adds the env fallback chain
  `.next/BUILD_ID` → `KNEXT_BUILD_ID` → `NEXT_DEPLOYMENT_ID`. `knext build`/`deploy` set
  `KNEXT_BUILD_ID` (`cli/build-id-env.ts`) and the operator renders `NEXT_DEPLOYMENT_ID`, so "no build
  id at all" is reached only by an image built outside knext's build path.
- Tag invalidation: `revalidateTag` clears Redis through a per-tag index plus a `tag:stamp` key
  (`cache-handler.js:1336-1374`). Tags of `APP_PAGE`/`APP_ROUTE`/`PAGES` writes come from the
  `x-next-cache-tags` header, not `ctx.tags` (`:823-851`).
- The supervisor's very first statement is the ARP primer (`node-server.ts:50-74`,
  `arp-primer.cjs`, `KNEXT_ARP_PRIMER=0` disables it). The compiled single-exec has no supervisor
  process; it bakes `arp-primer.cjs` as its **first** preload (`standalone-compile.mjs:175-186`).
- `standalone-adapter-path.ts` is consumed by `cli/build-artifact.ts`, `tsup.config.ts` and the
  `package.json` exports, not by `node-server.ts`. So K4 and Z9 do not share a file; K4 and #2083
  share `next-adapter.ts` and `package.json`; #2083 and #2089 share `cache-handler.js`.
- The compat harness is `.github/workflows/test-e2e-deploy.yml`, dispatched with `nextjsRef`
  (default `v16.3.8`), `runtime`, `builder` and `smoke` inputs.

### Measured facts this design must not contradict

- **Cross-build PPR resume mismatch** (research Q2, reproduced on 16.4.0): an old build's postponed
  state is resumed against new code until Redis is flushed. #99289 makes it worse if knext returns a
  stored `cacheControl` without a build check: the old shell then counts as fresh.
- **Wake-ahead from `register()` is too late** (Z2 bench): it fires ~0.4 s (Node) / ~0.8 s (Bun)
  before the request reaches the handler, while a cold function needs ~1.4 s. Node: no measurable
  effect. Bun: partial. Moving the wake to process start, beside the ARP primer, is predicted to fire
  it about 1 s earlier (up to ~1.3 s off a Node chain, ~0.5 s off a Bun chain on kind). That is a
  prediction for Z9 to test, not a result.
- **Compat at v16.4.0** adds 120 test files, a `@gate`/`@force-gate` transformer and a moved
  flag-forwarding path. The current harness cannot run it unchanged (research Q3).

### Constraints

- **Compat budget.** One dispatch occupies roughly one pool-hour of the shared runner pool. Cap: two
  dispatches per agent. Sixteen queued dispatches once froze the merge queue. Harness edits land
  between credential windows.
- **1.x credential stays on Next 16.3.8.** Moving it restarts all four 1.x windows; nothing in 16.4 is
  a security fix knext needs (research Q7; jev keep-1.x-on-16.3.8 0.97). v2 cells start fresh on 16.4.x.
- **Release lines** follow ADR-0063: 1.3.x patches on `integration/v1.3`, 1.4.0 from `main`, 2.0 on
  `integration/v2`.

## Decision

### D1. Order and dependency edges

One order, enforced as issue dependencies. An arrow means "must be merged (or, for a run, recorded
green) before".

```
S1  #2084 / PR #2100 ─────────────► main, then backport to integration/v1.3 (1.3.x patch)
S1b #2083 interim (docs + doctor) ─► main (1.4.0)                 [independent of S2–S7]
S2  #2085 harness PR (no dispatch) ─► R1 smoke node/turbopack @v16.4.0 ─► triage table
S3  R2–R4 smoke on the other three stable cells @v16.4.0 (serialized)
S4  K4 #2066 on integration/v2      needs: this ADR Accepted, S2, S3, R3a (integration/v2 cut)
S5  #2083 backend on integration/v2 needs: S4 (floor + next-adapter.ts), S1 (shared build-id chain)
S6  #2089 seed + cacheControl       needs: S5 (shared key/tag module in cache-handler.js), S1, S4
S7a Z6 #2050 cached reads           needs: S5 (and Z3 #2047, per its own issue)
S7b Z9 #2054 wake-ahead             needs: D3 primer list, Z8 #2052 bindings; NOT S5
S8  #2090 v2 default                needs: S5, S1. (1.x opt-in needs S1b first.)
```

Why this order, edge by edge:

- **#2100 first.** It is a live 1.x correctness bug with no public surface, and it introduces the
  build-id resolution chain every later cache change reuses. #2089 is unsafe without it (#99289 would
  mark an old build's shell fresh).
- **Compat before floor.** Raising the floor before any official-suite run on 16.4 contradicts
  ADR-0007 and the hard rule (architect's K4 comment, jev 0.93). The harness PR needs no dispatch; the
  runs follow it (D4).
- **K4 before #2083.** Both edit `next-adapter.ts` and the `package.json` exports, and #2083's
  contract (`refreshTags`/`getExpiration`/`updateTags`, single-consume stream, #98039) is the 16.4
  contract. Landing #2083 first would mean writing it against a `>=16.0.0` floor and then rewriting
  its feature detection when K4 lands — the "runtime twice" this ADR exists to stop.
- **#2083 before #2089.** Both edit `cache-handler.js`. #2083 extracts the key, build-id and tag code
  into one shared module (D2); #2089 then returns `cacheControl` through that module instead of
  growing a second copy. The reverse order (jev 0.18) has #2089 edit code #2083 then moves.
- **Z6 after #2083.** Z6's two-user no-collision test passes vacuously against a no-op cache — a
  guard that stays green when its subject is absent (architect comment on #2050). It must run against
  the shared backend, across two pods, mutation-proved.
- **Z9 is off the cache chain.** It touches only the supervisor and the operator's env render. It
  waits for the primer list (D3) and the bindings Z8 adds, not for #2083. The 2.0 milestone still
  holds it; it may merge in parallel with S5–S6.

jev, order: **this order 0.81** / #2089 before #2083 0.18 / K4 first and compat last 0.01 /
independent parallel PRs 0.00 (confidence 0.75).

### D2. #2083: the shared `'use cache'` backend

**Design ownership.** This ADR fixes the cross-cutting contract: keys, build scoping, tags, failure
mode and wiring. #2083's PR records only its export path and option names, flagged as a public-API
trigger. jev: **this ADR plus PR-level naming 0.71** / a separate full ADR 0.28 / no design 0.01.

**Wiring.** The adapter's `modifyConfig` sets `cacheHandlers.default` and `cacheHandlers.remote` to
knext's Redis handler, the same way #1843 wires `cacheHandler`, and only when:
1. the app uses knext's `cacheHandler` (`isKnextCacheHandler`, `next-adapter.ts:69`); and
2. the app has not set that `cacheHandlers` key itself. The app's own entry wins, per key.

The scaffolds keep `cacheMaxMemorySize: 0`; it still disables Next's in-process ISR LRU, which is
correct beside a shared Redis cache. Once `cacheHandlers.default` is wired, it no longer makes
`'use cache'` a no-op. A guard test fails if a scaffold sets `cacheMaxMemorySize: 0` while the
adapter would not wire the backend for it. Scope: the official-adapter build (Node and Bun
standalone). The vinext target has its own cache adapter and stays out of scope while it is Beta.

**Key scheme — defined once, used by both handlers.** One shared module owns the prefix, the build-id
chain and the tag store. `cacheHandler` (ISR) and `cacheHandlers` (`'use cache'`) both import it.

| Element | Rule |
|---|---|
| Prefix | `REDIS_KEY_PREFIX` (the app name, operator-set), unchanged |
| ISR entries | `<prefix>:cache:<key>`, unchanged |
| `'use cache'` entries | `<prefix>:uc:<handler>:<cacheKey>`, `<handler>` = `default` or `remote` |
| Build scoping | App-scoped key; the entry stores `buildId`. A read whose stored `buildId` differs from this process's is a **miss**; the next `set` overwrites the same key |
| Build id | One resolver: `.next/BUILD_ID` → `KNEXT_BUILD_ID` → `NEXT_DEPLOYMENT_ID`, Next's constant id ignored (the #2100 chain, moved into the shared module) |
| No build id | **Fail open**, as #2100 does: entries are shared. A one-time warning names the three sources, and `kn-next doctor` reports it |
| TTL | The handler owns eviction through Redis `EXPIRE`, from the entry's `expire` |

This is "build-scoped" in the sense #2100 already uses: scoped on read, not by namespace.
- jev, scoping: **app key + stored build id, miss on foreign 0.67** / build id in the key namespace
  0.30 / no build check 0.03 (confidence 0.51). It matches #2100's own pick
  (miss-foreign 0.95 / key-by-build 0.04). The namespace option's real advantage (clean separation)
  costs a second copy of every entry during a rollout, plus stranded keys until TTL.
- jev, no build id: **fail open 0.77** / fail closed to per-process 0.23 / refuse to start 0.00
  (confidence 0.66). The medium confidence is why the case is surfaced in `doctor`, not just logged.

**Tag invalidation path — one store, both handlers.** The ISR handler and the `'use cache'` handler
read and write **one** app-scoped tag store: the existing per-tag index plus stamps under `<prefix>`.
- `revalidateTag` / `updateTag` reach `cacheHandler.revalidateTag` and every
  `cacheHandlers.*.updateTags`. Each writes the same stamps, so one call invalidates both kinds of
  entry on every pod.
- `getExpiration(tags)` reads the newest stamp for the tags. `refreshTags()` pulls stamps into a
  per-process map once per request, as Next calls it. Staleness across pods is therefore bounded by
  one request's refresh, not by a timer.
- Tags are **not** build-scoped. A data change invalidates every build's entries. Implicit path tags
  (`_N_T_…`) use the same store.

jev: **one shared tag store 0.93** / separate stores 0.07.

**Failure mode — Redis down.** The backend degrades to "no cache", never to a stale or per-process
copy.
- `get` returns a miss.
- `set` drains the stream (the single-consume contract, #98039) and drops the write.
- Calls carry a short timeout. A circuit breaker stops a dead Redis from adding latency to every
  request. Errors increment a counter on the existing metrics surface (name fixed in #2083's PR) and
  log one warning per outage.
- **Residual, stated:** an `updateTags` dropped while Redis is down is lost. Entries written before
  the outage stay valid until their TTL once Redis returns. The ISR handler has the same property
  today. The bound is the entry TTL. An in-process retry queue would be lost on scale-to-zero, which
  is the normal case, so it is not added.

jev: **miss/drop with breaker 1.00** / in-process LRU fallback 0.00 / fail the request 0.00.

**Security.** Redis credentials stay in the Secret-backed `REDIS_URL`. The backend adds no endpoint.
Per-user isolation of Z6's cached reads is Z6's contract (key on the verified subject, never the raw
token); this backend must not hash anything user-supplied into a shared key on its own.

**1.x interim.** Until the backend ships, 1.x states the behaviour instead of hiding it:
- a docs page, published from `main` (the dogfooded docs site), on `'use cache'` and
  `'use cache: remote'` on knext;
- a `kn-next doctor` finding for an app that uses `'use cache'` or `cacheComponents`. It says the
  cache is per-process, not shared across pods, and lost on scale-to-zero, and that with the scaffold's
  `cacheMaxMemorySize: 0` it is off.

No runtime change on 1.x. jev: **docs + doctor only 0.98** / backport the backend behind feature
detection 0.02 / non-zero `cacheMaxMemorySize` on 1.x 0.00.

### D3. Wake-ahead: the supervisor's process-start primer list

The supervisor changes **once**, to hold an ordered list of process-start primers. Z9 adds the second
entry.

```
PROCESS_START_PRIMERS = ["arp-primer.cjs", "wake-ahead.cjs"]   // defined in ONE module
```

- **Consumers.**
  - Disk mode: `node-server.ts` requires the primers in list order, as its first statements, before
    it spawns the Next server. This replaces today's single hard-coded ARP block.
  - Compiled single-exec: `standalone-compile.mjs` builds `PRELOAD_NAMES` by spreading the same list
    first, so the primers stay the earliest preloads. Neither file names a primer directly.
- **Primer contract.** Every primer:
  - is CommonJS and dependency-free;
  - never throws, and is never awaited (fire and forget; it must not delay the server's boot);
  - bounds its own work (per-call timeout, no retry loop);
  - can be switched off by env (`KNEXT_ARP_PRIMER=0` today; Z9 adds its own switch).
- **`wake-ahead.cjs`** sends one non-blocking GET to each bound function's health path. The list
  comes from an env var that **the operator renders from the `NextApp` bindings** Z8 adds.
  - Per-function opt-out: the operator leaves that binding out of the list.
  - The GET is non-mutating and cluster-local, so the "no unauthenticated mutating endpoints" rule
    is not engaged.
  - The `register()` hook from the Z2 spike is not shipped.
- **Why this placement does not fight the runtime.** The primer list is the only supervisor edit in
  this plan. K4 does not touch `node-server.ts`, and #2083/#2089 are cache-handler-only. Any later
  process-start work appends to the list rather than adding a third inline block.
- **Exit evidence** is Z9's: on kind, the chained cold start improves by the margin Z2 predicted, and
  the opt-out is honoured. Absolute numbers come from OKE in Z10.

jev:
- placement: **supervisor preload after the ARP primer 0.98** / out-of-process operator wake 0.02 /
  `register()` 0.00 / init container 0.00;
- hook shape: **one ordered primer list consumed by both entry points 1.00** / two inline call
  sites 0.00 / an app plugin API 0.00;
- list source: **operator-rendered from CR bindings 0.96** / runtime Kubernetes API discovery
  0.03 / baked at build time 0.01.

### D4. Compat gating: which runs, and their budget

No floor bump and no "supported" claim without a green 16.4 run.

| Run | Workflow and inputs | Gates | Budget |
|---|---|---|---|
| R1 | `test-e2e-deploy.yml` dispatch: `nextjsRef=v16.4.0`, `runtime=node`, `builder=turbopack`, `smoke=true`. After #2085's harness PR merges | Harness readiness; produces #2085's triage table | ~1 pool-hour |
| R2–R4 | Same inputs for `bun/turbopack`, `node/webpack`, `bun/webpack` | K4's floor raise | ~3 pool-hours, **serialized**, never more than 2 per agent, between credential slots |
| v2 credential | The v2 cells' credential runs at `v16.4.x`, started when K4 lands | Any "supported on Next 16.4" or compat-matrix claim | Existing credential slots; no extra dispatch |

- **"Green" for R1–R4** means every red file is triaged as vercel-infra-coupled or a `@gate`
  inversion, with zero open knext gaps. A run with an open knext gap does not count. Its fix lands
  first, and the re-dispatch comes out of the same cap. Triage happens before any re-dispatch, never a
  blind retry.
- **Total before K4: about 4 pool-hours**, one cell at a time. A full non-smoke four-cell run is not
  spent here; the v2 credential runs cover that ground once the floor is in.
- **What R1–R4 do not buy.** A floor is an engineering gate. A claim is a credential. Docs, the compat
  matrix and release notes say "supported" for 16.4 only after the v2 credential windows (14
  consecutive green independent runs per cell). Until then they say "builds and serves; credential
  in progress". The 1.x credential stays at 16.3.8 throughout.
- **#2089's** upstream `isr-cache-control-restart` check is read from the first v2 credential run after
  it merges. It costs no separate dispatch.

jev: **one triage smoke, then one smoke per remaining stable cell before K4 0.95** / full non-smoke
four-cell run 0.05 / the single node/turbopack smoke alone 0.00 / no run 0.00 (confidence 0.93).

### D5. What ships where

| Line | Ships | Why there |
|---|---|---|
| **1.3.x patch** (`integration/v1.3`) | #2084 / PR #2100 only | Internal correctness, no public surface, patch changeset |
| **1.4.0** (`main`) | #2100 (already on `main`); the #2083 interim docs and `doctor` finding; #2085's harness PR (CI only, no package content); #2090's 1.x opt-in, only after the `doctor` finding ships | A new `doctor` finding is user-visible output, so a minor, not a patch |
| **2.0** (`integration/v2`) | K4 floor + shim deletion; #2083 backend; #2089; Z6; Z9; #2090 default-on | Each depends on the `>=16.4.0` floor or on the backend |

A 1.4 backend behind Next-version detection was rejected for two reasons:
- it would ship a `<16.4` / `>=16.4` split that 2.0 then deletes, which is the runtime written twice;
- the 1.x credential runs at 16.3.8, so a 16.4-only code path on 1.x could not be gated by 1.x's
  compat runs.

jev: **this split 0.80** / backend in 1.4 behind feature detection 0.17 / interim also as a 1.3.x
patch 0.03 (confidence 0.70). For #2090's 1.x opt-in: **1.4.0, after the `doctor` finding 0.72** /
no Cache Components on 1.x 0.26 / a 1.3.x patch 0.02 (confidence 0.58).

## Options considered

All scores are jev `choice` distributions (`jev-1.13.0`, 2026-10-10). The winning option is listed
first in each table.

| Decision | Option | jev | Trade-off |
|---|---|---|---|
| Order | #2084 → #2085 runs → K4 → #2083 → #2089 → Z6 (Z9 parallel) | **0.81** | Each surface is edited once, against its final floor |
| | Same, but #2089 before #2083 | 0.18 | #2089 edits code #2083 then extracts |
| | K4 first, compat run last | 0.01 | Floor raised unverified; breaks ADR-0007 |
| | Independent parallel PRs | 0.00 | The 0.89 rework risk #2103 names |
| `'use cache'` key scoping | App key, stored build id, miss on foreign | **0.67** | One key per entry; overwrite in place. Canary splits thrash (see Consequences) |
| | Build id in the key namespace | 0.30 | Clean separation; double memory in a rollout, stranded keys until TTL |
| | No build check | 0.03 | Old-build RSC payloads served to new code |
| No build id | Fail open, warn, `doctor` | **0.77** | Same as #2100; only images built outside knext reach it |
| | Fail closed to per-process | 0.23 | Safer for old-build payloads; silently drops sharing |
| | Refuse to start | 0.00 | A cache problem becomes an outage |
| Tag store | One shared store for both handlers | **0.93** | One `revalidateTag` reaches every entry kind |
| | Separate stores | 0.07 | Invalidation misses the other handler |
| Redis down | Miss/drop, timeout, breaker, metric | **1.00** | Never serves stale; loses invalidations during the outage (TTL-bounded) |
| | In-process LRU fallback | 0.00 | Serves entries another pod has invalidated |
| | Fail the request | 0.00 | Cache outage becomes an app outage |
| 1.x interim | Docs + `doctor` finding | **0.98** | Honest, zero runtime risk on 1.x |
| | Backport backend behind detection | 0.02 | Runtime written twice; ungated by the 16.3.8 credential |
| | Non-zero `cacheMaxMemorySize` on 1.x | 0.00 | Per-pod cache that vanishes on scale-to-zero, presented as working |
| #2083 design | This ADR + PR-level naming | **0.71** | One place for the cross-cutting contract |
| | Separate full ADR | 0.28 | A second document for the same keys and tags |
| Wake-ahead placement | Supervisor primer after the ARP primer | **0.98** | ~1 s earlier than `register()` (Z2 prediction) |
| | Out-of-process operator wake | 0.02 | A new controller path on the cold path |
| | `register()` | 0.00 | Measured too late |
| | Init container | 0.00 | Delays the zone's own start |
| Hook shape | One ordered primer list, both entry points | **1.00** | Supervisor changed once |
| | Two inline call sites | 0.00 | Drift between disk and compiled modes |
| | App plugin API | 0.00 | New public surface for an internal need |
| Wake list source | Operator-rendered from CR bindings | **0.96** | Operator stays the source of truth |
| | Runtime Kubernetes API discovery | 0.03 | Needs RBAC in app pods |
| | Baked at build time | 0.01 | Stale after a rebind without a rebuild |
| Gate for K4 | Triage smoke + one smoke per stable cell (~4 pool-hours) | **0.95** | Every cell exercised once, inside the cap |
| | Full non-smoke four-cell run | 0.05 | Several times the cost; the credential covers it later |
| | Single smoke cell | 0.00 | Bun and webpack untested at the floor |
| | No run | 0.00 | Breaks ADR-0007 |
| Release split | 1.3.x: #2100 · 1.4: interim · 2.0: the rest | **0.80** | Matches what each line can gate |
| | 1.4 backend behind detection | 0.17 | Earlier feature; runtime written twice |
| | Interim as a 1.3.x patch | 0.03 | A new `doctor` finding is not a patch |
| #2090 1.x opt-in | 1.4.0, after the `doctor` finding | **0.72** | Opt-in users are told the cache is per-process |
| | No Cache Components on 1.x | 0.26 | Simplest; withholds a feature that builds and serves today |
| | 1.3.x patch | 0.02 | A new scaffold option is not a patch |

## Consequences

**Positive**
- Each surface is edited once, against its final Next floor. `cache-handler.js` gets #2100, then the
  #2083 extraction, then #2089. `next-adapter.ts` gets K4, then #2083. The supervisor gets one primer
  list.
- `'use cache'` stops being a silent no-op twice over: on 1.x it is stated (docs and `doctor`); on
  2.0 it is shared across pods and survives scale-to-zero.
- Z6's security test runs against a real shared cache, so it can fail.
- The 16.4 floor is backed by a recorded run on every stable cell, and the "supported" wording waits
  for the credential.

**Negative and residual risks, accepted**
- **Canary splits thrash `'use cache'` entries.** With two builds live, each overwrites the other's
  entry for the same key, so the hit rate drops for the length of the split. Correctness holds. Revisit
  only if measured.
- **No build id → shared across builds.** Images built outside knext with none of the three sources
  can serve an old build's payload to new code. Surfaced by a warning and `doctor`; jev's confidence
  here was medium (0.66).
- **Invalidations lost during a Redis outage** stay lost until entry TTL. The ISR handler already has
  this property.
- **Wake-ahead wakes every bound function on every zone cold start**, needed or not (founder decision:
  wake all; per-route targeting later). The cost is one function activation per binding per zone cold
  start.
- **2.0 carries more of the plan's weight**, and 1.x users get the backend only by upgrading major.
- **About 4 pool-hours of compat** are spent before K4, scheduled around the 1.x credential slots.

## Action items

1. **Link and order the issues** (owner: lead, on acceptance). #2083, #2089, #2066, #2054, #2050,
   #2085 and #2090 each link to this ADR and carry the D1 edges as "Depends on". In particular:
   - #2066 depends on R1–R4 recorded green;
   - #2089 depends on #2083 and #2066;
   - #2050 depends on #2083;
   - #2054 depends on the primer-list change and #2052, and not on #2083.
2. **#2100 → 1.3.x backport** after it merges on `main` (patch changeset already in the PR).
3. **#2083 interim** on `main`: the docs page and the `doctor` finding, plus a test that reds if the
   finding's condition stops matching an app with `'use cache'` and no `cacheHandlers`.
4. **#2085:** the harness PR, then R1. File R2–R4 as one tracked item with the serialization rule and
   the 2-per-agent cap written into it.
5. **K4** on `integration/v2` after R1–R4: floor `>=16.4.0`, delete `standalone-adapter-path.ts` and the
   16.0.x ctx branch, pin the v2 credential cells at `v16.4.x`.
6. **#2083 backend:**
   - extract the shared key/build-id/tag module from `cache-handler.js`;
   - add the `cacheHandlers` handler and the `modifyConfig` wiring;
   - add the scaffold guard test.
   Exit: on kind, two pods share a `'use cache'` entry; it survives scale-to-zero; `revalidateTag` on
   pod A invalidates pod B; a Redis-down test shows misses, not errors. Mutation-proved.
7. **#2089** through the shared module. Exit per its issue: `cache-handler-next-stale-after-wake`
   passes without the seed, and `isr-cache-control-restart` passes in the first v2 credential run.
8. **Primer list (Z9's first commit):**
   - move the ARP block into `PROCESS_START_PRIMERS`, consumed by `node-server.ts` and
     `standalone-compile.mjs`;
   - add a scan-based test that fails if either entry point names a primer directly or drops the list.
   Then `wake-ahead.cjs` and the operator env render.
9. **Docs wording** for 16.4 stays "builds and serves; credential in progress" until the v2 credential
   windows complete.
