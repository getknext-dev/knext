# Code review — PR #786 (fix/tier-warm-on-warmhold, #777/#778)

## Verdict: **ISSUES_FOUND**

The shape is right and matches the #766 ruling (no `minWarm`, no replica floor, hold-based warmth,
single-writer preserved). One **blocking** defect: withdrawing warmth by editing the spec never
releases the hold.

---

## Findings (ordered by severity)

### 1. HIGH — `gateway/internal/appdb/reconcile.go:180` — flipping `tier: warm` → `cold` leaks the hold forever; the compute never scales to zero again
`if cr.warmHoldRequested() { ... }` gates **both** the ensure *and* the release path. When a CR that
has an established permanent hold is edited to `tier: cold` **with no `warmSchedule`**,
`warmHoldRequested()` is false, `reconcileWarmHold` is never called, and `Holds.ReleaseHold(app)`
never runs. Verified empirically (probe test on this branch, since deleted):

```
after flip to cold: held=map[app1:true] released=[]
WarmHold cond after flip: True/TierWarm     <- stale, on a COLD tier
Ready cond after flip:    True/Provisioned  ("cold tier; compute wakes on connect")
```

The held TCP connection survives until the operator process restarts, so the gateway's idle
scale-to-zero never arms — the product's core promise silently inverts for that app. Why it matters
here specifically:
- **It is the documented usage.** `docs/appdatabase-api.md` §6 lists `tier` under "Update `spec` →
  reconciled idempotently", and `docs/adr-0007-zoned-consistency.md:374` — amended by *this PR* —
  says option (i) works by "The Zone operator sets it when a dependency is wired, **clears it when
  the last subscriber drops**". Clearing it does not clear the hold.
- **The alert that would catch it is blinded by the same bug.** `deploy/60-prometheus.yaml:159`
  subtracts `sum(appdb_warm_hold_active)`, and the leaked hold is still in `HoldManager.Held()`, so
  `ComputePhantomKeepalive` stays silent on a compute that can no longer sleep.

Counter-case that works: with a `warmSchedule` also present, the flip is handled correctly (windows
resume, `ReleaseHold` fires, condition → `False/WindowInactive` — verified). The leak is only the
schedule-less path, which is the common one.

Fix shape: an `else` branch that releases (idempotent, cheap) and clears/False-es `CondWarmHold`
when warmth is not requested. Note this also closes the pre-existing sibling leak (removing a
`warmSchedule` altogether leaks identically — also verified), so the "CRs that ask for no warmth at
all skip this entirely — byte-identical back-compat" claim at `reconcile.go:173` is exactly what
costs correctness here.

### 2. MEDIUM — `reconcile.go:180` + `types.go:47-60` — stale `WarmHold` condition contradicts the contract this PR writes
Same root cause as #1: nothing ever retracts `CondWarmHold`. A cold-tier CR keeps
`WarmHold=True/TierWarm` indefinitely, while `docs/appdatabase-api.md:51` (added here) states the
condition is "**present whenever warmth is requested**". A consumer reading `WarmHold` — the doc
calls it "the **only** true statement about whether the DB is warm right now" — is lied to.

### 3. MEDIUM — `reconcile.go:180` runs the first `EnsureHold` *before* the pageserver branch exists (step 5, `reconcile.go:189`)
On a first-ever `tier: warm` create the ordering is: apply compute at 0 (step 4) → **dial the hold**
(4c) → create the branch (5). The dial wakes `compute-<app>` through the gateway against a
`TIMELINE_ID` the pageserver does not have yet, so the first pass predictably yields
`WarmHold=False/HoldFailed`, a `WarmHoldFailed` **Warning event**, and `Ready=True/WarmHoldDegraded`
until the next resync (~15 s). Step 4's own comment ("Applied BEFORE the branch; a Deployment at 0
starts nothing") is the invariant 4c now breaks for every warm-tier creation. Not a regression in
kind (the old replicas-1 create started the compute early too), but it is newly *user-visible* noise
plus a wasted wake-budget token. Either move 4c after step 5, or suppress the first-pass event —
and confirm the real behaviour in the OKE drill rather than assuming it is benign.

### 4. LOW/MED — `docs/operations.md:1706-1707` — stale runbook (package rule 2b)
"**Stuck in `Provisioning`** → … or (warm tier) the compute has no available replica yet." That
cause no longer exists — the branch was deleted in this PR. Doc drift found in review counts as a
defect per `packages/scale-zero-pg/CLAUDE.md` rule 2b.

### 5. LOW — `deploy/82-appdb-crd.yaml:42` + `:186` — the `Ready` printer column is `.status.computeReady`, which this PR demotes to a diagnostic
`kubectl get appdatabase` prints a column literally named `Ready` sourced from `computeReady`, while
the new docs say `computeReady` is "diagnostic only — **not** a readiness gate for either tier"
(`appdatabase-api.md:62`). A cold (or momentarily-unheld warm) DB that is fully Ready prints
`Ready: false`. The CRD field description (`:186`) was also left un-updated while the tier
description and the metric HELP text were. Rename the column (`Compute`) or point it at the `Ready`
condition.

### 6. LOW — `deploy/60-prometheus.yaml:163` — alert annotation still says "declared **warmSchedule** warm holds" only
`cmd/appdb-operator/main.go:164` was updated to mention `tier: warm`; the alert text describing the
same subtraction was not.

### 7. NIT — `reconcile.go:296` / PR body — "That state could never resolve" is stronger than the truth
`K8sCluster.ApplyCompute` preserves replicas only on **update**; on **create** it writes the rendered
count (`k8s.go:219-222`), so the old warm tier did come up at 1 and the `ComputeStarting` branch did
resolve on first-ever provision. It became unresolvable after the first gateway park. The replaced
test's own comment (`reconcile_test.go:349`) states this accurately — the code comment and PR body
should match it. (This repo's standing rule: re-read your own claims against the tree.)

---

## What I verified as good (not padding — these were the attack targets)

- **Single-writer:** no replica/Scale write added anywhere; `desiredReplicas()` is 0 for both tiers
  (`types.go:686`), and `TestTierWarm_OperatorNeverWritesAReplicaFloor` pins it. Matches the #766
  ruling (option A rejected).
- **Delete path:** `reconcileDelete` releases the hold before object teardown
  (`reconcile.go:428-430`); `TestTierWarm_HoldReleasedOnDelete` mutation-sensitive and green. No leak
  on CR deletion.
- **Retry/backoff:** `EnsureHold` is idempotent, pings then re-dials a dead hold, every Dial/Ping is
  bounded by `DefaultHoldTimeout` (5 s); retry cadence is the resync tick (15 s), not a hammer.
  Warning events are transition-gated, so a persistently failing hold does not spam Event objects.
- **Precedence:** windows are genuinely not evaluated when the tier is warm (`reconcile.go:350-354`);
  one `EnsureHold` per pass and one gauge entry per app (`Held()` is a set) — no double-hold, no
  double-count. Flipping warm→cold **does** resume window evaluation when a schedule exists (probed).
- **Mutation proofs re-run, both reproduce:** (1) `warmHoldRequested` → schedule-only ⇒ 6 tier tests
  red; (2) precedence removed ⇒ `TestTierWarm_SubsumesWarmScheduleWindows` (+5) red. Anchor-count
  asserting python script, tree restored via `git checkout --`, green re-verified.
- **TDD order is real:** `git worktree add --detach 5d9bc81` + `go test` ⇒ 9 failures, exactly the new
  contract tests (`TestWarmTier*`, `TestTierWarm_*`), with `TestTierCold_Unaffected…` green as a
  back-compat control. Worktree removed after.
- **Replaced tests encoded the defect, not lost behaviour.** `TestWarmHold_TierWarmUnchanged`
  asserted replicas 1 + no holds — pure defect. `TestWarmTierRequeuesUntilAvailable` asserted the
  replica floor *and* replica-gated readiness; only the latter is a real semantic loss, and dropping
  it is justified (the wake path is identical for both tiers) and documented in `appdatabase-api.md`.
- **Hygiene:** `gofmt -l` clean, `go vet ./...` clean, `go test ./...` 9/9 packages ok. No secrets;
  `redactDSN` still wraps every error that reaches a condition/event, including the new `due`-prefixed
  messages.

## Test quality
Strong overall — the 9 new tests assert real reconciler state (holds ensured/released, condition
type+status+reason, replica count, phase) and both documented mutations red them. Two gaps: a **third
mutation** I ran — make the hold fire once and never re-establish — is caught only by a pre-existing
test (`TestWarmHold_HoldFailedEventFiresAgainAfterRecovery`), and notably **not** by
`TestTierWarm_StaysWarmPastTheIdleWindowThatUsedToDegradeIt`, whose `fh.held["app1"]` assertion
cannot fail because the fake never drops a hold — its central claim ("survives the window that used
to degrade it") is near-tautological; clearing `fh.held` between passes would make it real
(actuator-level re-dial is covered by `TestHoldManager_DeadHoldIsRedialed`). And **no test covers
warmth withdrawal** (finding #1) — the leak got in precisely because no test flips the tier back.
