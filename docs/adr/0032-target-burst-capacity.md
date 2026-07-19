# ADR-0032 — Operator-owned burst/surge control (`spec.scaling.targetBurstCapacity`)

- **Status:** Accepted
- **Date:** 2026-07-19
- **Issue:** #411. Relates to #377/ADR-0028 (scale-to-zero model, `ContainerConcurrency`
  default, connection wall), #378/ADR-0029 (connection-wall byo-pooler + enforced cap),
  #380/ADR-0030 (scheduled warm-floor).
- **Relates to / amends:** ADR-0028 (this ADR adds the missing "unpredicted burst"
  lever the ContainerConcurrency default alone does not provide) and ADR-0001 (the
  operator remains the single writer of the ksvc autoscaling annotations — this is
  another annotation on the ksvc it already owns, no new control loop, no new
  child object, no new RBAC).
- **Scope:** a new optional `spec.scaling.targetBurstCapacity` on the `NextApp` CRD
  (`api/v1alpha1/nextapp_types.go`), range validation in
  `internal/validation/validate.go` (shared by the webhook and the fail-closed
  reconciler), and the annotation stamp in `buildDesiredKsvc`
  (`internal/controller/nextapp_controller.go`).

## Context

ADR-0028 lowered `ContainerConcurrency` 100→20 so reactive scale-out actually
*fires* under load, and ADR-0030 added `warmSchedule` to pre-warm *known* traffic
windows. Neither buffers an **unpredicted** spike: with `min-scale: 0`/`1` and a
handful of Running pods, a burst that arrives faster than the KPA can schedule new
pods lands entirely on whatever pods are already Running — the classic
tail-latency cliff on the first wave of a surge.

Knative Serving already ships a lever for exactly this: the
`autoscaling.knative.dev/target-burst-capacity` (TBC) annotation. It controls
whether the **activator** — the component that sits in front of the pods and can
buffer/queue requests — stays in the request path once pods are Running, or steps
out once capacity looks sufficient. While the activator is in the path it paces a
burst into pods as they come up instead of letting the first Running pod absorb
the whole spike directly. Today knext leaves TBC unmanaged: `buildDesiredKsvc`
stamps `min-scale`/`max-scale`/`containerConcurrency` but never TBC, so every app
runs at the Knative cluster default (`200`).

## Decision

Add an optional `spec.scaling.targetBurstCapacity *int32` field, mirroring
upstream Knative TBC semantics exactly (no reinterpretation):

- **`-1`** — always keep the activator in the request path. Maximum burst
  tolerance; the trade-off is an extra network hop (activator → pod) on **every**
  request while the KPA holds the activator in path, not just during a burst.
- **`>= 0`** — a numeric burst capacity in requests: the buffer the activator
  will absorb before Knative decides enough capacity exists to remove it from the
  path.
- **Unset (`nil`)** — the annotation is **not stamped**; the Knative cluster
  default (`200`, unmanaged) applies exactly as before this field existed.
  Byte-identical back-compat for every existing `NextApp`.

Validation (shared by the webhook and the fail-closed reconciler, in
`internal/validation/validate.go`) rejects any value `< -1` — the only value with
no meaning in Knative's model — while accepting `-1` and any `>= 0`. Unset is
always valid. This mirrors the existing `poolMax`/`warmSchedule` validation style:
a single Go function both entry points call, so a spec the webhook accepts is
exactly one the reconciler would also accept.

`buildDesiredKsvc` stamps `autoscaling.knative.dev/target-burst-capacity` into the
**same** annotations map that already carries `min-scale`/`max-scale`/
`containerConcurrency`, only when the field is set. It is written unconditionally
of the preview-env override block (which only touches `max-scale`/`min-scale`/
`scale-to-zero-pod-retention-period`), so a preview app that declares TBC still
gets it stamped alongside the forced `max-scale: 1`.

### Options considered

| Option | Trade-off |
| --- | --- |
| **A. Add `targetBurstCapacity` (chosen)** | Direct mapping to an existing, well-understood Knative mechanism. Zero new control loop, zero new child object/RBAC (ADR-0001 preserved) — it is one more key in the annotations map `buildDesiredKsvc` already writes. Additive/optional, byte-identical back-compat when unset. |
| **B. Auto-compute TBC from `containerConcurrency`/`maxScale`** | Removes a knob from the operator, but hides a genuine cost/latency trade-off (activator hop vs burst tolerance) the app owner is best placed to make per-workload; also couples this ADR to guessing a formula with no measured basis yet. Deferred — could layer a smart default on top of the explicit field later without breaking it. |
| **C. Panic-window/panic-threshold knobs instead/also** | A different, complementary KPA lever (how fast the KPA reacts, not what the activator does while reacting). Explicitly out of scope per the planning meeting — fast-follow, keeps this change reviewable as one clean A/B. |
| **D. Do nothing (leave TBC at the Knative default)** | Leaves the "unpredicted burst" gap this issue exists to close; the whole point of #411. |

**Recommendation: Option A.** It closes the gap with the smallest possible
surface — one field, one annotation, no new writer — consistent with ADR-0001 and
the narrow-adapter-not-PaaS positioning (CLAUDE.md §1).

## The connection-wall interlock (must be read together with ADR-0028/ADR-0029)

TBC does **not** create a new failure mode on its own, but it changes the shape of
an existing one. `maxScale × poolMax ≤ MaxAppConnections (80)` (ADR-0028,
enforced in `internal/validation`) bounds the **peak** number of pods — and hence
peak backend DB connections — an app can reach. A buffered burst (TBC keeping the
activator in path) does not raise that ceiling: it only **paces** how the burst is
released into pods as they scale, up to whatever `maxScale` already allows. Once
those pods are Running, they still each open up to `poolMax` connections, and the
existing admission check still gates the product at 80 — independent of whatever
TBC value is set. In other words: **TBC changes the timing of the ramp into the
connection-wall ceiling, not the ceiling itself.** The two composes cleanly at
admission because they are validated independently and both act on the same
`ScalingSpec`:

- A high `maxScale` with a declared `poolMax` is still rejected if their product
  exceeds 80, regardless of TBC.
- Setting TBC to `-1` (max burst tolerance) on an app with a **low** `maxScale` is
  the safest posture: the activator absorbs the spike while the KPA schedules
  pods up to a ceiling that was already proven to fit the connection budget.
- Setting TBC to `-1` on an app with **no declared `poolMax`** does not get a free
  pass either — the wall is still documented-and-unenforced in that case (ADR-0028
  §3), exactly as it is today without TBC.

This is stated explicitly here (rather than left implicit) because the two knobs
live in the same `ScalingSpec` and an operator tuning burst absorption is exactly
the operator who should re-check the connection-wall math while they're at it.

## Consequences

- **New optional `spec.scaling.targetBurstCapacity` field** — additive/optional;
  CRD and deepcopy regenerated (`make manifests generate`). No migration for
  existing CRs; unset behavior is byte-identical to pre-#411.
- **Operators gain a real lever for unpredicted bursts** that neither ADR-0028
  (fires scale-out) nor ADR-0030 (warms known windows) provides.
- **`-1` has a real cost** (an activator hop on every request while it stays in
  path) — documented here and in `docs/operator/scaling-cold-start.md` so it is
  not treated as a free win.
- **No new control loop, child object, or RBAC** — ADR-0001 single-writer
  invariant is preserved; this is one more annotation on the ksvc the operator
  already owns.
- **Composes with the connection wall, does not bypass it** — see the interlock
  section above. W3 (#378) still owns the actual work of breaking the wall (a
  shared pooler); TBC does not substitute for that.

## Action items

- [x] `TargetBurstCapacity *int32` on `ScalingSpec` (`api/v1alpha1/nextapp_types.go`).
- [x] Range validation (`< -1` rejected) in `internal/validation/validate.go`.
- [x] Stamp `autoscaling.knative.dev/target-burst-capacity` in `buildDesiredKsvc`,
      coexisting with the preview-env override.
- [x] `make manifests generate` (CRD + deepcopy regenerated).
- [x] Docs: `docs/operator/crd-nextapp.md` field row + interlock caveat,
      `docs/operator/scaling-cold-start.md` section.
- [ ] Deferred (per planning meeting, not this issue): panic-window/panic-threshold
      knobs (fast-follow); #387 learned/predictive warm controller; #389 per-tenant
      warm-budget cap; gateway load-shedding/Retry-After.
