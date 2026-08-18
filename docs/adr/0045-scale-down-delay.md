# ADR-0045: `spec.scaling.scaleDownDelay` — keep the last pod routable after idle

- **Status:** Proposed (2026-08-19). Architect design gate ran **pre-implementation** on the design
  brief (issues #761–#763 carry the verdicts); this ADR records the accepted shape.
- **Depends on:** ADR-0001 (operator = sole cluster writer), ADR-0017 (`v1alpha1` additive-only,
  operator-first upgrade order), ADR-0028/0029 (the connection wall), ADR-0040 (CR field validation
  pattern), ADR-0041 (scaffolder precedent).
- **Relates to:** ADR-0030 (`warmSchedule` — the scheduled sibling of this on-demand knob),
  ADR-0032/0033/0037 (the other Knative-annotation passthrough fields).

## Context

Measured on the file-manager spike (OKE, records in
`docs/benchmarks/fm-confirmatory-prepulled-ab-2026-08-18.md`):

- A **true** cold start on the vinext+bytecode target is **2.1–2.7 s** with every app-side lever
  applied; the remaining floor is Knative wake/schedule/start.
- A request that lands **while a pod is still routable** is **~52 ms** — no cold start exists.
- A request that lands **during the scale-down transition** stalls **5.3–7.5 s** in the routing
  layer (activator/endpoints), the single worst user-visible mode observed (4/12 samples in the
  confirmatory sitting).

Knative already ships the lever: `autoscaling.knative.dev/scale-down-delay` keeps the last pod
routable for a window after traffic stops. Within the window: warm hits, and **no scale-down
transition exists to stall in**. After it: scale-to-zero proceeds exactly as before. Proved on the
spike: 3.5 min after last traffic, pod still up, 646 ms response (external), then zero.

Nothing exposes this through knext. Users would have to hand-annotate the ksvc the operator owns —
which ADR-0001 forbids surviving reconciliation.

## Decision

1. **Add `spec.scaling.scaleDownDelay` (string, Go `metav1.Duration` semantics) to `NextAppSpec`,
   additive `v1alpha1`, DEFAULT UNSET.** Unset ⇒ the annotation is **not stamped** and the Knative
   cluster default applies unmanaged, exactly as before this field existed — **byte-identical
   back-compat**, the same invariant the `targetBurstCapacity`/`panicWindow*`/`imagePrewarm` godoc
   states verbatim. Set ⇒ the operator stamps `autoscaling.knative.dev/scale-down-delay` on the
   revision template. The operator remains the only writer (ADR-0001).
2. **No product default.** A `5m` field default was considered and **rejected** (options below).
   The zero-devops posture ships in the **scaffolder** instead: `kn-next create` writes
   `scaleDownDelay: '5m'` into the generated `kn-next.config.ts` — visible in the user's own file,
   removed by deleting a line, and with **zero effect on any existing deployment** (ADR-0041
   precedent).
3. **Validation per ADR-0040:** parsed and range-checked in the single shared
   `ValidateNextAppSpec` precondition branch (admission webhook and reconciler cannot diverge);
   **no `MustParse` at the use site**. Range: Knative accepts `0s`–`1h`; reject outside it with the
   Knative bound named in the error.
4. **The godoc carries two mandatory paragraphs:**
   - **Connection wall (ADR-0028/0029):** the delay holds pods — and their DB pool connections —
     alive past the point they would have released. It does not raise peak `maxScale × poolMax`,
     but it raises **idle** connection occupancy against the shared budget, exactly as
     `targetBurstCapacity`'s godoc states for its own effect.
   - **Cluster-feature honesty:** the annotation's acceptance range is the *installed* Knative's;
     a value the webhook accepted can still be clamped or ignored by an older cluster. `doctor`
     reports the installed Knative version; the docs promise 52 ms only inside the window **on a
     cluster that honours the annotation**.
5. **Ships standalone, before ADR-0042 Phase 4.** Batching with the `build` field was rejected:
   `v1alpha1` grows additively (ADR-0017 §2.1), so there is no CRD-version bump to save, and
   coupling a target-independent latency knob to the flip-gated Phase 4 change creates schedule
   pressure pointing the wrong way while violating the disjoint-blast-radius rule
   (`workflow.md`).

## Options considered

| Option | Verdict | Why |
|---|---|---|
| Field, default unset + scaffolded `5m` | **ACCEPTED** | Byte-identical back-compat; the default lives where the user can see and delete it; off→on later is a release note, on→off later regresses users — ship the reversible one |
| Field, default `5m` | REJECTED | Silently changes every **stored** `NextApp` on the operator-first upgrade leg (ADR-0017 §4) with no CR edit; "approximately always-on" contradicts the scale-to-zero positioning (`CLAUDE.md` §1) as a *default* — that is a founder call, not a field default |
| A `warmPaths` CR field alongside | REJECTED | `KNEXT_WARM_PATH` is already fully settable via `spec.env`; a dedicated field is a permanent (ADR-0017) second way to say the same thing, for zero new capability |
| Do nothing (document the annotation) | REJECTED | The operator owns the template; a hand-stamped annotation does not survive reconciliation (ADR-0001), so "document it" means documenting a fight with the reconciler |
| Batch into Phase 4's schema change | REJECTED | See Decision 5 — the claimed saving does not exist |

## The admission rule for the NEXT annotation-passthrough field

This is the **seventh** `ScalingSpec` member and the **fourth** 1:1 Knative-annotation mirror. The
family has grown by precedent; this ADR states the policy so the next one is admitted or refused on
it rather than by accretion (`CLAUDE.md` §1's anti-PaaS-drift line):

> A Knative annotation earns a `NextAppSpec` field only when **all four** hold: (1) a measured,
> recorded user-visible effect on a stated knext goal (this one: the 52 ms window and the
> eliminated transition stall); (2) the operator is the only viable writer (ADR-0001 makes
> hand-annotation unworkable); (3) unset is byte-identical back-compat; (4) the semantics are
> target-independent (identical on node and vinext). An annotation failing any prong stays a
> documented recipe.

## Consequences

- Users on the scaffolded default get **~52 ms** responses for any request within 5 minutes of the
  previous one, and never see the 5–7 s transition stall inside that window — while still scaling
  to zero afterwards. Users who never re-run `create` see **no change whatsoever**.
- Idle cost is real and visible: one pod (plus its idle DB connections) for the window after every
  burst. On saturated nodes that capacity matters — which is exactly why it must be the user's
  visible choice, not the operator's silent one.
- A follow-up measured elsewhere (#766): the DB compute has no equivalent knob, so within the
  window the app is warm while scale-zero-pg may still sleep its compute — the first DB-touching
  request after DB idle pays the DB wake even on a warm pod. The two windows are independent by
  design (ADR-0030 addendum shape); the docs must say so.

## Action items

- [ ] #762 — operator field + annotation stamping + `ValidateNextAppSpec` branch + godoc paragraphs
      (ADR-0040 three-part shape; envtest for stamp/unset/byte-identical-when-nil).
- [ ] #763 — scaffolder writes `scaleDownDelay: '5m'`; separate commit; docs-site page states the
      idle cost plainly.
- [ ] Docs cross-reference to #766 (DB window independence) when that lands.
