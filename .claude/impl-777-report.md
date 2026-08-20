# Impl report — #777 `tier: warm` on warmhold (closes #777, closes #778)

- **Worktree:** `/Users/banna/alpheya/pocs/knext/.claude/worktrees/agent-ae5f5354a47b82988`
- **Branch:** `fix/tier-warm-on-warmhold` (from `origin/main`), NOT pushed
- **Commits (TDD, red → green):**
  - `5d9bc81` test(appdb): pin tier:warm as a permanent warm hold, red (#777)
  - `49020be` fix(appdb): reimplement tier:warm as a permanent warm hold, green (#777)

## Approach

`spec.tier: warm` is now a **permanent warm hold** on the existing warmhold actuator —
a 24/7 warm window. `desiredReplicas()` returns **0 for both tiers**, so the operator
never writes a replica count and the apps-gateway stays the single writer; warmth is
the held authenticated connection, the only thing that actually keeps a Neon compute
awake. Status is honest: `WarmHold` True/`TierWarm` while held, False/`HoldFailed` or
False/`HoldsUnavailable` otherwise; `Ready` carries reason `WarmHeld` vs
`WarmHoldDegraded`; warmth never gates serving.

**Semantics recorded (lead's call, AC6):** `tier: warm` is permanent, active
regardless of `warmSchedule`; when both are set the permanent hold **subsumes** the
windows — they are not evaluated at all (no window boundary can drop a warm tier's
hold; a malformed window on a warm tier is inert and raises no `InvalidWarmWindow`
event). Documented in the godoc of `warmHoldRequested` / `reconcileWarmHold` and in
`docs/appdatabase-api.md` §2a + §3b.

**One consequence worth the lead's eye:** the old `"warm compute starting"` branch
(Phase=Provisioning + requeue while no replica was available) is **removed**. With no
replica floor that state could never resolve — a warm-tier CR reported `Provisioning`
forever after its first idle window while serving fine. Warm and cold now share the
same readiness semantics (the wake path is the same); `status.computeReady` remains as
a diagnostic. This is a change to the documented §2 status contract, rewritten in the
same PR.

## Files

Code:
- `packages/scale-zero-pg/gateway/internal/appdb/types.go` — `desiredReplicas` → 0 always (documented why), new `warmHoldRequested`, `CondWarmHold` godoc rewritten
- `packages/scale-zero-pg/gateway/internal/appdb/reconcile.go` — hold gate on `warmHoldRequested` + `HoldsUnavailable` condition; `reconcileWarmHold` permanent-vs-windowed; tier-aware status branch
- `packages/scale-zero-pg/gateway/cmd/appdb-operator/main.go` — `appdb_warm_hold_active` HELP text

Tests:
- `packages/scale-zero-pg/gateway/internal/appdb/tier_warm_test.go` (**new**, 8 tests)
- `packages/scale-zero-pg/gateway/internal/appdb/reconcile_test.go` — `TestWarmTierRequeuesUntilAvailable` replaced by `TestWarmTierNeverWaitsOnAReplica`
- `packages/scale-zero-pg/gateway/internal/appdb/warmhold_reconcile_test.go` — `TestWarmHold_TierWarmUnchanged` removed (it asserted the defect), replaced by a pointer comment

Docs (rule 2b, same PR):
- `packages/scale-zero-pg/docs/appdatabase-api.md` — tier line 42, `WarmHold` + `computeReady` status rows, readiness semantics, **new §2a "Tiers — what `warm` actually is"** (held connection, not a replica floor; precedence; degrade-not-fail), §3b cross-reference, §6 lifecycle
- `packages/scale-zero-pg/deploy/82-appdb-crd.yaml` — `spec.tier` description (schema unchanged; `kubectl create --dry-run=client` accepts it)

## Verification

- `go test ./...` in `packages/scale-zero-pg/gateway`: **all packages green**
- `go vet ./...`, `gofmt -l .`: clean
- **Mutation-proved (AC2), twice, with abort-on-anchor-miss scripts (not bare perl), on top of the green commit, tree restored via `git checkout --` and re-verified green:**
  1. `warmHoldRequested` → schedule-only (i.e. the warm-tier hold removed): **6 tests red**, incl. `TestTierWarm_HoldEnsuredWithoutAnySchedule`, `..._StaysWarmPastTheIdleWindowThatUsedToDegradeIt`, `..._FailedHoldNeverReportsWarmAndHealthy`, `..._HoldsUnavailableIsSurfacedNotAssumedWarm`.
  2. Precedence removed (windows evaluated even for a warm tier): `TestTierWarm_SubsumesWarmScheduleWindows` red. (Mutation 1 alone leaves this test green — that is why the second mutation exists.)

## Deferred / for the lead

- **OKE drill (the real AC1 proof) — not run here, no cluster work done.** The unit
  tests pin the reconcile behaviour; the *running* system claim needs the drill:
  1. Apply an `AppDatabase` with `spec.tier: warm` on OKE (`context-ckmva7v7zvq`, ns
     `scale-zero-pg`) with the operator image built from this branch.
  2. `psql` once through `pggw-apps`, close the session, wait **> `GW_IDLE_MS`** (plus
     one `APPDB_RESYNC_MS` tick).
  3. Assert `deploy/compute-<app>` is still at **1 ready replica**, `kubectl get appdb
     <app> -o jsonpath` shows `WarmHold` True/`TierWarm` and `Ready` reason `WarmHeld`,
     and `appdb_warm_hold_active{app="<app>"} 1` on the operator's `:9092/metrics`.
     Pre-fix this is where it degraded to 0 forever.
  4. Negative half: make the hold fail (e.g. an unreachable compute) — assert
     `WarmHold` False/`HoldFailed`, `Ready` True/`WarmHoldDegraded`, a `WarmHoldFailed`
     event, and that the app still serves via a cold wake.
- **Upgrade order:** operator first. No CRD schema change (description only), but a
  post-#777 operator changes what `tier: warm` *does* — roll it consciously.
- **Not touched (flagged, not fixed):** `docs/connecting.md` "Choosing a tier",
  `docs/adr-0002`, `docs/ARCHITECTURE.md` `warmpool` — those describe the **separate**
  single-DB gateway warm-pool/parked-pod tier (`wake/warm.go`), not `AppDatabase
  spec.tier`, so this change does not make them false. `docs/adr-0007-zoned-consistency.md`
  §4c *does* describe `tier: warm` as "min replicas 1, never sleeps" for zones — that
  phrasing is now mechanism-wrong (the effect it wants still holds). It is an ADR, not
  mine to edit; the lead may want an amendment or a follow-up issue.
- **PR body must say:** `Closes #777, closes #778.`
