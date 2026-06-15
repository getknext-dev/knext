# knext Roadmap (canonical)

> Strategy & hard rules: `CLAUDE.md`. Decisions: `docs/adr/`. Detailed exit criteria:
> `docs/MATURITY_PLAN.md` (its Phases map to the Tiers below). North star: a **verified** Next.js
> Deployment Adapter for Knative — open source, passes the official compat suite, listed in the
> Next.js docs. Sequencing is strict: **correctness before breadth.**

## Phase 0 — Official-adapter migration  ✅ largely done
Real `NextAdapter` (official API 16.2+), `output:'standalone'`, official cache interfaces,
`NODE_COMPILE_CACHE` cold-start caching. **Merged to `main` (PR #29).** Remaining: retire the
deprecated Vinext/Nitro runtime (`node-server.ts`); wire `@next/routing` where needed.
*Exit:* no Vinext code paths; adapter is the only runtime.

## Tier A — Correctness (the north star)
The credibility gate. Nothing in later tiers ships before this is green.
- **Official Next.js compatibility suite in CI**, on every PR (the verified-adapter lever).
- **Image optimization** (biggest functional gap; currently missing).
- **Graceful shutdown** — drain in-flight requests + run `after()` callbacks on SIGTERM.
- **Control-plane consolidation (ADR-0001)** — CLI emits a `NextApp` CR only; operator is the
  sole cluster writer; remove `deploy.ts` raw-manifest path + `containerConcurrency` drift;
  `:latest` rejection / digest pinning everywhere (incl. the revalidator sidecar).
*Exit:* compat suite green; image optimization shipped; operator = sole writer; e2e deploy via CR.

## Tier B — Platform
- **Security/supply-chain:** SBOM per image, Trivy/Grype (fail on high), cosign signing,
  reproducible builds, threat model. (The open security milestone.)
- **Endpoint auth** — fix `POST /api/cache/invalidate`; no unauthenticated mutating endpoints.
- **Previews** (per-PR ephemeral envs), **rollback** (Knative revision traffic split),
  **skew protection** (BUILD_ID-versioned assets), **RUM**.
*Exit:* signed/scanned images; all mutating endpoints authenticated; preview+rollback demoed.

## Tier C — Edge (partly upstream-gated)
CDN, multi-region, WAF. **Edge Middleware/Proxy and PPR/Cache Components are not yet
adapter-standardizable** — track upstream, do not force. Lower priority for the fame phase.

## Track P — Promotion (parallel, fame-first)
GitHub org, landing page, **docs site (dogfooded on knext)**, examples, npm publishing
(`@knext/*` — unblocks `npx kn-next` for outside users), Next.js-docs adapter listing.

## Optional module — gRPC business-logic layer
**Design now, build later (after Tier A).** Polyglot backends as cluster-local scale-to-zero
Knative services behind the Next.js gateway. See `docs/adr/0002-0004` + `docs/design/grpc-layer.md`.

## Vercel-parity buckets (what to chase vs defer)
1. **Architectural edge** (global CDN, edge middleware/PPR) — defer / upstream-gated.
2. **Buildable-but-unbuilt** — image optimization, endpoint auth, previews, rollback, skew, RUM
   → **do these (cheap wins)** in Tiers A/B.
3. **Deliberate differences** — Prometheus/Grafana (not Web Analytics), multi-cloud/no lock-in.

## Phase ↔ Tier mapping (vs docs/MATURITY_PLAN.md)
| ROADMAP | MATURITY_PLAN phase |
|---|---|
| Phase 0 migration | Phase 0 + Phase 1 (correctness start) |
| Tier A | Phase 1 (correctness) + Phase 2 (control-plane) + image opt from Phase 4 |
| Tier B | Phase 3 (security) + previews/rollback |
| Tier C | (new — edge, upstream-gated) |
| Track P | Phase 5 (release) + docs |
| gRPC module | Phase 6 |
