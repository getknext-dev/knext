# ADR-0033 — KPA panic-window / panic-threshold knobs (`spec.scaling.panic{Window,Threshold}Percentage`)

- **Status:** Accepted
- **Date:** 2026-07-19
- **Issue:** #413. Direct fast-follow to #411/ADR-0032 (`targetBurstCapacity`), completing the
  unpredicted-burst config family together with #377/ADR-0028 (`ContainerConcurrency` default,
  connection wall) and #380/ADR-0030 (scheduled warm-floor).
- **Relates to / amends:** ADR-0032 (this ADR adds the missing "how fast does the KPA react"
  lever ADR-0032 explicitly deferred as Option C) and ADR-0001 (the operator remains the single
  writer of the ksvc autoscaling annotations — two more annotations on the ksvc it already owns,
  no new control loop, no new child object, no new RBAC).
- **Scope:** two new optional fields on `spec.scaling` (`api/v1alpha1/nextapp_types.go`), range
  validation in `internal/validation/validate.go` (shared by the webhook and the fail-closed
  reconciler), and the annotation stamps in `buildDesiredKsvc`
  (`internal/controller/nextapp_controller.go`).

## Context

ADR-0032 closed the "does the activator buffer a spike" gap with `targetBurstCapacity`. Between
the three burst-related levers that already exist —`targetBurstCapacity` (whether the activator
buffers), `ContainerConcurrency` (ADR-0028, what makes reactive scale-out *fire*), and
`warmSchedule` (ADR-0030, pre-warming *known* windows) — none of them tune **how fast the Knative
Pod Autoscaler (KPA) itself reacts** to an unpredicted N→M traffic surge. Knative's own
autoscaler already ships that lever: the KPA normally evaluates a 60s "stable" window, but when
observed traffic exceeds a threshold within a much shorter "panic" window, it switches into panic
mode — scaling up aggressively and refusing to scale back down until the panic period elapses.
Two annotations tune that behavior: `autoscaling.knative.dev/panic-window-percentage` (how short
the panic window is, as a percentage of the stable window) and
`autoscaling.knative.dev/panic-threshold-percentage` (how far over the steady-state target
triggers panic mode). Today knext leaves both unmanaged: `buildDesiredKsvc` stamps
`min-scale`/`max-scale`/`containerConcurrency`/`targetBurstCapacity` but never the panic knobs, so
every app runs at the Knative cluster defaults (10% window / 200% threshold).

## Decision

Add two optional fields, mirroring ADR-0032's `TargetBurstCapacity` pattern exactly:

- **`spec.scaling.panicWindowPercentage *int32`** — `+kubebuilder:validation:Minimum=1`,
  `Maximum=100`. A percentage of the KPA's stable window; a smaller value makes the KPA evaluate
  a shorter, more reactive window before entering panic mode.
- **`spec.scaling.panicThresholdPercentage *int32`** — `+kubebuilder:validation:Minimum=110`. A
  percentage of the steady-state target; Knative requires it to exceed 100% (110% is the
  documented practical lower bound), and a lower value trips panic mode on a smaller overshoot.
- **Unset (`nil`)**, either or both — the corresponding annotation is **not stamped**; the
  Knative cluster defaults (10% / 200%, unmanaged) apply exactly as before these fields existed.
  Byte-identical back-compat for every existing `NextApp`.

Validation (shared by the webhook and the fail-closed reconciler, `internal/validation/
validate.go`) rejects `panicWindowPercentage` outside `[1,100]` and `panicThresholdPercentage`
below `110`; unset is always valid for either field independently. This mirrors the existing
`targetBurstCapacity`/`poolMax` validation style: one Go function both entry points call.

`buildDesiredKsvc` stamps both annotations into the **same** annotations map that already
carries `min-scale`/`max-scale`/`containerConcurrency`/`target-burst-capacity`, each only when its
field is set, independently of the other. Both are written unconditionally of the preview-env
override block (which only touches `max-scale`/`min-scale`/`scale-to-zero-pod-retention-period`),
so a preview app that declares either panic knob still gets it stamped alongside the forced
`max-scale: 1`.

### Options considered (representation)

| Option | Trade-off |
| --- | --- |
| **A. Whole-percent `*int32` pair (chosen)** | Direct mirror of the `TargetBurstCapacity` pattern already shipped in ADR-0032 — same validation style, same stamp style, same back-compat story. Knative's own annotations are integer-valued percentage strings, so this is a 1:1 mapping with zero translation logic. Sub-integer precision (e.g. `12.5%`) is intentionally unsupported; nothing in the upstream KPA implementation or knext's own use cases needs it. |
| **B. Float string (`"12.5"`)** | Matches Knative's own string-typed annotation value verbatim and would support sub-integer precision, but introduces a new representation style inconsistent with every other numeric `ScalingSpec` field (`MinScale`, `MaxScale`, `TargetBurstCapacity` are all `int32`), and CRD-level range validation on a string requires a regex/CEL expression instead of the simple `Minimum`/`Maximum` markers already used throughout this CRD. |
| **C. `resource.Quantity`** | Kubernetes' native quantity type is built for byte/CPU-style values with binary/decimal suffixes, not percentages; using it here would be a semantic mismatch and add a dependency + parsing step the ksvc stamp does not need (it already just needs an integer to `fmt.Sprintf("%d", ...)` into a string annotation). |
| **D. Do nothing (leave both at Knative defaults)** | Leaves the "how fast does the KPA react" gap this issue exists to close — the whole point of #413, and the deferred Option C from ADR-0032. |

**Recommendation: Option A.** It is the smallest possible surface, consistent with the pattern
ADR-0032 already established and validated in review, and correctly reflects that knext exposes
Knative's own integer-percentage semantics rather than reinventing them.

## The connection-wall interlock (must be read together with ADR-0028/ADR-0029/ADR-0032)

Like `targetBurstCapacity`, the panic knobs do **not** create a new failure mode on their own —
they change the **rate** at which an existing one can be reached, not its ceiling.
`maxScale × poolMax ≤ MaxAppConnections (80)` (ADR-0028, enforced in `internal/validation`) bounds
the **peak** number of pods — and hence peak backend DB connections — an app can reach, regardless
of how quickly the KPA ramps toward that peak. A shorter panic window / lower panic threshold
makes the KPA reach `maxScale` **faster** during a surge; it does not let the KPA exceed
`maxScale`, and it does not change what happens once those pods are Running (each still opens up
to `poolMax` connections, and the existing admission check still gates the product at 80). In
other words: **the panic knobs change the timing of the ramp into the connection-wall ceiling
(how quickly, not how high), exactly like `targetBurstCapacity` changes the timing of how a
buffered burst is released — neither raises or bypasses the ceiling itself.**

- A high `maxScale` with a declared `poolMax` is still rejected if their product exceeds 80,
  regardless of how the panic knobs are tuned.
- A short panic window / low panic threshold combined with a **low** `maxScale` is the safest
  posture for an app that wants a fast reaction to a genuine surge: the KPA panics and scales
  aggressively toward a ceiling that was already proven to fit the connection budget.
- Tuning the panic knobs aggressively on an app with **no declared `poolMax`** does not get a free
  pass either — the wall is still documented-and-unenforced in that case (ADR-0028 §3), exactly as
  it is today without these knobs.

## The KPA-class caveat

Both annotations are read by Knative's **KPA** (Knative Pod Autoscaler) reconciler. They are
**silently ignored** if the ksvc's `autoscaling.knative.dev/class` is set to `hpa.autoscaling.knative.dev`
(the Kubernetes HPA-backed autoscaler class) instead — HPA has no concept of a KPA-style
panic window. knext does not currently stamp a class annotation, which means every ksvc defaults
to Knative's own default class (`kpa.autoscaling.knative.dev`), so this caveat is presently a
non-issue in practice — but it is recorded here because if a future change ever introduces
HPA-class support (e.g. for a workload that wants pure CPU-based scaling), the panic knobs
documented in this ADR would silently stop applying for that ksvc, and that surprise should be
looked up here first.

## Consequences

- **Two new optional `spec.scaling` fields** — additive/optional; CRD and deepcopy regenerated
  (`make manifests generate`). No migration for existing CRs; unset behavior is byte-identical to
  pre-#413.
- **Operators gain a real lever for surge REACTION SPEED** that none of `targetBurstCapacity`
  (buffers), `containerConcurrency` (fires scale-out), or `warmSchedule` (pre-warms known windows)
  provide — the burst-response config family is now complete.
- **A short panic window / low panic threshold has a real cost**: panic mode never scales down
  mid-panic, so an aggressively-tuned pair can over-provision (and therefore over-spend) during a
  noisy but non-critical spike — documented here and in `docs/operator/scaling-cold-start.md` so
  it is not treated as a free win, mirroring ADR-0032's TBC activator-hop caveat.
- **No new control loop, child object, or RBAC** — ADR-0001 single-writer invariant is preserved;
  these are two more annotations on the ksvc the operator already owns.
- **Composes with the connection wall and `targetBurstCapacity`, does not bypass either** — see
  the interlock section above.

## Action items

- [x] `PanicWindowPercentage *int32` (Min=1,Max=100) and `PanicThresholdPercentage *int32`
      (Min=110) on `ScalingSpec` (`api/v1alpha1/nextapp_types.go`).
- [x] Range validation in `internal/validation/validate.go`.
- [x] Stamp `autoscaling.knative.dev/panic-window-percentage` /
      `panic-threshold-percentage` in `buildDesiredKsvc`, coexisting with the preview-env
      override.
- [x] `make manifests generate` (CRD + deepcopy regenerated).
- [x] Docs: `docs/operator/crd-nextapp.md` field rows + interlock caveat,
      `docs/operator/scaling-cold-start.md` panic section, and the docs website
      `apps/docs/content/docs/scale-to-zero.mdx` "Tuning burst response" section (backfilling
      `targetBurstCapacity`, which never reached the site in #412).
- [ ] Deferred (per planning meeting, not this issue): gateway load-shedding/Retry-After; #387
      learned/predictive warm controller; #389 per-tenant warm-budget cap; auto-computing the
      panic knobs from `containerConcurrency`/`maxScale`.
