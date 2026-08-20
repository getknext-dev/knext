# Spec review — PR #786 vs issues #777, #778 and the #766 gate ruling

Reviewer: spec-review agent (read-only, independent of the implementer).
Tree: worktree `agent-ae5f5354a47b82988`, branch `fix/tier-warm-on-warmhold` @ `cd74257`.
`go test ./...` in `packages/scale-zero-pg/gateway`: **9 packages ok** (re-run by me).
All 10 tier tests pass (`-run 'TierWarm|TierCold|WarmTier' -v`).

## Checklist

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| #777 AC1 | With `tier: warm`, compute is still warm after (first connection closes + `GW_IDLE_MS` elapses) | **partial** | `tier_warm_test.go:61 TestTierWarm_StaysWarmPastTheIdleWindowThatUsedToDegradeIt` — PASSES, and the mechanism is right (`reconcile.go:350` `permanent := cr.Spec.Tier == "warm"` → `EnsureHold` every pass, never `ReleaseHold`). But the test **models** the sequence (4 reconcile passes at +1h/+9h/+23h, hold still `held`, no release); it never simulates a connection close or the gateway's idle sleep — `Holds` is a fake. The exact sequence is only provable on the running system, and the PR itself defers that to the OKE drill (draft PR, "Outstanding before merge"). Nit: the test comment claims "the compute goes UNavailable after the first pass" but `h.cl.depAvailable` is `false` for every pass (zero value) — no transition is modelled. |
| #777 AC2 | Mutation-proved: removing the warm-tier hold reds it | **met** | Reproduced independently, anchor-asserting python (count==1, abort otherwise), on a `/tmp` copy so the worktree was never mutated. **M1** `warmHoldRequested` → `return len(a.Spec.WarmSchedule) > 0` (types.go:255) ⇒ **6 red**: `HoldEnsuredWithoutAnySchedule`, `StaysWarmPastTheIdleWindow…`, `StatusIsWarmAndHealthyOnlyWhileHeld`, `FailedHoldNeverReportsWarmAndHealthy`, `HoldsUnavailableIsSurfacedNotAssumedWarm`, `HoldReleasedOnDelete`. **M2** `permanent := false` (reconcile.go:350) ⇒ 6 red incl. `SubsumesWarmScheduleWindows`. Control (unmutated `/tmp` copy) reds only `TestRenderDeploymentMatchesTemplateEnv` + a stray probe — both path-relative, discounted. Matches the PR's claim exactly. |
| #777 AC3 | Status warm-tier semantics are true statements; never gates serving | **partial** | Met for the states the PR covers: `reconcile.go:296-310` (`WarmHeld` / `WarmHoldDegraded`, `Phase=Ready` in both), `HoldsUnavailable` at `reconcile.go:182`, tests `tier_warm_test.go:99,117,149`; the never-resolving `ComputeStarting`/`Provisioning` branch is gone (`reconcile_test.go:342 TestWarmTierNeverWaitsOnAReplica`). **Not met for a `spec` edit — see FINDING 1: flipping `tier: warm → cold` leaves the hold established, and status then asserts "cold tier; compute wakes on connect" while this operator is holding the compute awake.** |
| #777 AC4 / #766 | No `minWarm` / replica-floor field; makes `minWarm` redundant "a second time over" | **met** | `types.go:246` `func (a *AppDatabase) desiredReplicas() int { return 0 }` with the rationale in godoc; `tier_warm_test.go:44 TestTierWarm_OperatorNeverWritesAReplicaFloor` asserts applied `Replicas == 0`; no new CRD field (`82-appdb-crd.yaml` diff is a `description:` only). Single-writer rule preserved — the ruling's stated reason for rejecting option A is now doubly true. |
| #778 | Docs describe what the mechanism keeps; no remaining replica promise | **partial** | Fixed and good: `appdatabase-api.md:42` tier line, `WarmHold`/`computeReady` status rows, rewritten readiness semantics, **new §2a** ("a held connection, not a replica floor", precedence, degrade-don't-fail), §3b cross-ref, §6 lifecycle; `82-appdb-crd.yaml` `spec.tier` description; ADR-0007 §4c table row (`cd74257`). **FINDING 2: two places still promise a replica.** |
| Drill deferral | OKE steps recorded and runnable as written | **partial** | `.claude/impl-777-report.md:60-72` has 4 steps (apply warm CR → psql + close → wait > `GW_IDLE_MS` + one resync → assert replica 1 + `WarmHold True/TierWarm` + `Ready/WarmHeld` + `appdb_warm_hold_active 1`; negative half). Correct assertions, but not turnkey: step 1 gives no build/push command for the operator image, step 4 says "make the hold fail (e.g. an unreachable compute)" with no procedure, no cleanup/restore step, and no app name. Also the report is **untracked** (`?? .claude/impl-777-report.md`) — the PR body points at a file that is not in the PR and dies with the worktree. |
| PR body | "Closes #777, closes #778" honest | **partial** | #777's mechanism, mutation proof and no-minWarm constraint are honestly delivered; #778 is not fully closed (Finding 2), and Finding 1 leaves a live instance of the honest-status class #777 exists to kill. |

## FINDING 1 (substantive) — a warm→cold tier edit never releases the hold; status then lies

`reconcile.go:176` gates the whole hold path on `cr.warmHoldRequested()`, and the only
`ReleaseHold` calls are *inside* that gate (`reconcile.go:380`) or on delete (`reconcile.go:429`).
So when a user edits a live CR from `tier: warm` to `tier: cold`, `reconcileWarmHold` is never
reached, the permanent hold stays open forever, the compute never idles to zero — and the status
branch falls to `default:` and writes `Ready=True/Provisioned`, `"provisioned; compute wakes on
connect"`.

Proved (my own probe against the green tree, `/tmp` copy):

```
TestSpecProbe_TierFlipWarmToColdReleasesHold
  after flip: held=true released=[] readyReason=Provisioned msg="provisioned; compute wakes on connect"
  FAIL: hold STILL held after flipping tier to cold
```

Why it is in scope rather than a follow-up:
- it is exactly #777 AC2/AC3's class — "status keeps reporting semantics the mechanism does not
  have", inverted;
- this PR is what makes `spec.tier` hold-bearing, so it **creates** this path (before it, a
  warm→cold flip released nothing because nothing was held);
- it contradicts this PR's own docs: `appdatabase-api.md` §6 says a `spec` update to `tier` is
  "reconciled idempotently";
- product cost: a compute pinned awake 24/7 in a scale-to-zero product, invisible on status.
- the same hole exists pre-PR for removing `spec.warmSchedule` (my second probe reproduces it) —
  one fix closes both.

Shape of the fix (small, no new mechanism): when `!warmHoldRequested() && d.Holds != nil`, release
the hold (idempotent) and clear/omit the condition — plus a test for the flip and for schedule
removal.

## FINDING 2 (#778 not fully closed) — docs/CRD still promise "one replica hot"

1. **`packages/scale-zero-pg/deploy/86-zone-crd.yaml:64`** — `Zone.spec.database.tier`:
   `description: cold = scale-to-zero at rest; warm = keep one replica hot.` This field is passed
   **straight through** to the AppDatabase (`gateway/internal/zone/reconcile.go:134` →
   `appdbclient.go:52 "tier": s.Tier`), so it is the same knob with the exact wording #778 was filed
   about, on the CRD a Zone user actually edits (`kubectl explain`). Sibling CRD `82-appdb-crd.yaml`
   was fixed; this one was missed.
2. **`packages/scale-zero-pg/docs/spikes/133-logical-replication.md:122`** — "keep the publisher
   zone warm (**min replicas 1**) while any subscriber…", the source the ADR-0007 §4c row was
   derived from. §4c was corrected; its spike was not. Lower severity (historical spike record) —
   a one-line "(mechanism: permanent warm hold, #777)" note suffices.

Everything else is clean: I grepped the package for `hot replica|keep one replica|warm replica|
replicas 1|min replicas 1|ComputeAvailable|ComputeStarting` — remaining hits are `provision-app.sh
--replicas 1` drill invocations, the single-DB gateway warm-pool (a different subsystem, correctly
flagged as untouched in the impl report), and infra review docs. No other AppDatabase-tier replica
promise survives.

## Minor / housekeeping

- Untracked residue observed in the worktree during this review:
  `packages/scale-zero-pg/gateway/internal/appdb/zz_review_probe_test.go` (a reviewer probe; it
  disappeared mid-review). It is not in the PR, but it contaminates local `go test` runs while
  present — sweep before merge (`git status --porcelain` clean except intended files).
- Scope drift: none. The diff is confined to the tier/warmhold path, its tests, and its docs; the
  two deletions (`TestWarmTierRequeuesUntilAvailable`, `TestWarmHold_TierWarmUnchanged`) are
  justified in-place because both **encoded the defect** — replacement coverage exists
  (`reconcile_test.go:342`, `tier_warm_test.go`), so this is not a quietly-dropped requirement.
- The removal of the `Provisioning`/`ComputeStarting` branch is a change to the documented §2
  status contract; it is documented in the same PR (`appdatabase-api.md` readiness semantics) and
  is the right call, but it is a consumer-visible contract change — worth naming to the architect
  gate rather than only in the PR body.

# Verdict: **ISSUES_FOUND**

Unmet / partial:
1. **#777 AC3** — warm→cold tier edit leaves the hold open and status reports cold-and-fine
   (FINDING 1). Blocking: it is the same honest-status defect class the issue was filed to fix, and
   this PR creates the path.
2. **#778** — `86-zone-crd.yaml:64` still documents `warm = keep one replica hot` on a field wired
   straight into `AppDatabase.spec.tier`; `docs/spikes/133-logical-replication.md:122` still says
   "min replicas 1" (FINDING 2). `closes #778` is not yet honest.
3. **#777 AC1** — met at the reconciler level and mutation-proved, but the *exact* sequence
   (connection close + `GW_IDLE_MS`) is unproven until the OKE drill runs; the recorded drill steps
   need concrete commands for step 1 and step 4, and the report holding them should be tracked in
   the PR rather than left untracked.

AC2 and AC4 are fully met, and the mutation proof reproduces exactly as claimed.
