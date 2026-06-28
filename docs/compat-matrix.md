# knext — Next.js compatibility matrix

> **Honest, evidence-gated status of what the knext adapter supports.** Every row is grounded in
> real, on-disk evidence and a mechanical guard test (`tests/compat-matrix.test.ts`) fails CI if a
> ✅ ("supported") row cannot be backed up. When in doubt we mark ⚠️, not ✅.
>
> **This is NOT a claim that knext passes the official Next.js compatibility suite.** That suite
> (the `vercel/next.js` deploy-test harness, ADR-0007 option B) is **not wired yet** — tracked in
> [issue #89](https://github.com/AhmedElBanna80/knext/issues/89). Until #89 is green nightly, no row
> here may say "official suite ✅". See **Maintenance & honesty** below.

## Legend

| Marker | Meaning |
|---|---|
| ✅ | **Supported** — backed by a red-on-fail check (the per-PR `compat-smoke` gate) or test-covered source on disk. |
| ⚠️ | **Partial** — implemented but **not** guarded by a hard correctness check, or with a known caveat (see Notes). Do not rely on it as "verified." |
| ❌ | **Unsupported / unverified** — no working implementation or no evidence; treat as a gap. |
| ⛔ | **Upstream-gated** — architecturally out of reach today (global edge, not yet adapter-standardizable upstream). |

The **Evidence** column cites either a real file path in this repo, or a `compat-smoke` check id
(`a`–`g`) from [`apps/file-manager/scripts/compat-smoke.mjs`](../apps/file-manager/scripts/compat-smoke.mjs),
or the `compat-smoke` CI job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). The
`compat-smoke` job runs per-PR on a **Node + Bun** matrix (ADR-0007 / A3-1). It is a knext **smoke**
gate, not the official suite.

## Matrix

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| App Router (RSC server render, `GET /` → 200 HTML) | ✅ | smoke a | Hard-asserts 200 + `text/html` + non-trivial body against the standalone `server.js`. |
| RSC flight payload (`RSC: 1` → `text/x-component`) | ✅ | smoke b | Hard-asserts the React flight content-type. |
| Route handlers (App Router `app/api/*/route.ts`) | ✅ | smoke c, apps/file-manager/src/app/api/health/route.ts | Hard-asserts `GET /api/health` → 200 + valid JSON. |
| Dynamic routes (`force-dynamic`, per-request render) | ✅ | smoke d | Hard-asserts 200 on a `force-dynamic` route. |
| Static / prerendered routes (`force-static`) | ✅ | smoke e | Hard-asserts 200 on a `force-static` route. |
| Middleware (Node runtime, response header injection) | ✅ | smoke f, apps/file-manager/src/middleware.ts | Hard-asserts the middleware-injected `x-knext-smoke: 1` header. Node-runtime middleware only (see edge-middleware row). |
| Graceful shutdown (SIGTERM drain) | ✅ | packages/kn-next/src/adapters/shutdown.ts, packages/kn-next/src/__tests__/shutdown.test.ts | Unit-tested drain-on-SIGTERM in the standalone runtime. Not yet exercised end-to-end by `compat-smoke` (no SIGTERM-drain HTTP check in the as-built script). |
| ISR / Data Cache (Redis-backed cache handler) | ⚠️ | apps/file-manager/cache-handler.js, apps/file-manager/next.config.ts | Redis cache handler (`cacheHandler` in `next.config.ts`), **not** GCS. `compat-smoke` runs with `REDIS_URL=""` (in-memory fallback) and has **no revalidate/ISR-freshness assertion**, so ISR correctness is unverified by the gate. |
| `next/image` optimization (sharp, avif/webp) | ⚠️ | docs/adr/0006-image-optimization.md, apps/file-manager/next.config.ts, packages/kn-next/src/adapters/image-cache-sync.ts | Implementation landed (ADR-0006, sharp #43, scale-to-zero image cache sync #66). But `compat-smoke` check **(g) is skip-on-fail**, not a hard gate — a missing/failed optimizer downgrades to SKIP, so the matrix does not mark this ✅. |
| Server Actions (`'use server'` mutations) | ⚠️ | apps/file-manager/src/app/actions.ts | Server Actions exist in the app, but there is **no** `compat-smoke` or unit assertion exercising a Server Action round-trip. Configured, not verified. |
| Streaming / Suspense (incremental flush) | ❌ | — | No streaming/Suspense flush assertion in `compat-smoke` and no other evidence. Listed as a planned check in ADR-0007 but not built. |
| Edge Middleware (edge runtime) | ⛔ | docs/adr/0007-compat-suite.md | Upstream-gated: edge-runtime middleware is not yet adapter-standardizable on Knative; knext middleware runs on the Node runtime only. |
| PPR / Cache Components | ⛔ | docs/adr/0007-compat-suite.md | Upstream-gated: Partial Prerendering / Cache Components are not yet adapter-standardizable (CLAUDE.md §6, Tier C). |
| Official Next.js compatibility suite | ❌ | docs/adr/0007-compat-suite.md | **Scaffolded, nightly running, NOT yet green** (#89): the `vercel/next.js` deploy-test harness (ADR-0007 option B / A3-2) is now wired as an MVP — `.github/workflows/test-e2e-deploy.yml` (nightly + dispatch, pinned Next ref, modest 4-way shard, Node-only) drives knext's `scripts/e2e-*.sh` + `test/deploy-tests-manifest.knext.json`; per-shard pass/fail lands in the `compat-suite-summary-*.json` artifact. This runs a REAL **partial subset** — it does **not** pass the full suite. Status stays ❌ until a green nightly (graduation = a separate PR, A3-3). No row may claim official ✅ while #89 is open. **Build-perf caveat (#147):** the suite gets past install/setup but compiling `vercel/next.js` from source proved **non-convergent** on the standard runner. Rounds 1–3 raised the `build-next` timeout (60→120→180 min), scoped the build to just `next` + its workspace deps, and added a GHA-backed turbo remote cache to persist a cancelled build incrementally — even so, the source build exceeded the 180-min ceiling across two cache-warming dispatches, so the 4 deploy-tests shards never executed. **Round 4 (#147 step 1) drops the source build entirely:** the published `next@16.0.3` npm tarball *is* the built `packages/next` at the same version, so `build-next` now `npm pack`s the **prebuilt** `next` (minutes) and hands it to the reference harness via `NEXT_TEST_PKG_PATHS` (which makes `create-next-install` skip its source-pack `linkPackages` step and install the tarball into each fixture app; `@next/swc` arrives prebuilt from the tarball's optionalDependencies). The next.js source checkout is still used for its `test/` harness + `run-tests.js`. **Round 5 (#147 — the cold-install decider):** dropping the source build also removed the pnpm-store cache, so the harness `corepack pnpm install` ran COLD against next.js's full monorepo for the first time and timed out at the 180-min ceiling — the shards still never ran. Fix: (a) re-add the pnpm-store `actions/cache` keyed on the pinned ref + the next.js lockfile, and (b) SLIM the install — the deploy harness only imports next.js's *root* devDependencies (`run-tests.js`, `create-next-install`, and the `test/lib` helpers), none of the monorepo workspace packages, so the install is now `corepack pnpm install --frozen-lockfile --prefer-offline --filter "{.}"` (root project only) with `NEXT_SKIP_NATIVE_POSTINSTALL=1` (the SWC native postinstall is wasted work in prebuilt mode). Playwright/chromium was still installed at this stage (later found to be the bug). **Round 6 (#147 — network resilience):** even the slimmed+cached root-only install STILL ran the full 180-min job timeout and was CANCELLED across 3 dispatches — identical 180:00 — initially (mis)read as pnpm *hanging* on stuck network requests; the retry-loop + pnpm network hardening were added as a hedge (they stay as harmless defense-in-depth). **Round 7 (#147 — THE root cause, definitive):** the run 28310661064 install-step log identifies the actual culprit — `corepack pnpm install` **RESOLVES all 3345 packages in ~3 SECONDS** (`resolved 3345, reused 3337, downloaded 0, added 0, done`), so pnpm resolution was *never* the bottleneck. Each of the 4 retry attempts then hung for 40 minutes in the **`playwright-chromium` postinstall — downloading the Chromium browser binary from Playwright's CDN** — which timed out (the same network throttling that failed Docker Hub pulls all session), got killed by the per-attempt `timeout`, and failed all 4 attempts (`playwright-chromium install: Failed` / `ELIFECYCLE`). **Every earlier "infra-bound / 180-min" framing was actually this browser download hanging — not runner size, not a slow pnpm resolve.** Fix: set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` (+ `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1`) on the Prepare install so the `playwright-chromium` postinstall skips the browser fetch — the install then finishes in **seconds** (resolution only). The redundant blocking `playwright install chromium` is removed from Prepare; chromium is instead installed **in the shard job that drives `next-webdriver`**, `actions/cache`-d (keyed on the playwright version, so the CDN download isn't repeated each run) and wrapped in a retry + per-attempt `timeout` (so a future CDN stall is bounded + retried, never an open-ended hang). The Prepare `timeout-minutes` drops 180→60. **Design note:** this tests the adapter against the *published* `next` rather than the source-built one — a deliberate deviation from the reference harness (arguably more correct for an adapter compat test, since it's the artifact users install); see ADR-0007. Status **stays ❌** — only an observed green nightly flips the row. Verification is post-merge `gh workflow run test-e2e-deploy.yml`: success = the Prepare job completes in minutes and the 4 deploy-tests shards EXECUTE (status running/completed, not skipped). |

## Maintenance & honesty

- **Every ✅ is mechanically gated.** `tests/compat-matrix.test.ts` parses this table and fails if a
  ✅ row's Evidence does not resolve to a real on-disk file, a **hard** `compat-smoke` check id, or
  the `compat-smoke` CI job. It also forbids: marking the **official suite** ✅ while #89 is open,
  and citing the **skip-on-fail** `next/image` check (g) as proof of a ✅.
- **The `compat-smoke` caveats are load-bearing.** It runs with `REDIS_URL=""` (in-memory cache, not
  Redis) and treats `next/image` (check g) as **skip-on-fail**. That is exactly why ISR and image
  optimization are ⚠️, not ✅, even though both are implemented.
- **Promotion path to ✅ for the partials / gaps.** A ⚠️/❌ row may move to ✅ only when a **red-on-fail**
  check covers it — e.g. an ISR-revalidate assertion (with a real `REDIS_URL`), a hard (non-skip)
  `next/image` assertion, a streaming-flush assertion, or the official suite landing via #89.
- **The official-suite claim is owned by #89.** Only after the full `vercel/next.js` deploy-test
  harness is green nightly (ADR-0007, A3-2/A3-3) may any doc say knext "passes the official Next.js
  adapter compatibility suite." This matrix is a smoke-gated honesty ledger in the meantime.
