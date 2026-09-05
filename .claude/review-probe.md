APPROVE

# Adversarial review — operator aggressive-readiness-probe fix

Branch `fix/operator-aggressive-readiness-probe` (e15d715 red + 843f2bc green) vs origin/main.
Diff: 2 files, +205/−3 — `aggressive_readiness_probe_test.go` (new) + `nextapp_controller.go`
(readiness timing removed, comments). Reviewer re-verified everything independently; nothing
taken on the implementer's word.

## 1. Knative validation claims — VERIFIED verbatim in the module cache

`~/go/pkg/mod/knative.dev/serving@v0.48.0/pkg/apis/serving/k8s_validation.go`:
- The literal comment `// PeriodSeconds == 0 indicates Knative's special probe with aggressive
  retries` and the two rejection branches (`failureThreshold is disallowed when periodSeconds is
  zero`, same for `timeoutSeconds`) are exactly where claimed (~L828-842).
- `ValidateUserContainer` (L589) → `validateReadinessProbe(..., isUserContainer=true)` (L593) —
  the test exercises the real validation path, not a lookalike.
- `revision_defaults.go` `applyReadinessProbeDefaults`: `successThreshold=1` unconditionally;
  the k8s `failureThreshold=3`/`timeoutSeconds=1` defaults apply **only when periodSeconds != 0**
  — so the unset probe survives defaulting in aggressive mode. Confirmed.
- The test builds the container via the **production** `buildDesiredKsvc` (not a re-typed
  literal), runs Knative's own `ksvc.SetDefaults(ctx)` in place, then reads the defaulted
  container and validates it. The `corev1.Container` value returned by the helper shares the
  probe pointers, so nothing is validated on a divergent copy.

## 2. Drift/upgrade hazards — fail-soft, no rejection path

- The change only **removes** fields. Knative's rejection branch fires only when
  failureThreshold/timeoutSeconds are **non-zero** with period 0 — the fix sets neither, so
  there is no input on which any serving webhook rejects this apply. An older Knative whose
  aggressive contract differed would at worst probe on its own schedule (slower readiness),
  never break a deploy. The periodSeconds==0 aggressive contract long predates any version
  knext supports.
- Checked the apply mechanics for the sneaky version of this hazard: `controllerutil.
  CreateOrUpdate` (nextapp_controller.go:443) + `buildDesiredKsvc` replacing the container
  wholesale means the update is a full PUT of the spec — **existing** ksvcs actually shed the
  live `initialDelay:2/period:3`. Had this been a merge patch, `omitempty` on the zeroed ints
  would have silently kept the old values and the fix would never take effect on upgrade. It
  isn't; no hazard.

## 3. Liveness reasoning — sound

Liveness is kubelet-enforced (no Knative aggressive mode; period 0 there just means kubelet
default), does not gate path-to-Ready, and zeroing it would risk restart-thrash on slow boots.
The new comment states exactly this distinction, correctly. Keeping `5/10` is right.

## 4. Mutation proof — re-run independently, all three RED

Fresh harness (Python substring mutation, anchors asserted exactly-once or abort 99,
`git checkout --` restore with residue check, **exit-code branching only**):

| Mutation | go test exit | Verdict |
|---|---|---|
| baseline | 0 | GREEN (required) |
| restore readiness `initialDelay:2, period:3` | 1 | RED |
| readiness `httpGet` → `tcpSocket` | 1 | RED |
| liveness `5/10` zeroed | 1 | RED |

Worktree clean after (only the untracked impl report remains).

## 5. Other probe-stamping sites — none missed

- Operator: exactly one ReadinessProbe + one LivenessProbe site (`nextapp_controller.go`).
- `packages/scale-zero-pg/gateway/internal/appdb/render.go:170,343`: TCP probes on **plain
  `appsv1.Deployment`s** (Postgres computes) — kubelet-probed, Knative aggressive mode does not
  exist there, and they already run `period:1/failureThreshold:60`. Out of scope, not a miss.
- CLI (`packages/kn-next/src`): zero probe stamping — confirms the removed "aligned with CLI"
  comment was indeed stale.
- ADR-0026's `periodSeconds=3` mention is in its **Context** section (pre-ADR state); the ADR
  prescribes the shallow *path*, which is preserved. No escalation trigger.

## 6. Suite — green

`go test ./...` in `packages/kn-next-operator`: exit 0, 7 packages ok, envtest included, with
`KUBEBUILDER_ASSETS=/Users/banna/alpheya/pocs/knext/packages/kn-next-operator/bin/k8s/1.36.2-darwin-arm64`
(the **main repo's** bin/k8s — the worktree has no assets dir; a first run without that path
reds the webhook suite's BeforeSuite, which is an environment artifact, not a defect).

## Residual (non-blocking, already declared by the implementer)

Live OKE re-verification that the ~1.2s is actually reclaimed is still owed to the workflow's
OKE stage (lead-serialised), including confirming the deployed operator image carries this
commit before attributing any delta.

# PR 814
ISSUES_FOUND

Branch `fix/operator-go-1.25.13` (21bbfee) vs origin/main — golang builder digest bump,
`packages/kn-next-operator/Dockerfile` only.

## Checks requested — all four pass

1. **Digest — VERIFIED independently.** Resolved via the Docker Hub registry API
   (anonymous pull token → HEAD `registry-1.docker.io/v2/library/golang/manifests/1.25.13`):
   `Docker-Content-Digest: sha256:cbff9d1a9041b316010f2da6b701b6c0d597718cb90928c85eb597334a0d23d4`,
   content-type `application/vnd.oci.image.index.v1+json` — the multi-arch manifest-list digest,
   which is the correct thing to pin in a FROM line. Exact match. (docker CLI unusable here —
   keychain locked — so resolved via registry API.)
2. **No stale `1.25.12` remains** in the Dockerfile (grep: only `1.25.13` at lines 10/20/22).
   Nit, non-blocking: the unchanged parenthetical "(fixes CVE-2026-39822 …)" was the *1.25.12*
   bump's rationale; cumulative-true for .13 but now reads as if it were this bump's reason.
3. **Nothing else changed**: 1 file, +3/−3, single commit.
4. **go.mod needs no change — confirmed from the directives, not assumed.** `go 1.25.3` is the
   module's *minimum* toolchain/language version and there is no `toolchain` line; the builder's
   go1.25.13 satisfies ≥ 1.25.3, and a builder patch bump adds no new language/stdlib API surface
   the module could depend on, so raising the minimum would be wrong, not just unnecessary.

## The issue — the Dockerfile's own lockstep instruction was not followed

Dockerfile line 12 (unchanged, in this PR's own diff context): *"Bump this in lockstep with
hack/check-trivy-baseimage.bats.sh (MIN_PATCH)."*
`packages/kn-next-operator/hack/check-trivy-baseimage.bats.sh:44` still reads **`MIN_PATCH=12`**
— the PR did not touch it (empty diff for that path).

Why it matters: that guard's assertion (`GO_PATCH >= MIN_PATCH`) exists to make the patched
floor a gate. Left at 12, it still **accepts golang:1.25.12 — the exact image this PR exists to
eliminate**, the one carrying 7 HIGH stdlib CVEs that Trivy blocks. A revert or copy-paste of
the old pin would sail through this guard and only fail much later at the Trivy publish gate on
main — precisely the blocked-publish scenario this PR is fixing. By this repo's own standard, a
guard that stays green for the state it exists to forbid is decoration.

**Fix (one line):** `MIN_PATCH=13` in `hack/check-trivy-baseimage.bats.sh`, same commit or a
follow-up on this branch. Everything else in the PR is correct.

# PR 814 round 2
APPROVE

`d0c00d4` on `fix/operator-go-1.25.13`, reviewed as `21bbfee..d0c00d4`.

- **Diff is exactly the two requested edits**: `MIN_PATCH=12` → `13` in
  `hack/check-trivy-baseimage.bats.sh:44`, plus the Dockerfile comment now naming this bump's
  actual rationale (the 7 HIGH stdlib CVEs in 1.25.12). Nothing else changed.
- **Mutation-proved the guard myself**, not taken from the pusher's run. Scratch copy of the
  package layout (the script resolves `$SCRIPT_DIR/../Dockerfile`, so the copy preserves
  `hack/` + `Dockerfile`); anchor asserted exactly-once before mutating; **exit-code branched**:
  - baseline (1.25.13 pin): exit **0** — guard passes.
  - FROM restored to the old `golang:1.25.12@sha256:d7912ce…` line: exit **1** — guard REDS
    against the exact image this PR eliminates. The round-1 defect (guard green on the
    forbidden state) is closed.
- Residual nits, non-blocking, comments only: the old "(fixes CVE-2026-39822 …)" parenthetical
  still trails the new one (two stacked parentheticals, the old one still reading as if it were
  this bump's reason), and the script's knob-history comment documents `# 12:` but gained no
  `# 13:` line. Neither affects behavior; fold into any future touch of these files.
