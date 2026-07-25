# ADR-0038: In-app observability pages — data sources & degradation contract

- **Status:** Accepted (2026-07-25; Phase 1.1 — the Web Vitals page — implemented in the same PR
  as an app-level recipe in `apps/file-manager`. P1.2–P1.4 and the Phase-2 scaffold promotion are
  deferred follow-ups, see Action items)
- **Depends on:** ADR-0027 (instrumentation seam — these pages are *consumers*, not collaborators),
  ADR-0001 (operator = single source of cluster state — the pages are read-only, never mutate),
  `.claude/rules/security.md`, `.claude/rules/scs-zones.md`
- **Plan:** `knext-plan-out/observability-pages-plan.md` (founder-approved, grader PASS)

## Context

Vercel gives every project an **Observability tab** — overview (requests/errors/latency), Speed
Insights (Web Vitals), and logs. knext apps already emit most of the underlying data: RED metrics on
`:9091` (`kn_next_http_*`), the `/api/rum` Web-Vitals series (`kn_next_web_vitals_*`), cold-start /
scaling series, and operator `NextApp` status conditions. What is missing is an **in-app surface**
that presents that data with the app's own auth and chrome — a Vercel-*feeling* observability tab.

Per `CLAUDE.md` §8, Prometheus/Grafana is knext's **deliberate model difference** from Vercel Web
Analytics — knext matches Vercel's compute-layer observability *feel*, not its global-edge analytics,
and this is **not a knext-hosted, multi-tenant dashboard**. The turnkey Grafana dashboards already
ship (`packages/kn-next-operator/config/grafana/`). So the question is not "build a dashboard" but
"where does each in-app page get its data, and how does it degrade when a backend is absent?" — and,
because this is an app-level recipe under scs-zones sequencing, it must live in the demo/app template,
**not** core packages.

## Decision

Adopt a **hybrid** architecture for an auth-gated `/observability/*` route group inside the app:

1. **App-owned data, read in-process (no external backend).** The **Web Vitals** page reads the
   app's OWN prom-client registry (`apps/file-manager/src/app/api/_metrics/registry.ts`, the
   `kn_next_web_vitals_*` histograms ingested by `POST /api/rum`) directly, server-side, and computes
   a current p75 per vital via a Prometheus-style linear-interpolation quantile over the histogram
   buckets. **Zero new dependency, zero coupling** — the app is already the source of truth for RUM.
2. **Server-side Prometheus queries with graceful degradation** (deferred, P1.2–P1.3) for RED /
   cold-start / scaling aggregates that need range/rate math. Prometheus base URL arrives via an
   operator-provisioned `OBSERVABILITY_PROMETHEUS_URL` (K8s Secret/env). Unset or unreachable ⇒ a
   typed empty state; the page 200s, never crashes, never leaks. **Degrade closed, not open.**
3. **Link-out to the shipped Grafana dashboards** for deep cluster analysis — reuse, don't rebuild.

**Auth mechanism (this PR):** header **Bearer token**, timing-safe, **fail-closed** — reusing the
established pattern of `api/cache/invalidate/auth.ts` (`node:crypto.timingSafeEqual`, length-checked).
The token is `OBSERVABILITY_TOKEN` (K8s Secret → env); **unset ⇒ deny-all**. The page reads the
`Authorization` header via `next/headers` in the Server Component and renders an "Unauthorized" view
(no metric data) when the check fails. Header-token gating (not a session/cookie) was chosen because
the app has **no existing session/cookie concept** — its only auth surface is the same Bearer pattern.
The plan's open question (session vs Bearer) is resolved as Bearer for now; a real session gate in
`middleware.ts` can be layered later without changing the fail-closed invariant. Every page is
`export const dynamic = 'force-dynamic'` — never cached, so the auth check runs on every request and
metrics are never stale.

All data access is **server-only**: the browser receives rendered aggregates, never the Prometheus
URL, a kubeconfig, a token, or raw metrics. These pages add **no mutating route** and put **no cluster
credential in the browser**.

## Options considered

| Criterion | A: Prometheus-API pages | B: Embedded Grafana | **C: Hybrid (chosen)** |
|-----------|-------------------------|---------------------|------------------------|
| Vercel-like feel | High | Low | **High** |
| New code / cost | High (all charts + PromQL) | Very low | **Medium (staged)** |
| Data-source coupling | Hard Prometheus dep on *every* page | Grafana + Prom | **Web Vitals need neither; RED degrades gracefully** |
| Works when Prometheus absent | All pages empty | All pages dead | **Web Vitals page still works** |
| Auth model | App's own (uniform) | Grafana's (separate) | **App's own** |
| scs-zones fit (app-level recipe) | Good | Weak (core/infra) | **Best — starts in demo app** |
| Scaffoldable later | Yes | Awkward | **Yes (in-app pages template)** |

**Chosen: C.** It ships the highest-value, lowest-coupling page (Web Vitals) with zero new infra
dependency, adds Prometheus-backed pages incrementally with graceful degradation, and reuses the
shipped Grafana overlay instead of rebuilding cluster dashboards — faithful to §8.

## Consequences

- **Positive:** the Web Vitals page ships with no new backend, no new dependency, and no coupling; it
  works even when Prometheus is absent. Auth reuses a proven fail-closed primitive. Coverage gate is
  unaffected (the gate's `include` is `packages/*/src`; this is app code).
- **Negative / accepted:** in-process p75 reflects only the current pod's counters (reset on restart /
  scale-to-zero) — this is an at-a-glance current view, not a historical time series; the Prometheus
  path (P1.2+) is the answer for range queries. Introducing `OBSERVABILITY_PROMETHEUS_URL` later adds
  one app↔Prometheus coupling, mitigated by mandatory graceful degradation.
- **Security:** fail-closed on unset token; no mutating route; server-only data access; force-dynamic
  (never cached) — consistent with the auth/mutation no-cache rule and `guard-sw-cache-policy.sh` spirit.

## Action items

- [x] **P1.1 Web Vitals page** — `apps/file-manager/src/app/observability/web-vitals/page.tsx` +
  `vitals.ts` (registry read + quantile) + `observability/auth.ts` (fail-closed Bearer gate) + tests.
- [x] **P1.2 Overview (RED)** — `apps/file-manager/src/app/observability/page.tsx` +
  `_prom/query.ts` (server-only Prometheus `query_range`/`query`, uncached + short abort timeout,
  typed `ok | unconfigured | unreachable` results). Graceful empty state when
  `OBSERVABILITY_PROMETHEUS_URL` is unset (no fetch) and an error state when unreachable; PromQL is
  parity-tested against `adapters/metrics.ts` so it only references real `knext_*` series. Its
  queries are **app-scoped** on the same `KN_APP_NAME` contract as P1.3 (below), with the same
  "scope unknown" and partial-outage states.
- [x] **P1.3 Cold-start & Scaling** — `apps/file-manager/src/app/observability/scaling/page.tsx`
  (replicas / cold-start rate + p50/p99 / **warm-start ratio** / DB-wake by `role`), reusing
  `_prom/query.ts` and the shipped `scale-to-zero` Grafana dashboard's PromQL shapes. Same auth +
  degrade contract, plus three further **distinct** states, each covered by a test:
  - **kube-state-metrics absent** — the replica series is cluster-provided, so its absence renders
    "requires kube-state-metrics", never a dishonest "0 replicas";
  - **scope unknown** — every series is multi-tenant, so all queries (on **both** metric pages) are
    scoped to this app via the operator-injected `KN_APP_NAME` — the same source
    `adapters/metrics.ts` labels the series with — validated as an RFC1123 label, which also blocks
    PromQL injection. An unset/invalid value renders "scope unknown" and issues **no** query rather
    than silently falling back to a cluster-wide sum;
  - **partial Prometheus outage** — failed queries read `metric unavailable`, deliberately distinct
    from `no data yet` ("nothing recorded") and from a measured zero.

  The parity test compares page ↔ dashboard PromQL **including label selectors** (an earlier version
  stripped them, which made the gate blind to exactly this scoping bug), and every `knext_*` series
  is checked against `adapters/metrics.ts`. Also lands the P1.2 sign-off follow-up: the explicit
  `no data yet` marker (`_ui/format.ts`) is now used by **all three** pages, Web Vitals included.

  Replica rows are aggregated across the per-revision series (`totalLatestMatrixValue`) so
  "Replicas (latest)" and "Replicas (now)" can never contradict each other, with a per-Deployment
  breakdown below them.

  Deferred from this item (not shipped): the warm-start ratio is **derived** on the page
  (`1 − coldstarts/requests` over 5m — how rare a cold start is per served request, not a
  per-request warm/cold attribution) because knext exports a cold-start counter, not a per-request
  flag. It therefore has no dashboard counterpart and is excluded from the mirrored-query parity
  list. Adding a first-class warm/cold request label (and a matching dashboard panel) would need a
  core `adapters/metrics.ts` change — out of scope for an app-level page.
- [x] **P1.4 Deployments** — `apps/file-manager/src/app/observability/deployments/page.tsx`, read-only,
  same auth + degrade contract. **The plan's §7 data-path fork is resolved as (c) both sources,
  degrading, with the Kubernetes path STRICTLY OPT-IN.**

  *Why:* (a) reading the `NextApp` CR gives the only real rollback fidelity (pinned revision, canary
  split, image digest, operator conditions, `lastSuccessfulDeployTime`) but adds an RBAC surface to
  the **app's** ServiceAccount and couples the app to the operator CRD — and the CRD is **not
  installed on the OKE cluster**, where (a)-alone would render permanently "unavailable". (b)
  Prometheus/kube-state-metrics needs no new trust surface and reuses the P1.2/P1.3 data path, but
  can only say *what revision appeared when and which one carries pods* — never *why* traffic moved.
  Taking both keeps the **default trust surface identical to (b)'s**: with
  `OBSERVABILITY_NEXTAPP_SOURCE` unset the reader (`observability/_k8s/nextapp.ts`) performs **no
  file read and no API call**, and no RBAC is required. Fidelity is *bought explicitly* in two
  deliberate steps — set `OBSERVABILITY_NEXTAPP_SOURCE=kubernetes` **and** apply
  `apps/file-manager/deploy/observability-nextapp-read-rbac.yaml`: a **namespaced** Role (never a
  ClusterRole) with `get/list/watch` on `nextapps`/`nextapps/status` only, bound to this app's
  ServiceAccount, **never** part of the operator's install bundle (pinned by
  `_k8s/rbac-manifest.test.ts`). The page always names the source that produced what it shows.

  Derived history PromQL (`_prom/query.ts#deploymentQueries`) uses the per-revision Deployment
  series Knative creates (`kube_deployment_created` / `_status_replicas` / `_status_replicas_available`),
  app-scoped on the same `KN_APP_NAME` contract as P1.2/P1.3.

  Degradation states, each with its own discriminating string and each **mutation-proved** (deleting
  the branch fails exactly its test): `no deployment history source is configured` (neither backend
  configured — and **no** empty table drawn) · `could not reach the observability backend`
  (Prometheus queries failed) · `requires kube-state-metrics` (query succeeded, series absent — never
  "no deployments") · `NextApp status source unavailable` + a per-reason sentence (**CRD absent** /
  **RBAC denied** / no in-cluster ServiceAccount / API unreachable) · `NextApp status reads are not
  enabled` (**off, not broken** — deliberately different from the previous state) · "scope unknown"
  (`KN_APP_NAME` unset/invalid ⇒ no read of either kind).

  Not shipped here: a deploy *event* timeline (the CR carries current state + condition transition
  times, not a history), and the `/observability` nav (see the cross-cutting item below).
- [ ] **Cross-cutting:** `/observability` layout with tab nav + Grafana link-out card.
- [ ] **Phase 2 (gated on founder greenlight):** promote the recipe to a scaffoldable `--observability`
  flag — deferred until after the official-adapter migration + Tier-A correctness (scs-zones sequencing).
