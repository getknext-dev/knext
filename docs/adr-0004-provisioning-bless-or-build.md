# ADR-0004 — Provisioning interface: bless the imperative script, or build a CRD operator?

- **Status:** PROPOSED — **DECISION PENDING OWNER RATIFICATION.** This ADR records
  the evidence and a recommendation; the architecture owner ratifies (or overrides)
  the decision. It does **not** close #96 on its own.
- **Recommendation:** **BLESS** the hardened imperative `deploy/provision-app.sh`
  (with `fsck` as the reconciler) as the v1.0/GA provisioning interface for the
  demonstrated scale bound; **DEFER** the CRD operator behind explicit triggers.
- **Date:** 2026-07-04
- **Deciders:** architecture owner (ratify); evidence by the scale-ceiling drill
  (`deploy/_verify-scale-ceiling.sh`, #86) + the hardening shipped across
  #74/#76/#87/#89/#90/#91/#93.
- **Relates to:** #96 (GA criterion 1 of #73), ADR-0003 (branch-per-app; "Provisioning
  is imperative today" + the deferred-operator follow-up), ADR-0002 KC1 (ops toil).

---

## Context

Branch-per-app multi-tenancy (ADR-0003) provisions each app **imperatively** with
`deploy/provision-app.sh` — operator/CI tooling, not a Kubernetes controller.
ADR-0003 explicitly named a **CRD-driven `AppDatabase` operator** as the
productization path "if app churn grows," and marked it out of scope for the MVP.
GA criterion 1 (#73) forces the call now: **bless the imperative script as the v1.0
interface, or build the operator before tagging v1.0.**

This is a classic build-vs-buy-vs-bless decision. The honest inputs are (a) what an
operator actually *buys* at **the scale we have demonstrated**, (b) what it *costs*
to build and maintain, and (c) how much of the operator's value the imperative
script **already delivers** after four waves of hardening.

### Demonstrated scale (the number this decision rests on)

The scale-ceiling drill (`deploy/_verify-scale-ceiling.sh`, #86) provisioned apps on
one shared plane and measured the footprint. **Demonstrated: tens of apps on one
plane** (see `docs/BENCHMARKS.md` "Branch-per-app scale ceiling" for the exact N and
the p50/p95). The plane-side cost is **flat** in branch count over that range: the
template's `pitr_history_size` did **not** grow with branch count (all branches pin
the *same* template LSN), sleeping apps hold **zero** safekeeper WAL dirs and zero
compute, and the control-plane footprint is **linear** (1 Deployment + 1 Service +
1 ConfigMap + 1 Secret per app). This is the "tens/low-hundreds" regime ADR-0003
claimed — now measured, not asserted. It is **not** a thousands-of-apps or
high-churn (per-PR-preview) regime; that is the regime an operator is *for*.

---

## What a CRD operator buys — and whether we already have it

| Operator capability | Imperative status today | Gap? |
|---|---|---|
| **Declarative desired state** (`AppDatabase` CR = source of truth) | The per-app **ConfigMap** is the durable owner of record (`TIMELINE_ID`); `create` is intent-first + idempotent | Cosmetic: a CR is nicer to `kubectl get`, but the ConfigMap already *is* declarative state |
| **Continuous reconciliation** (control loop repairs drift) | `provision-app.sh fsck [--converge]` reconciles **both directions** (orphan branches ⇄ dangling intents) and auto-repairs; `reclaim-orphans` GCs | Partial: reconcile exists but is **invoked** (CI/cron/hand), not a always-on loop. Closable by scheduling `fsck --converge` as a CronJob |
| **Self-healing on node/pod loss** | Computes are plain Deployments — the **built-in** Deployment/ReplicaSet controller already reschedules them; scale-to-zero is gateway-driven | **None** — k8s already does this; an operator adds nothing here |
| **k8s-native RBAC / audit / GitOps** | Script runs with a human/CI identity; changes are git-tracked in `deploy/` | Minor: an operator gives per-CR RBAC + an audit trail. At tens of apps, PR-tracked `deploy/` + CI is sufficient |
| **Atomic create/destroy with finalizers** | `destroy` is safe-by-default (two-sided timeline delete, #91); crash-safe create (#76); pending-delete durably recorded (#91) | **None** — finalizer semantics are already emulated with the intent ConfigMap + reclaim ledger |
| **Quotas / policy admission** | Per-app CPU/mem/`max_connections` quotas (#89), name validation, reserved-name + `(user,db)` authz | **None** for the MVP policy set |
| **Fleet-scale orchestration** (thousands of apps, high churn, PR previews) | Sequential shell; provision latency is RTT-bound from a workstation | **Real** — this is where an operator wins. **Above** the demonstrated bound |

**Reading of the table:** every operator capability that matters *at tens of apps* is
already delivered by the hardened script — because the hard problems here were never
"reconcile a spec," they were **Neon-specific lifecycle correctness** (safekeeper
tombstones, two-sided WAL delete, branch-pins-ancestor, crash windows), and those are
solved in `provision-app.sh` regardless of whether a control loop drives it. The
operator's *unique* win — continuous fleet-scale reconciliation — only pays off in a
regime (thousands of apps / per-PR churn) we have **not** entered and do not need for
MVP-GA.

## What the operator costs

- **Build:** a Go controller (controller-runtime), an `AppDatabase` CRD +
  deepcopy/codegen, create/destroy/repair reconcile logic that must **re-encode every
  Neon lifecycle subtlety already in the script** (fresh-timeline-id vs tombstone,
  two-sided delete, intent-first ordering, reclaim ledger), RBAC, a new image on the
  pinned-digest treadmill, and a test suite (envtest/kind). Realistically a
  multi-day-to-multi-week build for parity, not a weekend.
- **Maintain:** a long-lived controller is a new **always-on** component to monitor,
  alert on, upgrade, and reason about during incidents — net-new operational surface
  on a project whose thesis (ADR-0002) is *reuse below the wire, build only the glue*.
  It also re-opens the version-treadmill cost KC4 tracks.
- **Risk:** re-implementing correctness that is already drilled green is a regression
  surface for zero user-visible gain at current scale.

---

## Decision (recommended, pending ratification)

**BLESS `deploy/provision-app.sh` + `fsck` as the v1.0/GA provisioning interface.**
Defer the CRD operator until an explicit trigger fires. The imperative path is GA-
blessable because it already carries the operator's *load-bearing* guarantees:

- **Crash-safe, idempotent create** (intent-first ConfigMap/Secret before branch, #76).
- **Bidirectional reconcile + auto-repair** (`fsck [--converge]`, #93a) — the
  "reconcile loop," on demand.
- **Safe deprovision + GC** (two-sided delete by default #91; `reclaim-orphans`
  #87/#90; durable pending-delete ledger).
- **Per-app quotas** (CPU/mem/`max_connections`, #89) — noisy-neighbour bound.
- **Tenant authz + no existence oracle** (#74/#92), credential rotation (#93b),
  strict name validation (#79).
- **Drilled green on-cluster** — `_verify-multitenant.sh`, `_verify-tenant-quotas.sh`,
  `_verify-scale-ceiling.sh`, `test_provision-app.sh`.

### The one hardening step to make "blessed" mean "reconciled continuously"

Schedule **`provision-app.sh fsck --converge`** (alongside the existing
`apps-wal-monitor` / `reclaim-orphans` cadence) as a CronJob, so drift is repaired on
a loop **without** a bespoke controller. This gives ~90% of the operator's
reconciliation value at ~1% of its cost, and is the concrete "blessable" gate. (Ship
under #96's execution once ratified; not built in this ADR's lane.)

### Triggers to revisit and BUILD the operator (revisit ADR-0003 follow-up)

Build the CRD operator when **any** fires:
1. App count or churn crosses **low-hundreds / frequent per-PR-preview** provisioning
   (knext ADR-0013 preview branches at volume).
2. Manual/CI provisioning **ops toil > ~1 eng-day/month** (ADR-0002 **KC1**).
3. Multiple independent teams need **self-service** provisioning with per-tenant RBAC
   and an audit trail that git-tracked `deploy/` no longer serves.

---

## Alternatives considered

- **Build the operator now (before v1.0).** Rejected for MVP-GA: it re-implements
  drilled-green correctness for zero user-visible gain at the demonstrated scale, adds
  an always-on component against the "build only the glue" thesis, and delays the tag.
  Kept as the *deferred* path with explicit triggers.
- **Bless the script but do nothing further.** Rejected: without a scheduled
  `fsck --converge`, "reconciliation" is purely reactive. The CronJob is the small,
  cheap step that earns the "blessed" label.
- **Neither — keep provisioning ad hoc.** Rejected: GA needs a *named, owned*
  interface with a reconciler, not undocumented tooling.

---

## Consequences

- v1.0 ships with a **named, hardened, reconciled** imperative provisioning
  interface; ADR-0003's "provisioning is imperative today / operator deferred" becomes
  a **ratified** stance with triggers, not an open question.
- The CRD-operator option stays open and cheap to start later (the script encodes the
  lifecycle a future controller would reuse as its reconcile spec).
- If the owner **overrides to BUILD**, this ADR's capability table + cost estimate is
  the build brief; the script becomes the reference implementation for the reconcile
  logic.
