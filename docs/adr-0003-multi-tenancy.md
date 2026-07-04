# ADR-0003 — Multi-tenancy: branch-per-app on a shared storage plane

- **Status:** ACCEPTED (2026-07-04) — **branch-per-app.** Each app is a Neon
  **timeline** branched from a shared **template** timeline under one "apps"
  tenant. N apps share one storage plane (pageserver + safekeeper quorum); each
  has its own stateless compute (Deployment) that scales 0↔1 independently. The
  apps-gateway (template mode) routes `database=<app>` → `compute-<app>`.
- **Date:** 2026-07-04
- **Deciders:** architecture owner (ratify); evidence by the branch-per-app spike
  + drill on the OKE cluster (context `context-ckmva7v7zvq`, ns `scale-zero-pg`).
- **Closes:** #6 (multi-tenancy: template mode end-to-end OR single-DB ADR).
- **Answers:** #65 / ADR-0002 **KC5** (branching unused) — this is the justifying
  Neon capability, wired and demonstrated on-cluster.

---

## Context

The product promise for knext is **DB-per-app** (each knext app — and eventually
each PR preview — binds its own `DATABASE_URL`). ADR-0002 chose Neon partly on the
thesis that a Neon-specific capability (branching / PITR / shared-pageserver
fan-out) would justify the reuse over the simpler CNPG path. **KC5** makes that a
kill criterion: if no such capability is *wired and demonstrated on-cluster* by
2026-10-03 (tracked as #65), the CNPG-pivot discussion re-opens.

Two topologies were on the table:

1. **Tenant-per-app** — a fresh Neon *tenant* (independent history) per app. Full
   isolation, but each tenant is a separate storage footprint and there is no
   shared template; provisioning re-runs initdb + migrations per app (slow, no
   copy-on-write reuse). This is not what Neon branching is for.
2. **Branch-per-app** — a fresh Neon *timeline* (branch) per app off a shared
   **template** timeline holding the base schema. Copy-on-write: the branch
   inherits the template's pages instantly and diverges lazily. One storage plane
   serves all apps. This is the Neon-native DB-per-app pattern.

The known risk going in (documented in `docs/operations.md` "What we learned" and
`_restore-writable.sh`): on `neon:8464` OSS the **safekeeper** has no HTTP
timeline-create API, and a fresh timeline with no safekeeper state historically
hit the `flush_lsn 0/0` / `prev_record_lsn 0/0` wall that blocks a **writable**
compute (the whole reason `skctl.py` exists for the cold-restore drill). The open
question for branch-per-app: **does a branched writable timeline hit that same
wall?**

---

## Decision

Adopt **branch-per-app on a shared plane**. The seam is exactly the parked
`template` wake mode ADR-0002 anticipated (`{system}` = database name).

- **Storage:** one "apps" tenant (`a000…001`), one **template** timeline
  (`a000…010`) seeded with the base schema (`schema_migrations` + sample tables).
  Each app is a branch (child timeline) created via the **pageserver ancestor
  API**: `POST /v1/tenant/<t>/timeline/` with `ancestor_timeline_id` +
  `ancestor_start_lsn` (the template's `last_record_lsn`).
- **Compute:** one stateless `compute-<app>` Deployment per app (template
  `deploy/compute-app.template.yaml`), `Recreate` strategy, `replicas: 0` at
  rest — identical to the single-DB primary except the tenant/timeline come from a
  per-app ConfigMap. The compute **image, entrypoint and spec are unchanged** — a
  new app costs one branch + one ConfigMap + one Deployment + one Service.
- **Routing:** a **separate** apps-gateway (`deploy/81-apps-gateway.yaml`,
  `GW_COMPUTE_MODE=template`) maps the DSN `database=<app>` to `compute-<app>`,
  scaling it 0↔1 on connect. The DSN database name is a **logical routing handle**:
  the gateway rewrites the replayed startup's database to the served DB
  (`GW_SERVED_DATABASE`, default `postgres`), so every branch serves its inherited
  `postgres` DB — an app never has to create a database named after itself. The
  primary single-DB gateway (`pggw`, kubectl mode) is untouched — multi-tenancy is
  additive, zero blast radius on the existing path.
  - **Both routing hops are proven live end-to-end.** The apps-gateway image was
    built from this change (`deploy/81-apps-gateway.yaml` is digest-pinned to it,
    contract 22) and rolled onto the cluster. `deploy/_verify-multitenant.sh`
    asserts the full gateway-fronted path: a client connecting `database=<app>`
    routes to `compute-<app>`, wakes it 0→1, has its database rewritten to the
    served `postgres` DB (`servedDatabaseRewriter` / `GW_SERVED_DATABASE`), and
    reads back **its own** data — with isolation still holding through the gateway.
    Unit tests: `dbrewrite_test.go`, `wake_test.go`. The served DB is always
    `postgres`; the app-facing database name is purely a routing handle.
- **Provisioning contract:** `deploy/provision-app.sh {init-plane|create <app>|
  destroy <app> [--keep-timeline]|reclaim-orphans|list|fsck}`. The per-app timeline
  id is minted fresh (random) on first `create` and persisted in the app's ConfigMap;
  re-provisioning reads it back (idempotent). **`destroy` reclaims the timeline —
  pageserver AND all safekeepers — BY DEFAULT** (#91): the safe path is the obvious
  command. `--keep-timeline` is the explicit PITR/forensics opt-out (it prints the
  orphan id + reclaim command). `reclaim-orphans` sweeps any orphan branch (no owning
  ConfigMap) + drains recorded SK-delete failures — the reclamation drill that closes
  the leak the wal-janitor only WARNs on (#87/#90). See "Deprovision is the sharp
  edge" below.

### The safekeeper finding (the thin ice held)

**A branched writable compute needs NO safekeeper craft.** Booting a read-write
compute on a freshly-branched timeline works out of the box on `neon:8464`:

- The branch is created on a **live** pageserver that already holds the ancestor's
  full page history and records the branch point (`ancestor_lsn`). The child
  timeline reports `prev_record_lsn: 0/0` at creation — the same shape that blocks
  cold restore — **but it does not block here.** When the child compute's
  walproposer connects, the safekeepers **auto-create** the branch timeline at the
  branch LSN, and WAL continuity is satisfied by the live pageserver.
- This is categorically different from `_restore-writable.sh`: that path stands up
  **fresh, empty** safekeepers from backed-up WAL with **no live plane**, so it
  must hand-craft `safekeeper.control` (`skctl craft`) to assert continuity. Branch
  creation never leaves the live plane, so that machinery is not needed.

Net: `skctl.py` stays scoped to disaster restore; branch-per-app rides the normal
walproposer init path. (If a future upgrade ships a first-class safekeeper
timeline-import API — the ops "upgrade carrot" — nothing here needs to change.)

**Deprovision is the sharp edge, not provision.** Two findings shaped the
lifecycle contract:

1. The pageserver `DELETE .../timeline/<id>` does **not** remove the
   safekeeper-side WAL — `provision-app.sh destroy` must also `DELETE` on the
   **safekeeper** mgmt API (port 7676, which *does* exist on 8464, unlike
   POST/PUT) on **all three** safekeepers, or per-app WAL dirs leak as apps churn.
   **This two-sided delete is now the DEFAULT** (#91) — the original contract made it
   opt-in (`--delete-timeline`), so the *obvious* `destroy` manufactured an orphan on
   every deprovision (it deleted the owning ConfigMap while keeping the branch). A
   safekeeper that is **down at destroy time** no longer loses its WAL dir silently
   (`|| true`): the failed delete is recorded to the `apps-wal-reclaim-pending`
   ConfigMap and reconciled by `reclaim-orphans`. Ongoing reclaim ownership is the
   **deprovision path**, not the janitor (which only ever fail-safe-skips, never
   over-prunes); the `apps-wal-monitor` CronJob + `SafekeeperWALGrowth` alert are the
   bound/signal that pages if residue accumulates anyway (#90/#87).
2. The safekeepers **tombstone** a deleted timeline id and refuse to recreate it
   (`create timeline: Timeline <id> has been deleted`). So the app→timeline id is
   **minted fresh (random) on each `create` and persisted in the app ConfigMap** —
   never derived from the app name — otherwise re-creating a destroyed app name
   collides with the tombstone and the compute hangs in the walproposer handshake.
   Re-provisioning an existing app is idempotent (reads the id back from the
   ConfigMap); a create after destroy gets a new id.

---

## Evidence (on-cluster, neon:8464)

Spike + productized drill on OKE (`context-ckmva7v7zvq`, ns `scale-zero-pg`):

| Step | Measure |
|------|---------|
| Branch create (pageserver ancestor API) | ~1.0s |
| Branch → **writable** compute Ready (cold, image cached) | ~3.5s |
| Full app provision (branch + ConfigMap + Deployment + Service) | ~4.0s |
| Template schema inherited by branch | yes — `app_items` seed row visible |
| Writable on branch (`pg_is_in_recovery()`) | `f` (read-write) |
| Safekeeper craft needed | **none** (walproposer auto-init) |

Isolation + independent-scale drill (`deploy/_verify-multitenant.sh`), two apps on
one plane, all connects **through the apps-gateway**:

- Both apps wake on first connect and see the inherited template schema.
- **Isolation holds:** app A's write is invisible to app B and vice-versa; each
  sees only its own write (timeline-level isolation).
- **Independent 0↔1:** scaling app A to zero leaves app B serving; app A wakes
  again on connect with its data intact.

(Provision-time row also recorded in `docs/BENCHMARKS.md`.)

---

## Consequences & caveats (blast radius / isolation)

- **Access control is the per-app credential + the gateway `(user,database)`
  refusal (issue #74).** Data isolation (below) is necessary but not sufficient:
  the apps-gateway is a byte pipe after the handshake and every branch serves a
  `postgres` DB, so *routing alone* let any client that could reach `pggw-apps`
  set `database=<other-app>` and connect as the shared `cloud_admin` — full
  read/write on a neighbour, and `database=tmpl` could mutate the shared template.
  The fix is two layers:
  1. **Gateway pre-wake authorization.** The apps-gateway (template mode) refuses
     any startup whose `(user, database)` is not `app_<db>/<db>`, whose database
     is not a valid RFC1123 label, or whose database is a reserved system name
     (`tmpl`/`warm`/`ro`) — *before* it wakes any compute. This alone stops
     cross-app DSN reuse, the `cloud_admin` path, and reaching the template/warm/RO
     computes through the apps-gateway. (`GW_APP_ROLE_PREFIX` / `GW_RESERVED_SYSTEMS`.)
     Refusal is a clean `28P01`; and to close the tenant-existence oracle the v0.6.1
     review found (issue #92), a valid-syntax pair for a **non-existent** app — whose
     wake would otherwise fail with `deployments.apps "compute-<x>" not found` — is
     mapped to the **byte-identical** `28P01 password authentication failed for user
     "<user>"`, with the internal cause logged server-side only and a constant-floor
     delay (`GW_AUTH_FAIL_FLOOR_MS`) equalising refusal latency. So "app absent",
     "wrong pair", and "wrong password" are indistinguishable on the wire.
  2. **Per-app Postgres credential.** `provision-app.sh` mints a role `app_<app>`
     with a random md5 password into a Secret `app-db-<app>`; `compute_ctl` applies
     that login role from the spec every boot (the documented MVP behavior). So a
     client that even *names* the right user still needs that app's password, which
     only its `DATABASE_URL` Secret holds. `cloud_admin` remains the admin, reached
     **direct-to-compute** only — never through the apps-gateway.
  Both layers are proven live in `deploy/_verify-multitenant.sh` (app A's DSN is
  denied against app B; `cloud_admin` is denied through the gateway; the app's own
  credential to its own db succeeds). **Trust boundary:** `pggw-apps:55432` is the
  multi-tenant front door — open to knext app pods (they are the tenants), so
  tenant isolation is *credential-based, not network-based*. The netpols
  (`70-networkpolicy.yaml`) keep the sensitive path (`compute-<app>:55433`)
  reachable only from the apps-gateway; a deployment that does not trust its own
  namespace can additionally restrict ingress to `pggw-apps` with a
  namespace/pod selector.
- **Provisioning is crash-safe / intent-first (issue #76).** `create` applies the
  per-app ConfigMap — the sole durable owner of the branch's `TIMELINE_ID` — *and*
  the credential Secret **before** the pageserver branch call. A crash between the
  two leaves a ConfigMap with no branch (harmless: re-run branches the *same* id
  and converges), never a branch with no owner (the orphan that pins template WAL
  invisibly). `provision-app.sh fsck` surfaces any pre-existing orphan (a branch
  with no owning ConfigMap) and exits non-zero.
- **Isolation is at the timeline level, not the tenant level.** All app branches
  share one pageserver, one safekeeper quorum, and one tenant. Data is isolated
  (each timeline is a separate logical DB history — proven), but **availability is
  shared**: a pageserver stall or safekeeper quorum loss affects every app. The
  pageserver is a single read SPOF mitigated by the warm standby
  (`57-pageserver-standby.yaml`); that mitigation now covers all apps at once — an
  upside (one thing to run) and a risk (one thing to lose). **Noisy-neighbour is now
  BOUNDED** (issue #89, was unbounded): each app's compute carries a per-app CPU
  request+limit, memory request+limit, and a per-app Postgres `max_connections` cap
  (`provision-app.sh create --cpu-limit/--mem-limit/--max-conns …`), so one runaway
  tenant cannot starve the node or open unbounded backends. Because each app is its
  own Postgres, the connection bound is per-app by construction. **Note:** the
  apps-gateway `GW_MAX_CONNS` is a **process-wide** goroutine ceiling shared across
  all apps (a connection-storm OOM guard), **not** a per-app cap — a per-`{system}`
  gateway slot cap is a fast-follow. Drill: `_verify-tenant-quotas.sh`.
- **Branches pin ancestor history — but the pin is FLAT in branch count (measured,
  #86).** A child timeline holds the template's history from its branch LSN; the
  template's WAL/pages cannot be GC'd below the oldest live branch point. Crucially,
  every app branches from the **same** template `last_record_lsn`, so N branches pin
  the **same** point — the scale-ceiling drill measured the template's
  `pitr_history_size` **unchanged** across N branches (it grows with branch *age/
  divergence past distinct LSNs*, not branch *count* at a shared LSN). Sleeping apps
  also hold **zero** safekeeper WAL (a branch at replicas 0 never runs walproposer).
  Dropping an app **deletes its timeline by default** (`provision-app.sh destroy
  <app>`, #91) so any pin is released on the obvious command; `--keep-timeline`
  retains it deliberately and leaves a reclaimable orphan (swept by
  `reclaim-orphans`). The WAL-janitor / PITR windows (issue #19) are template-wide.
- **Per-app compute cost is real; the DEMONSTRATED ceiling is tens of apps on one
  plane (issue #86).** Each awake app is one compute pod (default 250m/1000m CPU
  request/limit, 256Mi/1Gi mem). Idle apps cost **zero** compute (scale-to-zero) and
  zero safekeeper WAL; each holds a branch (storage) and a linear
  Deployment/Service/ConfigMap/Secret (control-plane) footprint. The scale-ceiling
  drill (`_verify-scale-ceiling.sh`) **provisioned 30 apps on one shared plane** with
  flat template WAL pin, flat safekeeper WAL, and linear control-plane growth; cold-
  wake still routes each app to its own branch (a pooled/retrying client rides
  through the first-connect role-apply window — see below). The honest bound is
  therefore **tens of apps on one plane** (low-hundreds plausible on plane resources,
  not yet drilled); **not thousands / not high-churn per-PR-preview** — that regime is
  what a CRD operator (ADR-0004) is for. Exact numbers: `docs/BENCHMARKS.md`
  ("Branch-per-app scale ceiling").
- **Cold-wake role-apply race (measured, #86).** A freshly-woken compute opens its
  Postgres port a beat before `compute_ctl` finishes applying the per-app login role,
  so a **one-shot** client's very first connect can see a transient `28P01`. A knext
  app (connection **pool**) retries and connects; this is a first-connect timing
  window, not a data/availability defect. Documented in `docs/operations.md`.
- **Schema template drift.** Apps branch from the template *as it was at their
  branch LSN*. Rolling out a new base migration to the template does **not**
  retroactively update existing app branches — they own their schema after
  branching (that's the point). A migration runner per app is the app's concern
  (knext owns migrations); the template is a fast-start mold, not a live parent.
- **Connection bounds — corrected (issue #89).** Postgres `max_connections` is
  **per-app** (each app is its own compute/Postgres; default 100, tunable per app via
  `--max-conns`). The apps-gateway `GW_MAX_CONNS=90`, by contrast, is a
  **process-wide** goroutine ceiling on `pggw-apps` shared across *all* apps (a
  128Mi-gateway OOM guard), **not** a per-app cap — an earlier revision of this ADR
  wrongly called it per-app. A per-`{system}` gateway slot cap is a fast-follow;
  meanwhile the per-app Postgres cap is the real per-tenant bound, and a hostile
  flood beyond it is refused fast by that app's own Postgres (drill
  `_verify-tenant-quotas.sh`).
- **Provisioning is imperative today — recommended BLESSED for GA (ADR-0004, #96).**
  `provision-app.sh` is operator/CI tooling, not a controller, but it now carries the
  operator's load-bearing guarantees (crash-safe idempotent create, bidirectional
  `fsck` reconcile, safe deprovision + GC, per-app quotas). ADR-0004 recommends
  **blessing** it as the v1.0 interface at the demonstrated scale (with a scheduled
  `fsck --converge` as the reconciler) and **deferring** the CRD-driven `AppDatabase`
  operator behind explicit triggers (app churn / low-hundreds / KC1 ops toil).
  **Decision pending owner ratification.**
- **Version coupling unchanged.** App computes use the same pinned
  `compute-node-v17:8464` / `neon:8464` pair; the triple-pin (ADR-0002 amendment)
  and `skctl` format weld are unaffected — branch-per-app adds no new
  version-coupled artifact.

---

## Alternatives considered

- **Tenant-per-app** — rejected: no shared template (no copy-on-write fast start),
  larger storage footprint, and not what branching exists for. Stronger isolation,
  but the MVP's isolation need is data-level, which timeline branching meets.
- **Single-DB only (park multi-tenancy)** — the honest fallback had the spike
  failed. It did not: branch-per-app is viable on 8464 with no new machinery, so
  parking it would forfeit the KC5 justifying capability and the DB-per-app product
  promise. Rejected.
- **One shared DB, schema-per-app / row-level tenancy** — rejected: no
  scale-to-zero per app, no independent PITR, and app isolation becomes an
  application-code concern rather than a storage guarantee.

---

## Follow-ups

- knext contract: DB-per-app `DATABASE_URL` (per-app credential) →
  `postgres://app_<app>:<per-app-password>@pggw-apps.scale-zero-pg.svc:55432/<app>`,
  read from the Secret `app-db-<app>` that `provision-app.sh create` mints (see
  `docs/connecting.md` "Multi-app / branch-per-app"). `cloud_admin` is refused
  through the apps-gateway.
- If app churn or PR-preview branches (ADR-0013 on the knext side) push volume
  up, revisit: (a) a CRD-driven provisioning operator, (b) per-app PITR/GC
  windows, (c) tenant sharding across multiple pageservers.
