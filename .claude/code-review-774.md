# Code review — PR #774 (fix/preview-scale-down-delay, 19b90b6)

## Verdict: ISSUES_FOUND

Behaviour is correct and provably tested. Two documentation-accuracy defects — both of the exact
class this PR set out to fix — plus one non-blocking structural observation.

## Issues

1. `packages/kn-next-operator/internal/controller/nextapp_controller.go:795-796` and `:809-810` —
   the TargetBurstCapacity (#411) and panic-pair (#413) comments still assert the preview override
   "**rewrites only** max-scale/min-scale/retention-period". After this PR that enumeration is FALSE
   — the override also `delete`s `scale-down-delay` (:875). The conclusions those comments draw
   (TBC/panic survive) remain true, so this is not a behaviour bug, but the PR's own new comment
   says an enumerated disposition list is how the second knob got missed, and then leaves two
   contradicting enumerations ~40 and ~65 lines above the list it tells readers to consult. The PR
   body claims "a stale comment asserting the opposite was fixed" — one of three instances was.
   Fix: replace both parentheticals with a pointer to the disposition list in the preview block.

2. `docs/adr/0045-scale-down-delay.md:37` (unchanged by this PR) — Decision 1 states unconditionally
   "Set ⇒ the operator stamps `autoscaling.knative.dev/scale-down-delay` on the revision template."
   The code now narrows that to *non-preview* revisions. The decision record and the code disagree,
   and the mechanical escalation trigger (`git diff` touching `docs/adr/`) could not fire precisely
   because the ADR was not edited — the "would require amending an ADR" case. A one-line amendment /
   Consequences bullet on ADR-0045 is the fix; whether that also warrants the design gate is the
   lead's call, but the ADR should not ship stale.

3. Non-blocking — `nextapp_controller.go:846-870`: the "any NEW ScalingSpec knob MUST be explicitly
   dispositioned here, with an envtest" lesson is a documented expectation, not a gate. By this
   repo's own standard (`workflow.md`: "prefer scanning to enumerating"; "a documented expectation
   degrades and its efficacy is unobservable until it has already failed") the third leak is as
   likely as the second was. A scanning guard — e.g. a test that collects every
   `autoscaling.knative.dev/*` key `buildDesiredKsvc` can stamp and fails on any key with no
   preview-mode assertion — would convert it. Worth a follow-up issue, not a blocker on this PR.

## Verified clean (attacked, held)

- **Order of operations:** the stamp is at :832, the `delete` at :875, and `annotations` is assigned
  to the template exactly once at :939 (grep confirms a single `Template.ObjectMeta.Annotations`
  write site in the whole operator and no `annotations[...]` mutation after :875). Nothing can
  re-stamp it. Because the map is assigned wholesale, an existing preview ksvc carrying the
  annotation loses it on the next reconcile — the upgrade path works too.
- **Preview branch:** `Spec.Preview != nil && Spec.Preview.Enabled` at :842 is the ONLY preview
  branch in the operator (grep), and it is the same condition the forced annotations use. The CLI's
  preview path (`cli/preview.ts` → `cr-builder.ts:296`) emits `preview:{enabled:true,...}`, so there
  is no preview shape that misses this branch.
- **Disposition list accuracy (item 3 of the brief):** verified against code AND tests —
  target-burst-capacity and the panic pair are not touched in the preview block, and both already
  have preview-coexistence envtests (`reconcile_output_test.go:1010`, ~:1040). FORCED/DROPPED rows
  match :872-875. The list is accurate.
- **Test quality:** asserts the reconcile OUTPUT (`k8sClient.Get` of the emitted ksvc after a real
  `Reconcile`), not an intermediate map, and asserts BOTH halves from ONE `ScalingSpec` — preview
  lacks the key, production keeps `"1h"` — so a blanket removal reds it. Mutation-proved
  independently: deleting only `delete(annotations, ...)` (anchor asserted to occur exactly once)
  fails exactly this spec and nothing else; restored with no residue.
- **CRD regeneration (item 4):** ran `controller-gen` at 19b90b6 in a throwaway detached worktree —
  `git status` empty, so the yaml drift is exactly the three godoc description lines and nothing
  else. Only one CRD copy exists in the repo. Worktree removed and pruned.
- `go test ./internal/controller/...` green at the PR commit (envtest 1.36.2); `go vet` and `gofmt`
  clean.
- Security: no endpoint, secret, image tag, or shell surface touched. `docs/operator/crd-nextapp.md`
  addition is accurate. Deferring the docs-site clause to #773 is disclosed in the PR body.

## Test quality (one line)
Meaningful and adversarial: reconcile-output assertions, both halves from a shared spec, and it
mutation-proves red on the exact leak — not a tautology and not over-mocked.
