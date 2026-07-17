# ADR-0030 — Scheduled warm-floor (KEDA cron), and the deferred learned/budget controller

- **Status:** Accepted
- **Date:** 2026-07-17
- **Issue:** #380 (W5, part of the high-traffic wave #375). Relates to #376 (W1,
  concurrency→latency curve), #377 (W2, ADR-0028 scale-to-zero model), and #25
  (existing DB warm-tier).
- **Relates to / amends:** ADR-0001 (the operator is the single source of truth
  for the generated Knative Service and its autoscaling annotations — this ADR
  adds a **derived** KEDA `ScaledObject`, no raw-manifest generation),
  ADR-0028 (scale-to-zero model + `spec.scaling`).
- **Scope:** a new `spec.scaling.warmSchedule` on the `NextApp` CRD
  (`api/v1alpha1/nextapp_types.go` — `WarmSchedule []WarmWindow`), the KEDA
  `ScaledObject` generated in `reconcileWarmSchedule`
  (`internal/controller/nextapp_controller.go`), and the shared spec validation
  (`internal/validation/validate.go`).

## Context

Under sustained bursty traffic an app that scales to zero pays a cold start on
the first request of every wave (ADR-0028). The owner's ask — *"learn from data
→ more warm pods"* — is a **prediction** problem. The architect and
system-designer ruled the delivery order (YAGNI): the **lowest-risk first
delivery** is a **declarative, owner-authored schedule**, not a learned
controller. Owners already know their daily peaks and scheduled campaigns; a
scheduled warm floor cuts the spike-tail latency for those known windows with
zero new control loop, zero ML, and no new source of truth mutating the NextApp.

KEDA (already shipped as OPTIONAL infrastructure — see
`packages/scale-zero-pg/deploy/40-keda-scaledobject.yaml.optional`) provides a
`cron` scaler that sets a `minReplicaCount` floor during a window. That composes
cleanly with Knative's KPA: **KEDA sets the floor, the KPA scales ABOVE it** on
real traffic.

## Decision

Add `spec.scaling.warmSchedule` — a list of `WarmWindow{ start, end, replicas,
timezone }` where `start`/`end` are standard cron expressions. When non-empty,
the operator generates ONE KEDA `ScaledObject` named `<app>-warm-schedule` with:

- `scaleTargetRef` → the app's **Knative Service** (`serving.knative.dev/v1`,
  kind `Service`, name = app name). Targeting the ksvc (not the KPA-owned
  Deployment, whose replica count Knative reconciles and would fight) is the
  supported composition: KEDA writes the desired floor, Knative's KPA owns
  scale-above.
- `minReplicaCount: 0` — the ScaledObject NEVER floors the app above zero
  *outside* a window, so the default scale-to-zero cost model (ADR-0028) is
  fully preserved.
- `maxReplicaCount` = the app's `spec.scaling.maxScale` (or the operator default
  `10` when maxScale is unbounded) — KEDA requires a finite ceiling and must
  never floor above the reactive ceiling.
- one `cron` trigger per window: `{ start, end, timezone (default UTC),
  desiredReplicas }`.

When `warmSchedule` is empty (the DEFAULT) **no ScaledObject is generated**, and
any previously-generated one is deleted. KEDA therefore remains **OPTIONAL**: a
cluster without KEDA installed is unaffected, and a missing `keda.sh` CRD is a
non-fatal log-and-continue during reconcile (the operator does not add a hard
`Owns(ScaledObject)` watch, which would break startup where KEDA is absent).

Validation (shared by the admission webhook and the fail-closed reconciler)
rejects: an empty `start`/`end`, `replicas < 1` (a floor of 0 warms nothing —
omit the window instead), and `replicas > maxScale` when maxScale is finite (the
floor cannot exceed the reactive ceiling).

## Honesty — this is SCHEDULED, not LEARNED

`warmSchedule` is **owner-authored scheduling**, not learned prediction. It cuts
the cold-start tail only for windows the owner declared. It does **not** learn
traffic, does **not** pre-warm the app's database compute, and does **not** cap
warm cost per tenant. Those three are explicitly **DEFERRED** (below).

## Deferred (follow-up issues referencing #375/#380)

1. **Learned/heuristic warm controller (#387)** — set tomorrow's schedule from
   the same-hour-last-week RPS percentile (per-app, from the metrics already
   scraped). No ML until measured seasonality justifies it. This ADDS a control
   loop that mutates the NextApp schedule and would need its own ADR.
2. **DB-compute lockstep pre-warm (#388)** — warm the app's scale-to-zero
   Postgres compute (existing warm-tier, #25) in lockstep with the scheduled
   window, so the prediction removes the DB half of the cold tax, not just the
   pod half.
3. **Per-tenant warm-budget cap (#389)** — an analog to the ADR-0008 wake budget
   so over-provisioning (a mispredicted or over-broad schedule) cannot erode the
   scale-to-zero cost win. Mispredict failure modes (cold storm on under-warm /
   wasted spend on over-warm) must be measured.

## Consequences

- **Positive:** known peaks get a warm floor with zero new control loop and no
  new source of truth; back-compat is byte-identical for every CR that omits
  `warmSchedule`; KEDA stays optional.
- **Negative / accepted:** the floor is only as good as the owner's schedule
  (no learning yet); a warm floor costs `replicas` pods for the window's
  duration (the owner opts into that cost explicitly). The AC's benchmark
  (KEDA-cron warm floor vs off, warm cost quantified) is owner-gated on an OKE
  run and tracked in `BENCHMARKS.md` — this ADR ships the mechanism.
