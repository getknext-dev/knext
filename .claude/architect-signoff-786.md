SIGN-OFF

# Architect sign-off — PR #786 (`fix/tier-warm-on-warmhold`, head bcd87a1)
**Scope:** architecture only (ADR compliance · sequencing · boundaries/contracts · positioning ·
decision hygiene). Read-only. Reviewed in worktree `agent-ae5f5354a47b82988`, diff
`origin/main...HEAD` (15 files, +943/−123).

## Verdict: **SIGN-OFF**

## 1. ADR / hard-rule compliance — clean

- **#766 gate ruling (the pre-ruled shape of the keep-warm knob) — obeyed exactly.** The ruling
  fixed three things: the held gateway connection IS the keep-warm actuator, **no `minWarm` /
  replica-floor field lands**, and **the gateway stays the single writer of per-app replicas**.
  This PR moves `tier: warm` *onto* that actuator rather than adding a second one. Verified, not
  assumed:
  - `desiredReplicas()` now returns **0 for both tiers** (`types.go`), with the reason documented
    at the one named site rather than inlined away;
  - **no new spec field** — the CRD diff is printer-column + `description` text only; no enum,
    validation, or property change;
  - **no replica/Scale write added** — the appdb operator's RBAC is untouched (no
    `deployments/scale`), `ApplyCompute`'s preserve-live-replicas behaviour is untouched, and the
    only new cluster interaction is a **client dial** through the apps-gateway.
  This closes, rather than reopens, the two-writer defect ADR-0030 §Context records.
- **ADR-0030 + its 2026-07-18 addendum (#388) — extended, not contradicted.** One actuator, two
  ways in (permanent / windowed). The addendum's lockstep promise ("during a declared window the
  DB is warm") holds *a fortiori* under a permanent hold, and the shared-owner-declaration seam is
  unchanged. `WarmHold` / `appdb_warm_hold_active` / degrade-not-fail semantics are reused, not
  duplicated.
- **ADR-0007 §4c (zoned consistency, option (i))** — correctly amended in-commit (`cd74257`):
  mechanism restated as a permanent hold, **promise unchanged** (a publishing zone never sleeps).
  That is the right shape of amendment — it does not relitigate the ratified option.
- **ADR-0001 / knext hard rules** — untouched. No CLI cluster write, no raw Knative manifest, no
  out-of-band mutation, no second writer of deployment shape. The change is entirely inside the
  scale-zero-pg control plane it already owns.
- **Honest-status discipline** is *strengthened*: `Ready` can no longer report warm-and-healthy on
  a tier that is running cold (`WarmHoldDegraded`), and `WarmHold` is **retracted** on withdrawal
  so a `True` never outlives the spec that asked for it.

## 2. The three items flagged into my field of view

**(1) Printer column `Ready` → `Compute` (`deploy/82-appdb-crd.yaml`).** Safe in both upgrade
directions, and the upgrade note is *not load-bearing here*: `additionalPrinterColumns` is display
metadata, not stored schema — no field, enum, or validation changed, so **operator-new + CRD-old**
and **operator-old + CRD-new** both behave identically; the only divergence is a header string.
This is the benign end of the CRD-surface class (unlike the knext-side apiVersion/unknown-field
hazard, which needs the operator/CRD-first order). Nothing in `deploy/_validate.sh`, the drills, or
any script parses that header. The rename is also *correct*, not cosmetic churn: keeping a column
named `Ready` next to a `Ready` condition that deliberately no longer tracks it was the trap.

**(2) Withdrawal release moved to step 4c, before the pageserver steps.** Violates no ordering
invariant. Step 4's real invariant — **the compute is applied at 0 before the branch exists** — is
untouched; only the *release* (a map delete + a socket close, needing neither branch nor timeline)
moved ahead of steps 5/5b. The asymmetry is principled and stated in the code: the **ensure** half
still runs after the branch (5c) so a first-ever warm create never dials a timeline that does not
exist, while the **release** half must not sit behind a step that returns early — the round-2 test
pins exactly that (a sustained pageserver fault used to keep a withdrawn hold alive for the whole
outage). Trading ensure-latency (one ~15 s resync tick) for never leaking a withdrawal is the right
direction: a late ensure self-heals, a leaked hold does not.

**(3) `tier: warm` subsumes `warmSchedule`.** Consistent with ADR-0030's model. A permanent hold is
a strict superset of any window set, so no declared window can be under-served, and the rule
removes a genuine hazard (a window boundary dropping a *permanent* tier's hold). The one accepted
cost — a malformed window on a warm-tier CR is inert and raises no `InvalidWarmWindow` (this CRD
has no admission webhook) — is explicit in code, in the CRD description, and in
`appdatabase-api.md` §2a, and it surfaces loudly the moment the tier flips to `cold`. Accepted as
documented.

## 3. Boundaries, sequencing, positioning

- **Boundaries:** one actuator, one owner. Operator = declarative intent + hold; gateway = replicas.
  No new control loop, no new config channel to the data-plane proxy, no RBAC growth.
- **New standing cost, correctly disclosed rather than hidden:** one connection of `GW_MAX_CONNS`
  (90) per warm app, held forever, plus a liveness ping per resync. Documented in the §2a cost
  column; bounded well inside the demonstrated 30-app ceiling. Wake-budget (ADR-0008) exposure is
  the same class #388 already accepted (re-dial only on failure), and the runbook now names the
  `pggw_system_wake_budget_exceeded_total` cross-check.
- **Alert integrity preserved:** release-on-withdrawal + absent-series (not `0`) semantics keep the
  `ComputePhantomKeepalive` subtraction from blinding the alert that would catch a leak — the
  failure mode that made this defect self-concealing.
- **Sequencing:** this is Tier-A-class *correctness* (a shipped tier that silently degraded after
  its first idle window), not deferred scope pulled forward. Nothing here builds toward a general
  PaaS; the surface got **smaller** (no new field), which is the right direction for positioning.

## 4. Non-blocking items for the lead (fix pre-merge where cheap)

1. **Two stale column headers, in docs this PR already edits** — `docs/operations.md:1633`
   (`APP PHASE TIMELINE READY TIER AGE`) and `docs/getting-started.md:166`
   (`READY <bool>`) still print the pre-rename header, while new text in the same file says
   "printed as the `Compute` column". Two lines; package rule 2b calls doc drift a defect. Not an
   architecture block — flagged to the code-review track.
2. **`docs/adr-0006-unified-config.md`** still describes the field as
   *"warm = one parked replica for ~0.4s wake"* — the mechanism this PR replaced. Same class as the
   ADR-0007 amendment that *was* made; it should get the same one-line treatment.
3. **`docs/guides/database-platform.md:144`** (knext-side, user-facing) sells the warm tier as
   "a parked pod … ~0.4 s wake". Under the hold there is no wake at all; the number also came from
   the unshipped Neon warm-standby pool, so it was already generous. Follow-up.

## 5. ADR to write / update (follow-up, not a merge gate)

Add a dated **addendum to ADR-0030** (the addendum that already owns the warm-hold actuator)
recording the two decisions this PR makes that live only in code comments and API docs today:
**(a)** `AppDatabase.spec.tier: warm` is actuated as a permanent hold on that same actuator — the
tier is a *latency* property, never a replica floor or a serving gate; **(b)** the **precedence
rule** (tier subsumes `warmSchedule`; windows unevaluated and invalid windows inert on a warm
tier), plus the consequent demotion of `status.computeReady` to diagnostic-only. Both are
CR-surface semantics decided by lead's call in #777; ADR-0006's stale field comment should be
fixed in the same pass.

---

# Addendum — delta `bcd87a1..0d8f900` (system-designer BLOCK fixes)

**The SIGN-OFF above CARRIES OVER.** Reviewed the two new commits (`7bf3120` red, `0d8f900` green;
8 files, +129/−16). Nothing in the delta touches the CRD, the single-writer invariant, the
`desiredReplicas() == 0` decision, or the 4c/5c ordering I reviewed — and all three architectural
questions I could raise against it check out.

## (1) The early best-effort `UpdateStatus` in the withdrawal branch — clean

Three hazards this class of change usually carries, all checked in the tree rather than assumed:

- **Optimistic-concurrency interference with the step-6 write:** none.
  `K8sCluster.UpdateStatus` (`k8s.go:427`) does a fresh **GET before every write** and swallows
  `IsConflict`/`IsNotFound` as benign, so the second write in the same pass re-reads the live object
  — the two writes cannot stale-fight each other. Cost is one extra GET+UPDATE **per withdrawal
  transition**, not per tick (the `alreadyRetracted` guard), which is the right side of the
  status-churn trade.
- **Premature "settled" status:** none, and this is the subtle one.
  `cr.Status.ObservedGeneration` is assigned at **line 292 (step 6)**, *after* the early write at
  line 199 — so a pass that fails in the pageserver steps publishes the retraction while
  `observedGeneration` still trails `generation`. A driver using the documented
  "detect stale status after a `spec` edit" gate therefore still reads *not yet reconciled*, which
  is the truth. Had the early write carried the new generation it would have been a real contract
  break; it does not.
- **Intermediate condition pairing:** during a sustained pageserver outage an observer can now see
  `WarmHold=False/WarmthNotRequested` alongside a not-yet-resettled `Ready=True/WarmHeld`. This is
  strictly **more** honest than what it replaces (`WarmHold=True/TierWarm` while nothing is held),
  and it is consistent with the §2 contract, which makes `WarmHold` the authority on warmth and the
  `Ready` reason its echo. Accepted.

Following the `reconcileDelete` precedent (`reconcile.go:486,539`) rather than inventing a new
persistence path is the right call — same seam, same best-effort semantics, no new writer.

## (2) The `GW_MAX_CONNS` docs corrections — a correction, correctly cited

Verified against the code and the cited ADR, since a wrong citation is the failure mode this repo
has been bitten by: `gateway.go:96,168` holds **one `connSem` per process**, taken in the accept
loop, and `adr-0003-multi-tenancy.md:232,272` already states "**process-wide** … shared across all
apps". So the two comments this delta fixes (`81-apps-gateway.yaml`, `adr-0008` §bounded-damage)
genuinely said the opposite of the code, and the fix cites the ADR that was right all along.

This materially **improves** the cost disclosure in my §3 finding: a permanent hold does not spend a
per-app slot, it spends one of **90 shared per gateway pod**, so warm-hold pressure is fleet-wide
and exhaustion refuses `53300` to *every* app. Pricing that in `appdatabase-api.md` §2a is the
correct response — it is a **disclosed, bounded** standing cost, not a new architectural risk, and
it stays well inside the demonstrated 30-app ceiling. Fixing a doc that contradicted the code is
squarely within this repo's stale-doc discipline; it needs no ADR amendment (ADR-0003 already says
the right thing, and ADR-0008's edit is a correction to a supporting sentence, not to its decision).

## Follow-up added by this delta (non-blocking)

**Give the fleet-wide warm-hold ceiling an operational guard, not just a doc paragraph.** The
platform now has a standing, permanent consumer of a shared 90-slot semaphore with no signal before
exhaustion — and exhaustion is a **fleet-wide** `53300`, not a per-app degradation. The ingredients
already exist: alert on `sum(appdb_warm_hold_active)` crossing a fraction of `GW_MAX_CONNS` in
`60-prometheus.yaml`. Worth an issue; it is capacity observability, not a gate on this PR.

Earlier follow-ups (stale `READY` column headers, ADR-0006's "one parked replica" comment, the
knext-side `database-platform.md:144` claim, and the ADR-0030 addendum) stand unchanged.

**Verdict on the delta: SIGN-OFF carries over — no new concern.**
