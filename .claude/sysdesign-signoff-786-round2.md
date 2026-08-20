SIGN-OFF

# System-designer sign-off — PR #786, round 2 (`bcd87a1..0d8f900`)

Re-review of the three BLOCKs from `.claude/sysdesign-signoff-786.md`. All three are closed, and
I verified each by execution rather than by reading the claim.

## BLOCK 1 — persisted retraction: CLOSED, and mutation-proved

`reconcile.go:186-200` now persists the retraction best-effort on the withdrawal branch, before the
pageserver steps, guarded on the transition (`alreadyRetracted` sampled *before* `setCondition`, so
the guard reads last pass's persisted value, not this pass's mutation).

Verified, not assumed:

- **Red at the test commit for exactly my reason.** Ran `TestTierWarm_WithdrawalRetractionIsPersisted…`
  in a worktree at `7bf3120`: `PERSISTED WarmHold = {Status:True Reason:TierWarm …}`. That is the
  defect I blocked on, reproduced verbatim.
- **Green at `0d8f900`** — full `internal/appdb` package `ok` (0.95s); `gofmt -l` clean, `go vet` clean.
- The test asserts `fakeCluster.persistedWarmHold`, a snapshot taken *inside* `UpdateStatus`, so it
  is now observing the API-visible half rather than the in-memory struct. The sibling in-memory test
  is retained, which is the right split — the two halves are asserted separately.

**The retry path holds under the guard**, which was the one way this fix could have gone wrong:
`Controller.reconcileAll` does a fresh `List` + `fromUnstructured` every pass
(`controller.go:85-97`), so `cr` always reflects *persisted* status. A failed status write therefore
leaves `True/TierWarm` in the decoded object next tick, `alreadyRetracted` is false again, and the
write retries. No cached-object hole; the "next resync tick retries" sentence in §2 is true.

The §2 contract now says what the code delivers — "persisted best-effort in the same pass",
next-tick retry, gauge authoritative in any gap, `observedGeneration` as the staleness detector. The
absolute is gone. Note the pleasing detail that `ObservedGeneration` is still only written at step 6,
so a pass that fails after 4c persists the fresh condition with a *stale* generation — conservative
in the right direction (a driver over-reports staleness, never under-reports it).

## BLOCK 2 — fleet-wide pricing: CLOSED

§2a's cost cell, §3b's cost paragraph, `81-apps-gateway.yaml:113` and `adr-0008:114` all now carry the
process-wide framing, matching the code (`gateway.go:96,169,259` — one `connSem` per process, taken
in the accept loop before any app is identified) and ADR-0003's explicit correction. The new §2a
capacity note states the three things that were missing and that matter operationally: the standing
floor of N slots, that exhaustion is refused `53300` to **other apps' clients**, and that "every app
warm" does not fit at the platform's own sizing. The ADR-0003 per-`{system}` slot cap is
cross-referenced as the fast-follow rather than silently inherited.

Checked rather than trusted: `81-apps-gateway.yaml` still parses (`kubectl create --dry-run=client`
→ `deployment.apps/pggw-apps`, `service/pggw-apps`), and the drill's metric name is real —
`pggw_rejected_connections_total` is the exported name (`metrics/metrics.go:198`), not the bare
JSON field.

`TestTierWarm_NWarmAppsHoldExactlyNDistinctSlots` pins the N-holds-for-N-apps arithmetic the capacity
note rests on, and is honestly labelled a green-from-birth pin. It does not measure gateway
saturation — the drill's new §4 is where that lives, which is the correct home for it.

## BLOCK 3 — runbook reason scoping: CLOSED

The bullet is scoped to `spec.tier: warm`, with the schedule-only case called out explicitly
(`Ready` stays `Provisioned`; failures surface on `WarmHold` only). That matches the switch at
`reconcile.go:334-352` exactly.

## Sign-off questions, restated for the record

Unchanged from round 1 and still clean: **data sovereignty** (own-DSN from own Secret, host from
`APPDB_GATEWAY_HOST` env, no cross-zone read); **single writer of replicas** (`desiredReplicas()==0`,
preserve-on-update, no `deployments/scale` grant, no replica write in either round's diff);
**security** (authenticated SCRAM dial, `redactDSN` before condition/Event/log, no new mutating
endpoint); **scale-to-zero** (release before teardown, release before the pageserver steps on
withdrawal, crash-only re-establish). Round 2 adds no new cluster-write surface — one extra
status-subresource write on a spec transition.

## One nit, not blocking

`adr-0008:114` now reads "90 **process-wide** per gateway pod, shared across all apps … — caps
concurrent connections **per compute**". The trailing "per compute" is the tail of the sentence the
edit corrected, and now contradicts its own opening clause. One-word fix ("per compute" → "per
gateway pod") whenever that file is next touched; it does not change any behaviour or contract, and
the two authoritative statements (§2a and ADR-0003) are correct.

## Failure mode the tests still do not cover

Real gateway saturation: `TestTierWarm_NWarmAppsHoldExactlyNDistinctSlots` proves N holds for N apps
against a fake, but nothing exercises holds against a finite `connSem`, so the first `53300` refused
to an *unrelated* tenant because of warm holds will be observed on a cluster. That is now a
*documented, measurable* drill step (`tier-warm-drill.md` §4, `pggw_rejected_connections_total` vs
warm-app count) rather than an unknown, which is the right trade for this PR — the actual fix is
ADR-0003's per-`{system}` slot cap, not more mocking here.

**Verdict: SIGN-OFF.**
