BLOCK

# System-designer sign-off — PR #786 (`spec.tier: warm` as a permanent warm hold)

Repo `/Users/banna/alpheya/pocs/knext`, branch `fix/tier-warm-on-warmhold`, head `bcd87a1`,
reviewed in worktree `.claude/worktrees/agent-ae5f5354a47b82988` (`git diff origin/main...HEAD`).
Read first: `.claude/rules/scs-zones.md`, `.claude/rules/security.md`,
`packages/scale-zero-pg/docs/adr-0003-multi-tenancy.md`, `adr-0008-wake-primitive-security.md`.

**Verdict: BLOCK.** The mechanism is right and I would sign the code off as designed. What I cannot
sign off is the **contract this PR publishes about that mechanism**: it states two absolutes the
system does not deliver, and prices a shared, fleet-wide resource as if it were per-app. All three
fixes below are small; none require a redesign.

---

## What is correct (stated so the next round does not re-litigate it)

- **Data sovereignty — clean.** The hold dials the app's **own** DB, DSN read from that app's
  operator-minted `app-db-<app>` Secret (`HoldManager.dsn` → `cluster.DatabaseURL`), through the
  gateway host resolved from env (`APPDB_GATEWAY_HOST`, `main.go:69`) — no hardcoded host, no
  cross-zone read, no shared database. `scs-zones.md` §Data sovereignty: satisfied.
- **Single writer of replicas — verified, not assumed.** `desiredReplicas()` is now unconditionally
  `0` (`types.go`), `ApplyCompute`/`ApplyROCompute` preserve the live count on update
  (`k8s.go:227,276`), RBAC carries no `deployments/scale` grant (`83-appdb-operator.yaml`), and the
  diff adds **no** replica write anywhere. The two-writer defect ADR-0030 records is genuinely
  closed, not relocated.
- **Security invariants — clean.** The hold is a real authenticated SCRAM connection, not an
  unauthenticated wake; `redactDSN` runs before the error reaches condition, Event, or stdout; the
  only new surface is a read-only `/metrics` line; no image or pin changes.
- **Isolation of the operator itself.** `replicas: 1` + `strategy: Recreate`
  (`83-appdb-operator.yaml:78`) means one hold-set, one gauge publisher — no N-pod split-brain in
  the actuator. Crash → TCP dies with the process → resync re-establishes. Correct and covered.
- **Scale-to-zero correctness.** Delete path releases before compute teardown; withdrawal release
  now runs at step 4c ahead of the pageserver steps, which is the right call for the reason the
  comment gives.

---

## BLOCK 1 — the status contract states an absolute the reconciler cannot honour

`docs/appdatabase-api.md` §2 (the **driver-consumable** table) and `types.go` both assert:

> retracted to `"False"`/`WarmthNotRequested` **in the same pass that releases the hold** … so a
> `"True"` here **never outlives the spec that asked for it**

and call `WarmHold` "**the only** true statement about whether the DB is warm right now".

That is false on the path the PR's own test exercises. Step 4c retracts the condition **in memory**;
`UpdateStatus` runs only at step 6. A sustained pageserver fault returns at step 5
(`reconcile.go:193-206`, `return true, fmt.Errorf(...)`) **every pass**, so through the API — the only
thing a driver can observe — `WarmHold` stays `True/TierWarm` and `Ready` stays `WarmHeld` for the
whole outage while nothing is held. `TestTierWarm_WithdrawalReleasesEvenDuringASustainedPageserverFault`
asserts on the in-memory `cr`, so it proves the release and the *intent*, not the observable status —
the "assert both halves" hazard this repo has hit repeatedly.

The staleness window is **not inherent**: `reconcileDelete` already sets the precedent
(`_ = d.Cluster.UpdateStatus(ctx, cr)`, best-effort, before the risky work).

**Smallest fix — pick one:**
- (a) doc-only: drop the absolute. State that the retraction is **best-effort within the pass** and
  that a pass failing before step 6 leaves the last-written status in place for the outage; point
  drivers at `status.observedGeneration` vs `metadata.generation` (already in the same table) as the
  staleness detector, and say the **gauge**, not the condition, is authoritative during an outage.
- (b) code: a best-effort `UpdateStatus` on the withdrawal branch, mirroring `reconcileDelete`, and
  a test that asserts the **persisted** status, not the in-memory struct.

(b) is what makes the sentence true; (a) is acceptable if the sentence changes with it.

## BLOCK 2 — `GW_MAX_CONNS` is process-wide, so §2a prices a fleet resource as per-app

New §2a costs the warm tier at "**1 connection of `GW_MAX_CONNS` (90)**". That reads as 1/90 of *this
app's* allowance. It is not. `connSem` is **one semaphore per gateway process**, taken in the accept
loop before any app is known (`gateway/internal/gateway/gateway.go:96,169,259`), and ADR-0003 corrects
this explicitly, twice: "*a **process-wide** goroutine ceiling shared across all apps … **not** a
per-app cap — an earlier revision of this ADR wrongly called it per-app*" (`adr-0003:232`, `:270`).
`81-apps-gateway.yaml:113` ("per compute … so this is per-app") and `adr-0008:114` ("90 per app") are
the pre-existing wrong comments the new doc has inherited.

Why this matters *for this PR* specifically, not as a pre-existing gripe: #388 holds are windowed and
few. #777 makes the hold **permanent** and attaches it to a first-class, tenant-settable field. N warm
apps therefore hold a **permanent floor of N slots out of 90 fleet-wide**, and exhaustion is refused
`53300` **to other tenants' clients** (`Serve`'s `default:` branch). That converts a per-app spec field
into cross-tenant availability coupling — the noisy-neighbour bound ADR-0003 claims, and my
"no shared-state assumption that breaks at N" question. At the lead's own "tens/low-hundreds of apps"
sizing, low-hundreds is **past the wall**, and nothing today caps, alerts, or documents it.

**Smallest fix (doc + one alert note, no code):** correct §2a's cost cell to say the slot comes from
the apps-gateway's **process-wide** `GW_MAX_CONNS` (90 per gateway pod), shared with all tenant
traffic; state the resulting practical ceiling on concurrently-warm apps and that exhaustion is
refused `53300` to *other* apps; cross-reference ADR-0003's "per-`{system}` gateway slot cap is a
fast-follow". While there, fix `81-apps-gateway.yaml:113` and `adr-0008:114`, which say the opposite
of the code.

## BLOCK 3 — the runbook sends operators to a `Ready` reason that cannot occur

`docs/operations.md` (new bullet): "**`Ready` with reason `WarmHoldDegraded`** → the CR asked for
warmth (`spec.tier: warm`, **or an active `spec.warmSchedule` window**)". The switch
(`reconcile.go:334-352`) sets `WarmHoldDegraded` only when `cr.Spec.Tier == "warm"`. A
schedule-only CR whose in-window hold fails reports `Ready`/`Provisioned`, message "*cold tier;
compute wakes on connect*". Its sub-bullets `InvalidWarmWindow` and `WindowInactive` likewise cannot
co-occur with that heading. §2 of the API doc is correct; the runbook is not.

**Smallest fix:** scope the heading to `spec.tier: warm`, and give schedule-only CRs their own line —
"a failed hold on a `warmSchedule` window shows on `WarmHold`, **not** on the `Ready` reason" — or
extend the switch to cover an active window. Doc-side is the smaller change and matches §2.

---

## Failure mode the tests do not yet cover

**Aggregate, cross-app hold pressure.** Every test drives one or two CRs through one `HoldManager`;
nothing exercises N warm apps against a finite gateway slot budget, so the first observation of
`53300` refusals to an *unrelated* tenant caused by warm holds will happen on a cluster, not in CI.
The cheap version is a unit assertion that N warm CRs produce exactly N distinct holds plus a
documented ceiling; the honest version is a drill line in `docs/drills/tier-warm-drill.md` measuring
`rejected_connections_total` against warm-app count.

Second, smaller: no test asserts the **persisted** status after a pass that fails before step 6
(BLOCK 1) — the current one asserts the in-memory CR and therefore stays green under the defect.
