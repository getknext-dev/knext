# ADR-0030 — Scheduled warm-floor (min-scale CronJobs), and the deferred learned/budget controller

- **Status:** Accepted
- **Date:** 2026-07-17
- **Issue:** #380 (W5, part of the high-traffic wave #375). Relates to #376 (W1,
  concurrency→latency curve), #377 (W2, ADR-0028 scale-to-zero model), and #25
  (existing DB warm-tier).
- **Relates to / amends:** ADR-0001 (the operator is the single source of truth
  for the generated Knative Service and its autoscaling annotations — this ADR
  adds **derived** CronJobs that patch the SAME `min-scale` annotation the
  operator already owns; no raw app-manifest generation), ADR-0028 (scale-to-zero
  model + `spec.scaling`).
- **Scope:** a new `spec.scaling.warmSchedule` on the `NextApp` CRD
  (`api/v1alpha1/nextapp_types.go` — `WarmSchedule []WarmWindow`), the CronJobs +
  scoped patcher RBAC generated in `reconcileWarmSchedule`
  (`internal/controller/nextapp_controller.go`), and the shared spec validation
  (`internal/validation/validate.go`, incl. 5-field cron-syntax validation).

## Context

Under sustained bursty traffic an app that scales to zero pays a cold start on
the first request of every wave (ADR-0028). The owner's ask — *"learn from data
→ more warm pods"* — is a **prediction** problem. The architect and
system-designer ruled the delivery order (YAGNI): the **lowest-risk first
delivery** is a **declarative, owner-authored schedule**, not a learned
controller. Owners already know their daily peaks and scheduled campaigns; a
scheduled warm floor cuts the spike-tail latency for those known windows with
zero new control loop, zero ML, and no new source of truth mutating the NextApp.

### Why NOT KEDA (research finding — corrects the first draft)

The first draft generated a **KEDA `cron` ScaledObject** targeting the Knative
Service. **That does not work.** Research on this repo's pinned Knative
(`serving@v0.48.0`) and the KEDA model:

- KEDA actuates its `scaleTargetRef` through the Kubernetes **`/scale`
  subresource** (it reads/writes `.spec.replicas`).
- The Knative **Service** CRD declares `subresources: { status: {} }` only — **no
  `/scale`** (`config/core/300-resources/service.yaml`). The Knative
  **PodAutoscaler** CRD is likewise `status`-only — no `/scale` either
  (`config/core/300-resources/podautoscaler.yaml`). Knative's replica count is
  owned by its KPA and expressed via the `autoscaling.knative.dev/min-scale`
  annotation, not `.spec.replicas`.
- So a KEDA ScaledObject on a ksvc errors at KEDA's own reconcile
  (`error getting scale target … could not find the requested resource`) and the
  warm floor **never materializes** — the feature would be inert.
- The repo's own example (`packages/scale-zero-pg/deploy/40-keda-scaledobject.yaml.optional`)
  targets a plain **Deployment** — consistent with the `/scale` requirement.
- Patching the per-revision **PodAutoscaler** min-scale annotation directly does
  NOT survive either: the Knative Revision reconciler makes the Revision template
  the **source of truth** for all `autoscaling.knative.dev/*` annotations and
  *deletes* any it did not put there (`reconcile_resources.go`
  `syncAnnotationsForKPA`). A PA-level patch is reverted on the next PA reconcile.

The one place Knative accepts as source of truth is the **ksvc
`spec.template` `min-scale` annotation**. That is the mechanism this ADR lands.

## Decision

Add `spec.scaling.warmSchedule` — a list of `WarmWindow{ start, end, replicas,
timezone }` where `start`/`end` are standard **5-field** cron expressions. When
non-empty, the operator generates, all owner-referenced to the NextApp for GC:

1. A **scoped patcher RBAC** trio (`<app>-warm-patcher`): a `ServiceAccount`, a
   `Role` granting ONLY `get`/`patch` on the app's OWN Knative Service
   (`resourceNames: [<app>]` — least privilege; a warm job can touch no other
   ksvc or resource), and a `RoleBinding`. RBAC escalation-prevention is
   satisfied because the operator itself already holds `get`/`patch` on
   `serving.knative.dev/services`.
2. Per window, a pair of **Kubernetes CronJobs**:
   - `<app>-warm-<i>-set`, scheduled at the window **`start`** (in the window's
     `timezone`, via CronJob `spec.timeZone`, default `UTC`), runs
     `kubectl patch service.serving.knative.dev <app> --type=merge` to set
     `spec.template.metadata.annotations["autoscaling.knative.dev/min-scale"]`
     to **`replicas`** — raising the KPA's scale floor for the window.
   - `<app>-warm-<i>-clear`, scheduled at the window **`end`**, patches the same
     annotation back to **`"0"`** — restoring scale-to-zero.
   Both run as the scoped patcher SA, `ConcurrencyPolicy: Forbid`, with bounded
   history/backoff (an idempotent floor patch — no missed-window backlog).

The Knative **KPA reads that annotation as its floor and still scales ABOVE it**
on real traffic, so the composition is: CronJob sets the floor during the window,
KPA scales above it. Outside every window the floor is `"0"`, so the default
scale-to-zero cost model (ADR-0028) is preserved.

When `warmSchedule` is empty (the DEFAULT) **no warm children are generated**,
and any previously-generated ones (CronJobs + patcher RBAC) are deleted. A
**shrinking** schedule prunes the now-unused higher-index window CronJobs.
CronJobs and RBAC are **core built-in kinds** (always present), so they are also
`Owns(...)`-watched — drift on a generated child re-enqueues the NextApp.

Validation (shared by the admission webhook and the fail-closed reconciler)
rejects: an empty `start`/`end`, a `start`/`end` that is **not valid 5-field
cron** (validated with `robfig/cron` `ParseStandard` — the exact parser the
Kubernetes CronJob controller uses, so a cron the operator accepts is one the
generated CronJob accepts; a seconds field, out-of-range value, or garbage is
rejected at admission with an actionable error instead of failing silently in the
scheduler), `replicas < 1` (a floor of 0 warms nothing — omit the window), and
`replicas > maxScale` when maxScale is finite (the floor cannot exceed the
reactive ceiling).

### Known trade-off — a min-scale patch rolls a new Revision

Patching the ksvc `spec.template` annotation is a template change, so Knative
creates a **new Revision** at each window boundary (twice per window). This is
acceptable for a twice-a-window annotation flip on a normal app, but it resets
traffic to latest-ready — so **`warmSchedule` must not be combined with a pinned
traffic target** (`spec.traffic.revisionName`, #92). This is documented on the
CRD field. A revision-free variant (a first-class Knative scheduled-scale, or an
operator-run scheduler that patches the PA in a way Knative won't revert) is a
possible future refinement but is out of scope for the MVP.

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
  `warmSchedule`; the mechanism uses only core Kubernetes kinds (CronJob + RBAC)
  and the Knative min-scale annotation the operator already owns — **no KEDA
  dependency at all** (the abandoned KEDA path could not actuate a ksvc).
- **Negative / accepted:** the floor is only as good as the owner's schedule (no
  learning yet); a warm floor costs `replicas` pods for the window's duration
  (opt-in cost); each window boundary rolls a new Revision (so not for
  pinned-traffic apps). The AC's benchmark (scheduled warm floor vs off, warm
  cost quantified) is owner-gated on an OKE run and tracked in `BENCHMARKS.md` —
  this ADR ships the mechanism.
