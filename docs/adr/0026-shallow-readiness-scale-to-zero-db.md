# ADR-0026 — Readiness/liveness are SHALLOW; deep DB checks are observability-only

- **Status:** Accepted
- **Date:** 2026-07-17
- **Relates to / amends:** ADR-0023 (health dependency taxonomy — this ADR
  narrows its scope: the taxonomy no longer backs readiness), ADR-0001 (operator
  = single source of truth for the generated Knative Service / probes), the
  scale-zero-pg database layer (DB scales to zero and wakes on connect).
- **Scope:** `checkShallowHealth()` / `checkDeepHealth()` in
  `packages/lib/src/health/index.ts`, the app health routes
  (`/api/health` shallow, `/api/health/deep` deep), and the operator-generated
  readiness + liveness probes in `buildDesiredKsvc`.

## Context

The `/api/health` route ran `checkDeepHealth()` — a DEEP Postgres+Redis
reachability check with a hard-coded 3s "cluster timeout" — and was wired as
**both** the Knative readiness and liveness probe (readiness
`timeoutSeconds=1, periodSeconds=3, failureThreshold=3`).

Under the unified platform the app's database is a **scale-to-zero**
scale-zero-pg compute (`compute-<app>`) that legitimately sleeps at zero and
takes ~2–6s to wake on connect. During that wake window the deep check's
Postgres dial is refused or exceeds the 3s (and the 1s probe) timeout, so the
probe **fails** and readiness **flaps**. Observed live on OKE (file-manager on
scale-zero-pg): every cold start logged `[Health Check] System health
verification timed out`, and cold-start latency under ~20 concurrent requests
ballooned to ~32s (vs ~6s single) because Knative won't route to a
not-Ready pod, so the wake never completes under load.

An asleep/waking scale-to-zero DB is **normal**, not unhealthy. Gating
readiness on deep DB reachability directly defeats scale-to-zero.

## Decision

1. **Readiness + liveness are SHALLOW.** `checkShallowHealth()` returns healthy
   whenever the process/server is up, WITHOUT dialing Postgres or Redis. The
   app serves this at `/api/health`, and the operator wires **both** the
   readiness and liveness probes to that shallow path. Readiness no longer
   depends on DB reachability, so a cold DB wake can never flap it.
2. **Deep checks are observability-only.** `checkDeepHealth()` still dials the
   dependencies, but it is exposed at a separate `/api/health/deep` endpoint for
   monitoring/alerting and is **never** wired to a probe.
3. **Deep check is wake-aware.** A Postgres connection-level failure
   (ECONNREFUSED/ECONNRESET/ETIMEDOUT/host-unreachable) or a timeout that
   exceeds the deep budget classifies as **`waking`** (a normal, transient
   scale-to-zero state), not `down`. A reachable-but-erroring query (auth,
   missing relation, syntax) remains `down` (genuine fault). A Redis-cache blip
   remains `degraded` (fails OPEN, ADR-0023).
4. **Deep timeout is configurable.** `HEALTH_DEEP_TIMEOUT_MS` overrides the
   cluster timeout; the default is aligned with the DB wake budget (8s), not the
   old 3s. Because deep no longer gates readiness, this only affects how long
   monitoring waits before reporting `waking`.

## Status taxonomy (deep, observability-only)

| postgres (hard)                | redis (cache) | overall    | HTTP (`/api/health/deep`) |
|--------------------------------|---------------|------------|---------------------------|
| up                             | up / uncfg    | `ok`       | 200                       |
| up                             | down          | `degraded` | 200                       |
| conn-refused / timeout (asleep)| *             | `waking`   | 200                       |
| reachable-but-erroring         | *             | `down`     | 503                       |

`/api/health` (shallow) always returns 200 while the process is up.

## Consequences

- **Readiness no longer gates on DB reachability** — the cold-wake readiness
  flap and its cold-start-under-load amplification are eliminated. This is a
  deliberate readiness-semantics change and is called out in the PR body.
- **Liveness no longer kills a pod for a DB blip.** A waking/blipping DB can no
  longer trip the liveness probe and restart the pod mid-wake.
- **A genuinely-down DB no longer evicts the pod via readiness.** That is
  intentional under scale-to-zero (the app may serve DB-free routes and should
  surface DB faults through `/api/health/deep` + alerting, not by removing
  itself from rotation). ADR-0023's fail-closed intent moves to the deep
  observability signal.
- `HealthStatus.status` gains a `waking` member and `checks.postgres` gains a
  `waking` member — additive to the `@knext/lib/health` public API.
- The operator adds a `deepHealthPath` (`<readinessPath>/deep`) used only for
  documentation/monitoring wiring; it is never attached to a probe.
