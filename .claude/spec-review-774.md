# Spec review — PR #774 vs issue #770 (+ ADR-0045)

Reviewer: spec-review agent (read-only). Branch `fix/preview-scale-down-delay` @ `19b90b6`.
Envtest run by the reviewer, not taken on the PR's word.

## Criterion checklist

| # | Criterion (issue #770) | Verdict | Evidence |
|---|---|---|---|
| 1 | Envtest: `scaleDownDelay: 1h` ⇒ PREVIEW ksvc without the annotation, PRODUCTION ksvc keeps `1h` | **met** | `internal/controller/reconcile_output_test.go:1069-1102` — `It("DROPS scale-down-delay under the preview override, while the same spec keeps it in production (#770)")`. Both halves asserted from ONE `scaling()` spec: `Expect(previewAnnotations).NotTo(HaveKey(".../scale-down-delay"))` (:1095) **and** `Expect(prodKsvc.Spec.Template.Annotations).To(HaveKeyWithValue(".../scale-down-delay","1h"))` (:1099). Ran locally: `go test ./internal/controller/...` → `ok` (105 specs). |
| 1b | Mutation-proved: removing the clamp reds it | **met — reproduced, not assumed** | Removed **only** `delete(annotations, "autoscaling.knative.dev/scale-down-delay")` (`nextapp_controller.go:874`), anchor asserted to occur exactly once: **104 Passed / 1 Failed**, the failure being this spec at `reconcile_output_test.go:1095` with the intended message. Matches the PR's claimed 0/1/104. Second, stronger mutation (move the `delete` OUT of the preview branch = drop everywhere): **102 Passed / 3 Failed** — the prod half of this spec plus the two #762 stamping specs red, so an over-broad "fix" cannot pass either. File restored from backup; `git status --porcelain` clean, **no residue**. |
| 2 | Override block's comment enumerates the annotation among the ones it forces | **met** | `nextapp_controller.go:846-870`: complete disposition list — `FORCED max-scale=1 / min-scale=0 / retention=30s`, `DROPPED scale-down-delay (#770)`, `PASSED target-burst-capacity (#411) + panic-window/threshold (#413)`. The PASSED row is accurate and independently guarded (existing spec at `reconcile_output_test.go:~1050`, "panic-threshold must coexist with the preview scaling override"). |
| 2b | "second-knob" lesson recorded for the next knob's author | **met** | `nextapp_controller.go:865-870`: "scale-down-delay is the SECOND scaling knob to leak silently through this list — enumeration is exactly how the second one gets missed. Any NEW ScalingSpec knob … MUST be explicitly dispositioned … with an envtest asserting it." Also fixes the previously-false claim at :828-830 ("a stamped delay survives it"). |
| 3 | Issue proposed "clamp (or drop)" — PR chose drop | **met, and the better of the two** | Issue text explicitly permits drop; its intent (previews cheap, production keeps the user's value) is satisfied: the `delete` lives strictly inside `if nextApp.Spec.Preview != nil && …Enabled` (:842), proved by the over-broad mutation above. Drop = the ADR-0045 §1 unset posture (annotation absent ⇒ Knative cluster default applies unmanaged) = previews' exact pre-#762 behaviour; a clamp would reintroduce duration parsing at the use site, which ADR-0040 / #435 / #455 forbid. Rationale recorded in-code (:857-864), not only in the PR body. |
| 4 | Godoc / docs note ("previews ignore this") | **met** (this was in "Proposed", not an AC checkbox) | `api/v1alpha1/nextapp_types.go:460-462`; regenerated CRD `config/crd/bases/apps.kn-next.dev_nextapps.yaml:431-433` (drift = exactly those 3 description lines, no incidental regeneration); operator docs `docs/operator/crd-nextapp.md:130-133`. |
| 5 | Deferral of the user-facing docs-site clause pending #773 | **sound; leaves no criterion unmet** | Verified `gh issue view 773` → **OPEN**, so the docs-site `scaleDownDelay` section genuinely does not exist on `main`; adding a "previews don't keep pods warm" clause would introduce a caveat for a field the page never documents. No #770 acceptance criterion mentions the docs site, and the operator-facing doc clause DID land here. |
| 6 | "Closes #770" honest | **yes** | Merging this makes preview ksvcs annotation-free while production keeps the value, with a red-on-removal envtest — the whole of the issue. No scope drift: diff is +84/−5 across controller, its test, godoc, generated CRD, operator doc. Nothing unrelated. |

## Verdict: **APPROVE**

All acceptance criteria are met by tested behaviour, and both the drop-scope and the
mutation-proof claims were independently reproduced.

### One non-blocking nit (worth fixing in this PR — it is the same defect class the PR itself fixed)

`nextapp_controller.go:793-797` (targetBurstCapacity, #411) and `:806-810` (panic pair, #413) still
say the preview override *"rewrites **only** max-scale/min-scale/retention-period"*. As of this PR
that sentence is false — the override also `delete`s scale-down-delay. Their conclusions ("a stamped
TBC / panic annotation always survives it") remain correct, so there is no behavioural risk, but
these are two more enumerated lists of the override's contents, now stale — precisely the
enumeration hazard criterion 2 exists to kill, and precisely the stale sentence this PR removed for
scale-down-delay at :828-830. Cheapest durable fix: replace "rewrites only …" in both with a pointer
to the single disposition list at :846-870, so there is ONE enumeration in the file rather than three.
