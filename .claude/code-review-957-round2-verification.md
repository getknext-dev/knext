# PR #957 round-2 verification — VERDICT: APPROVE

Branch `agent/s3-isr-wiring` @ `df4dd318` (delta vs `00afb09f`). Runs executed in the existing
implementer worktree (`.claude/worktrees/agent-ab7e2245dd4826e2b`, clean before and after; every
mutation anchor-checked, restored, and sha-verified — `git status --porcelain` empty at exit).

## Baseline

`bun test packages/kn-next/src/__tests__/vinext-isr-redis-wiring.test.ts` → **9 pass / 0 fail**.
Guard set (`tests/runtime-entry-copy-parity`, `tests/compat-smoke-capability-checks`,
`tests/compat-matrix`, `apps/file-manager/.../redis-client.test.ts`) → **67 pass / 0 fail**.

## The 8 claims, measured

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | check (k) asserts ISR key BY NAME + per-key TTL + warn-absence | HOLDS | `compat-smoke.mjs:815-860`. `KEYS *:cache:*knext-smoke/isr*` — the discriminating segment is the **route pathname**, not a prefix. Key shape confirmed from code, not comment: `cache-handler.js:693` → `${KEY_PREFIX}:cache:${key}`, and vinext `dist/.../isr-cache.js` `isrCacheKey(router, pathname, buildId)` → `app:${buildId}:${pathname}`. Memory fallback writes **nothing** to Redis → 0 matches → red. `kn-next:cache-events` does **not** match (`:cache-` ≠ `:cache:`). Warn string is **real**, not decorative: `[vinext] failed to initialize the configured data cache adapter` is present verbatim in vinext@1.0.0-beta.8's dist (generated virtual-module template). No `skip()` anywhere in the runner. |
| 2 | `cache-init.ts` deleted; comment-blanked scan reds any imperative registration | HOLDS, mutation-proved | No live importer at `df4dd318` (`layout.tsx` + `events/route.ts` imports removed; remaining hits are comments/ADR prose). Planted `setDataCacheHandler(...)` in `apps/file-manager/src/` → **RED**; planted alias `setCacheHandler(...)` in a `.mjs` under `packages/` → **RED**; comment-only mention control → **GREEN**. |
| 3 | bun-exec runtime-contract says NOT-wired; parity guard accepts | HOLDS | `runtime-contract.mjs:14-23` states the honest NOT-wired status with the beta.4 cause. Recorded `DIVERGENT` sha256 `ef12adc5…f5d32f` equals the file's actual sha. Parity guard green. |
| 4 | beta.4 pin self-expires | HOLDS, mutation-proved | Bumped `examples/bun-exec/package.json` vinext → `1.0.0-beta.9` → the SELF-EXPIRES test **RED**; restored, sha identical. |
| 5 | `isr-caching.mdx` + matrix rows | HOLDS | New page registered in `meta.json:15`; **zero** ADR/issue/PR refs (grep for `ADR-\d`, `#\d{2,}`, `adr/`); `## Upgrading an app scaffolded before the cache wiring` present with a concrete verify recipe. `apps/docs/.../compat-matrix.mdx:41` stale `REDIS_URL=""` ⚠️ row replaced with ✅ + the real assertions. `docs/compat-matrix.md:43` re-attributes to the vinext plugin and marks the old DBSIZE evidence decorative. |
| 6 | PUBLIC_API sub-note + 15/15; ADR-0050 consequence + action item | HOLDS | Internal-subpath table = exactly **15** rows; `### Generated-file-referenced internal subpaths` at :384 names `vinext-cache-adapter`, `vinext-image-optimizer`, `node-server`. ADR-0050: Consequences :92 (public-surface), Action items :131 incl. `knextVinext()` consolidation :148. |
| 7 | TTL === 3600 pin | HOLDS, mutation-proved | `cache-handler.js:789-799`. Reverted `Math.max(revalidate * 2, DEFAULT_TTL_SECONDS)` → `revalidate` → layer-3 **RED**; restored, sha identical. |
| 8 | PR body: `Refs #953`, honest scope | HOLDS | Opens "Refs #953 — … Deliberately NOT 'Closes': the cluster half … stays with the S3-V verification runner". |

## Regression skim of `df4dd318`

Deletions are `cache-init.ts` and its two imports. `route.ts:66` reads
`globalThis.cacheEvents … || []` — defensively defaulted, so dropping the eager import cannot
throw; the handler module (`cache-handler.js:30`) still seeds it, loaded by the registration
module before any route runs. `redis-client.test.ts` mock removal matches. `serverLog`
accumulation in the runner is unbounded but scoped to one smoke run.

## Full-suite note (not a PR defect)

`node scripts/bun-test.mjs` → `[245/353] vinext-isr-redis-wiring.test.ts ok`; 5 unique failures,
**all environment-induced by running inside a worktree nested under the outer repo**:
`build-context-root.test.ts:653` resolves up to `/Users/banna/alpheya/pocs/knext` instead of
throwing (4 cases), and one `#666` nightly test asserting "does not resolve the surrounding
repository". None touch #953. PR body's 353/353 is consistent with a non-nested checkout.

## Minor (non-blocking, no change requested)

- The imperative-registration scan's `SKIP_DIRS` omits `.vinext`; a local tree holding vinext
  build output could false-positive on the generated `setDataCacheHandler(` line. CI is clean, so
  this is a local-ergonomics wart, not a hole.
- `redisCommand`'s bulk-length arithmetic compares UTF-16 `buf.length` against byte lengths —
  correct for the ASCII keys in play, would need care if keys ever carry multi-byte characters.
