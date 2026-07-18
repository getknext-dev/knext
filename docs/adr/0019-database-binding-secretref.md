# ADR-0019 — First-class Postgres binding: `spec.database.secretRef` (BYO mode)

- **Status:** Accepted
- **Date:** 2026-07-06
- **Relates to:** ADR-0001 (operator = single source of truth), ADR-0018
  (`spec.database` managed mode — delegated scale-zero-pg provisioning),
  the 2026-06-26 scope decision (knext stays **engine-agnostic** and builds
  **no** database scale-to-zero machinery).

## Context

Binding a NextApp to an **existing** Postgres (the pggw/scale-zero-pg DSN, a
managed cloud Postgres, anything) has been a **manual recipe**: users hand-wire

```yaml
spec:
  secrets:
    envMap:
      DATABASE_URL: { secretName: shop-db, secretKey: DATABASE_URL }
```

This is proven live — the scale-zero-pg demo on knext2 runs exactly this — but
it is untyped and has real footguns the recipe cannot enforce or even surface:

- **Doc drift**: the recipe lives in prose, drifts, and every consumer re-derives
  the same four lines (scale-zero-pg's own #32-class doc-drift pain).
- **Contract footguns** (measured on knext2): the app's Postgres **pool idle
  timeout must be below the gateway's 60s idle window**, or the pool holds dead
  sockets and the first request after gateway idle-close fails; the client
  **connect timeout must be ≥ 10s** to survive a ~2.5s cold DB wake with margin.
- **Cold-start shape** (measured): when app and DB are both at zero, the DB
  cold-connect happens **inside the app's activation window** — total
  time-to-first-byte T_both ≈ 13s and is **app-dominated**, not additive
  (the DB's ~2.5s wake overlaps the app's own cold start).

Separately, ADR-0018 (#219) already claimed `spec.database` for the **managed**
mode (delegated auto-provisioning via an `AppDatabase` CR). A second, sibling
field for BYO would fork the author surface; the BYO binding belongs on the
same block as a mutually-exclusive mode.

## Decision

Extend `NextApp.spec.database` with a **binding (BYO) mode**:

```yaml
spec:
  database:
    secretRef:   { name: shop-db }                   # -> env DATABASE_URL
    roSecretRef: { name: shop-db }                   # -> env DATABASE_URL_RO (optional)
```

- `secretRef: {name, key?}` maps the named same-namespace Secret's key to the
  container env var `DATABASE_URL`. `key` defaults to `DATABASE_URL`.
- `roSecretRef: {name, key?}` optionally maps a read-only DSN to
  `DATABASE_URL_RO`. `key` defaults to `DATABASE_URL_RO`, so the common pggw
  pairing (one mirrored Secret carrying both keys) binds with zero `key`
  configuration.
- **Sugar over the proven envMap path, NOT a new env mechanism**: the
  reconciler injects the binding into the **in-memory** `spec.secrets.envMap`
  and the existing envMap → `SecretKeyRef` wiring does the rest — the exact
  machinery ADR-0018's managed mode already reuses (`injectDatabaseEnv`).
  Dedupe/ordering/`spec.env` precedence rules are therefore identical by
  construction.
- **Secret-missing behavior = envMap semantics**: the operator wires the
  `SecretKeyRef` without gating on the Secret's existence (kubelet surfaces
  `CreateContainerConfigError` until it appears). No hard-gate — that is a
  managed-mode (ADR-0018) property, because only there does the operator own
  the Secret's lifecycle.
- Status surface: `status.databaseSecretName` records the bound Secret and
  condition `DatabaseReady=True/Bound` is set (auditability parity with the
  managed mode).

### Admission validation

| # | Rule | Outcome | Enforced by |
|---|------|---------|-------------|
| 1 | `secretRef.name` / `roSecretRef.name` must be a DNS-1123 subdomain (≤253) | REJECT | CRD CEL/pattern + shared `validation` pkg |
| 2 | `key` omitted | defaults `DATABASE_URL` / `DATABASE_URL_RO` | reconciler |
| 3 | `spec.database` defines `DATABASE_URL` (any mode: `secretRef` **or** `enabled: true`) **and** `spec.secrets.envMap` also defines `DATABASE_URL` | REJECT on create / on updates that ADD it — no silent precedence | **webhook only, ratcheted** |
| 4 | same for `DATABASE_URL_RO` (`roSecretRef` or `enabled+readReplicas` vs envMap) | REJECT (as rule 3) | **webhook only, ratcheted** |
| 5 | `enabled: true` together with `secretRef` (managed vs BYO) | REJECT — one mode per app | CRD CEL + shared `validation` pkg |
| 6 | `roSecretRef` without `secretRef` | REJECT | CRD CEL + shared `validation` pkg |
| 7 | provisioning knobs (`tier`, `readReplicas`, `quotas`, `keepOnDelete`) together with `secretRef` | REJECT — managed-mode-only, never silently ignored | CRD CEL + shared `validation` pkg |

Rules 1/5/6/7 are intra-`spec.database` shape rules: a stored CR either
satisfies them or was never valid, so they live in both CRD CEL and the shared
`validation.ValidateNextAppSpec` (run by the webhook AND the fail-closed
reconciler).

Rules 3/4 (the envMap collision) are different: CRs stored **before** these
rules existed can legally carry the collision — including ADR-0018 managed-mode
CRs that combined `enabled: true` with an author `envMap[DATABASE_URL]` (then
silently overridden). Failing them closed would **brick running apps on
operator upgrade**, so they are enforced with **true ratcheting** (the
Kubernetes pattern), chosen over hard-fail-honestly:

- **Webhook** (`ValidateNextAppSpecCreate` / `ValidateNextAppSpecUpdate`):
  REJECT any collision on CREATE; on UPDATE reject only a collision the update
  **adds** (compared per env-var name against the old spec). An update that
  merely carries a pre-existing collision forward — an image bump — is allowed.
- **Not CRD CEL**: a spec-root CEL rule re-fires on *any* spec change, so a
  stored collision CR would be rejected on its next unrelated update — the
  exact harm ratcheting exists to prevent. Collision enforcement is therefore
  deliberately webhook-only.
- **Reconciler**: the shared fail-closed `ValidateNextAppSpec` does NOT include
  rules 3/4. A stored collision CR reconciles normally and `spec.database` wins
  **deterministically and loudly** — a Warning event (the #186/#191
  collision-event semantics) names the ignored envMap entry, in BOTH modes.
  Never `Degraded/InvalidSpec`, never silent.

Net effect vs ADR-0018: the previously *silent* managed-mode override becomes
(a) an admission error for every NEW configuration and (b) a Warning-evented
override for grandfathered ones.

## Options considered

| Option | Verdict | Why |
|--------|---------|-----|
| Do nothing — keep the envMap recipe in docs | Rejected | Proven but untyped; doc drift recurs; the pool-idle/connect-timeout contract has no home the operator can point at; no collision protection. |
| knext builds DB provisioning/scale-to-zero machinery | **Rejected (standing decision)** | 2026-06-26 scope decision: knext is engine-agnostic and builds **no** DB machinery. Managed Postgres already exists as pure *delegation* to scale-zero-pg (ADR-0018) — knext still only ever binds a Secret. |
| Typed `secretRef` sugar over envMap (this ADR) | **Chosen** | First-class, validated author surface; zero new runtime machinery; same reconciliation path as everything else; the contract ships in the field's docs + guide. |

## Consequences

- The `spec.database` block now has **two mutually-exclusive modes** (managed
  `enabled` / BYO `secretRef`), validated at admission — a single author
  surface for "this app has a Postgres".
- `DATABASE_URL` collisions between `spec.database` and `spec.secrets.envMap`
  are **webhook admission errors in both modes for new configurations**, and
  Warning-evented `spec.database`-wins overrides for CRs grandfathered in by
  the ratchet (behavioral tightening of ADR-0018's silent override; v1alpha1,
  acceptable).
- **Mode removal / switch:** when `spec.database` is removed (or emptied) the
  reconciler clears `status.databaseSecretName` and drops the `DatabaseReady`
  condition — status never claims a database that is no longer declared.
  Switching a MANAGED app to BYO (or to no database) **orphans its
  `AppDatabase`**: `status.databaseAppName` is deliberately retained so the
  delete-time `db-cleanup` finalizer can still reclaim it when the NextApp is
  eventually deleted. Switch-time handling is defined by the **addendum
  below** (retain + flag; never auto-delete).

  > **Superseded (managed-mode half).** The orphaned-`AppDatabase` /
  > `status.databaseAppName` / `db-cleanup`-finalizer machinery this bullet
  > describes no longer exists: managed provisioning was removed by
  > [ADR-0025](0025-remove-managed-database-mode.md) (#303), and the
  > `db-cleanup` finalizer itself was then removed by **#304**. The BYO half
  > (removing `spec.database` clears `status.databaseSecretName` and the
  > `DatabaseReady` condition) remains the live contract.
- Rotation semantics differ by mode and are documented: managed mode rolls a
  new Revision on DSN change (checksum annotation); BYO inherits envMap
  semantics (a Secret edit does **not** roll a Revision — redeploy to pick it
  up).
- The wake/pooling contract (pool idle < gateway idle 60s; connect timeout
  ≥ 10s; T_both ≈ 13s app-dominated) gets a canonical user-facing home:
  `docs/guides/postgres-binding.md`. `@knext/lib`'s `getDbPool()` now also
  ships a bounded default `connectionTimeoutMillis` of 15s
  (`DB_POOL_CONNECT_TIMEOUT_MS`): pg's default of 0 waits indefinitely, which
  survives wakes but hangs forever on a truly-dead DB — bounded failure with
  ~6x margin over the ~2.5s cold wake is the better product default.
- `spec.secrets.envMap` remains fully supported for every non-`DATABASE_URL`
  secret and as the escape hatch for exotic layouts.

## Addendum (2026-07-06) — orphaned AppDatabase on a managed→BYO/none switch

> **Superseded by the DB-scope trim ([ADR-0025](0025-remove-managed-database-mode.md),
> 2026-07-15).** Managed provisioning was removed entirely, so there is no longer
> a managed `AppDatabase` to orphan on a mode switch — this addendum (the
> `DatabaseOrphaned` condition, the retained `status.databaseAppName`, the
> switch-time reclaim) **no longer describes live behaviour**. The BYO binding in
> the body of this ADR is unaffected and remains the operative contract. Retained
> for history; do not read this addendum as a live operator contract.

This resolves the follow-up scope named above: what the operator does **at
switch time** with the `AppDatabase` a managed-mode app had provisioned.

**Decision: retain + flag. A spec edit never deletes data.** On a switch away
from `enabled: true` the operator does **not** delete (or mark for deletion)
the `AppDatabase`. Rationale:

- The `AppDatabase` fronts the user's data (the Neon timeline). Deleting a
  data-bearing resource as a side effect of an *edit* — as opposed to deleting
  the `NextApp` itself, an explicit destructive act — is the classic
  irreversible-footgun; the safety bias wins.
- There is **no author signal that could authorize deletion at switch time**:
  admission rule 7 (this ADR) rejects `keepOnDelete` (and every other
  provisioning knob) alongside `secretRef`, so the post-switch spec cannot
  express a retain/delete preference. Absent a signal, the only safe default
  is retain.
- ADR-0018's existing deletion policy (`keepOnDelete`, honored by the
  delete-time finalizer) is a **NextApp-deletion** policy, not a spec-edit
  policy; it is left unchanged.

Mechanics (reconciler, every pass while not in managed mode and
`status.databaseAppName` is set):

- Condition **`DatabaseOrphaned=True`** (reason `ModeSwitched`) names the
  retained `AppDatabase` and the three resolution paths; a **Warning event**
  (`DatabaseOrphaned`) fires on the transition only — steady-state reconciles
  stay quiet.
- The new BYO binding is unaffected: `DatabaseReady=True/Bound` is set as
  normal, with the orphan surfaced separately.
- The operator-mirrored `<name>-db` Secret is also retained (old Revisions
  pinned by rollback/traffic-split may still reference it); it is GC'd with
  the NextApp via its ownerRef.

Resolution paths, all spec-tested:

1. **Manual reclaim** — the user deletes the `AppDatabase`. The next reconcile
   confirms NotFound and clears both `DatabaseOrphaned` and
   `status.databaseAppName` (nothing left to reclaim; status must not lie).
2. **Switch back to managed** — `deriveAppName` is deterministic, so
   `enabled: true` rebinds the **same** `AppDatabase` (CreateOrUpdate; no
   duplicate provisioning) and the orphan flag is dropped.
3. **NextApp deletion** — the retained `status.databaseAppName` drives the
   `db-cleanup` finalizer exactly as before. *(The `db-cleanup` finalizer no
   longer exists: [ADR-0025](0025-remove-managed-database-mode.md)/#303 removed
   managed provisioning and only drained the finalizer for one release; **#304**
   then removed the drain path itself — nothing on this path is live.)* Note: a
   `keepOnDelete: true` set while managed is no longer visible in the
   post-switch spec, but the
   `keepTimelineOnDelete` it wrote onto the `AppDatabase.spec` **is** still
   honored by scale-zero-pg's deprovision finalizer — the timeline survives
   even though the CR is reclaimed.

Only a **confirmed** NotFound clears the flag; a plane-unreachable probe error
keeps it raised (fail-loud, never fail-silent-clean).
