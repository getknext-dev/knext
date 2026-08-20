# Issue #770 — preview override drops `scale-down-delay`

- **Worktree:** `/Users/banna/alpheya/pocs/knext/.claude/worktrees/agent-a8dfbc78a5d33ea70`
- **Branch:** `fix/preview-scale-down-delay` (from `origin/main` @ `a22fb4a`)
- **Commit:** `19b90b65b38756cb1fac200f5e47caaa29e9a3d0` — not pushed.

## Approach

Preview mode now **drops** `autoscaling.knative.dev/scale-down-delay` rather than clamping it
(lead's decision, recorded verbatim in the code comment): previews predate the field, so dropping
restores their exact prior behaviour — the cluster default applies unmanaged, the same posture the
field's unset case uses — and the forced 30s pod-retention already bounds preview idle cost. No ADR
written: ADR-0045 already owns the field, and this is its preview disposition, not a new decision
class.

## Files changed

- `packages/kn-next-operator/internal/controller/reconcile_output_test.go` — new envtest (test first).
- `packages/kn-next-operator/internal/controller/nextapp_controller.go` — the fix + rewritten
  preview-override comment (complete forced/dropped/passed-through disposition list + the #770
  lesson that any new `ScalingSpec` knob must be explicitly dispositioned there), and a corrected
  cross-reference in the `ScaleDownDelay` stamping comment (it previously *claimed* the delay
  survives the preview override).
- `packages/kn-next-operator/api/v1alpha1/nextapp_types.go` — godoc sentence on `ScaleDownDelay`.
- `packages/kn-next-operator/config/crd/bases/apps.kn-next.dev_nextapps.yaml` — regenerated.
- `docs/operator/crd-nextapp.md` — "Previews ignore this field" clause.

## Test: failing first, then passing

New spec (in the existing `Preview environment (#91)` context, alongside the TBC/panic
preview-coexistence specs):
`DROPS scale-down-delay under the preview override, while the same spec keeps it in production (#770)`.
It builds **one** `ScalingSpec{MaxScale: 10, ScaleDownDelay: "1h"}` and reconciles it twice —
preview and non-preview — so a fix that dropped the annotation everywhere would red it too.

Before the fix (`go test ./internal/controller/`):

```
[FAIL] ... [It] DROPS scale-down-delay under the preview override ...
Expected <map[string]string | len:4>: {
    "autoscaling.knative.dev/max-scale": "1",
    "autoscaling.knative.dev/min-scale": "0",
    "autoscaling.knative.dev/scale-down-delay": "1h",
    "autoscaling.knative.dev/scale-to-zero-pod-retention-period": "30s",
}
not to have key <string>: autoscaling.knative.dev/scale-down-delay
Ran 105 of 105 Specs — 104 Passed | 1 Failed
```

i.e. it failed for exactly the right reason: the user's `1h` leaked onto the preview revision.

After the fix: `ok .../internal/controller 33.111s` (105/105).

## Mutation proof

Removed **only** `delete(annotations, "autoscaling.knative.dev/scale-down-delay")` from the preview
branch (via an exact-match edit that aborts if the anchor is not found/unique — no `perl`), re-ran
focused:

```
Ran 1 of 105 Specs in 5.841 seconds
FAIL! -- 0 Passed | 1 Failed | 104 Skipped
```

Restored, then verified no residue: `grep -r MUTATION-PROOF` → none, and the delete line occurs
exactly once. The mutation was done and reverted **before** the commit; the committed tree is the
fixed one.

## Full suite / vet / manifests

- `go vet ./...` — clean. `gofmt -l ./api ./internal` — empty.
- `go test ./...` with `KUBEBUILDER_ASSETS` (envtest 1.36.2, as the Makefile resolves it) —
  all packages `ok`: api/v1alpha1, cmd, internal/controller, internal/install, internal/validation,
  internal/webhook/v1alpha1, test/utils.
- **Manifest drift:** regenerated with the repo's `controller-gen` (same invocation as
  `make manifests`). Drift is exactly the 3 added description lines in
  `config/crd/bases/apps.kn-next.dev_nextapps.yaml`, committed. No other copy of the CRD exists in
  the tree (grepped for the `ScaleDownDelay tunes the Knative` description) — nothing else to
  regenerate.

## Deferred / not done, with reasons

- **The two docs-site pages in step 5 could not be updated as specified.**
  `apps/docs/content/learn/scale-to-zero.mdx` **does not exist**, and
  `apps/docs/content/docs/scale-to-zero.mdx` never mentions the delay at all — it documents
  `minScale`/`warmSchedule`/`targetBurstCapacity`/the panic pair, so there is no unconditional
  promise to qualify. Adding a "previews don't keep pods warm" clause to a page that never promises
  warmth would be introducing the topic, not correcting it. The only in-tree page that *does*
  promise the delay is `docs/operator/crd-nextapp.md`, which I updated. If the user-facing
  `scaleDownDelay` docs live in the separate `getknext-dev/docs` repo, that page still needs the
  clause — flagging rather than guessing.
- **No kind / OKE verification** — that is the lead-owned pipeline stage; this change is covered at
  the envtest level only.
