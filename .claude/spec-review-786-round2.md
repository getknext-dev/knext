# Spec review round 2 — PR #786 @ `61da794` vs #777 / #778 / the #766 ruling

Independent read of `cd74257..61da794` in worktree `agent-ae5f5354a47b82988`.
`go test ./...` (gateway): **all packages ok**. `gofmt -l .` clean, `go vet ./...` clean.

## Round-1 findings — resolution

| Round-1 finding | Status | Evidence (verified by me, not read off the PR body) |
|---|---|---|
| **F1 (blocking): warm→cold edit leaks the hold; status then says cold-and-fine** | **RESOLVED** | `reconcile.go` step 5c `else` branch: unconditional idempotent `d.Holds.ReleaseHold(app)` + retraction to `False/WarmthNotRequested` guarded by `findCondition(...) != nil`. My round-1 probe now passes as shipped tests: `TestTierWarm_FlipToColdReleasesTheHoldAndRetractsTheCondition` and `TestWarmHold_RemovingTheLastWindowReleasesTheHold` (the pre-existing #388 sibling I flagged — also fixed, not deferred). |
| **F2: `86-zone-crd.yaml:64` "keep one replica hot"; spike "min replicas 1"** | **RESOLVED** | `86-zone-crd.yaml:64` now describes the permanent held connection and says "NOT a replica floor"; `docs/spikes/133-logical-replication.md:122` keeps the historical wording but marks it superseded by the #777 hold. Re-grepped the whole package for `hot replica\|keep one replica\|warm replica\|min replicas 1\|ComputeAvailable\|ComputeStarting` — **no AppDatabase-tier replica promise survives**; remaining hits are `provision-app.sh --replicas 1` drill invocations and the unrelated single-DB warm-pool. |
| **F3: AC1 exact sequence / drill steps not runnable / report untracked** | **RESOLVED in form** | `docs/drills/tier-warm-drill.md` is now **tracked** and indexed in `DRILLS.md`, with preconditions ("merged ≠ deployed" image check, cluster queue-of-one), a warm half, a negative half, a release half, and teardown. Two factual errors in it — see below. |
| Minor: `StaysWarm…` test comment overstated the modelled transition | **RESOLVED and strengthened** | The test now `delete(fh.held, "app1")` between passes, so each later pass must genuinely **re-establish** the hold; comment corrected and points at `TestHoldManager_DeadHoldIsRedialed`. |
| Minor: untracked `zz_review_probe_test.go` residue | **RESOLVED** | `git status --porcelain` in the worktree is clean apart from `.claude/impl-777-report.md`. |

## Mutation proof of the NEW behaviour (mine, anchor-asserting, `/tmp` copies, control run green)

| Mutation | Result |
|---|---|
| **A** withdrawal `ReleaseHold` disabled | red: `TierWarm_FlipToColdReleasesTheHold…`, `WarmHold_RemovingTheLastWindowReleasesTheHold` |
| **B** condition retraction disabled | red: same two |
| **D** retraction written unconditionally (**the guard's other half**) | red: `TierCold_UnaffectedByTheWarmTierHold`, `WarmHold_NoScheduleMeansNoHoldAndNoCondition` |
| **E** the 5c block moved back before branch creation (ordering fix reverted) | red: `TierWarm_FirstPassDoesNotFailTheHoldBeforeTheBranchExists` |

Both halves of every new guard are covered — the failure mode this repo's rules call out most often. Round-1 mutations M1/M2 still red identically.

## No acceptance criterion weakened

- **AC1** strictly stronger (hold now dropped between passes; running-system half still owed to the drill, now tracked).
- **AC2** all four new mutations red; the original two still red.
- **AC3** strictly stronger: `WarmHold=True` can no longer outlive the spec that asked for it (`types.go` CondWarmHold contract), `Ready` reasons unchanged (`WarmHeld`/`WarmHoldDegraded`/`Provisioned`), serving still never gated (`Phase=Ready` in every branch).
- **AC4** untouched: `desiredReplicas() { return 0 }`, no `minWarm`, no replica-floor field; `TestTierWarm_OperatorNeverWritesAReplicaFloor` and the first-pass ordering test both assert applied `Replicas == 0`.
- **#778** now covers every user-facing surface a maintainer meets: both CRDs, `appdatabase-api.md` §2/§2a/§3b/§6, ADR-0007 §4c, the spike, `operations.md` alert table + runbook, `60-prometheus.yaml` alert text.
- Relaxations are deliberate and compensated: `TierCold_…` / `NoScheduleMeansNoHold…` dropped the `released == 0` assertion (release is now called on every non-warm pass) and gained stronger *invisibility* assertions — no condition, no event, **no churn across a second resync tick** — which mutation D proves are load-bearing.

## ISSUES — two factual errors in the new drill/runbook (doc-only, one-line fixes)

**I1 — `GW_APPS_HOST` does not exist.** `docs/drills/tier-warm-drill.md:19` and `:67`, and
`docs/operations.md:1722`, tell an operator to check/point `GW_APPS_HOST`. Grepping the package,
that name occurs **only in those three doc lines** — the real knob is **`APPDB_GATEWAY_HOST`**
(`gateway/cmd/appdb-operator/main.go:69`, default `pggw-apps.scale-zero-pg.svc`). Worse, the
attached claim is unreachable: `main.go:117,122` constructs `holds` **unconditionally** and always
passes it, so `Deps.Holds` is never nil in the shipped operator and `False/HoldsUnavailable`
cannot occur from a missing env — it is a defensive branch for an embedder/build without the
actuator. Fix: name `APPDB_GATEWAY_HOST` where the *hold target* is meant, and state that
`HoldsUnavailable` indicates an operator build without the actuator wired, not a missing env.

**I2 — `appdb_warm_hold_active` never reads `0`.** The exporter emits a line **only for held
apps** (`main.go:165-168`, `appdb_warm_hold_active{app=%q} 1`); on release the series becomes
**absent**, so the drill's `grep` returns *no output*. `tier-warm-drill.md:94` says
`# expect value: 0`, and the same "drops to `0`" wording is in `appdatabase-api.md` §2a
(withdrawal paragraph) and `operations.md:1723-1725`. For the alert this is harmless — the
PromQL carries `or vector(0)` — but as a drill assertion it is a wrong expected value: the
operator sees nothing and cannot tell "released" from "typo'd grep". Fix: "expect: **no**
`appdb_warm_hold_active{app="…"}` series (the gauge is emitted only while held)".

## Informational, not blocking

- Moving the hold to step 5c means a hard error in step 5/5b (pageserver branch, Secret) returns
  before **both** the ensure *and* the withdrawal release for that pass. Self-heals on the next
  ~15 s resync and the delete path releases regardless, so it is a latency not a leak — worth one
  clause in the 5c comment.
- `main.go:110-115`'s comment above `NewHoldManager` still describes the hold as the *scheduled*
  lockstep only; the gauge HELP text beside it was updated for `tier: warm`.
- **CRD printer column renamed `Ready` → `Compute`** (`82-appdb-crd.yaml:42`). Correct call — a
  column labelled `Ready` showing `computeReady` reads `false` for a perfectly healthy app — but
  it is a user-visible CRD surface change (scripts/muscle memory) and only takes effect once the
  CRD is re-applied. It belongs in the architect / system-designer sign-off's field of view and in
  the upgrade note (CRD+operator first), not just in the diff.

# Verdict: **ISSUES_FOUND** (I1, I2 — docs only)

Every round-1 finding is genuinely resolved in the place a maintainer encounters it, no #777/#778
criterion was weakened, and the new behaviour is mutation-proved on both halves. The only
outstanding items are the two wrong values in the freshly-added drill/runbook text — precisely the
"a drill doc that asserts wrong expected values is worse than none" case. Correct `GW_APPS_HOST` →
`APPDB_GATEWAY_HOST` (3 lines) and the gauge's `0` → absent-series (3 lines) and this is an
**APPROVE** from spec review; no code change is required.

---

# Round 3 confirmation — `7446291` — **APPROVE**

Verified `61da794..7446291` (5 files, docs + comments only; no behavioural change).

| Round-2 issue | Status | Evidence |
|---|---|---|
| **I1** `GW_APPS_HOST` (invented env, 3 sites) | **RESOLVED** | `grep -rn "GW_APPS_HOST" packages/scale-zero-pg/` → **0 hits**. `APPDB_GATEWAY_HOST` now named in `docs/drills/tier-warm-drill.md` (precondition + negative half) and `docs/operations.md:1722`. The unreachability half is fixed too, not just the name: both say the shipped operator **always** wires the actuator, so `HoldsUnavailable` means a build without it compiled in — never a missing env — and the drill precondition escalates to "stop and fix the deployment before drilling". That matches `main.go:117,122` (unconditional `NewHoldManager`, always passed into `Deps`). |
| **I2** gauge "expect value: 0" / "drops to 0" (3 sites) | **RESOLVED** | `grep -rni "warm_hold_active.*drops to .0.\|expect value: 0"` → **0 hits**. Drill step 3(b), `appdatabase-api.md` §2a withdrawal paragraph, and `operations.md:1723-1727` all now say the series is **absent** (emitted only while held) and cite the alert's `or vector(0)`. The drill additionally gives the operator a pass/fail rule they cannot misread — "grep exiting 1 here is the pass; a `1` line is the leak" — which matches `main.go:165-168` exactly (`appdb_warm_hold_active{app=%q} 1` per held app, nothing otherwise). |
| Informational: 5c ordering trade | **TAKEN** | `reconcile.go:194-198` states the ensure/release-after-5/5b trade in the terms I raised: latency not a leak, next resync tick runs the block, delete path releases regardless. |
| Informational: stale `NewHoldManager` comment | **TAKEN** | `main.go:110-113` now covers the permanent `spec.tier: warm` hold alongside the windowed form. |
| Informational: CRD printer column `Ready` → `Compute` | **still open by design** | Not a spec-review defect — flagged for the architect / system-designer sign-off and the CRD-first upgrade note, as recorded above. |

Re-verified on `7446291`, uncached: `go test ./... -count=1` → **9 packages ok**, `go vet ./...`
clean, `gofmt -l .` clean. Worktree clean apart from the untracked `.claude/impl-777-report.md`
(superseded as the drill of record by the tracked `docs/drills/tier-warm-drill.md`).

## Final verdict — **APPROVE**

All four #777 acceptance criteria are met by tested behaviour, mutation-proved on both halves of
every new guard (six mutations across three rounds, all reproduced independently by me), and #778
is honestly closed — every user-facing surface (both CRDs, `appdatabase-api.md`, ADR-0007 §4c, the
spike, the alert text, the runbook) now describes the held connection, and no replica promise for
`AppDatabase.spec.tier` survives anywhere in the package. `Closes #777, closes #778` is honest.

One criterion remains **evidence-pending rather than unmet**, and it was never in the PR's gift:
AC1's *running-system* half — compute still warm past (connection close + `GW_IDLE_MS`) — is
proven at the reconciler level only until the OKE drill runs. It is now a tracked, indexed,
command-by-command drill whose expected values I have checked line by line against the code
(condition reasons `TierWarm`/`WarmHeld`/`HoldFailed`/`WarmHoldDegraded`/`HoldsUnavailable`/
`WarmthNotRequested`, gauge `appdb_warm_hold_active` on `:9092` per `APPDB_HEALTH_ADDR`,
`GW_IDLE_MS` deployed `60000` per `81-apps-gateway.yaml:83`, `APPDB_RESYNC_MS` default `15000` per
`main.go:78`) — every one correct. Merge on the lead's drill, not on a further spec round.
