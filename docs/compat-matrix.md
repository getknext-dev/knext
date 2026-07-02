# knext — Next.js compatibility matrix

> **Honest, evidence-gated status of what the knext adapter supports.** Every row is grounded in
> real, on-disk evidence and a mechanical guard test (`tests/compat-matrix.test.ts`) fails CI if a
> ✅ ("supported") row cannot be backed up. When in doubt we mark ⚠️, not ✅.
>
> **knext passes the official Next.js deploy-test suite on `main`** (the `vercel/next.js`
> deploy-test harness, ADR-0007 option B): run 28602886003 (2026-07-02) — **788 passed / 0 failed**
> across 16 shards against `vercel/next.js` **v16.2.0**, Node runtime. The exact scope of that claim
> (architectural exclusions, the per-case flaky-quarantine ledger, Node-only) lives in the
> official-suite row below — read it before repeating the claim. The guard test now **requires**
> that row to cite its run ID + pinned ref + "N passed / 0 failed" result; an evidence-less ✅
> fails CI. See **Maintenance & honesty** below.

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
gate, not the official suite — the official suite has its own row, own workflow
([`test-e2e-deploy.yml`](../.github/workflows/test-e2e-deploy.yml)), and a stricter evidence rule
(run ID + pinned ref + result, enforced by the guard test).

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
| Official Next.js compatibility suite (deploy-test harness) | ✅ | .github/workflows/test-e2e-deploy.yml, test/deploy-tests-manifest.knext.json, docs/adr/0007-compat-suite.md | **GREEN on main — run 28602886003** (2026-07-02, `workflow_dispatch` on `main` @ `f247151`): **788 passed / 0 failed** across **16 shards**, `vercel/next.js` **v16.2.0**, `NEXT_TEST_MODE=deploy`, Node runtime, driven by knext's `scripts/e2e-*.sh` lifecycle scripts + the `@knext/core` adapter tarball (totals summed from the run's 16 `compat-suite-summary-*.json` artifacts; 0 failed on every shard). **What the claim covers:** Next's own deploy-eligible e2e set — the `test/deploy-tests-manifest.json` base selection mirrored at the pinned ref, including upstream's own per-case known-failing skips — minus (1) knext's **4 documented architectural exclusions** (`$knextExclusions` in [the manifest](../test/deploy-tests-manifest.knext.json): edge-runtime module errors, edge middleware, PPR, Cache Components — the ⛔ rows above) and (2) the **per-case, evidence-quarantined flaky ledger** (`$knextQuarantines`, 9 entries — each carries the observed run IDs, failure mechanism, and upstream provenance; guarded by `tests/deploy-manifest.test.ts`). **What it does NOT cover:** the **Bun runtime axis** (the harness runs `KNEXT_RUNTIME=node` only today) and **long-run nightly stability** — the nightly record starts now (cron in the workflow); a sustained red nightly must flip this row back or annotate it. Graduation history (the multi-round path to green) is recorded in the ADR-0007 addenda. |

## Maintenance & honesty

- **Every ✅ is mechanically gated.** `tests/compat-matrix.test.ts` parses this table and fails if a
  ✅ row's Evidence does not resolve to a real on-disk file, a **hard** `compat-smoke` check id, or
  the `compat-smoke` CI job. For the **official-suite row** it additionally requires the ✅ to cite
  a workflow **run ID**, the **pinned `vercel/next.js` ref**, and an explicit **"N passed / 0
  failed"** result — an evidence-less flip fails CI. It also forbids citing the **skip-on-fail**
  `next/image` check (g) as proof of a ✅.
- **The `compat-smoke` caveats are load-bearing.** It runs with `REDIS_URL=""` (in-memory cache, not
  Redis) and treats `next/image` (check g) as **skip-on-fail**. That is exactly why ISR and image
  optimization are ⚠️, not ✅, even though both are implemented.
- **Promotion path to ✅ for the partials / gaps.** A ⚠️/❌ row may move to ✅ only when a **red-on-fail**
  check covers it — e.g. an ISR-revalidate assertion (with a real `REDIS_URL`), a hard (non-skip)
  `next/image` assertion, or a streaming-flush assertion. Note that a green official-suite run does
  **not** automatically promote a smoke-gated ⚠️ row: each row keeps its own named evidence.
- **The official-suite claim is scoped by its row.** The ✅ above means exactly what its Notes cell
  says — the deploy-eligible set minus the documented exclusions and the quarantine ledger, Node
  runtime, one observed green run on `main` (#89 wired the harness; #147 graduated it, ADR-0007).
  The claim stays honest only while the nightly stays green: a sustained red nightly must flip the
  row back (the guard permits an honest ❌ regression without ceremony) or annotate it. The
  quarantine + exclusion ledgers in `test/deploy-tests-manifest.knext.json` are the public
  scoreboard — shrinking them to zero is the standing goal (ADR-0007 A3-3).
