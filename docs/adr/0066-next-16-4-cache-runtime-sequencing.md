# ADR-0066: Next 16.4 cache surface and runtime-supervisor changes — one sequenced plan

- **Status:** **Accepted with Amendment 1 (2026-10-11).** Proposed 2026-10-10 and revised in review
  round 2 the same day; accepted at the Sprint 2 close design review (jev 0.98). D1–D5 stand as
  written, except where Amendment 1 (end of this file) supersedes a line. Design and sequencing only;
  no code lands with this ADR.
- **Date:** 2026-10-10
- **Trigger class:** ADR + hard rule ("don't rewrite the runtime twice"; "gate every feature on the
  official compatibility suite") + public API (the `'use cache'` backend export and its adapter
  wiring) + CRD (the `NextApp` fields that render the proto-version and wake-list variables, Z8 #2052). Reviewed at sprint close per `.claude/rules/workflow.md` (2026-09-22 amendment: not a
  merge gate).
- **Relates to:** ADR-0007 (compat gating — this ADR names the runs that gate the 16.4 floor),
  ADR-0052 (zone functions — Z6 cached reads and Z9 wake-ahead), ADR-0063 (release lines on
  integration branches), ADR-0064 (platform layer — the `'use cache'` backend is a platform default,
  not a recipe).
- **Covers:** #2084 / PR #2100, #2085, K1 #2065, K4 #2066, #2083, #2089, Z6 #2050, Z9 #2054,
  #2090. Release gate: #2102.
- **Evidence:** `.claude/research/next-16-4-impact-2026-10-09.md` (Q2, Q3, Q7, T1–T5),
  `.claude/plans/v2-sprint1-close-architect.md` (§4 task graph), `.claude/plans/v2-plan-rev4.md`
  (§3 slot accounting, K1→K4→K5), `docs/benchmarks/zone-functions-coldstart-kind-2026-10-09.md`
  (wake-ahead timing), and the published `next@16.4.0` package (`dist/server/lib/cache-handlers/types.d.ts`,
  `dist/server/use-cache/use-cache-wrapper.js`, `dist/server/revalidation-utils.js`,
  `dist/server/config-shared.js`).
- **Decision method:** every option choice below was scored with jev (`jev-1.13.0`, 2026-10-10);
  the winning option and the full distribution are quoted where the choice is made, and collected
  in "Options considered". **jev is not the evidence.** Review round 2 measured it as lenient on this
  topic (deliberately false findings scored 0.61–0.76), and one round-2 question (TTL cap) moved from
  0.33 to 0.93 when a single missing fact was added to its state. Every round-2 score therefore sits
  next to the code or package line it rests on, and the decision stands on that line.

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
| K4 #2066 | Next peer floor `>=16.4.0`; delete the 16.0.x ctx branch (**Amendment 1: `standalone-adapter-path.ts` is NOT deleted**) | `package.json`, `next-adapter.ts`, `cli/build-artifact.ts`, `tsup.config.ts` |
| #2083 | Shared Redis `cacheHandlers` (`'use cache'`) backend, wired by the adapter | new handler, `next-adapter.ts`, `cache-handler.js` (shared key/tag code) |
| #2089 | Return build-scoped `cacheControl` from `get()` (Next #99289); delete the #1888 private seed | `cache-handler.js` |
| Z6 #2050 | Generated `'use cache'` query functions for zone functions | generator; needs a real shared cache to test against |
| Z9 #2054 | Wake bound functions when the zone starts | supervisor |
| #2090 | Cache Components in `knext create`: opt-in on 1.x, default in v2 | templates |

### Verified against `main` (42d2d2dae)

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
- Tag invalidation is **delete-based, with no timestamps**. `set` adds the entry key to a per-tag
  Redis set `<prefix>:tag:<tag>` (`tagKey`, `cache-handler.js:817`; `SADD` at `:1301-1305`), and
  `revalidateTag` reads that set and `DEL`s every listed entry plus the set in one MULTI/EXEC
  (`:1349-1360`). No `tag:stamp` key exists (round 1 asserted one; it was wrong). The handler ignores
  Next 16's `durations` argument, so `revalidateTag(tag, profile)` expires immediately rather than
  marking stale. Tags of `APP_PAGE`/`APP_ROUTE`/`PAGES` writes come from the `x-next-cache-tags`
  header, not `ctx.tags` (`:823-851`).
- **Outage behaviour of the ISR handler is a per-process fallback, not a miss.** While Redis is
  unreachable or the breaker is open, `ensureConnected()` returns null and `get`/`set` use the
  module-level `memoryCache` Map (`:244`, read `:1205`, write `:1311-1323`). `revalidateTag` then
  clears only that pod's map (`:1370-1384`). The breaker is module state, so per process: one
  `unhealthyUntil` deadline and `REDIS_RETRY_COOLDOWN_MS` (default 5 s) per pod (`:133-139`, `:239-241`).
- **ISR TTL has no upper bound.** `__redisTtlSeconds` returns the render's `expire` as-is, else
  `max(2 × revalidate, 3600)` (`:957-968`). The per-tag index sets carry no TTL.

### What Next 16.4's `'use cache'` handler contract says (read from the `next@16.4.0` package)

- **Interface** (`cache-handlers/types.d.ts`): `get(cacheKey, softTags)`, `set(cacheKey,
  pendingEntry)`, `refreshTags()`, `getExpiration(tags)`, `updateTags(tags, durations?)`. An entry is
  `{value: ReadableStream, tags, stale, timestamp (ms), expire (s), revalidate (s)}`.
  - `set` consumes the stream once. It must not keep the stream, or put `pendingEntry` in a map that
    outlives the request.
  - A `get` that arrives while a `set` for the same key is pending **must wait for that set**, not
    return a miss.
  - "The handler also owns eviction. Next.js never removes an entry from the store."
- **Tag semantics are timestamps.** Next's built-in handler (`cache-handlers/default.js:142-190`)
  keeps `{stale, expired}` per tag:
  - `updateTags(tags, {expire})` sets `stale = now` and `expired = now + expire·1000`;
  - `updateTags(tags)` sets `expired = now`;
  - `getExpiration` returns the newest `expired`;
  - a read compares the entry's `timestamp` against both stamps.
  A delete-based index cannot express "stale now, expired later".
- **One `revalidateTag` already reaches both handlers.** `revalidation-utils.js:129-138` calls
  `updateTags` on every configured `cacheHandlers` kind **and** `incrementalCache.revalidateTag` (the
  ISR handler) for the same tags. Neither handler needs the other's store to see an invalidation.
- **Next already scopes `'use cache'` keys per build.** The key is `[id, args, implementationPart]`
  (`use-cache-wrapper.js:1509-1513`). `implementationPart` is `[deploymentId || buildId]` by default,
  or `[codeHash, nextVersion]` under the experimental durable-entries flag (`:2526-2572`).
- **Next already dedupes in-process.** Concurrent invocations of one key in a process join one
  pending computation (`SharedCacheEntry`, `use-cache-wrapper.js:89-160`).
- **The default `expire` is effectively unbounded**: `cacheLife.default.expire = INFINITE_CACHE`
  = `0xfffffffe` s, about 136 years (`config-shared.js:147-151`, `lib/constants.js:286`).
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

- **Compat budget.** One dispatch occupies roughly one pool-hour of the **one** shared runner pool,
  which the live 1.x credential windows also use. Cap: two dispatches per agent. Sixteen queued
  dispatches once froze the merge queue. Harness edits land between credential windows. **No v2
  credential lane exists yet.** Per the v2 plan (§3), R5 (#2041) first puts every credential workflow
  in one concurrency group. At 2.0 GA the v1.0 lane retires and the four 2.0 cells take the v1.3 slots.
- **1.4.0 release gate (#2102).** Nothing ships in 1.4.0, and no `operator-v*` bundle that installs
  the KnextPlatform CRD is tagged, until all of these hold:
  1. ADR-0064 reads "Accepted for design (P0)" and the founder has applied its Appendix A;
  2. #2099 (PR #2101) has landed;
  3. #2098 (PR #2110) has landed;
  4. #2108 (PR #2120) has landed;
  5. #2112's kind e2e is green.
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
S1a #2083 interim docs page ───────► main; the docs site deploys from main, so it publishes on merge.
                                     True of released 1.3.x today. Not held by #2102.
S1b #2083 interim doctor finding ──► main; RELEASED only in 1.4.0, so held by gate #2102
S1c #2090 1.x opt-in ──────────────► main after S1b; RELEASED only in 1.4.0, so held by gate #2102
S2  #2085 harness PR (no dispatch) ─► R1 smoke node/turbopack @v16.4.0 ─► triage table
S3  R2–R4 smoke on the other three stable cells @v16.4.0 (serialized)
S4  K4 #2066 on integration/v2      needs: this ADR Accepted, K1 #2065, S2, S3, R3a (integration/v2 cut)
S5  #2083 backend on integration/v2 needs: S4 (floor + next-adapter.ts), S1 (shared build-id chain)
S6  #2089 seed + cacheControl       needs: S5 (shared key/build-id module in cache-handler.js), S1, S4
S7a Z6 #2050 cached reads           needs: S5, Z8 #2052 (proto version + SERVICE_URL render), Z3 #2047
S7b Z9 #2054 wake-ahead             needs: D3 primer list, Z8 #2052 bindings; NOT S5
S8  #2090 v2 default                needs: S5, S1.
```

**The 1.4.0 gate (#2102) holds S1b and S1c.** Landing on `main` is not shipping. The `doctor` finding
and the opt-in reach users only in the 1.4.0 npm release. That release waits for every #2102 item
(Constraints above), whatever state this plan is in. Nothing in this plan may be used to argue
1.4.0 out early, and no item here is a reason to cut a 1.3.x minor around the gate. The docs page is
the exception, and deliberately so. It describes the behaviour of the *released* 1.3.x line, and the
docs site deploys from `main`, so holding it would hide a true statement for no gain.
jev, placement: **docs now, finding and opt-in in 1.4.0 behind #2102 0.97** / all three wait for
1.4.0 0.02 / the finding as a 1.3.x patch 0.01 (confidence 0.95). The evidence is #2102's own text:
"Neither 1.4.0 nor any `operator-v*` tag … ships until all of these hold".

**K1 → K4.** K1 (#2065, remove the `kn-next` bin), K4 and K5 all edit
`packages/kn-next/package.json`, and the v2 plan makes them serial: K4's row lists K1 as its
dependency (`v2-plan-rev4.md`, "K1 → K4 → K5 are serial"). Round 1 omitted that edge.

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
- **#2083 before #2089.** Both edit `cache-handler.js`. #2083 extracts the prefix, build-id
  resolver and Redis connection/breaker into one shared module (D2); #2089 then returns
  `cacheControl` through that module instead of growing a second copy. The reverse order (jev 0.18)
  has #2089 edit code #2083 then moves.
- **Z6 after #2083 and Z8.** Z6's two-user no-collision test passes vacuously against a no-op cache —
  a guard that stays green when its subject is absent (architect comment on #2050). It must run
  against the shared backend, across two pods, mutation-proved. Its key needs the served proto
  version that Z8 renders (D2, "Key").
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

**What the two handlers share, and what they do not (round 2).** One shared module owns:
- the key prefix;
- the build-id resolver (the #2100 chain);
- the Redis connection, with its timeouts and its circuit breaker.

`cacheHandler` (ISR) and `cacheHandlers` (`'use cache'`) both import it. They do **not** share an
entry format, a tag store or an outage mode. Next's contract differs between the two on all three
(Context, "What Next 16.4's `'use cache'` handler contract says"). Each difference is stated below
with its reason. Round 1 assumed one tag store and one outage mode, and both rested on facts that are
false on `main`.

**Key.**

| Element | Rule |
|---|---|
| Prefix | `REDIS_KEY_PREFIX` (the app name, operator-set), unchanged |
| ISR entries | `<prefix>:cache:<key>`, unchanged |
| `'use cache'` entries | `<prefix>:uc:<handler>:<cacheKey>`. `<handler>` is `default` or `remote`; `<cacheKey>` is Next's key, stored opaque |
| Build scoping, `'use cache'` | **Next's key already carries it.** The key's implementation part is `deploymentId \|\| buildId`, or a code hash under the durable-entries flag (`use-cache-wrapper.js:1509-1513`, `:2526-2572`). The handler stores `buildId` for diagnostics only and adds **no** foreign-build miss. A second check would be redundant on the default path, and it would defeat the durable-entries flag, whose purpose is reuse across builds when the code is unchanged |
| Build scoping, ISR | Unchanged from #2100: a stored `buildId` that differs from this process's is a miss. ISR keys are route paths, which Next does not scope by build |
| Build id | One resolver: `.next/BUILD_ID` → `KNEXT_BUILD_ID` → `NEXT_DEPLOYMENT_ID`, Next's constant id ignored (the #2100 chain, moved into the shared module) |
| No build id | ISR: **fail open**, as #2100 does. `'use cache'`: governed by Next's own key, as above. In both cases a one-time warning names the three sources, and `kn-next doctor` reports it |
| Function proto version (Z6) | **Part of every Z6 cached read's key.** Z6's generated `'use cache'` function takes the bound function's **served** proto version as an explicit argument, so the version lands in the `args` part of Next's key. The operator renders the value into the zone beside `<NAME>_SERVICE_URL`, from the served version Z8 records in `BackendService` status (ADR-0052 D7). The env var name is fixed in Z8's PR, as a CRD/public-API trigger |
| TTL | For `expire > 0`: Redis `EX` = min(entry `expire`, a configurable max, **default 24 h**). For `expire <= 0`: **skip the store** (next paragraph). Z6's per-user cached functions use a generated `cacheLife` profile with `expire` ≤ **1 h**; the handler's 24 h cap is the backstop. The cap only bounds eviction: Next itself treats an entry past `expire` as a miss (`types.d.ts`, `CacheEntry.expire`) |

**`expire <= 0` is never sent to Redis.** Next 16.4 calls `set` with `expire: 0` for dynamic
entries, and its built-in handler skips storing them in production: `if (!process.env.__NEXT_DEV_SERVER
&& entry.expire === 0) { ...; return }` (`next@16.4.0`, `dist/server/lib/cache-handlers/default.js:120`).
Redis rejects `SET ... EX 0`, and `redisCall()` (`cache-handler.js:802-808`) trips the shared breaker on
any error, so an unguarded `min(expire, cap)` would turn every dynamic entry into a breaker trip and
push ISR onto per-pod memory. The handler therefore:
- skips the store when `expire <= 0`, **but still fully consumes the entry's value stream** (and
  resolves the pending set), so Next is never left waiting on a half-read stream;
- validates arguments before the Redis call, and a client-side validation error (bad TTL, bad key)
  **never trips the outage breaker**. Only connection and timeout errors do, as today.

jev, `expire: 0` handling: **skip the store, drain the stream, as Next's built-in handler does 0.91** /
clamp to 1 s and store 0.09 / send `EX 0` and rely on the breaker 0.00 (confidence 0.86). The decision
rests on the `default.js:120` line and the Redis `EX 0` rejection, not on the score.

Why the proto version is required (#2050). ADR-0052 D7 makes functions roll out first. A function
rollout changes none of the zone's build id, deployment id or code hash, so nothing in Next's key
moves. Without the version, Z6 keeps serving results the previous function computed until their
TTL, and with Next's default `expire` that means indefinitely. The handler cannot add the version
itself, because it sees an opaque key and does not know which function produced it. A version change
re-renders the zone's env, so Knative rolls a new zone revision on the same image. Old pods keep the
old version in their key until the roll completes, and they share those entries only with each other.

Why a TTL cap. Next's default `cacheLife` sets `expire` to `INFINITE_CACHE`, about 136 years
(`config-shared.js:147-151`). The contract puts eviction on the handler: "Next.js never removes an
entry from the store". Without a cap, every `'use cache'` entry lives until memory pressure evicts it.
That includes Z6's entries holding one user's query results, which would outlive a permission change
or an account deletion. Self-managed Redis on 64-bit has no memory limit by default (`maxmemory 0`,
`noeviction`), and knext documents no Redis memory setting today (a repo-wide search for `maxmemory`
finds nothing).

**Redis memory policy (documented as part of #2083).** Set `maxmemory`, with
`maxmemory-policy volatile-lru`.
- Every cache entry carries a TTL, so it is evictable.
- ISR's tag-index sets and the `'use cache'` tag-stamp hash carry none, so `volatile-lru` never
  evicts them. Evicting either would silently lose an invalidation.
- `allkeys-*` policies can evict a tag index, so they are not supported.
- Under `noeviction` (the Redis default), writes fail at the limit and the breaker trips. ISR then
  falls back to per-pod memory and `'use cache'` returns misses. That failure is loud, and it is a
  correctness failure only to the extent of ISR's existing fallback.
- jev, eviction bound: **cap (24 h, 1 h per-user, `volatile-lru` documented) 0.93** / no cap 0.07 /
  uniform 7-day cap 0.00 (confidence 0.89). The first run, without the Redis-default fact in its
  state, scored no cap 0.67 / cap 0.33 (confidence 0.51). The decision rests on the contract line and
  the 136-year default above, not on either score.
- jev, policy: **`volatile-lru` 0.89** / `noeviction` 0.09 / `allkeys-lru` 0.02 (confidence 0.83).

jev, build scoping (round 2, replaces round 1's "stored build id, miss on foreign" for `'use cache'`):
**rely on Next's key, store `buildId` for diagnostics 0.97** / add a foreign-build miss 0.03
(confidence 0.94). Evidence: `use-cache-wrapper.js:2555-2572`.
jev, proto version: **generator passes the served version as an argument 0.91** / no version, rely on
TTL 0.08 / one global prefix in the handler 0.01 (confidence 0.86). Evidence: ADR-0052 D7
(function-first rollout), and the key composition above.

**Tag invalidation: separate mechanisms per handler.** This replaces round 1's "one shared tag
store", which assumed a stamp key that does not exist.
- **ISR: unchanged.** It keeps the delete-based index (`cache-handler.js:1349-1360`), including the
  MULTI/EXEC atomicity guard and its SIGTERM test. It is not migrated.
- **`'use cache'`: a timestamp store that implements Next's contract.** One Redis hash,
  `<prefix>:uc:tags`, with field = tag and value = `{stale, expired}` in epoch ms. Its semantics copy
  Next's built-in handler (`cache-handlers/default.js:142-190`) exactly:
  - `updateTags(tags, {expire})` sets `stale = now` and `expired = now + expire·1000`.
    `updateTags(tags)` sets `expired = now`.
  - `getExpiration(tags)` runs `HMGET` on those tags only and returns the newest `expired`, or `0`.
  - `get(key, softTags)` reads the entry and its own tags' stamps in one round trip (a server-side
    script):
    - `expired` later than the entry's `timestamp` and not in the future: miss;
    - `stale` later than `timestamp`: return the entry with `revalidate: -1`, Next's "serve once,
      refresh in the background" convention (`types.d.ts`, `CacheEntry.revalidate`).
  - `refreshTags()` is a no-op. There is no per-process tag manifest, so there is no cross-pod
    staleness window: every read checks the live stamps. Round 1's "pull stamps into a per-process map
    once per request" would read the whole hash on every request, and is dropped.
  - **Stamp growth is bounded.** A stamp older than the TTL cap cannot affect a live entry, because
    every entry written before it has already expired. `updateTags` prunes such fields with a bounded
    `HSCAN` step per call.
  - Timestamps are pod wall clock, as Next's are. Cross-pod clock skew, bounded by NTP to
    milliseconds, is the window in which a write that races an invalidation can survive it.
- **One `revalidateTag` call still reaches both.** Next fans every `revalidateTag`/`updateTag` out to
  each `cacheHandlers` kind's `updateTags` **and** to the ISR handler's `revalidateTag`
  (`revalidation-utils.js:129-138`). Sharing a store is not needed for coverage.
- **Why not one store.** Next's contract is timestamp-based, and ISR's index is delete-based. A
  single store means either:
  - giving `'use cache'` a delete-based index, which cannot express "stale now, expired later" and
    so breaks `revalidateTag(tag, profile)`; or
  - migrating ISR to stamps. That puts a Redis read on every ISR `get`, needs a dual-write release
    (stamps and index both) before the index can go, and reopens the T13 atomicity work. It also
    moves a 1.x correctness surface for no 2.0 feature.

  If ISR later needs `revalidateTag(tag, profile)` stale-while-revalidate semantics (today it ignores
  `durations`), that gets its own ADR with that three-step migration.
- Tags are **not** build-scoped. A data change invalidates every build's entries. Implicit path tags
  (`_N_T_…`) arrive through the same fan-out and are stored the same way.

jev, tag store: **separate mechanisms per handler 0.91** / shared timestamp stamps with an ISR
migration 0.08 / one delete-based index for both 0.01 (confidence 0.86). Evidence:
`cache-handler.js:1349-1360` (delete-only), `cache-handlers/default.js:159-190` (timestamps),
`revalidation-utils.js:129-138` (fan-out). Round 1's "one shared tag store 0.93" is withdrawn: its
state described a stamp key that does not exist.

**Failure mode: the two handlers differ, deliberately.** Round 1 said the new backend's behaviour
"matches ISR". It does not, and the ADR now says so.

| | `'use cache'` (new) | ISR (unchanged, 1.x behaviour) |
|---|---|---|
| Redis down or breaker open | `get` → miss. `set` drains the stream (the single-consume contract, #98039) and drops the write. `updateTags` is dropped. **No per-process store of any kind**, not even Next's in-memory default handler | Falls back to the per-process `memoryCache` (`:1205`, `:1311-1323`). `revalidateTag` clears only that pod's map (`:1370-1384`) |
| Signals | A counter on the existing metrics surface (name fixed in #2083's PR), one warning per outage | Existing `logCacheEvent` with `source: 'memory'` |

- **Why they differ.** The `'use cache'` store is where Z6's per-user entries live, and a per-process
  fallback there would be a security defect, not just a staleness one:
  - It holds one user's results in pod memory, outside the Redis TTL cap.
  - It never sees an invalidation another pod processed, so a revoked permission keeps serving on
    that pod.
  - It builds its own key, which is one more place where a key-composition slip turns into a
    cross-user leak.

  Miss/drop has no such store, so no entry can sit in a shared per-process fallback under the wrong
  key. ISR entries are prerendered pages and route responses shared across users. Its fallback risks
  staleness, not a cross-user leak, and changing a 1.x behaviour is out of this plan's scope.
  Aligning ISR to miss/drop is filed as tech debt (#2122) for the sprint-close review, not decided here.
- **Breaker: per process, one per process, shared by both handlers** through the shared module (one
  connection, one `unhealthyUntil`).
  - Why per process: a breaker shared across pods needs a store that is up while Redis is down. The
    platform has none, and a breaker kept in Redis fails exactly when it is needed. The cost of per
    process is one probe per pod per cooldown (5 s default): N pods send N probes every 5 s.
  - Why shared by both handlers: they always agree on whether Redis is up, so a page and the
    `'use cache'` reads inside it never straddle the two states.
- **Residual, stated.**
  - `'use cache'`: an `updateTags` dropped during the outage is lost. Entries written before the
    outage stay valid until their Redis TTL, which the cap now bounds at 24 h, or 1 h for per-user
    entries.
  - ISR: a `revalidateTag` during the outage clears only the local map. Its Redis entries stay stale
    until their TTL, as they do today.
  - An in-process retry queue would be lost on scale-to-zero, which is the normal case, so neither
    handler adds one.

jev, outage: **the two handlers differ, stated 0.69** / `'use cache'` also falls back per process
0.27 / change ISR to miss/drop too 0.04 (confidence 0.53). The confidence is medium, so the decision
rests on the security argument and the code lines above, not on the score.
jev, breaker: **per process, shared by both handlers 0.85** / per process, one per handler 0.14 /
held in Redis 0.01 (confidence 0.77).

**Herd on scale-from-zero.**
- **In process.** Next already joins concurrent invocations of one key (`SharedCacheEntry`,
  `use-cache-wrapper.js:89-160`). The handler adds the pending-set wait the contract requires
  (`types.d.ts`, `set`): a per-process map from Redis key to a **handler-owned** promise. That promise
  settles when the `set` finishes and is removed in `finally`, and a `get` for that key awaits it. The
  map never holds `pendingEntry` or the stream, which the contract forbids.
- **Across pods: no distributed lock.** The activator buffers the cold-start burst and hands it to the
  first ready pod, so most of the herd lands in one process, where the in-process dedup applies.
  Duplicate computation across pods is bounded by the number of pods that start inside one miss
  window, and they write the same key. A Redis lock (`SET NX PX`) costs too much here:
  - a round trip on every miss;
  - under routine SIGTERM, a holder that dies mid-compute stalls every waiter until the lock's `PX`
    expires;
  - it fails anyway when Redis does.
- jev: **in-process dedup + pending-set wait, no cross-pod lock 0.92** / Redis lock 0.07 / none 0.01
  (confidence 0.88).

**Security.** Redis credentials stay in the Secret-backed `REDIS_URL`. The backend adds no endpoint.
- Per-user isolation of Z6's cached reads is Z6's contract: key on the verified subject, never the
  raw token. This backend must not hash anything user-supplied into a shared key on its own.
- The backend has no per-process fallback (Failure mode above), so a per-user entry exists only in
  Redis, under Next's key.
- Per-user entries are capped at 1 h (TTL above).

**1.x interim.** Until the backend ships, 1.x states the behaviour instead of hiding it:
- a docs page, published from `main` (the dogfooded docs site), on `'use cache'` and
  `'use cache: remote'` on knext. It describes released 1.3.x, so it publishes on merge and is not
  held by #2102 (D1, S1a);
- a `kn-next doctor` finding for an app that uses `'use cache'` or `cacheComponents`. It says the
  cache is per-process, not shared across pods, and lost on scale-to-zero, and that with the scaffold's
  `cacheMaxMemorySize: 0` it is off. It reaches users in **1.4.0, behind the #2102 gate** (D1, S1b).

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
  - bounds its own work: a hard per-call timeout below the target's cold start, errors logged once,
    no retry loop;
  - can be switched off by env (`KNEXT_ARP_PRIMER=0` today; Z9 adds its own switch);
  - **is never on the readiness path.** No health or readiness handler awaits, reads or depends on a
    primer. The zone's first `/healthz` answers whatever state the primers are in;
  - **is cancelled on SIGTERM.** The list module owns one `AbortController`, anchored on `globalThis`
    under a `Symbol.for('knext.runtime.*')` key (ADR-0027: a module-level `let` would split across
    bundle copies). Each primer passes its signal to every outbound call and `unref()`s its timers.
    Both entry points' SIGTERM handlers call the list's `abortPrimers()` **before** draining, so a
    primer can never hold the drain or keep the event loop alive.
- **`wake-ahead.cjs`** sends one non-blocking GET to each bound function's health path.
  - **Discovery uses the ADR-0004 contract, not a prefix scan** (#2054). The operator renders two
    things from the `NextApp` bindings Z8 adds:
    - `<NAME>_SERVICE_URL` for each binding (ADR-0004, unchanged);
    - one list of the binding **names** to wake.

    The primer resolves each listed name to its `<NAME>_SERVICE_URL`. A name with no URL is logged
    once and skipped. The primer never scans `process.env` for a suffix: a scan picks up unrelated
    variables and drifts silently when the naming changes.
  - **Both sides test one contract.** The name → env-var derivation (case, separator) and the list
    variable are recorded in an ADR-0004 amendment. One shared fixture of bindings and expected env is
    asserted by a Go test (the operator renders it) and a TypeScript test (the primer parses it).
    Changing either side alone reds the other's test, and that is mutation-proved.
  - Per-function opt-out: the operator leaves that binding's name out of the list.
  - **N pods.** A zone scaling from 0 to N pods with M bindings fires N×M wake calls. They collapse
    into one activator wake per function, so this is harmless, and the ADR says so rather than leave
    it to be discovered.
  - The GET is non-mutating and cluster-local, so the "no unauthenticated mutating endpoints" rule
    is not engaged.
  - The `register()` hook from the Z2 spike is not shipped.
- **Why this placement does not fight the runtime.** The primer list is the only supervisor edit in
  this plan. K4 does not touch `node-server.ts`, and #2083/#2089 are cache-handler-only. Any later
  process-start work appends to the list rather than adding a third inline block.
- **Exit evidence** is Z9's:
  - on kind, the chained cold start improves by the margin Z2 predicted, and the opt-out is honoured;
  - a test points wake-ahead at an unreachable function (a blackholed address) and shows that neither
    the first `/healthz` nor the SIGTERM drain is delayed. It is mutation-proved by making the call
    blocking, and by removing the `abortPrimers()` call;
  - the operator/primer contract tests above are green on both sides.

  Absolute numbers come from OKE in Z10.

jev:
- placement: **supervisor preload after the ARP primer 0.98** / out-of-process operator wake 0.02 /
  `register()` 0.00 / init container 0.00;
- hook shape: **one ordered primer list consumed by both entry points 1.00** / two inline call
  sites 0.00 / an app plugin API 0.00;
- list source: **operator-rendered from CR bindings 0.96** / runtime Kubernetes API discovery
  0.03 / baked at build time 0.01;
- discovery (round 2): **a list of binding names resolved through `<NAME>_SERVICE_URL`, with one
  fixture tested on both sides 0.99** / a separate URL-list variable 0.01 / an env suffix scan 0.00
  (confidence 0.98). Evidence: ADR-0004 lines 19 and 38 (the `<NAME>_SERVICE_URL` contract) and the
  #2054 review ("an ad-hoc prefix scan will drift"). This score adds little beyond that evidence.

### D4. Compat gating: which runs, and their budget

No floor bump and no "supported" claim without a green 16.4 run. Round 1 said the v2 credential
"uses existing credential slots, no extra dispatch". That was not honest. No v2 credential lane
exists, and the one runner pool is the same pool the live 1.x windows run on. The plan therefore has
two parts: smoke dispatches now, with a real budget; and credential lanes later, created by the v2
plan's own tasks.

**Part 1: smoke dispatches now (the engineering gate for K4 and #2089).**

| Run | Workflow and inputs | Gates | Dispatches |
|---|---|---|---|
| R1 | `test-e2e-deploy.yml`: `nextjsRef=v16.4.0`, `runtime=node`, `builder=turbopack`, `smoke=true`. After #2085's harness PR merges | Harness readiness; produces #2085's triage table | 1 |
| R2–R4 | Same inputs for `bun/turbopack`, `node/webpack`, `bun/webpack` | K4's floor raise | 3 |
| Triage re-dispatches | One per cell at most, and only after the fix for a triaged knext gap has landed. Never a blind retry | Same as the run it repeats | ≤ 4 |
| R6 | One **full** (non-smoke) `node/turbopack` dispatch at `v16.4.x` on `integration/v2`, after #2089 merges. Upstream `isr-cache-control-restart` is not in the smoke manifest (`test/deploy-tests-manifest.smoke.knext.json`), and the workflow has no test-filter input, so a smoke run cannot carry it | #2089's exit | 1, plus ≤ 1 triage re-dispatch |

- **Budget: at most 10 dispatches, about 10 pool-hours; 5 expected** (R1–R4 and R6 green first
  time). The budget is a ceiling. A run past it needs the lead's sign-off and a written reason.
- **Serialization.** One dispatch in flight at a time. The lead owns the queue, and each agent stays
  under the existing cap of 2 dispatches. Every dispatch goes between the 1.x credential cron slots,
  never overlapping a credential run, because they share the pool.
- **"Green" for R1–R4 and R6** means every red file is triaged as vercel-infra-coupled or a `@gate`
  inversion, with zero open knext gaps. A run with an open knext gap does not count. Its fix lands
  first, the re-dispatch comes out of the budget above, and triage always happens before a
  re-dispatch.
- **What these runs do not buy.** A floor is an engineering gate. A claim is a credential. Smoke runs
  are dispatch-only and never count toward a credential window.

**Part 2: v2 credential lanes, created later by the v2 plan (not by this ADR).**
- Today no v2 credential lane exists, and none is started when K4 lands.
- R5 (#2041) first puts every credential workflow in one concurrency group, landing between windows
  (`v2-plan-rev4.md` §3).
- At **2.0 GA the v1.0 lane retires**, and the four 2.0 cells take the v1.3 slots (§3, slot
  accounting). Net load never exceeds today's slot count.
- Until those lanes complete their windows (14 consecutive green independent runs per cell), docs,
  the compat matrix and release notes say "builds and serves; credential in progress" for Next 16.4,
  never "supported". The 1.x credential stays at 16.3.8 throughout.

jev, round 2: **smoke now with an explicit budget including triage re-dispatches and one full run
for #2089; credential lanes later per R5 and the 2.0 GA slot swap 1.00** / "existing slots, no extra
dispatch" 0.00 / a full four-cell run now 0.00 (confidence 1.00). The score adds nothing to the
evidence: `test-e2e-deploy.yml` inputs (`:69-206`), the smoke manifest, and `v2-plan-rev4.md` §3.
Round 1's choice of runs before K4 (one triage smoke, then one smoke per remaining stable cell, 0.95)
stands. Only its budget and its credential wording change.

### D5. What ships where

| Line | Ships | Why there |
|---|---|---|
| **1.3.x patch** (`integration/v1.3`) | #2084 / PR #2100 only | Internal correctness, no public surface, patch changeset |
| **Docs site** (deploys from `main`) | The #2083 interim docs page | Describes released 1.3.x; not an npm release, so not held by #2102 |
| **1.4.0** (`main`), **held by gate #2102** | #2100 (already on `main`); the #2083 interim `doctor` finding; #2085's harness PR (CI only, no package content); #2090's 1.x opt-in, only after the `doctor` finding | A new `doctor` finding is user-visible output, so a minor, not a patch. 1.4.0 itself ships only when every #2102 item holds: ADR-0064 accepted with Appendix A applied by the founder, #2099 (PR #2101), #2098 (PR #2110), #2108 (PR #2120), and #2112's kind e2e green |
| **2.0** (`integration/v2`) | K1 then K4 floor (the `adapterPath` shim stays, Amendment 1); #2083 backend; #2089; Z6; Z9; #2090 default-on | Each depends on the `>=16.4.0` floor or on the backend |

A 1.4 backend behind Next-version detection was rejected for two reasons:
- it would ship a `<16.4` / `>=16.4` split that 2.0 then deletes, which is the runtime written twice;
- the 1.x credential runs at 16.3.8, so a 16.4-only code path on 1.x could not be gated by 1.x's
  compat runs.

jev: **this split 0.80** / backend in 1.4 behind feature detection 0.17 / interim also as a 1.3.x
patch 0.03 (confidence 0.70). For #2090's 1.x opt-in: **1.4.0, after the `doctor` finding 0.72** /
no Cache Components on 1.x 0.26 / a 1.3.x patch 0.02 (confidence 0.58).

## Options considered

All scores are jev `choice` distributions (`jev-1.13.0`, 2026-10-10). The winning option is listed
first in each table. Rows marked **(r2)** were added or changed in review round 2. Each of those
decisions rests on the code or package evidence cited in its D-section, not on the score (see
"Decision method").

| Decision | Option | jev | Trade-off |
|---|---|---|---|
| Order | #2084 → #2085 runs → K1 → K4 → #2083 → #2089 → Z6 (Z9 parallel) | **0.81** | Each surface is edited once, against its final floor |
| | Same, but #2089 before #2083 | 0.18 | #2089 edits code #2083 then extracts |
| | K4 first, compat run last | 0.01 | Floor raised unverified; breaks ADR-0007 |
| | Independent parallel PRs | 0.00 | The 0.89 rework risk #2103 names |
| 1.x interim placement **(r2)** | Docs page now from `main`; `doctor` finding and opt-in in 1.4.0 behind #2102 | **0.97** | True docs are not held hostage to an unrelated gate; npm content waits for it |
| | All three wait for 1.4.0 | 0.02 | Hides a true statement about released 1.3.x |
| | `doctor` finding as a 1.3.x patch | 0.01 | Routes around the gate; a new finding is not a patch |
| `'use cache'` build scoping **(r2)** | Rely on Next's key (`deploymentId \|\| buildId`, or code hash); store `buildId` for diagnostics | **0.97** | No redundant check; durable entries keep working |
| | Also miss on a foreign stored `buildId` | 0.03 | Redundant by default; defeats durable entries. Round 1's pick (0.67), withdrawn: its state did not know Next's key carries the build |
| No build id (ISR) | Fail open, warn, `doctor` | **0.77** | Same as #2100; only images built outside knext reach it |
| | Fail closed to per-process | 0.23 | Safer for old-build payloads; silently drops sharing |
| | Refuse to start | 0.00 | A cache problem becomes an outage |
| Function proto version **(r2)** | Generator passes the served version as a cached-function argument | **0.91** | Function-first rollouts change the key; a version change re-rolls the zone revision |
| | Nothing; rely on TTL | 0.08 | Old function's results served until TTL (indefinitely by default) |
| | One global prefix in the handler | 0.01 | The handler cannot know which function an opaque key belongs to |
| Eviction bound **(r2)** | Cap 24 h, 1 h per-user, `volatile-lru` documented | **0.93** | Bounded memory and per-user retention; capped entries recompute sooner |
| | No cap; rely on `maxmemory` | 0.07 | Redis has no limit by default; per-user data outlives permission changes. Scored 0.67 in a first run whose state omitted the Redis default |
| | Uniform 7-day cap | 0.00 | Per-user retention still a week |
| Redis memory policy **(r2)** | `volatile-lru` with `maxmemory` | **0.89** | Tag indexes and stamps (no TTL) are never evicted |
| | `noeviction` | 0.09 | Writes fail at the limit; loud but safe |
| | `allkeys-lru` | 0.02 | Can evict a tag index and lose an invalidation |
| Tag store **(r2)** | Separate mechanisms: ISR delete index unchanged; `'use cache'` timestamp hash | **0.91** | Each implements its own contract; Next's fan-out reaches both |
| | Shared timestamp stamps, migrate ISR | 0.08 | Read on every ISR `get`, a dual-write release, the T13 work reopened |
| | One delete-based index for both | 0.01 | Cannot express stale-then-expired; breaks `revalidateTag(tag, profile)`. Round 1's "one shared store 0.93" is withdrawn: it assumed a stamp key that does not exist |
| Redis down **(r2)** | `'use cache'` miss/drop; ISR keeps its per-process fallback; stated | **0.69** | No per-user data in pod memory; the two handlers degrade differently |
| | `'use cache'` also falls back per process | 0.27 | Per-user entries in pod memory, outside TTL and invalidation |
| | Change ISR to miss/drop too | 0.04 | Changes a 1.x behaviour outside this plan; filed as tech debt (#2122) |
| Circuit breaker **(r2)** | Per process, shared by both handlers | **0.85** | No external store needed; both handlers agree on Redis state |
| | Per process, one per handler | 0.14 | A page and its `'use cache'` reads can straddle states |
| | Held in Redis | 0.01 | Fails exactly when needed |
| Herd **(r2)** | Next's in-process dedup + pending-set wait; no cross-pod lock | **0.92** | Contract-required; the activator funnels the burst to one pod |
| | Redis `SET NX PX` lock | 0.07 | A round trip per miss; a SIGTERMed holder stalls waiters |
| | None | 0.01 | Breaks the contract's pending-set rule |
| 1.x interim content | Docs + `doctor` finding | **0.98** | Honest, zero runtime risk on 1.x |
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
| Wake discovery **(r2)** | Names list resolved via `<NAME>_SERVICE_URL`, one fixture tested on both sides | **0.99** | Reuses the ADR-0004 contract; drift reds a test |
| | Separate URL-list variable | 0.01 | A second encoding of the same URLs |
| | Env suffix scan | 0.00 | Picks up unrelated variables; drifts silently |
| Gate for K4 | Triage smoke + one smoke per stable cell | **0.95** | Every cell exercised once, inside the cap |
| | Full non-smoke four-cell run | 0.05 | Several times the cost |
| | Single smoke cell | 0.00 | Bun and webpack untested at the floor |
| | No run | 0.00 | Breaks ADR-0007 |
| Compat budget and credential **(r2)** | Smoke now, ≤ 10 dispatches incl. triage and R6; v2 lanes later via R5 and the 2.0 GA slot swap | **1.00** | Honest about the shared pool; "supported" waits for real lanes |
| | "Existing credential slots, no extra dispatch" | 0.00 | Round 1's wording; no v2 lane exists |
| | Full four-cell run now | 0.00 | Pool-hours the 1.x windows need |
| Release split | 1.3.x: #2100 · 1.4 (behind #2102): interim · 2.0: the rest | **0.80** | Matches what each line can gate |
| | 1.4 backend behind detection | 0.17 | Earlier feature; runtime written twice |
| | Interim as a 1.3.x patch | 0.03 | A new `doctor` finding is not a patch |
| #2090 1.x opt-in | 1.4.0, after the `doctor` finding | **0.72** | Opt-in users are told the cache is per-process |
| | No Cache Components on 1.x | 0.26 | Simplest; withholds a feature that builds and serves today |
| | 1.3.x patch | 0.02 | A new scaffold option is not a patch |

## Consequences

**Positive**
- Each surface is edited once, against its final Next floor. `cache-handler.js` gets #2100, then the
  #2083 extraction, then #2089. `next-adapter.ts` gets K4, then #2083. `package.json` gets K1, then
  K4. The supervisor gets one primer list.
- `'use cache'` stops being a silent no-op twice over: on 1.x it is stated (docs and `doctor`); on
  2.0 it is shared across pods and survives scale-to-zero.
- Z6's security test runs against a real shared cache, so it can fail. Per-user entries never sit in
  pod memory, and they are bounded at 1 h.
- The 16.4 floor is backed by a recorded run on every stable cell, and the "supported" wording waits
  for a real credential lane.

**Negative and residual risks, accepted**
- **Two builds' `'use cache'` entries coexist during a rollout.** Next's key differs per build, so
  entries are not overwritten in place. The old build's entries strand until their TTL, now at most
  24 h. (Round 1 said canary splits "thrash" one shared key. That was wrong for `'use cache'`.) With
  the durable-entries flag, entries whose code hash did not change are reused across builds, which is
  the flag's intent.
- **Two outage behaviours.** During a Redis outage ISR serves from per-pod memory and `'use cache'`
  recomputes. An operator reading metrics sees `source: 'memory'` for one and misses for the other.
  Aligning ISR is tech debt, filed as #2122.
- **Two tag mechanisms.** One `revalidateTag` reaches both through Next's fan-out. A future ISR
  move to timestamp semantics needs its own ADR and a three-step migration.
- **No build id → ISR shared across builds.** Images built outside knext with none of the three
  sources can serve an old build's ISR payload to new code. Surfaced by a warning and `doctor`; jev's
  confidence here was medium (0.66).
- **Invalidations lost during a Redis outage** stay lost until entry TTL: at most 24 h for
  `'use cache'`, 1 h per-user. ISR's outage invalidations clear only the local map, as today.
- **A function proto-version change re-rolls the zone** (an env change makes a new Knative revision
  on the same image). That is the price of putting the served version in the key.
- **Clock skew.** `'use cache'` tag timestamps are pod wall clock, as Next's are. An NTP-bounded,
  millisecond-scale window exists in which a write that races an invalidation survives it.
- **Wake-ahead wakes every bound function on every zone cold start**, needed or not (founder decision:
  wake all; per-route targeting later). The cost is one function activation per binding per zone cold
  start. N pods × M bindings calls collapse into one activator wake per function.
- **2.0 carries more of the plan's weight**, and 1.x users get the backend only by upgrading major.
- **Compat: up to 10 dispatches (5 expected)**, serialized around the 1.x credential slots. The
  "supported" claim for 16.4 waits until after 2.0 GA, when the v2 lanes take the retired v1.0 slots
  and complete their windows.
- **1.4.0's interim items wait on #2102**, which depends on platform-layer work (ADR-0064) unrelated
  to the cache. That delay is accepted, and only the docs page escapes it.

## Action items

1. **Link and order the issues** (owner: lead, on acceptance). #2083, #2089, #2065, #2066, #2054,
   #2050, #2085 and #2090 each link to this ADR and carry the D1 edges as "Depends on". In
   particular:
   - #2066 depends on #2065 (K1) and on R1–R4 recorded green;
   - #2089 depends on #2083 and #2066;
   - #2050 depends on #2083 and #2052 (served proto version render);
   - #2054 depends on the primer-list change and #2052, and not on #2083;
   - the 1.4.0 checklist on #2102 lists the #2083 `doctor` finding and #2090's 1.x opt-in as release
     content held by that gate.
2. **#2100 → 1.3.x backport** after it merges on `main` (patch changeset already in the PR).
3. **#2083 interim** on `main`:
   - the docs page (publishes on merge);
   - the `doctor` finding (ships in 1.4.0), with a test that reds if the finding's condition stops
     matching an app with `'use cache'` and no `cacheHandlers`.
4. **#2085:** the harness PR, then R1. File R2–R4, the triage re-dispatch allowance and R6 as one
   tracked item, with the ≤ 10 budget, the serialization rule and the 2-per-agent cap written into it.
5. **K4** on `integration/v2`, after K1 and R1–R4: floor `>=16.4.0`; delete the 16.0.x ctx branch
   (Amendment 1: `standalone-adapter-path.ts` is kept). The v2 credential lanes are **not** started here (D4, part 2).
6. **#2083 backend:**
   - extract the shared prefix/build-id/connection-and-breaker module from `cache-handler.js`;
   - add the `cacheHandlers` handler, implementing D2's tag store, TTL cap, miss/drop outage mode and
     pending-set wait;
   - add the `modifyConfig` wiring and the scaffold guard test;
   - document the Redis `maxmemory` / `volatile-lru` setting.

   Exit, all mutation-proved, on kind:
   - two pods share a `'use cache'` entry, and it survives scale-to-zero;
   - `revalidateTag` on pod A invalidates pod B, and `revalidateTag(tag, profile)` serves stale once
     before refreshing;
   - with Redis down, a `set` then `get` in one process returns a miss: no per-process store exists;
   - the Redis TTL never exceeds the cap;
   - `set` with `expire: 0` stores nothing, fully drains the value stream, and does **not** trip the
     breaker: ISR still serves from Redis afterwards. Mutation-proved by removing the `expire <= 0`
     guard (the test reds because the breaker opens);
   - a client-side validation error in the `'use cache'` path leaves the breaker closed, while a
     connection error opens it;
   - a `get` racing a pending `set` waits for it rather than missing.
7. **#2089** through the shared module. Exit per its issue: `cache-handler-next-stale-after-wake`
   passes without the seed, and upstream `isr-cache-control-restart` passes in R6.
8. **Z6 (#2050):**
   - the generated per-user cached functions take the served proto version as an argument and carry
     the ≤ 1 h `cacheLife` profile;
   - a function-first rollout test: bump the served version, and the zone's next read misses;
     mutation-proved by dropping the argument;
   - the two-user test has a positive control (A's second read is a hit) and a cross-pod
     `updateTag` test.
9. **ADR-0004 amendment** (with Z8): record `<NAME>_SERVICE_URL`'s name derivation, the wake-list
   variable and the served-proto-version variable as the operator↔runtime contract, with the shared
   fixture tested in Go and TypeScript. **Scope and exit criteria of Z8 #2052 (a CRD trigger):**
   rendering the served proto version and the wake list into the `NextApp` zone's env is part of
   #2052, not left to #2050 or #2054; its exit test shows a bumped served version re-renders the
   zone's env and rolls a new revision.
10. **Primer list (Z9's first commit):**
    - move the ARP block into `PROCESS_START_PRIMERS`, consumed by `node-server.ts` and
      `standalone-compile.mjs`, with `abortPrimers()` on the `globalThis` anchor called first in
      both SIGTERM paths;
    - add a scan-based test that fails if either entry point names a primer directly or drops the
      list.

    Then `wake-ahead.cjs` and the operator env render, with D3's unreachable-function exit test.
11. **Docs wording** for 16.4 stays "builds and serves; credential in progress" until the v2
    credential lanes (created per the v2 plan, after R5 and at 2.0 GA) complete their windows.
12. **Tech debt for sprint close:** ISR's per-process outage fallback, and its delete-only handling of
    `revalidateTag(tag, profile)`. Filed as #2122 (milestone v2.0, `priority:P2`).

## Amendment 1 (2026-10-11): K4 keeps the `adapterPath` shim; the gate is the D4 smoke runs

**Status of this amendment: Accepted** (Sprint 2 close design review, jev 0.98; keep-Proposed 0.01).
It corrects one design premise that a measurement invalidated, and one piece of wording. Trigger-class
(ADR, hard rule "gate every feature on the official compatibility suite", public API via the peer
floor); per the 2026-09-22 workflow amendment it is not a merge gate. It must merge before K4 (#2066)
starts. D1, D2 and D4 are otherwise unchanged.

### What changed

1. **`standalone-adapter-path.ts` does not retire at K4.** This ADR's Context table, D5 and action 5
   said K4 deletes the module, on the premise that Next 16.4.0 fixes the bug it works around
   (vercel/next.js#98964). #98964 fixes only half of it. The module now blanks `adapterPath` in the
   standalone runtime config **unconditionally, on every Next version** (#2124, PR #2132):
   - with `adapterPath` set, Next 16.4.0's app-page runtime answers a `dynamicParams = false` miss
     with `render404()` instead of throwing `NoFallbackError`, which is what lets Next's own router
     fall through to the next, less specific route (a catch-all behind a closed `[slug]`);
   - the adapter branch is written for a platform that routes with `@next/routing` over the `routing`
     output of `onBuildComplete`. knext does not: it boots Next's own standalone `server.js`, so the
     fall-through has to come from Next's router, which needs the branch unset;
   - the official reference adapter does the same (`delete configRecord.adapterPath` before writing
     the runtime config);
   - below 16.4.0 the same blanking also removes the racy 500 that #98964 fixed. That is now the
     lesser reason, and the version only chooses which reason is logged.

   The module and its call sites (`compileArtifactForDeploy` in `cli/build-artifact.ts`,
   `scripts/e2e-deploy.sh`, the `./internal/standalone-adapter-path` export) stay.

2. **K4 shrinks** to the `>=16.4.0` peer floor plus deleting the 16.0.x ctx branch. K4 must not
   delete `standalone-adapter-path.ts`, and the `cache-components-allow-otel-spans` comparison (#2129)
   is run with the shim in place, so its absence is no longer a hypothesis for that change.

3. **Retirement probe.** The shim retires only when one of these holds, and the first to hold owns the
   deletion PR:
   - knext routes through `@next/routing` instead of Next's own router (a verified-adapter design
     question, tracked as tech debt in #2172, not Sprint 3 work); or
   - an upstream Next release whose adapter branch falls through to `NoFallbackError` on its own.

   The probe for the second is the in-repo served test
   `packages/kn-next/src/__tests__/standalone-adapter-path-404.test.ts` on the fixture
   `fixtures/dynamic-params-false-404`: `GET /overlap/unlisted` must answer 200 from the catch-all
   (`app/overlap/[...rest]`, body containing `id="catch-all">unlisted<`) rather than 404 from the
   closed `app/overlap/[slug]`. Today that test applies the blanking first. The probe is the same
   assertion with the blanking step skipped (an unblanked variant, added with the deletion PR or
   when #2172 is decided), run against the stable Next release in question. Mirrors upstream's
   `dynamic-params-request-modes` case. When the unblanked variant passes on a stable Next release,
   the shim is deletable. Raising the Next floor never retires it.

4. **K4's gate is the D4 smoke runs, not a credential bump.** K4 raises the floor only when R1–R4
   (D4, Part 1: the four stable cells at `v16.4.0`) are green, meaning every red file triaged and
   zero open knext gaps. Otherwise K4 does not raise the floor to `>=16.4.0` (today's peer floor is
   `>=16.0.0`; plan rev4's fallback was `>=16.3.8`). The 1.x credential stays on Next
   16.3.8, and **no v2 credential lane exists until 2.0 GA** (D4, Part 2). Wording elsewhere that
   gates K4 on "the 16.4 credential bump" (issue bodies and sprint outputs) is wrong: gating a
   floor on a credential that cannot exist before the floor would be circular. This ADR's own text
   already said smoke (D4); the correction is to #2066, #2089 and #2149. R2–R4 also supply the
   four-cell evidence the ADR-0007 section (h) quarantine needs.

5. **#2089 is rescoped.** It no longer retires the shim. It keeps only replacing the private
   `shared-cache-controls` seed (#1888 workaround) with the build-scoped `cacheControl` returned from
   `cacheHandler.get()`. Its exit criterion drops "no callers of `standalone-adapter-path.ts` remain".

6. **Supervisor preload inventory.** D3 says the primer list is the only supervisor edit and that
   `PRELOAD_NAMES` is arp-primer first. #2142 added `public-origin.cjs` as a preload outside this
   ADR's sequence (`standalone-compile.mjs` `PRELOAD_NAMES`: `arp-primer.cjs`,
   `cache-control-normalize.cjs`, `bun-keepalive-guard.cjs`, `public-origin.cjs`,
   `request-body-cap.cjs`, plus the self-contained supervisor behind its flag; `node-server.ts` loads
   `public-origin.cjs` by path). The preload inventory is therefore these five preloads, not the ARP
   primer alone; D3 itself carries no inventory, and Z9's first commit records it (below). `public-origin.cjs` is a request-time shim, not a process-start
   primer, so it stays outside `PROCESS_START_PRIMERS`; Z9 must keep the primers first and must not
   reorder the others. The "runtime twice" rule is held narrowly here, and Z9's first commit
   inventories the preloads before touching either entry point.

### Consequences

- K4 is smaller and no longer blocked on the shim; Z9 and #2083 are unaffected.
- The shim is permanent for now. That is a cost, accepted: deleting it ships the `dynamicParams =
  false` fall-through bug on every app with a catch-all behind a closed segment.
- Dependency edges: K4 (#2066) keeps D1 S4's dependencies unchanged (this ADR Accepted, K1 #2065,
  S2, S3, R3a). S2 and S3 are the R1–R4 smoke runs; per item 4 they count as green only with every
  red triaged and zero open knext gaps, which includes the smoke-triage gaps such as #2126. #2089
  needs #2083 and K4, but no longer waits on the shim.
