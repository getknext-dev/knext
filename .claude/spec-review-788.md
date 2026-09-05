APPROVE

# Spec review — PR #788 vs issue #775

Reviewer: independent spec reviewer (read-only). All verification re-run by me in an **isolated
detached worktree** (`/tmp/spec788` at 343970b, removed afterwards), not on the implementer's
report and not in the shared worktree — see the concurrency note at the bottom for why that
mattered.

## Acceptance criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Guard enumerates stamped annotation keys by **SCANNING**, not a hand-maintained list | **met** | Keys come from the builder's own output: `stampedAutoscalingAnnotations()` runs `r.buildDesiredKsvc(app, ksvc)` and collects `ksvc.Spec.Template.ObjectMeta.Annotations` filtered on the `autoscaling.knative.dev/` prefix (`preview_annotation_disposition_test.go:172-215`), for **both** a production and a preview run, and asserts over the **union** (`:229-241`). Layer 1 is reflection over the CRD type: `assertFixtureCoversEveryScalingField` walks `reflect.TypeOf(ScalingSpec)` and fails on any zero-valued field (`:149-168`). Nothing enumerates keys from a literal list. |
| 2a | Mutation-proved: new stamped key with no preview assertion ⇒ guard reds | **met** | I added `annotations["autoscaling.knative.dev/initial-scale"] = "3"` next to the min-scale stamp (`nextapp_controller.go:787`) with an anchor-asserting script (exactly-one-match or abort). Result: `FAIL … buildDesiredKsvc stamps "autoscaling.knative.dev/initial-scale" but it has NO preview disposition.` Restored, green again. |
| 2b | Mutation-proved: remove an existing knob's preview assertion ⇒ guard reds | **met**, proved in **four** forms | (i) deleted `delete(annotations, ".../scale-down-delay")` from the preview block — the literal #770 leak — ⇒ `FAIL … declared DROPPED … but preview stamped it as "5m"`. (ii) removed the `scale-down-delay` table entry ⇒ FAIL (no disposition) **plus** the stale-entry check firing. (iii) removed the `target-burst-capacity` entry ⇒ same both-direction failure. (iv) drifted the forced values (`max-scale "1"→"2"`; deleted the forced `min-scale = "0"`) ⇒ `FAIL … declared FORCED to "1" … but preview stamped "2"` / `… but preview stamped "5"` (the warm-schedule floor leaking into a preview — exactly the class this guards). Each restored to green. |
| 2c | (extra) new `ScalingSpec` field ⇒ reflection layer reds | **met** | Added `StableWindowMut string` to `ScalingSpec` ⇒ `FAIL … ScalingSpec field "StableWindowMut" is ZERO in maximalScalingSpec()`. So a knob cannot reach the builder unexercised. |
| 3 | The disposition-list comment points at the guard | **met** | `nextapp_controller.go:872-878` — the `GATE (#775)` paragraph is appended to the existing `LESSON (#770)` disposition list, **inside the preview block, immediately above the forced stamps**, and names the file (`internal/controller/preview_annotation_disposition_test.go`) and the symbol (`previewDispositions`). Placement is where a knob author lands: each production stamp site already says "recorded in the override's single disposition list below" (`:795-797`, `:807-809`, `:828-831`). |

## Adversarial probes — is a hand-maintained list load-bearing anyway?

- The in-test `previewDispositions` table **is** hand-maintained (allowed by the issue), but it
  **cannot go stale silently** in either direction: an unknown key fails (`:243-255`), a **stale
  entry for a key the builder no longer emits** fails (`:260-267`), and each declared fate is
  asserted *observably* against real builder output — FORCED must differ from the production value
  (so "forcing" that proves nothing fails), DROPPED must be present in prod and absent in preview,
  PASSED must be equal in both (`assertObservable`, `:271-311`). Mutations (ii)–(iv) above confirm.
- `maximalScalingSpec()` is hand-maintained but guarded by reflection (2c).
- Vacuity guard present: zero collected keys is a hard `t.Fatal` (`:225-228`). Determinism: pinned
  `Clock` inside the warm window (`:183-188`), so the min-scale floor is not wall-clock dependent.

## Residual gaps (non-blocking, none contradict the issue as written)

1. Reflection is **one level deep** — a field added to `WarmWindow` (nested) is not covered. Low
   risk (WarmWindow only feeds min-scale, which is dispositioned).
2. The scan is bounded by the issue's own proposed method: it exercises **`ScalingSpec`** against
   the builder. An autoscaling annotation stamped conditionally on a **non-ScalingSpec** field
   (a future `spec.autoscalingClass`-style knob) would not be emitted by the fixture and would
   escape. Unconditional stamps are still caught.
3. Only `buildDesiredKsvc` is observed, and only the `autoscaling.knative.dev/` prefix. I verified
   by grep that **today** every `autoscaling.knative.dev/*` write in non-test operator code lives in
   `buildDesiredKsvc` (`nextapp_controller.go:767,768,782,787,799,812,815,832,879-882`), so there is
   no current hole; a cheap source-scan asserting that stays true would close the residual.

## Other checks

- **CI lane:** runs in job `operator-test` — *"Operator Go tests (envtest + install bundle)"*
  (`.github/workflows/ci.yml:663-716`), whose final step is `make test`, i.e.
  `go test $(go list ./... | grep -v /e2e)` (`packages/kn-next-operator/Makefile:91-92`). The guard
  is a plain `go test` in `package controller` with no build tag, so it is in that set — and it
  needs no envtest assets (it passed here with none). `gofmt -l` clean, `go vet ./internal/controller`
  clean, and every non-envtest test in the package passes at HEAD.
- **RED commit 771631f fails for the claimed reason:** with an empty `previewDispositions`, it fails
  with exactly **seven** "stamps X but it has NO preview disposition" errors — max-scale, min-scale,
  panic-threshold-percentage, panic-window-percentage, scale-down-delay,
  scale-to-zero-pod-retention-period, target-burst-capacity — i.e. the RED came from the *scan*
  finding real keys, not from a compile error or a fabricated assertion.
- **"Closes #775" is honest.** All three acceptance criteria are met by tested behaviour; merging
  resolves the issue. No scope drift: the diff is +319 test lines and a +7-line comment, nothing
  else — no behaviour change to the operator (`git diff --stat origin/main...HEAD`).
- **PR body claims re-checked against the tree:** "TDD red-first", "mutation-proved three ways",
  "plain `go test`, deterministic (pinned Clock)", "stale entries also fail" — all verified true.

## Housekeeping note for the lead (not a PR defect)

During this review the shared implementer worktree
(`.claude/worktrees/agent-a12a0c8cef7b2bbdd`) transiently carried **uncommitted mutation residue** —
`api/v1alpha1/nextapp_types.go` with a `// MUTATION: a brand-new knob` `StableWindow` field — which
appeared and was then restored while I was running. It is the known mutation-residue hazard, and it
briefly polluted one of my runs (which is why I redid everything in an isolated worktree). It is
**not** in the branch: `git log -S StableWindow origin/main..HEAD` and `git grep StableWindow HEAD`
are both empty, and the worktree is clean now (`?? .claude/impl-775-report.md` only). Worth
confirming the implementer agent is stopped before merge so no residue lands in a follow-up commit.

**Verdict: APPROVE.**
