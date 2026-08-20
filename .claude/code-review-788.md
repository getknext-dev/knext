ISSUES_FOUND

# Adversarial code review — PR #788 (#775 preview-annotation disposition guard)

Reviewed: `343970b` (green) and `771631f` (red), diffed against `origin/main`.
All mutations were run in a **hook-free copy** (`git archive 343970b | tar -x -C /tmp`)
because the shared worktree rewrites files under my tool calls (see issue 5). Every
mutation used an anchor-asserting script that aborts unless the anchor occurs exactly
once — never bare `perl` — with a tar restore + re-verified green between runs.

## What I could NOT defeat (mutation-proved, both halves)

| Mutation | Result |
|---|---|
| preview stops `delete(scale-down-delay)` — the literal #770 regression | **RED** — "declared DROPPED … but preview stamped it as \"5m\"" |
| preview stops forcing `min-scale=0` (warm floor leaks in) | **RED** — "declared FORCED to \"0\" … but preview stamped \"5\"" |
| preview stops forcing `scale-to-zero-pod-retention-period` | **RED** — stale-entry arm |
| preview forces `target-burst-capacity` (breaks PASSED) | **RED** — "prod=\"150\" preview=\"0\"" |
| fixture `MaxScale: 7 → 1` (forcing made unobservable) | **RED** — anti-tautology arm fires |
| new flat `ScalingSpec` field + stamp, fixture NOT extended | **RED** — reflection arm |
| new flat `ScalingSpec` field + stamp, fixture extended (author fixes layer 1 only) | **RED** — disposition arm |

Red-first is **honest**: at `771631f` the test compiles and fails naming all seven keys
with the "DECIDE the disposition" message — not a compile error.
Determinism holds: clock pinned and `WarmWindow.Timezone: "UTC"` is explicit, so
`TZ=UTC/America\_Santiago/Pacific\_Kiritimati/Australia\_Lord\_Howe/Asia\_Kathmandu` all pass.
`gofmt -l` clean, `go vet ./internal/controller/` clean, plain-`go test` style matches
`build_ksvc_resources_test.go`, and CI really runs it (`ci.yml:719 make test` →
`go test $(go list ./... | grep -v /e2e)`). No secrets, no shell-building, no `:latest`.

## Issues

- **`preview_annotation_disposition_test.go:157` — the reflection scan is SHALLOW, so a knob
  nested one level below `ScalingSpec` escapes the guard entirely.** `v.Field(i).IsZero()` is
  checked only on top-level fields. `WarmSchedule` is a slice with one element, so it is
  non-zero regardless of what its element contains. **Mutation-proved:** I added
  `WarmWindow.BurstDuringWindow` and stamped `autoscaling.knative.dev/window-burst` from it —
  the guard stayed **GREEN**. Same shape for any future struct or `*struct` field: setting one
  sub-field makes `IsZero` false while its siblings stay zero. `WarmWindow` is not
  hypothetical — it is the one nested type `ScalingSpec` already has, and this is exactly the
  "second knob leaks silently through the list" class (#770) the guard exists to stop. Fix:
  recurse into struct / slice-of-struct / pointer-to-struct fields instead of testing only the
  top level.

- **`preview_annotation_disposition_test.go:190` — the scan sees ONE NextApp shape, so an
  `autoscaling.knative.dev/*` annotation stamped from a non-`ScalingSpec` field escapes.** The
  fixture sets only `Image`, `Scaling` and `Preview`; `Observability`, `Traffic`, `Resources`
  etc. stay nil, so their branches never run. **Mutation-proved:** stamping
  `autoscaling.knative.dev/metric` inside the `spec.observability.enabled` branch left the guard
  **GREEN**. This makes the new comment at **`nextapp_controller.go:876`** inaccurate as written
  — it claims the guard "collects the `autoscaling.knative.dev/*` keys it emits, and FAILS on
  any key with no entry", when it collects the keys emitted *for this one fixture*. Either
  populate every optional sub-spec in the fixture, or narrow the comment to the scope the guard
  actually has. An overclaiming comment is how the next author concludes they are covered.

- **`nextapp_controller.go:985` — `ContainerConcurrency` is an autoscaling knob with NO recorded
  preview disposition, and is structurally invisible to this guard.** It is stamped as a ksvc
  *field*, not an annotation, so the prefix filter can never see it and the prose list never
  dispositions it; previews silently inherit the user's value. The commit subject claims "record
  **every** autoscaling knob's preview disposition". Either disposition it in the prose list
  (PASSED is presumably right) or narrow the claim to "every autoscaling *annotation*". Any
  future knob expressed as a template field (e.g. `timeoutSeconds`) has the same blind spot.

- **`preview_annotation_disposition_test.go:314` — the PASSED arm asserts `prod == preview` but
  never ties either value to the user's spec, so it is one-half.** **Mutation-proved:** hardcoding
  the production stamp to `"0"` (ignoring `spec.scaling.targetBurstCapacity`) left the guard
  **GREEN** — both runs agreed on a wrong value. FORCED has an explicit anti-tautology check;
  PASSED has no equivalent. Low severity only because `reconcile_output_test.go:227-299` asserts
  the production values; closing it is one line (`prodVal` must equal the fixture's value).

- **PROCESS, not PR content — mutation residue is sitting in the shared worktree.**
  `packages/kn-next-operator/internal/controller/preview_annotation_disposition_test.go` is
  uncommitted-modified in `.claude/worktrees/agent-a12a0c8cef7b2bbdd`, with the
  `"autoscaling.knative.dev/scale-down-delay"` key replaced by `"MUTATED-REMOVED-ENTRY"` —
  leftover from someone's mutation proof. The **committed** content is clean (verified by
  `git archive 343970b`), so the PR itself is unaffected, but this is precisely the repo's own
  "mutation residue hazard" memory: a further commit on this branch lands the inverse of the
  guard, and `git status` shows only a legitimately-modified file. Clean it before any further
  commit here. I deliberately did not restore it — it may belong to a live agent. **Update:** it
  disappeared from the worktree later in this review (a hook or a live agent restored it), so
  the exposure was transient — but it was real for the window it existed, and the same worktree
  also silently reverted an edit of mine mid-review, so treat that tree as unsafe for commits
  until the agent holding it is stopped.

## Test quality

Genuinely strong and non-tautological: it collects keys from the builder rather than a
hand-written list, asserts each disposition observably in both directions, carries its own
anti-tautology and stale-entry arms, and survived seven of nine adversarial mutations — the two
it failed are scan-coverage gaps (nested fields, non-`ScalingSpec` fields), not weakened assertions.

---

# Round 2 — `8d25f40` (red) + `a7c06a8` (green)

ISSUES_FOUND

Worktree verified clean before starting (only the untracked `.claude/impl-775-report.md`).
All mutations again run in a hook-free `git archive a7c06a8` copy, anchor-asserting script,
tar-restore + re-verified green between each.

## All four round-1 findings are genuinely fixed — re-ran MY OWN mutations

| Round-1 mutation | R1 | R2 |
|---|---|---|
| `WarmWindow.BurstDuringWindow` + `window-burst` stamp (nested knob) | GREEN | **RED** — `ScalingSpec.WarmSchedule[0].BurstDuringWindow is zero in the fixture` |
| `autoscaling.knative.dev/metric` stamped in the `spec.observability` branch | GREEN | **RED** — "stamps … but it has NO preview disposition" |
| production `target-burst-capacity` hardcoded to `"0"` | GREEN | **RED** — "declared PASSED THROUGH from the user's spec value \"150\", but production rendered \"0\"" |
| **M8** preview stops dropping `scale-down-delay` (the literal #770 defect) | RED | **RED** — unchanged |
| new: preview clamps `containerConcurrency` | (n/a) | **RED** — `prod="42" preview="1"` |

Red-first is honest at `8d25f40`: it compiles and fails on the fullness arm, naming each unset
sub-spec. `gofmt -l` clean, `go vet` clean, still deterministic under
`TZ=America/Santiago` / `Pacific/Kiritimati`. Failure messages are actionable — they name the
field, the file, and the decision to make. No new dead code, no `console.log` equivalent, style
still matches `build_ksvc_resources_test.go`.

## Residual issues (narrower than round 1, but two are undisclosed)

- **`preview_annotation_disposition_test.go:149` — `previewTemplateFieldDispositions` is a
  2-of-4 enumeration, which re-creates the exact #770 mechanism inside the fix for #770.**
  `servingv1.RevisionSpec` has **four** non-PodSpec knobs: `ContainerConcurrency`,
  `TimeoutSeconds`, `ResponseStartTimeoutSeconds`, `IdleTimeoutSeconds`. The table lists the
  first two. **Mutation-proved:** I made the builder render `ResponseStartTimeoutSeconds`
  (30 in production, clamped to 1 in preview) and the guard stayed **GREEN** — a preview-clamped
  template knob with no disposition, silently, which is the sentence this whole PR exists to
  make impossible. The SCOPE note is honest about the *mechanism* ("asserted separately, by
  name") but never says the table covers half of the struct, and the repo rule is "prefer
  scanning to enumerating — an enumerated list of call sites is how the second one gets missed".
  This is fixable with the technique already in this file: reflect over `RevisionSpec`'s own
  fields (skip the inline `PodSpec`), and require a disposition for any that renders non-nil.
  Judging the caveat as the lead asked: **honest about shape, not sufficient** — a scan is
  tractable here, so the limit is a hole dressed as a caveat.

- **`preview_annotation_disposition_test.go:194` — `maximalNextAppSpec()` builds a CR that
  admission REJECTS, and the layer-2 fullness rule structurally requires that.** Running
  `validation.ValidateNextAppSpec` on the fixture returns: *"warmSchedule cannot be combined with
  pinned traffic (spec.traffic.revisionName \"app-00001\") … drop the pin or the warmSchedule
  (see ADR-0030)"* (`internal/validation/validate.go:414`, the #393 HARD rejection). So the
  guard's baseline is a shape that can never exist on a cluster, and the pinned-traffic class of
  app — a legal shape — is never exercised at all. This is the direct answer to "does the
  fullness check make future optional fields impossible to add": it does not block them, but the
  API already contains one mutually-exclusive pair and fullness can only be satisfied by
  violating it, so every future exclusive pair makes the fixture more impossible. Nothing in the
  file acknowledges this. The fix also closes the next bullet: use **two fixtures** (warm-schedule
  and pinned-traffic) and union the collected keys, rather than one all-fields-set spec.

- **`preview_annotation_disposition_test.go:305` — the fullness fix inverted the round-1 blind
  spot instead of removing it: a stamp gated on a sub-spec being ABSENT is now unreachable.**
  **Mutation-proved:** `if nextApp.Spec.Observability == nil { annotations["autoscaling.knative.dev/activation-scale"] = "2" }`
  stayed **GREEN**, because layer 2 now demands every field be populated. In round 1 the minimal
  fixture covered the absent half and missed the present half; now it is the reverse. A
  default-when-unset stamp is a plausible shape (the builder already seeds `min-scale`/`max-scale`
  defaults unconditionally). Undisclosed. Two fixtures — one maximal, one minimal — closes it,
  and the harness already unions two runs.

- **`preview_annotation_disposition_test.go:65-72` (SCOPE) — the layer-2-is-shallow caveat is
  accurate, but the gap it protects is only TWO leaves wide.** **Measured:** applying the file's
  own `assertLeavesNonZero` to the whole `NextAppSpec` reports exactly two unset leaves,
  `Observability.Rum` and `Observability.Tracing` — and the SCOPE note names
  `spec.observability.tracing` as its hypothetical, which is *actually* uncovered today (my
  mutation adding an `ObservabilitySpec` field that stamps `autoscaling.knative.dev/metric`
  stayed **GREEN**). When closing a documented caveat costs two struct literals and one call to a
  helper already written in the same file, `security.md`'s "a documented expectation degrades,
  and its efficacy is unobservable until it has already failed" applies rather than the caveat.
  Lowest severity of the four only because it is disclosed in both the test header and
  `nextapp_controller.go`.

## Successive-round check

One fix did introduce a new hole: the layer-2 fullness rule (fix #2) created the absent-branch
blind spot and forced the fixture into an admission-rejected shape. Both are cured by the same
change (two fixtures instead of one maximal one), so this is one more round, not a spiral.

## Test quality

Materially stronger than round 1 — leaf-deep recursion, spec-tied PASSED, a second test for the
field-shaped knobs, and every arm I attacked on the annotation path now reds. The remaining gaps
are coverage of the *scan*, not weakened assertions: no arm was loosened to get green.

---

# Round 3 — `3e7cb77` (red) + `cb7ecc6` (green)

APPROVE

Tree verified clean first (only the untracked `.claude/impl-775-report.md`). All mutations run in
a hook-free `git archive cb7ecc6` copy, anchor-asserting script, tar-restore + re-verified green
between each.

## All four round-2 residuals are structurally fixed — I re-ran my own escapes

| Round-2 escape | R2 | R3 |
|---|---|---|
| `responseStartTimeoutSeconds` rendered + preview-clamped (the 2-of-4 enumeration) | GREEN | **RED** — names the field, tells you to disposition it |
| stamp gated on a sub-spec being ABSENT | GREEN | **RED** (control below) |
| fixture admission-rejected (warmSchedule + pinned traffic) | undetected | **RED** on drift — I re-added `warmSchedule` to `pinned-traffic` and got the real ADR-0030 rejection |
| layer-2 shallowness (`Observability.Rum` / `.Tracing` unscanned) | GREEN | **RED** — dropping `Tracing` from the fixture names all three leaves |

Plus the controls: **M8** (preview stops dropping `scale-down-delay`, the literal #770 defect) reds
naming the fixture; my round-1 nested `WarmWindow.BurstDuringWindow` knob reds as
`NextAppSpec.Scaling.WarmSchedule[].BurstDuringWindow`; preview clamping `containerConcurrency` reds.

**The minimal fixture is load-bearing, proved both ways.** The implementer's own honesty flag checks
out: with all three fixtures a `Scaling == nil`-gated stamp **REDS**; delete
`{name: "minimal", …}` from `guardFixtures()` and the same mutation goes **GREEN**. That is a
mutation proof of a fixture, which is unusual and correct.

**The cycle guard skips nothing.** I compared `typeLeafPaths` against an independent depth-capped
walk with no type-cycle guard: **52 leaves vs 52, zero dropped**, and zero "opaque" structs (types
with no exported fields, which would be silently unscanned — `resource.Quantity` would be one if it
ever appeared). `renderedTemplateFields` sees all four `RevisionSpec` fields
(`ContainerConcurrency`, `TimeoutSeconds`, `ResponseStartTimeoutSeconds`, `IdleTimeoutSeconds`).

**Red-first is honest at `3e7cb77`:** it compiles and fails on exactly the two claimed reasons — the
`maximal` fixture ADMISSION-REJECTED with the real ADR-0030 message, and
`Observability.Rum.*` / `Observability.Tracing.*` zero in every fixture.

`gofmt -l` clean, `go vet` clean, deterministic under `TZ=America/Santiago`,
`Pacific/Kiritimati`, `Australia/Lord_Howe`. The now-false caveats are deleted from both the test
header and `nextapp_controller.go`, and I checked each surviving claim in that comment against
observed behaviour — all accurate.

## The conjunction limit — judged as asked, and NOT blocking

The disclosed gap is real: a stamp gated on a conjunction none of the three shapes realises escapes.
**Mutation-proved GREEN** twice — `Traffic != nil && Observability != nil`, and
`Traffic != nil && scaleDownDelay != ""`. Both are admission-valid shapes.

In general this is intractable — full combination coverage is 2^N fixtures — so the limit itself is
acceptable. **But the current blind spot is far wider than it needs to be**, because
`pinnedTrafficSpec()` sets only `Image`, three `Scaling` fields and `Traffic`, which leaves *every*
conjunction involving `Traffic` uncovered. I tested the cheap cure rather than just asserting it:

```go
func pinnedTrafficSpec() appsv1alpha1.NextAppSpec {
    s := maximalWarmScheduleSpec()
    scaling := *s.Scaling
    scaling.WarmSchedule = nil          // the ONLY #393 exclusion
    s.Scaling = &scaling
    s.Traffic = &appsv1alpha1.TrafficSpec{RevisionName: "app-00001", CanaryPercent: 10}
    return s
}
```

With that six-line change the suite stays **green**, `assertFixturesAreAdmissible` still **passes**
(so the shape is legal), and my `Traffic && Observability` conjunction mutation now **REDS**. The
residual blind spot shrinks to conjunctions of `warmSchedule` × pinned traffic — which admission
forbids anyway. **Recommended, not blocking.**

Second, smaller: the conjunction limit is documented only in `.claude/impl-775-report.md` (§ "Fixture
leaf coverage proves a branch's GATE is exercised, not that every combination of gates is"), which is
**untracked and will not survive into the repo**. Nothing in the test header or the controller
comment mentions it. The in-file text is not false — it claims leaf coverage and delivers leaf
coverage — but one sentence in the SCOPE block would stop the next author reading union-of-leaves as
combination coverage. **Recommended, not blocking.**

## Why APPROVE rather than a fourth round

Every defect class this guard exists to stop is now mechanically caught: a new `ScalingSpec` knob at
any depth, a new annotation from any sub-spec, a newly-rendered `RevisionSpec` field, an
absent-branch stamp, a fixture that drifts into an inadmissible shape, a stale table entry, and the
literal #770 regression. Eleven mutations red; the one green class is inherently combinatorial,
disclosed, and its cheap 80% cure is a follow-up rather than a correctness hole. Neither
recommendation changes what the guard catches today.

## Test quality

The strongest of the three rounds: every list — fixtures' leaf coverage, annotation keys, template
fields — is now derived from a type or from the builder's output rather than hand-maintained, the
fixtures are themselves gated by real admission validation, and a fixture that stops being
load-bearing is provable by deletion. No assertion was loosened across the three rounds to get green.

---

# Delta — `08881d4`

APPROVE stands. Both round-3 recommendations landed as specified and I re-verified independently on
the new commit: `pinnedTrafficSpec()` is now maximal-minus-the-#393-exclusion with the residual
blind spot named in-comment, the union-of-leaves-is-not-combination-coverage LIMIT is in the test
header's HOW IT SCANS block with an instruction for conjunction-gated authors, and my
`Traffic && Observability` conjunction mutation — GREEN in round 3 — now **REDS**; M8 (#770) still
reds; suite green after restore; `gofmt -l` and `go vet` clean. No new findings.
