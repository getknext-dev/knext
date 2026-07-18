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
**`warmSchedule` cannot be combined with a pinned traffic target**
(`spec.traffic.revisionName`, #92). As of #393 this is a **hard admission
rejection** in `ValidateNextAppSpec` (shared by the webhook and the fail-closed
reconciler): a spec that sets a non-empty `spec.scaling.warmSchedule` together
with a non-empty `spec.traffic.revisionName` is refused with an actionable error
("warmSchedule cannot be combined with pinned traffic … see ADR-0030"). It is no
longer a documented-only advisory. A revision-free variant (a first-class Knative
scheduled-scale) is a possible future refinement, out of scope for the MVP.

### Timezones on distroless (embedded tzdata)

Window membership is evaluated per window in its IANA `timezone` via
`time.LoadLocation`. The operator ships on `gcr.io/distroless/static:nonroot`,
which has **no** `/usr/share/zoneinfo`, so the operator's `main` package
blank-imports `time/tzdata` to embed the IANA database in the binary — without
it a non-UTC window would silently fail-open (skipped, warming nothing) in the
shipped image while passing on a dev host that has system tzdata.
`TestEmbeddedTimezoneDatabase` (cmd package, which links the embed) guards this.
DST-transition-boundary behavior is pinned by `warm_schedule_floor_test.go`
(#394): the floor engages/disengages correctly straddling the `America/New_York`
2026 spring-forward gap (02:00→03:00, the 02:xx wall hour is skipped) and
fall-back overlap (01:00→02:00 replayed) — including windows whose start lands in
the gap or on the repeated hour. `robfig/cron`'s `ParseStandard` + `Next` over a
`time.LoadLocation` zone handle both transitions; no normalization was needed.

## Honesty — this is SCHEDULED, not LEARNED

`warmSchedule` is **owner-authored scheduling**, not learned prediction. It cuts
the cold-start tail only for windows the owner declared. It does **not** learn
traffic and does **not** cap warm cost per tenant — those two remain
**DEFERRED** (below). (The third original gap — "does not pre-warm the app's
database compute" — is **closed by the 2026-07-18 addendum below**, #388.) The
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
   pod half. **SHIPPED 2026-07-18 — see the addendum below.**
3. **Per-tenant warm-budget cap (#389)** — an analog to the ADR-0008 wake budget
   so over-provisioning (a mispredicted or over-broad schedule) cannot erode the
   scale-to-zero cost win. Mispredict failure modes (cold storm on under-warm /
   wasted spend on over-warm) must be measured.

## Addendum 2026-07-18 — DB-compute lockstep pre-warm SHIPPED (#388)

**Status of this addendum:** Accepted. Implements Deferred-item-2. The DATABASE_URL
contract is unchanged: knext still binds a database only via the Secret and still
manages no DB machinery — the entire mechanism lives on the scale-zero-pg side
(`packages/scale-zero-pg`), and the coordination seam is **shared owner
declaration**, not a new cross-operator writer.

**Decision.** The `AppDatabase` CRD gains `spec.warmSchedule` — the SAME
`WarmWindow{start,end,timezone}` shape and 5-field-cron/IANA-tz semantics as this
ADR's `spec.scaling.warmSchedule` (one deliberate divergence: **no `replicas`**
— a Neon compute is single-writer, `Recreate` strategy, one attach per timeline,
so a DB warm window is binary: warm means exactly one compute held awake). The
owner declares the same windows on the NextApp (pod floor) and on the AppDatabase
(DB hold); both operators evaluate identical semantics against cluster-synchronized
clocks, so the two halves of the pre-warm flip at the same boundaries. This side
flips within one appdb-operator resync of a boundary (`APPDB_RESYNC_MS`, default
15s — the lean loop's tick IS the boundary requeue; no per-CR RequeueAfter like
the knext side's).

**Mechanism — a held connection, not a replica write.** While any window is
active the appdb operator holds ONE authenticated idle postgres connection per
app through the apps-gateway (DSN read verbatim from the operator-minted
`app-db-<app>` Secret's `DATABASE_URL` key; SCRAM-SHA-256 via lib/pq). The
gateway counts a compute with an open connection as active, so its idle
scale-to-zero (`GW_IDLE_MS`) never arms during the window; the first dial rides
the ordinary wake path (one wake-budget token, the normal 0→1). At window end
the hold is released and the gateway parks the compute on its usual idle window.

**Why NOT mirror the pod-side approach (and why NOT a CronJob scaling the
compute).** The pod floor works by the operator folding a value into an
annotation it solely owns. The DB side has no equivalent annotation to own:
- An external CronJob (or the appdb operator) writing `compute-<app>`
  `spec.replicas=1` is **undone by the apps-gateway**, which scales the compute
  to 0 `GW_IDLE_MS` after the last connection ends regardless of any replica
  pin — the gateway is the sole writer of per-app replica counts (the appdb
  operator deliberately holds NO `deployments/scale` grant; its `ApplyCompute`
  preserves the live count). A replica-pinning writer would fight the gateway
  every idle window — the same two-writer defect §Context records for ksvc
  min-scale patches, one layer down.
- The held connection is the only mechanism that warms **through** the
  single-writer wake path instead of around it: zero new replica writers, zero
  gateway changes, and a genuine end-to-end warm (the held session completes
  real SCRAM auth, so the first in-window query pays neither the compute wake
  nor a cold-auth surprise). Cost: 1 of `GW_MAX_CONNS` (90) per held app, one
  liveness ping per resync, and the compute's reserved cpu/mem for the window —
  the opt-in warm cost the owner declared.

**Failure and lifecycle semantics.** Warming is **best-effort**: a hold failure
degrades to the ordinary cold-wake path and surfaces loudly (`WarmHoldFailed`
Warning event + `WarmHold` status condition), it never fails provisioning.
Malformed windows are loud too (`InvalidWarmWindow` — this CRD has no admission
webhook). Holds are in-memory in the operator: an operator restart drops them
(TCP dies with the process), the gateway parks on idle, and the next resync
re-establishes — crash-only, self-healing. Deprovision releases the hold first.
Schedule-less CRs reconcile byte-identically to before (no condition emitted).

**Observability.** `WarmHold` status condition per AppDatabase
(`True/WindowActive`, `False/WindowInactive|HoldFailed|InvalidWarmWindow`);
`appdb_warm_hold_active{app=...}` gauge on the operator's `:9092/metrics`
(scraped by the platform Prometheus); the `ComputePhantomKeepalive` alert
subtracts held connections (a declared hold is intended warming, not a phantom
pool) with an `or vector(0)` guard so the alert is not silenced when nothing is
held.

**Known skew (accepted).** The pod floor flips within seconds of a boundary
(RequeueAfter); the DB hold within one resync (≤15s default). At window start an
early query in that gap simply pays one ordinary wake and the hold then keeps
the compute warm; at window end the DB stays warm ≤15s longer. Declare windows
to open a minute ahead of the expected peak. The acceptance-criteria measurement
(first in-window query vs pod-only warming) is owner-gated on an OKE run and
tracked in `docs/BENCHMARKS.md`.

**Still deferred:** #387 (learned controller) and #389 (per-tenant warm-budget
cap) — unchanged, above.

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
