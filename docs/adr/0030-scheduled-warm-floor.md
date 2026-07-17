# ADR-0030 — Scheduled warm-floor (operator-owned min-scale), and the deferred learned/budget controller

- **Status:** Accepted
- **Date:** 2026-07-18
- **Issue:** #380 (W5, part of the high-traffic wave #375). Relates to #376 (W1,
  concurrency→latency curve), #377 (W2, ADR-0028 scale-to-zero model), and #25
  (existing DB warm-tier).
- **Relates to / amends:** ADR-0001 (the operator is the single source of truth
  for the generated Knative Service and its autoscaling annotations — this ADR
  keeps that invariant: the operator itself folds the active warm-window floor
  into the `min-scale` annotation it already owns; no new writer, no
  raw-manifest generation), ADR-0028 (scale-to-zero model + `spec.scaling`).
- **Scope:** a new `spec.scaling.warmSchedule` on the `NextApp` CRD
  (`api/v1alpha1/nextapp_types.go` — `WarmSchedule []WarmWindow`), the
  window-evaluation (`warmScheduleFloor` / `warmScheduleRequeue`) folded into
  `buildDesiredKsvc` + the boundary requeue in `Reconcile`
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

### Two mechanisms rejected before landing single-writer

Two earlier drafts were wrong; the record matters because both traps are easy to
re-introduce:

1. **KEDA `cron` ScaledObject targeting the ksvc — does not work.** KEDA actuates
   its `scaleTargetRef` through the Kubernetes **`/scale` subresource** (reads/
   writes `.spec.replicas`). On this repo's pinned Knative (`serving@v0.48.0`) the
   Knative **Service** CRD is `subresources: {status: {}}` only — **no `/scale`**
   (`config/core/300-resources/service.yaml`), and the **PodAutoscaler** is
   likewise status-only (`podautoscaler.yaml`). Knative's replica count lives in
   the `autoscaling.knative.dev/min-scale` annotation, not `.spec.replicas`. A
   KEDA ScaledObject on a ksvc errors at KEDA's own reconcile and the floor never
   materializes. (The repo's `40-keda-scaledobject.yaml.optional` targets a plain
   Deployment — consistent with the `/scale` requirement.)

2. **External CronJobs patching the ksvc min-scale annotation — two-writer
   defect.** `buildDesiredKsvc` rebuilds the ksvc `spec.template` annotations map
   from `Spec.Scaling.MinScale` (default `"0"`) wholesale on **every** reconcile,
   and the ksvc is `Owns`-watched. So an external CronJob that patched
   `min-scale=K` triggered a reconcile that **reverted** it to `Spec.MinScale`
   within one pass — and each set+revert rolled a new Revision (thrash). For
   default apps (`MinScale=0`) the feature was **inert**. (Patching the
   per-revision PodAutoscaler directly does not survive either: the Revision
   reconciler's `syncAnnotationsForKPA` makes the Revision template the source of
   truth and deletes autoscaling annotations it did not put there.)

The lesson: **there must be exactly one writer of `min-scale`, and it must be the
operator** (ADR-0001). That is the mechanism this ADR lands.

## Decision — the operator owns the schedule (single writer of min-scale)

Add `spec.scaling.warmSchedule` — a list of `WarmWindow{ start, end, replicas,
timezone }` where `start`/`end` are standard **5-field** cron expressions.

On **every reconcile**, the operator (in `buildDesiredKsvc`) evaluates the
windows against **now** (`r.now()`, a test-injectable clock) and sets the ksvc
`autoscaling.knative.dev/min-scale` annotation to:

```
effective_min_scale = max( Spec.Scaling.MinScale , active_warm_window_floor )
```

where `active_warm_window_floor` is the **max `replicas`** over all windows whose
`[start, end)` contains now (0 if none). Membership is evaluated per window in its
own `timezone` (default `UTC`) using `robfig/cron` `ParseStandard` (the 5-field
flavour the Kubernetes CronJob controller uses, matching admission validation): a
window is active iff its next `end` fire is sooner than its next `start` fire —
i.e. we are between a start and its end. A window whose cron/timezone somehow
fails to parse (should be impossible post-validation) is skipped defensively
rather than erroring the whole reconcile.

Because the **operator is the sole writer**, there is no external actor to race
it: the floor set on one reconcile is exactly what the next reconcile recomputes,
so it **never reverts and never thrashes**. Outside every window the annotation is
`Spec.MinScale` (default `0`), so scale-to-zero (ADR-0028) is preserved.

**Boundary requeue.** Because the operator reconciles event-driven (not on a
timer), `Reconcile` additionally sets `RequeueAfter` to the **next window
boundary** — the soonest of every window's next start/end after now — clamped to
`[10s, 1h]` (a near/negative boundary from clock skew is floored to 10s to avoid
a busy 0s loop; a distant boundary is capped at 1h for a bounded periodic
re-check). It takes the sooner of this and any status-verdict requeue (e.g.
ksvc-not-ready) so neither is masked. The floor therefore flips within seconds of
each `start`/`end` without waiting for an unrelated event.

**No child objects.** This mechanism generates **no** CronJobs, **no** patcher
ServiceAccount/Role/RoleBinding, and needs **no** extra RBAC (no
`batch/cronjobs`, no `rbac roles/rolebindings`) — the floor is folded into the
ksvc the operator already manages. Empty/removed `warmSchedule` => the next
reconcile simply computes `min-scale = Spec.MinScale` (byte-identical back-compat
for every CR that omits the field).

Validation (shared by the admission webhook and the fail-closed reconciler)
rejects: an empty `start`/`end`, a `start`/`end` that is **not valid 5-field
cron** (validated with `robfig/cron` `ParseStandard` — a seconds field,
out-of-range value, or garbage is rejected at admission with an actionable error
instead of failing silently), `replicas < 1` (a floor of 0 warms nothing — omit
the window), and `replicas > maxScale` when maxScale is finite (the floor cannot
exceed the reactive ceiling).

### Single-writer of min-scale (invariant)

The operator is the **only** writer of the ksvc `autoscaling.knative.dev/min-scale`
annotation. `buildDesiredKsvc` computes the effective value (`max(Spec.MinScale,
active window)`) from spec + clock every reconcile and stamps it; nothing else
(no CronJob, no KEDA, no human patch that would survive) writes it. This is what
makes the scheduled floor correct: there is no writer to race, so no revert and
no Revision thrash. Any future scheduled-scaling refinement MUST preserve this
invariant.

### Known trade-off — a min-scale change may roll a new Revision

Changing the ksvc `spec.template` `min-scale` annotation is a template change, so
Knative creates a **new Revision** when the effective floor actually changes (at a
window boundary). This is far less churn than the abandoned CronJob approach (no
revert loop — the operator only changes the annotation when the *computed* floor
changes, i.e. twice per window), but it still resets traffic to latest-ready — so
**`warmSchedule` must not be combined with a pinned traffic target**
(`spec.traffic.revisionName`, #92). This is documented on the CRD field. A
revision-free variant (a first-class Knative scheduled-scale) is a possible
future refinement, out of scope for the MVP.

## Honesty — this is SCHEDULED, not LEARNED

`warmSchedule` is **owner-authored scheduling**, not learned prediction. It cuts
the cold-start tail only for windows the owner declared. It does **not** learn
traffic, does **not** pre-warm the app's database compute, and does **not** cap
warm cost per tenant. Those three are explicitly **DEFERRED** (below). The
operator-owns-schedule model is also the natural foundation for the learned
controller (#387): that work replaces the owner-authored windows with a computed
schedule, writing through the same single min-scale writer.

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

- **Positive:** known peaks get a warm floor with zero new control loop, no new
  source of truth, and **no new child objects or RBAC** — the operator folds the
  floor into the ksvc it already owns (ADR-0001 single-writer preserved).
  Back-compat is byte-identical for every CR that omits `warmSchedule`; no KEDA,
  no CronJobs, no kubectl-image supply-chain surface.
- **Negative / accepted:** the floor is only as good as the owner's schedule (no
  learning yet); a warm floor costs `replicas` pods for the window's duration
  (opt-in cost); a boundary floor change rolls a new Revision (so not for
  pinned-traffic apps). The AC's benchmark (scheduled warm floor vs off, warm
  cost quantified) is owner-gated on an OKE run and tracked in `BENCHMARKS.md` —
  this ADR ships the mechanism.
