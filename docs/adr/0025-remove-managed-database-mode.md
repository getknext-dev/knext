# ADR-0025 — Remove the managed `spec.database.enabled` mode (engine-agnostic DB scope)

- **Status:** Accepted
- **Date:** 2026-07-15
- **Supersedes:** [ADR-0018](0018-unified-config-nextapp-database.md) (the managed
  `spec.database.enabled` → scale-zero-pg provisioning mode).
- **Amends:** [ADR-0019](0019-database-binding-secretref.md) — its managed→BYO/none
  orphan addendum is annotated superseded; the BYO binding it defines is **kept and
  is now the only database surface**.
- **Relates to:** ADR-0001 (operator = single source of truth), ADR-0008 (NextApp
  deletion finalizer + app-scoped teardown), ADR-0017 (CRD stays `v1alpha1`),
  ADR-0021 (Drizzle data-SDK — unaffected; it is a client-side SDK over any
  `DATABASE_URL`).

## Context

The 2026-06-26 scope decision fixed knext's positioning: knext stays
**engine-agnostic** and builds **no** scale-to-zero-Postgres provisioning
machinery — it ships only a Postgres + pooler **recipe** and a bring-your-own
`DATABASE_URL`-from-Secret **binding**.

The operator, however, still carried a full **managed provisioner**
(ADR-0018): `spec.database.enabled: true` (with `tier`, `readReplicas`, `quotas`,
`keepOnDelete`) made the operator mint and own an `AppDatabase` CR in the
scale-zero-pg namespace, **hard-gate** the app on `AppDatabase.status.phase ==
Ready`, mirror the minted Secret across namespaces, and cross-namespace-finalize
it on delete. That is precisely the machinery the decision says knext does not
build — sitting next to the **engine-agnostic BYO binding** (ADR-0019,
`spec.database.secretRef`) that the decision endorses.

The two are cleanly separable: the managed half is self-contained
(`appdatabase.go`), and the BYO half (`database_binding.go`) references nothing in
it. `packages/scale-zero-pg` (the standalone platform the managed mode was a thin
client of) is a **separate user decision** — it stays in-repo, decoupled; this ADR
only removes the operator's coupling to it.

## Decision

**Remove the managed provisioning mode entirely; keep the BYO binding.**

1. Delete the operator's managed provisioner (`appdatabase.go`) and its managed
   tests, the scoped RBAC that let it write `AppDatabase`s in the scale-zero-pg
   namespace, and the consumed `AppDatabase` CRD envtest fixture.
2. Remove the managed fields from `NextApp.spec.database`
   (`enabled`, `tier`, `readReplicas`, `quotas`, `keepOnDelete`) and the
   `DatabaseQuotas` type; remove the managed `status.databaseAppName` and the
   managed conditions (`DatabaseOrphaned`, the provisioning/hard-gate verdicts).
   **Keep** `secretRef` / `roSecretRef` / `DatabaseSecretRef` and the BYO
   `DatabaseReady=Bound` / `status.databaseSecretName` surface.
3. Of the three `spec.database` CEL `XValidation` rules, remove the two that
   reference managed fields (managed-vs-BYO exclusivity; managed-knobs-vs-secretRef)
   and **keep** the pure-BYO rule (`roSecretRef` requires `secretRef`).
4. Remove the `--database-namespace` operator flag and its reconciler field.

### Finalizer drain (one release)

Live `NextApp`s that were ever managed carry the string finalizer
`apps.kn-next.dev/db-cleanup` in metadata. A finalizer clears only when a
controller removes it — deleting the handler outright would wedge those CRs in
`Terminating` forever. So the trimmed operator, **for one release**:

- **no longer adds** `apps.kn-next.dev/db-cleanup` to any NextApp, but
- **still drains it on delete**: the delete-reconcile path strips the finalizer off
  any NextApp still carrying it. The cleanup body (`cleanupDatabase`) is now a
  **no-op** — it neither re-provisions nor reaches cross-namespace; it exists only
  so the finalizer can be released and deletion can complete.

The constant `DatabaseCleanupFinalizer` is retained to name the string being
drained. An envtest pins the drain: a NextApp pre-set with the legacy finalizer,
deleted under the trimmed reconciler, must reach `NotFound` (never stuck
`Terminating`).

## Options considered

| Option | Summary | Verdict |
|---|---|---|
| **Remove managed, keep BYO (chosen)** | Delete the provisioner; `spec.database` becomes BYO-only. Clean CRD cut at `v1alpha1`. | **Chosen** — matches the engine-agnostic decision; smallest live surface. |
| Soft-deprecate for one release | Keep the fields as a hard-rejecting no-op (webhook denies `enabled: true`), then delete later. | Rejected — ceremony for an alpha API with no operator-GA release; the decision is to not ship the surface at all. |
| Bare-delete the finalizer handler | Delete `appdatabase.go` including the finalizer path. | Rejected — **wedges** any live ever-managed CR in `Terminating`. The drain is a block-level safety requirement. |

## Consequences

- **Breaking `v1alpha1` CRD change.** `spec.database.enabled` (+ managed knobs) and
  `status.databaseAppName` are removed, and the consumed `AppDatabase` CRD is no
  longer required. Defensible as a **clean removal**: the API is `v1alpha1`,
  pre-1.0 (ADR-0017: no conversion webhook), unreleased at operator-GA.
- **Ops precondition (human, before applying the new CRD on any live cluster —
  e.g. knext2/OKE):** confirm **no** `NextApp` sets `spec.database.enabled: true`
  **and** no `NextApp` carries the `apps.kn-next.dev/db-cleanup` finalizer that
  cannot reach this operator to be drained. A managed-mode CR would fail validation
  post-trim; an undrained finalizer would wedge deletion. The scale-zero-pg demo on
  knext2 runs via the **BYO** recipe (ADR-0019), so it survives the trim.
- **BYO path unchanged.** `spec.database.secretRef` → `DATABASE_URL` from a
  same-namespace Secret still flows entirely through the operator (ADR-0001
  honoured); its envtest stays green.
- **`packages/scale-zero-pg` stays in-repo** (user decision), now **decoupled** —
  the operator no longer imports/drives it. Positioning note: keeping a
  scale-to-zero-Postgres platform in the monorepo, even decoupled, is a known
  tension with the engine-agnostic line; re-coupling must not be reintroduced.
- The finalizer-drain path is **temporary** — it can be removed in a later release
  once no live cluster carries the legacy finalizer.

## Action items

- [x] Delete `appdatabase.go` + managed tests + `appdb_driver.yaml` + the
  `AppDatabase` CRD fixture; keep `database_binding.go` intact.
- [x] Trim `nextapp_types.go` (managed fields, `DatabaseQuotas`, 2 XValidation
  rules, `status.databaseAppName`); regenerate CRD + deepcopy.
- [x] Trim `nextapp_controller.go` (managed branch, `reconcileOrphanedDatabase`
  call sites, managed status) and keep the minimal finalizer drain.
- [x] Remove the `--database-namespace` flag/field from `cmd/main.go`.
- [x] Add the finalizer-drain envtest; operator suite green.
- [ ] **(human)** run the ops precondition check on live clusters before applying
  the new CRD.
- [ ] **(later release)** remove the finalizer-drain path once no live cluster
  carries `apps.kn-next.dev/db-cleanup`.
