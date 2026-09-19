# ADR 0004 — Failover promotion scope == routing scope, and the generation ledger as sole authority

Status: Proposed
Date: 2026-09-20

> Numbered within the `docs/adr/` sub-series (0001–0003 exist here). This is distinct
> from the root `docs/adr-000N-*.md` series.

## Context

The pageserver auto-failover controller (`pswatcher`) converts the manual failover
runbook into an automatic action: on sustained primary-pageserver death it promotes
the warm standby at `generation+1`, flips the client `pageserver` Service selector to
the standby, and bounces the compute so a cold wake re-attaches to the promoted node.

Two defects were found in that path.

**1. Promotion scope was narrower than routing scope (split-brain).** `pswatcher`
promoted exactly ONE tenant — the base tenant (`PSW_TENANT_ID`). But the `pageserver`
Service it flips routes EVERY tenant the storage plane holds. Investigating the actual
tenant topology:

- The **base tenant** (`f000…`, `compute-config` `TENANT_ID`) — the base app and its
  warm / read-only computes all attach here.
- The **apps tenant** (`a0000000000000000000000000000001`, `APPDB_TENANT_ID` /
  `APPS_TENANT`) — **every per-app `AppDatabase` is a *timeline* branched under this ONE
  tenant**, not a separate tenant (`provision-app.sh`: "each app is a Neon TIMELINE …
  under one 'apps' tenant"; the appdb-operator branches timelines under
  `APPDB_TENANT_ID`).

Neon attach/generation is **per-tenant** (`PUT /v1/tenant/<T>/location_config`), so the
complete routed-tenant set is exactly **{base, apps}** — two well-known ids. Promoting
the apps tenant re-attaches ALL its per-app timelines in one call. Because the old code
promoted only the base tenant, a failover stranded every per-app database on the demoted
pageserver — the split-brain the live GKE run hit and the failover drill's multi-tenant
reachability assertion catches.

**2. The generation ledger's write/heal side was unowned.** T1 (#1095) made the durable
`pageserver-generation` ConfigMap the read authority: bootstrap attach paths read
`max(ledger, pageserver-view, 1)` and **fail closed** on an unreadable/empty ledger. But
T1 also found an upgrade hazard: applying `deploy/57` (which deliberately ships the key
UNDECLARED, `data: {}`) three-way-prunes a live `generation` key from a pre-#1095
install's last-applied-configuration (proved on kind: live `5` → apply → empty). The
fail-closed readers then REFUSE rather than silently floor to `1` — safe, but it turns
an upgrade into a manual runbook step. T1 handed the write/seed/heal side to this task.

## Decision

1. **Promotion scope == routing scope.** On failover, `pswatcher` promotes EVERY tenant
   the flipped `pageserver` Service routes — the base tenant AND the apps tenant — each
   re-attached at the incremented generation, BEFORE the selector flip. The routed set is
   configured explicitly (`PSW_TENANT_ID` + `PSW_APPS_TENANT_ID`), not discovered by
   listing `AppDatabase` CRs: per-app databases are timelines under the single apps
   tenant, so there is no per-app *tenant* to enumerate, and avoiding a CRD list keeps the
   RBAC surface unchanged. A tenant the pageserver does not hold (`ErrTenantNotFound`,
   e.g. an unprovisioned apps tenant) is SKIPPED and counted
   (`pswatcher_tenant_absent_total`); any OTHER promotion error ABORTS the failover before
   the flip (retried next tick), so a tenant that DOES exist is never stranded. The flip
   proceeds only if at least one routed tenant was actually promoted.

2. **The `pageserver-generation` ledger is the sole authority.** `pswatcher` is its sole
   WRITER (advances it on failover) and its SEEDER/HEALER (startup). The single shared
   ledger advances EXACTLY ONCE per failover for the whole plane; every routed tenant is
   promoted at that one generation. Readers (storage-init, provision-app.sh) attach at
   `max(ledger, pageserver-view, 1)` and fail closed — T1's read contract, ratified here.

3. **Startup seed/heal.** At startup `pswatcher` seeds/heals the ledger to
   `max(current ledger, pageserver's current generation view, base)`, reading the
   pageserver view from the PRIMARY (the pre-failover authority, `GET /v1/tenant/<base>`,
   top-level `generation`). It NEVER lowers the ledger, and if the pageserver view is
   unavailable it leaves the ledger untouched (never floors on an unavailable vantage).
   This auto-corrects the upgrade-path prune — recovering the true generation from the
   pageserver — converting T1's loud fail-closed refusal into automatic recovery.

4. **Single-writer safety is preserved.** `pswatcher` stays a single-replica, crash-only,
   lease-free singleton (`strategy: Recreate`; single-writer is intrinsic to Neon, the
   higher generation fences the dead primary). Multi-tenant promotion is idempotent and
   generation-guarded: re-running converges (each tenant re-promoted at the same
   generation until the flip completes), the ledger never double-advances (advanced once,
   after all tenants promoted), and never promotes below the ledger (`newGen = ledger+1`).

5. **Standby warms the apps tenant (best-effort).** The standby-init Job registers the
   apps tenant as a warm Secondary alongside the base tenant, so a promotion is a warm
   re-attach rather than a cold object-store fetch. Best-effort: correctness does not
   depend on it (AttachedSingle cold-attaches from the shared bucket), so an unprovisioned
   apps tenant does not fail the Job.

## Options considered

| Option | How the routed set is known | Trade-offs |
|---|---|---|
| **A. Configured tenant set {base, apps} (CHOSEN)** | Two well-known ids via env | Matches the real topology (per-app = timelines under one apps tenant); bounded + deterministic; no new RBAC; correct regardless of standby warming (cold attach works). Residual: a tenant id added to the plane outside {base, apps} would need a config change (none exists today). |
| B. List `AppDatabase` CRs and promote each | Kube API list of the CRD | Architecturally wrong — AppDatabases map to timelines under ONE tenant, not to tenants; promoting "per app" would repeatedly re-attach the same apps tenant. Adds CRD list RBAC for no benefit. |
| C. Enumerate from the pageserver's tenant list (`GET /v1/tenant`) | The promotion-target (standby) | Elegant ("promote what the target holds") but only lists tenants registered on the standby (Secondary locations); an apps tenant provisioned AFTER standby-init, or never warmed, is missed → the exact split-brain. Rejected as the sole source; the standby list is an optimisation, not the authority. |
| D. Per-tenant generation ledgers | one ledger key per tenant | Both tenants have always shared one ledger (storage-init + provision-app read the same `pageserver-generation`); per-tenant ledgers would fork the authority and complicate the reader contract for no gain (both attach at the same generation). |

For the seed/heal source we chose the PRIMARY's generation view (pre-failover authority)
over the standby's (which holds Secondary locations that may report a stale generation).

## Consequences

**Positive.**
- A failover recovers reads for EVERY tenant the Service routes — the split-brain is
  closed; the failover drill's multi-tenant reachability assertion goes green.
- The upgrade-path ledger prune self-heals at pswatcher startup — T1's manual runbook step
  becomes automatic, while the fail-closed reader guarantee is unchanged.
- RBAC is unchanged (config + pageserver HTTP only; no `AppDatabase` list).
- New per-app databases are covered for free — they are timelines under the already-routed
  apps tenant.

**Negative / residual (stated honestly).**
- The routed set is config-driven. A future tenant beyond {base, apps} would require a
  `PSW_APPS_TENANT_ID`-style addition; there is no auto-discovery. This matches the fixed
  two-tenant topology but is a coupling to note if the topology grows.
- The `GET /v1/tenant/<T>` top-level `generation` field and the `PUT location_config`
  404-on-unknown-tenant behaviour are pinned to the live pageserver (neon:8464) and
  asserted on-cluster by the failover drill — off-cluster unit tests fake them. A future
  pageserver image change to either shape would need re-verification.
- Apps-tenant warming on the standby is best-effort and one-shot at deploy; an apps tenant
  provisioned long after standby-init runs is promoted COLD (correct, slower) until the
  Job is re-run. The correctness of the promotion does not depend on the warm.
- Single-replica crash-only means a brief promotion gap during a watcher restart persists
  (unchanged by this ADR); recovery is idempotent.

## Action items

- [x] `pswatcher` promotes every routed tenant at the incremented generation, skip-absent
      / abort-on-real-error, flip only after ≥1 promoted (`internal/pswatcher/watcher.go`).
- [x] Startup ledger seed/heal to `max(ledger, pageserver-view, base)`, never lowering
      (`SeedLedger`, wired in `cmd/pswatcher/main.go`).
- [x] `HTTPGenerationViewer` (primary generation view) + `ErrTenantNotFound` on 404
      (`internal/pswatcher/http.go`).
- [x] `PSW_APPS_TENANT_ID` + `PSW_PRIMARY_BASE_URL` env (`deploy/58-pswatcher.yaml`);
      standby warms the apps tenant best-effort (`deploy/57-pageserver-standby.yaml`).
- [x] `pswatcher_tenant_absent_total` metric.
- [x] Unit tests: all-tenants promotion, skip-absent, abort-on-real-error, seed/heal
      (up + never-down + unreachable), multi-tenant idempotency — each mutation-proved.
- [ ] On-cluster verification via the failover drill (owned by the drill task, #1101).
