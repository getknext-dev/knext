# Code review — PR #786, round 3 (`7446291..7cd554c`)

## Verdict: **ISSUES_FOUND** — one LOW, **doc-only**. The code change is approve-quality; both round-2 findings are genuinely fixed.

If the lead wants to merge the code and fix the drill line in the same push, nothing here blocks the
Go change. But it lands in the drill the OKE battery is executing right now, so it is worth 30
seconds before the negative half runs.

---

## New finding

### 1. LOW — `docs/drills/tier-warm-drill.md:69-73` — the replacement method still can't fail the hold for the app under drill
The false method (scale the gateway to 0) is correctly removed, with a good explanation of *why* it
made the assertion unfalsifiable. But its replacement reads:

> point the operator at an unreachable `APPDB_GATEWAY_HOST` (**scratch namespace, or a temporary env
> edit on the operator Deployment**)

The env edit half does not work against `${APP}` from step 1. The hold does **not** dial
`APPDB_GATEWAY_HOST` — it dials whatever DSN is stored in the app's Secret:
`NewHoldManager(cluster.DatabaseURL, …)` (`cmd/appdb-operator/main.go:116`) →
`K8sCluster.DatabaseURL` reads `app-db-<app>`'s `DATABASE_URL` key (`k8s.go:160-169`). That Secret is
minted **once** — step 3 skips when it exists, `EnsureSecretOwnerRef` touches only ownerRefs, and
`EnsureSecretROKey` writes only `DATABASE_URL_RO` (`k8s.go:119-147`), so the writer host is never
rewritten. Editing the env therefore changes the dial target for **newly minted** apps only; the
drill app keeps dialling the real gateway and step 2 observes nothing (no `HoldFailed`, no event) —
which reads as "the degradation path is broken" when it is the method that is broken.

Two methods that do work against an existing drill app, either is a one-line fix:
- keep only the **scratch-namespace** option (it works precisely because the Secret is minted there
  with the unreachable host); or
- point the *existing* app at nowhere: patch `DATABASE_URL` in `app-db-${APP}` to an unreachable
  host. The operator will not rewrite it (above), the hold fails on the next resync, and a `psql`
  client using the real DSN still connects — so degrade-not-fail stays falsifiable, which was the
  whole point of dropping the scale-to-0 method.

---

## Round-2 findings — both verified fixed

### Finding 2 (the real one) — CLOSED, and fixed in the strictly-better shape
`reconcile.go:156-188` now runs the withdrawal release + retraction at **step 4c, before** the
pageserver steps; only the ensure half stays at 5c (`reconcile.go:229-233`), and the 5c comment now
claims ensure-latency only. Attacked rather than confirmed:

- **Red proof reproduced independently**, and for the right reason: `git worktree add --detach
  a29dbf9` ⇒ exactly one failure, `tier_warm_test.go:383: hold STILL held: a withdrawn hold must be
  released before the pageserver steps…`. Not a generic red.
- **Mutation-proved the ordering, not just the behaviour:** moving the whole 4c block back to where
  it sat at `7446291` (anchor-asserting script, tree restored, green re-verified) reds
  `TestTierWarm_WithdrawalReleasesEvenDuringASustainedPageserverFault` and nothing else — so the test
  is an ordering guard, not a duplicate of the flip test.
- The new fake is honest: `failExists` makes `TimelineExists` error, and the test **asserts the
  precondition** (`err != nil && requeue`) before asserting the release — so it cannot silently
  degenerate into "the pass succeeded, of course the hold went away". That is the shape I'd have
  asked for.
- My round-2 "asserted only in prose" gap is closed by that test.

### Finding 1 — CLOSED
The scale-gateway-to-0 method is gone and the doc now states why it made the assertion
unfalsifiable. Only the residue in finding #1 above remains.

## One observation, not a finding
During a sustained pageserver outage the pass still returns before step 6, so the retracted
`WarmHold` condition is **not persisted** that pass — the cluster keeps showing `True/TierWarm` for a
CR whose hold has actually been released, until a pass gets past step 5. That is inherent to
returning early (every status field is stale in that window, `observedGeneration` included) and it
converges on recovery. It does **not** re-open the alert-blinding problem: the gauge reads
`HoldManager.Held()` directly (`main.go:155-168`), so `appdb_warm_hold_active` drops the moment the
release happens, which is the half that matters. Worth knowing before someone debugs a stale
condition during an outage; not worth code.

## Re-verified at `7cd554c`
Full gateway suite green (9 packages), `gofmt -l` clean over `internal` + `cmd`, `go vet ./...`
clean, worktree clean after every mutation (all restored via `git checkout --`, each mutation
asserted its anchor occurred exactly once before writing). Single-writer untouched — the round-3 diff
contains no replica or Scale write. Back-compat still pinned: cold CRs dial nothing, grow no
condition, and churn no events across repeated passes even though the release now runs earlier.
