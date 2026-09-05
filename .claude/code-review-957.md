# Code review — PR #957 (vinext ISR-to-Redis wiring, #953) — ISSUES_FOUND

Branch `agent/s3-isr-wiring` → base `agent/s2-tail`. Read-only adversarial review.

## Blocking

### B1. The fix is unobserved on the shipping build target; ADR-0050's compiled-binary coverage claim is false
`docs/adr/0050-vinext-isr-redis-wiring.md` (Consequences): "The compiled-binary half runs in
CI's `compat-smoke` (check k: cache-state headers + real-Redis `DBSIZE > 0` against the single
executable)."

Measured, not argued — check (k)'s own report line is **byte-identical** before and after the fix:

| | job | check (k) result |
|---|---|---|
| base `agent/s2-tail` | 101198547752 | `cached HIT/HIT mtnjw24e… → revalidated …; redis keys=19` |
| PR `agent/s3-isr-wiring` | 101285288171 | `cached HIT/HIT mto6pct5… → revalidated …; redis keys=19` |

Registering a Redis-backed data cache for `/knext-smoke/isr` would have added at least the entry
key (plus the handler's tag/event keys). The count did not move. So check (k) cannot distinguish
the wired from the unwired state — it was green for the entire duration of row E — and citing it
as this change's compiled-binary coverage is decoration by this repo's own standard
(`.claude/rules/workflow.md`, "a guard that stays green when its subject is removed").

Root cause of the insensitivity is B2. Either the new `cache.data` registration is inert in the
binary, or it is redundant with an existing path; the PR ships no evidence distinguishing the two.

### B2. ADR-0050's Context is wrong for `apps/file-manager`, and the PR now double-registers
ADR Context: "Nothing registered a data cache handler". Not true for the app the compat gate
actually runs — `apps/file-manager/src/cache-init.ts:13-17` calls `next/cache`'s
`setCacheHandler(new CacheHandler())`, and under vinext that resolves to vinext's own shim, which
exports it (`vinext/dist/shims/cache-handler.d.ts`). The PR's CI log proves it is live:

```
[server] [Cache Init] Registered Custom CacheHandler via setCacheHandler
[server] [Cache] SET app:…:/cache-tests/dynamic-static/static:html (redis)
```

Consequences:
- file-manager now holds **two** registrations of the same class in vinext's two distinct slots
  (`cacheHandler` via cache-init.ts, `dataCacheHandler` via the new plugin option) → two
  `CacheHandler` instances per isolate, two Redis clients, two circuit breakers, two memory
  fallbacks. Nothing reconciles them and no test says which one page ISR reads.
- ADR Option B dismisses "imperative `setDataCacheHandler(...)`" as deprecated upstream while the
  repo's own imperative `setCacheHandler(...)` call is left in place and unmentioned.

Fix: state what `cache-init.ts` does, decide whether it stays, and make check (k) (or a new check)
assert the ISR **key by name** in Redis rather than `DBSIZE > 0`.

### B3. `examples/bun-exec/runtime-contract.mjs:14-16` now carries a false claim
It asserts item 4 is "WIRED: the vinext() plugin's `cache.data` adapter in vite.config.ts
registers @getknext/core/internal/vinext-cache-adapter" — in the one app the test explicitly
EXEMPTS from that wiring (`vinext-isr-redis-wiring.test.ts:77-81`: pinned to beta.4, and
`@getknext/core` is not a dependency of `examples/bun-exec/package.json`). The blanket sed across
all five `runtime-contract` copies overshot.

### B4. The exemption is not self-expiring (guard asserts one half)
`packages/kn-next/src/__tests__/vinext-isr-redis-wiring.test.ts:160-167` checks only that the
exempt path still exists. The written reason is version-conditional; bumping
`examples/bun-exec/package.json:17` from `1.0.0-beta.4` to beta.8 leaves the exemption silently in
force. Assert the premise (pin still beta.4 and/or `@getknext/core` absent from its deps).

### B5. CI red — "Escalation triggers acknowledged" fails
`scripts/check-escalation-triggers.mjs`: "the published package surface — changes exports/bin/…
in packages/kn-next/package.json … NOT acknowledged". Per `.claude/rules/workflow.md` this is a
trigger-class touch that must be acknowledged / gated before merge.

## Answered, no defect

- **Adapter contract (Q1).** Correct against beta.8: `generateCacheAdaptersModule`
  (`vinext/dist/cache/cache-adapters-virtual.js`) emits
  `setDataCacheHandler(factory({ env, options }))`; the factory shape matches. Minor: knext's
  `get(key)` (`cache-handler.js:843`) and `revalidateTag(tags)` (`:988`) drop the `ctx` /
  `durations` args the contract allows, and `resetRequestCache?` is unimplemented (optional today,
  silent if vinext starts passing `durations.expire`).
- **Redis DOWN at request time (Q1b).** Fails open correctly. Breaker short-circuits in
  `ensureConnected` (`:647-650`); `get` catches → MISS (`:877`); `#set` catches (`:978`); the
  constructor never throws (`ensureConnected().catch(() => {})`, `:840`). Requests are served, the
  health-200-with-Redis-at-0 story survives, and a dead Redis does not trip vinext's fallback.
- **Silent fallback (Q2).** vinext does `console.warn("[vinext] failed to initialize the
  configured data cache adapter; using the default handler…")` — logged, not silent. But **our**
  wiring adds no detection: nothing asserts at runtime that `getDataCacheHandler()` is knext's
  handler. A startup assertion or a metric would close it; B1/B2 are the reason it matters.
- **Scanning guard (Q3).** Sound and non-vacuous: repo walk on `vinext(`, five known homes pinned
  as a floor, both halves checked, offenders aggregated. A new app tree without `cache.data` reds.
  Nit: the two halves are independent, so the specifier could satisfy `includes()` from a comment
  while `adapter:` points elsewhere.
- **Fake RESP2 (Q4).** Faithful for what is asserted: the `EX` is read from the socket argv, which
  is the right level. The fake does not implement expiry and the test does not rely on it
  (staleness comes from `cacheState` labelling). `bun:test` → runs on the CI bun lane
  (`scripts/bun-test.mjs`), reproducible, not dev-only.
- **Public surface + supply chain (Q5).** `./internal/*` is a pre-existing prefix with 12+ entries,
  not new public surface. `vinext` is exact-pinned `1.0.0-beta.8` as a devDependency, `bun.lock`
  updated, not shipped. (The escalation gate B5 still applies.)
- **TTL (Q7).** The 1-year premise is wrong: `isrCacheControl(1)` returns `{ revalidate: 1 }` with
  no `expire` (`vinext/dist/server/isr-cache.js:96`), so `__redisTtlSeconds`
  (`cache-handler.js:789-798`) yields `Math.max(2, 3600)` = **3600** — the same function both
  entrances use, so no divergence. The test asserts only `> 1`; asserting `=== 3600` would pin the
  contract.
- **ADR options table (Q8).** Honest and specific; rows C and D are well-reasoned. Context and
  Consequences are the problem (B1, B2).
