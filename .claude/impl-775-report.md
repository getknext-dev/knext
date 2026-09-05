DONE

Branch: `test/preview-annotation-disposition-guard` (from `origin/main` @ ef1ebce). Not pushed, no PR.

Commits:
- `771631f` test(operator): RED — scanning guard for preview autoscaling-annotation dispositions (#775)
- `343970b` test(operator): GREEN — record every autoscaling knob's preview disposition (#775)

## Approach

A scanning guard, `packages/kn-next-operator/internal/controller/preview_annotation_disposition_test.go`,
that scans in two layers:

1. **Fixture scan (reflection).** `maximalScalingSpec()` sets every `ScalingSpec` field to a non-zero
   value; `assertFixtureCoversEveryScalingField` walks the struct by reflection and fails on any field
   left at its zero value. A new `ScalingSpec` field cannot be added without the fixture noticing.
2. **Key scan (builder output).** `buildDesiredKsvc` is run twice over that maximal spec — production
   and preview — and the `autoscaling.knative.dev/*` keys are collected from
   `ksvc.Spec.Template.ObjectMeta.Annotations`, never from a hand-written list. Every key in the union
   must have an entry in the in-test `previewDispositions` table (FORCED / DROPPED / PASSED); a key
   with no entry fails with a message telling the author to *decide* the disposition and record it in
   both places. A stale table entry for a key the builder no longer emits also fails.

Each declared fate is asserted **observably**, so a fate that is declared but not exercised also reds:
FORCED must differ from the production value the fixture produced (min-scale prod is `5` from an
active warm window vs forced `0`; max-scale `7` vs `1`), DROPPED must be present in production and
absent in preview, PASSED must be present and equal in both.

It is a plain `go test` (no envtest), like `build_ksvc_resources_test.go`, with `Clock` pinned to
2026-01-01T12:00:00Z so the warm-schedule floor is deterministic. The issue said "in the envtest
suite"; a plain test is strictly stronger operationally here — it runs without the API-server
binaries and exercises the same builder.

## TDD, red first

Commit `771631f` has an **empty** disposition table. `go test -run TestPreviewDisposition` failed
naming all seven stamped keys, e.g.:

```
buildDesiredKsvc stamps "autoscaling.knative.dev/scale-down-delay" but it has NO preview disposition.
DECIDE what a preview revision should do with it — FORCE it ... DROP it ... or deliberately PASS ...
```
(same for max-scale, min-scale, panic-window-percentage, panic-threshold-percentage,
scale-to-zero-pod-retention-period, target-burst-capacity). Commit `343970b` fills the table → PASS.

## Mutation proofs (all with anchor-asserting Python, `assert count == 1` or abort; restored via `git checkout --`)

(a) **New stamped key, no disposition** — inserted
`annotations["autoscaling.knative.dev/fake-new-knob"] = "mutation-probe"` after the min-scale stamp in
`nextapp_controller.go` (anchor asserted unique; `grep -c` confirmed 1 occurrence applied):
```
--- FAIL: TestPreviewDispositionCoversEveryStampedAutoscalingAnnotation
  buildDesiredKsvc stamps "autoscaling.knative.dev/fake-new-knob" but it has NO preview disposition. ...
```
Restored (`grep -c fake-new-knob` → 0), re-ran → `ok`.

(b) **Existing disposition entry removed** — deleted the `scale-down-delay` entry from
`previewDispositions` (anchor asserted unique):
```
--- FAIL: TestPreviewDispositionCoversEveryStampedAutoscalingAnnotation
  buildDesiredKsvc stamps "autoscaling.knative.dev/scale-down-delay" but it has NO preview disposition. ...
```
Restored, re-ran → `ok`.

(c) **Extra, beyond the AC** — added `FakeNewKnob int32` to `ScalingSpec` to prove the reflection
layer, not just the key layer:
```
ScalingSpec field "FakeNewKnob" is ZERO in maximalScalingSpec(): the field was added (or renamed)
without extending the fixture, ...
```
Restored, re-ran → `ok`. Working tree clean after all three (`git status --short` empty).

## AC5 — pointer comment

`internal/controller/nextapp_controller.go`, in the preview block right after the `LESSON (#770)`
paragraph, now carries a `GATE (#775)` note naming
`internal/controller/preview_annotation_disposition_test.go` and its `previewDispositions` table.

## Verification

- `KUBEBUILDER_ASSETS=<repo>/packages/kn-next-operator/bin/k8s/1.35.0-darwin-arm64 go test ./... -count=1`
  → all 7 packages `ok` (api, cmd, internal/controller 36.7s, install, validation, webhook, test/utils).
  (`make setup-envtest` was needed first; without `KUBEBUILDER_ASSETS` the three envtest suites fail in
  `BeforeSuite` on `main` too — that is environment, not this change.)
- `go vet ./...` clean; `gofmt -l ./internal ./api ./cmd` empty.

## Deferred / honest notes

- No kind/OKE run: this is a test-only change plus a comment; nothing in the reconciled output changed.
- The guard covers `autoscaling.knative.dev/*` only, which is the disposition list's scope. Other
  preview-relevant surfaces (labels, `prometheus.io/*`, container fields such as
  `containerConcurrency`) are out of scope for #775 and remain enumerated elsewhere.


---

# Review round 2 — fixes for the four findings in `.claude/code-review-788.md`

Tree was verified clean before starting (`git status --short` showed only the untracked report;
`git diff` empty) — no reviewer mutation residue survived.

Commits (on `test/preview-annotation-disposition-guard`):
- `8d25f40` RED — strengthened scans landed against the OLD minimal fixture, so the hole shows as a failure
- `a7c06a8` GREEN — fixture extended, spec-tie closed, template-field knobs dispositioned, controller comment corrected

## Finding 1 (HIGH) — shallow reflection scan

`assertLeavesNonZero` now recurses through structs, pointers/interfaces, slices/arrays and maps and
requires every LEAF to be non-zero, replacing the top-level-only `IsZero` check. Path-aware messages
name the exact leaf (e.g. `ScalingSpec.WarmSchedule[0].BurstDuringWindow`).

**Red-proved with the reviewer's exact mutation** (M1): added `WarmWindow.BurstDuringWindow` and
stamped `autoscaling.knative.dev/window-burst` from it — previously GREEN, now:
```
ScalingSpec.WarmSchedule[0].BurstDuringWindow is zero in the fixture: a scaling knob was added ...
```
And the second stage (M1b): with the fixture extended (`BurstDuringWindow: 4`) — i.e. an author who
fixes layer 1 only — the disposition arm fires:
```
buildDesiredKsvc stamps "autoscaling.knative.dev/window-burst" but it has NO preview disposition. ...
```

## Finding 2 (MED) — one NextApp shape

`maximalNextAppSpec()` now populates EVERY `NextAppSpec` field (Resources, Storage, Cache,
Revalidation, Secrets, Database, Env, Observability, HealthCheckPath, Preview, Runtime,
TimeoutSeconds, Security, Traffic, BuildID), and `assertFixtureCoversEveryNextAppSubSpec` makes that
structural: a new top-level sub-spec left unpopulated reds the guard. The RED commit `8d25f40` is
exactly this hole made visible — 14 fields reported unexercised.

**Red-proved with the reviewer's probe** (M2): stamping `autoscaling.knative.dev/metric` inside the
`spec.observability.enabled` branch — previously GREEN, now:
```
buildDesiredKsvc stamps "autoscaling.knative.dev/metric" but it has NO preview disposition. ...
```

Both were done: the fixture was extended AND the `nextapp_controller.go` comment was narrowed. The
GATE note now states the real scope — leaf-deep under `ScalingSpec` only, top-level fullness for the
other sub-specs — and explicitly says to deepen the scan if a knob ever nests inside one of them.

## Finding 3 (MED) — `containerConcurrency` is field-shaped

Read the preview block: it touches annotations only, so a preview inherits the user's
`containerConcurrency` unchanged — the real fate is **PASSED**. Added to the prose list in
`nextapp_controller.go` with an explicit "stamped as a ksvc TEMPLATE FIELD, not an annotation, which
is why it was missing from this list" note, and asserted in the test by a second table,
`previewTemplateFieldDispositions`, checked by `TestPreviewDispositionCoversScalingTemplateFields`
(prod vs preview vs the spec value).

`timeoutSeconds`: checked, and it is **not** an autoscaling knob — a per-request duration cap. It is
included anyway (PASSED, `fromSpec: "111"`), because it is the other template field a preview could
plausibly clamp; recording the non-decision keeps the blind spot visible rather than leaving the next
author to rediscover it.

**Red-proved** (M4): making preview clamp `cc = 1` ⇒
```
spec.template.spec.containerConcurrency: declared PASSED THROUGH (...) but preview changed it: prod="42" preview="1"
```

## Finding 4 (LOW) — PASSED was one-half

`previewFate` gained `fromSpec`, and the `dispPassed` arm now asserts `prodVal == fate.fromSpec`
before comparing prod to preview.

**Red-proved** (M3) with the reviewer's mutation — hardcoding the production stamp to `"0"` instead
of `*spec.scaling.targetBurstCapacity`, previously GREEN:
```
autoscaling.knative.dev/target-burst-capacity: declared PASSED THROUGH from the user's spec value "150",
but production rendered "0" — the value is not coming from the spec at all
```

## All mutation proofs re-run against the strengthened guard

Every one used an anchor-asserting Python script (`assert s.count(anchor) == 1` or abort — no bare
`perl`), restored with `git checkout --`, and re-verified green after each.

| # | Mutation | Result |
|---|---|---|
| M1 | new `WarmWindow.BurstDuringWindow` knob + stamp, fixture untouched | RED (leaf scan) — was GREEN before this round |
| M1b | same, fixture extended (author fixes layer 1 only) | RED (disposition arm) |
| M2 | `autoscaling.knative.dev/metric` stamped from the observability branch | RED (disposition arm) — was GREEN before |
| M3 | production `target-burst-capacity` hardcoded to `"0"` | RED (spec-tie) — was GREEN before |
| M4 | preview clamps `containerConcurrency` to 1 | RED (template-field PASSED arm) — no assertion existed before |
| M5 | new flat stamped key `autoscaling.knative.dev/fake-new-knob` | RED (disposition arm) |
| M6 | `scale-down-delay` entry deleted from the table | RED (disposition arm) |
| M7 | new flat `ScalingSpec.FakeNewKnob` field | RED (leaf scan) |
| M8 | preview stops `delete(scale-down-delay)` — the literal #770 regression | RED (DROPPED arm) |

M4's first attempt failed to compile (`cc` is declared after the preview block); the anchor assert
did its job and the retry mutated at the `cc` assignment instead. Recorded because a build failure is
not a guard failure and should not be read as one.

After the last restore: `git status --short` shows only the untracked report file, `git diff` empty.

## Verification

- `KUBEBUILDER_ASSETS=<pkg>/bin/k8s/1.35.0-darwin-arm64 go test ./... -count=1` → all 7 packages `ok`
- `go vet ./...` clean, `gofmt -l ./internal ./api ./cmd` empty

## Deferred / honest

- Layer 2 is top-level fullness, not leaf-deep, for the non-`ScalingSpec` sub-specs. Deepening it
  would force every leaf of Database/Storage/Observability/... into the fixture, which risks
  fabricating invalid combinations for branches that host no autoscaling knob today. The limit is
  stated in both the test's SCOPE note and the controller comment rather than papered over.
- Template-field coverage is a named two-entry table, not a scan: there is no prefix to filter on for
  RevisionSpec fields, so a future field-shaped knob is caught by review plus that table's stale-entry
  arm, not structurally. Stated rather than claimed otherwise.


---

# Review round 3 — fixes for the four residual issues

Tree verified clean before starting (`git status --short` = only the untracked report; `git diff`
empty).

Commits:
- `3e7cb77` RED — round-3 machinery against the OLD single all-fields fixture
- `cb7ecc6` GREEN — three admission-valid fixtures, RevisionSpec scanned by reflection

## 1 (HIGH) — previewTemplateFieldDispositions was 2-of-4

`renderedTemplateFields` now REFLECTS over `servingv1.RevisionSpec`'s own fields, skipping the
anonymous inline `PodSpec`, and returns every field the builder actually rendered (pointer nil =
not rendered). Any rendered field without a table entry fails. The table still holds two entries
because only two are rendered today — but the LIST is now derived from the type, not typed by hand.

**Red-proved with the reviewer's exact mutation:** rendering `ResponseStartTimeoutSeconds` (30 prod,
clamped to 1 in preview), previously GREEN:
```
"spec.template.spec.responseStartTimeoutSeconds" is a rendered ksvc template field with NO preview disposition. ...
```

## 2 (MED) — the fixture was admission-REJECTED

Split into three admission-valid fixtures whose collected keys are UNIONED:
`maximal-warm-schedule` (everything except Traffic), `pinned-traffic` (the other side of the #393
exclusivity; it is what covers the Traffic leaves) and `minimal`. `assertFixturesAreAdmissible` runs
`validation.ValidateNextAppSpec` over every fixture in both production and preview shape, so the
constraint is structural rather than remembered.

That assertion is exactly what the RED commit `3e7cb77` shows failing:
```
fixture "maximal" (preview=false) is ADMISSION-REJECTED: warmSchedule cannot be combined with pinned
traffic (spec.traffic.revisionName "app-00001") ... (see ADR-0030)
```

## 3 (MED) — the absent-branch blind spot

The `minimal` fixture (Image only) restores the absent half, and the harness already unions across
fixtures.

**Red-proved with the reviewer's mutation** (`activation-scale` stamped when `Observability == nil`):
RED. Worth recording honestly: that particular mutation reds even WITHOUT the minimal fixture,
because `pinned-traffic` also leaves Observability nil — so it does not prove the minimal fixture is
load-bearing. A stamp gated on `Scaling == nil` does, since both other fixtures set Scaling, and
that is the control I ran:

| Configuration | Result |
|---|---|
| `Scaling == nil` stamp + all three fixtures | **RED** (undeclared key) |
| same stamp, `minimal` fixture removed | **GREEN** — the fixture is what catches it |

## 4 (LOW) — layer-2 shallowness

Replaced by a union leaf scan over the WHOLE `NextAppSpec`: `typeLeafPaths` enumerates every leaf of
the type (structs, pointers, slice/map elements collapsed to `[]`, cycle-guarded) and
`valueLeafPaths` records the non-zero leaves of each fixture; every type leaf must be covered by
some fixture. The `Observability.Rum` / `Observability.Tracing` leaves are now populated, and the
caveat that described the gap is DELETED from both the test header and `nextapp_controller.go` —
the controller comment now describes the real mechanism (several admission-valid shapes, union leaf
coverage, annotations by prefix + RevisionSpec by reflection) and the prose list notes that the two
unrendered RevisionSpec knobs are guarded by that reflection.

The five zero leaves are the other half of the RED commit:
```
NextAppSpec.Observability.Rum.Enabled is zero in EVERY fixture ... (+ Rum.SampleRate, Tracing.Enabled,
Tracing.Endpoint, Tracing.SampleRate)
```

## All mutations re-run against the round-3 guard

Anchor-asserting Python (`assert count == 1` or abort), `git checkout --` restore, green re-verified
after each.

| # | Mutation | Result |
|---|---|---|
| N1 | preview-clamped `ResponseStartTimeoutSeconds` rendered | RED (template-field scan) — was GREEN |
| N2 | `activation-scale` stamped when `Observability == nil` | RED |
| N2b | `activation-scale` stamped when `Scaling == nil` (only `minimal` reaches it) | RED; GREEN with `minimal` removed — the control |
| N3 | new `ObservabilitySpec.MetricTarget` field stamping `autoscaling.knative.dev/metric` | RED (leaf scan) — was GREEN |
| M1 | nested `WarmWindow.BurstDuringWindow` knob + stamp | RED (leaf scan, path `NextAppSpec.Scaling.WarmSchedule[].BurstDuringWindow`) |
| M2 | `autoscaling.knative.dev/metric` from the observability branch | RED |
| M3 | production `target-burst-capacity` hardcoded `"0"` | RED (spec-tie: "NO fixture renders that value") |
| M4 | preview clamps `containerConcurrency` | RED |
| M5 | new flat stamped key | RED |
| M6 | `scale-down-delay` entry deleted from the table | RED |
| M7 | new flat `ScalingSpec` field | RED |
| M8 | preview stops dropping the delay (literal #770) | RED |

One anchor assert fired for real: the first `Observability == nil` script matched two occurrences and
ABORTED rather than mutating — the run that followed was the unmutated tree, and it would have read
as "guard green" if the assert had not printed the abort. Recorded because that is precisely the
failure mode the anchor rule exists for.

## Verification

- `KUBEBUILDER_ASSETS=... go test ./... -count=1` → all 7 packages `ok`
- `go vet ./...` clean, `gofmt -l ./internal ./api ./cmd` empty
- tree clean after the last restore (only the untracked report file)

## Honest limits that remain

- The disposition FATES are still judgement recorded in a table; the guard proves a fate is declared,
  consistent across fixtures and observable — not that the fate is the right product decision.
- Fixture leaf coverage proves a branch's GATE is exercised, not that every combination of gates is.
  A stamp gated on a conjunction no fixture happens to realise (e.g. `Storage != nil && Traffic == nil`)
  could still escape; the three shapes cover the single-gate and all-absent cases.
