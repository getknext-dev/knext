# ADR-0018 — Unified config: `NextApp.spec.database` delegates to scale-zero-pg

- **Status:** **Superseded by [ADR-0025](0025-remove-managed-database-mode.md)**
  (2026-07-15). The managed `spec.database.enabled` provisioning mode this ADR
  records was **removed** to honour the 2026-06-26 engine-agnostic DB-scope
  decision (knext builds no scale-to-zero-Postgres machinery). The BYO binding
  ([ADR-0019](0019-database-binding-secretref.md)) is now the only database
  surface. Kept for history — do not read the sections below as live contract.
  Was: Accepted (implements #119). Companion to the cross-repo design record
  [scale-zero-pg ADR-0006](https://github.com/getknext-dev/scale-zero-pg/blob/main/docs/adr-0006-unified-config.md),
  which owns the `AppDatabase` external-driver contract. This ADR records the **knext
  side**: the `spec.database` surface, the mirror, and the finalizer.
- **Date:** 2026-07-05
- **Relates to:** ADR-0001 (operator = single source of truth), ADR-0008 (NextApp
  deletion finalizer + app-scoped teardown), ADR-0017 (CRD stays `v1alpha1`).

## Context

The unified-platform vision — an app and its database both scale-to-zero, joined by a
single `DATABASE_URL` — was previously **assembled by hand**: provision an
`AppDatabase` in the scale-zero-pg namespace, find its Secret, copy it into the app
namespace, and reference it in `spec.secrets.envMap`. Four manual steps across two
namespaces, with **no lifecycle coupling** — deleting a `NextApp` silently leaked a
database, its Neon timeline, and safekeeper WAL.

## Decision

Add an optional `NextApp.spec.database` block. When `enabled`, the knext operator
**delegates** the database lifecycle to the scale-zero-pg `AppDatabase` operator
(delegation, **not** merged operators — knext scales apps, scale-zero-pg scales
databases; only the config surface is unified):

1. **Derive** a plane-globally-unique `appName` from the NextApp's own
   `(namespace, name)`. Never author-supplied — the security seam (a NextApp can only
   bind its own identity's DB). Recorded on `status.databaseAppName`.
2. **Create/own** an `AppDatabase` CR in the scale-zero-pg namespace (driven as an
   unstructured external-driver object; scale-zero-pg code is not imported).
3. **Hard-gate** the app on `AppDatabase.status.phase == Ready` — no Knative Service
   until the DB is provisioned, so an app never crash-loops on a missing DSN.
4. **Mirror** the minted `app-db-<appName>` Secret into the app namespace
   (`<name>-db`), owner-referenced to the NextApp (cross-ns `secretKeyRef` is
   impossible; same-ns ownerRef gives clean GC). Inject `DATABASE_URL` (+
   `DATABASE_URL_RO` when `readReplicas`).
5. **Cross-namespace teardown** via a `apps.kn-next.dev/db-cleanup` finalizer:
   ownerReferences cannot cross namespaces, so on delete the finalizer explicitly
   deletes the `AppDatabase` (its own deprovision finalizer reclaims the timeline)
   unless `keepOnDelete`. Best-effort/bounded — never wedge on an unreachable plane.

`appName` is **not** surfaced (derived); `tier`, `readReplicas`, `quotas`, and
`keepOnDelete` are. RBAC is a **scoped** `Role`/`RoleBinding` in the scale-zero-pg
namespace (`config/rbac/appdb_driver.yaml`) — least privilege, no storage-plane access.

## Consequences

- knext stays the **single writer** of app-namespace state (ADR-0001): the operator
  mirrors the Secret rather than adding a third controller (ESO/reflector), keeping
  rotation + GC semantics inside knext.
- The `AppDatabase` Secret + status is now a **public contract** knext depends on
  (owned/versioned by scale-zero-pg per ADR-0006).
- Two finalizers compose on `NextApp` (`external-cleanup` + `db-cleanup`); both clear
  independently.
- **BYO escape hatch preserved:** `enabled: false` leaves `spec.secrets.envMap`
  untouched — the inline path is additive.

## Alternatives rejected

- **Merged operators / knext builds DB machinery** — violates the two-layer platform
  boundary and knext's founding rule ("binds databases only via a Secret").
- **External projection (ESO/reflector) as default** — adds a third cluster-wide
  controller; kept as a documented fallback only.
- **Soft-deploy on DB-not-Ready** — trades a clear operator error for an opaque
  app-level crash-loop. Hard-gate chosen.
