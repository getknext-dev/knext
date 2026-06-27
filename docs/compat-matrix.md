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
| Official Next.js compatibility suite | ❌ | docs/adr/0007-compat-suite.md | **Scaffolded, nightly running, NOT yet green** (#89): the `vercel/next.js` deploy-test harness (ADR-0007 option B / A3-2) is now wired as an MVP — `.github/workflows/test-e2e-deploy.yml` (nightly + dispatch, pinned Next ref, modest 4-way shard, Node-only) drives knext's `scripts/e2e-*.sh` + `test/deploy-tests-manifest.knext.json`; per-shard pass/fail lands in the `compat-suite-summary-*.json` artifact. This runs a REAL **partial subset** — it does **not** pass the full suite. Status stays ❌ until a green nightly (graduation = a separate PR, A3-3). No row may claim official ✅ while #89 is open. **Build-perf caveat (#147):** the suite gets past install/setup but the cold `vercel/next.js` build kept hitting the `build-next` job timeout (round 1 raised it 60→120 min; the full-monorepo cold build then hit the 120-min ceiling exactly and was cancelled, so the deploy-tests shards never executed). Round 2 (#147 step 1) **reduces build scope** — the deploy tests only run `next build` against fixture apps, so we build just the `next` package + its workspace dependency closure (`turbo run build --filter=next...`) instead of the whole monorepo (docs/examples/eslint-plugin-next/create-next-app/…) — plus a 120→180-min timeout and pnpm-store/build-output caching keyed on `NEXTJS_REF`. A completing cold build is what finally populates the cache (`actions/cache` only saves on job success). Verification is a post-merge `gh workflow run test-e2e-deploy.yml`: success = `build-next` completes without timeout and the 4 deploy-tests shards execute. |

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
