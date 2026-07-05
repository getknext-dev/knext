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

### Admission validation (CRD CEL + shared `validation` package)

| # | Rule | Outcome |
|---|------|---------|
| 1 | `secretRef.name` / `roSecretRef.name` must be a DNS-1123 subdomain (≤253) | REJECT |
| 2 | `key` omitted | defaults `DATABASE_URL` / `DATABASE_URL_RO` |
| 3 | `spec.database` defines `DATABASE_URL` (any mode: `secretRef` **or** `enabled: true`) **and** `spec.secrets.envMap` also defines `DATABASE_URL` | REJECT — no silent precedence |
| 4 | same for `DATABASE_URL_RO` (`roSecretRef` or `enabled+readReplicas` vs envMap) | REJECT |
| 5 | `enabled: true` together with `secretRef` (managed vs BYO) | REJECT — one mode per app |
| 6 | `roSecretRef` without `secretRef` | REJECT |
| 7 | provisioning knobs (`tier`, `readReplicas`, `quotas`, `keepOnDelete`) together with `secretRef` | REJECT — they are managed-mode-only, never silently ignored |

Rules are enforced twice on purpose: CRD **CEL** (apiserver, works without the
webhook) and `validation.ValidateNextAppSpec` (webhook + reconciler
defense-in-depth for CRs that predate the CEL rules). For such pre-existing
(ratcheted) CRs that reach the reconciler with both sources defined,
`spec.database` wins and a **Warning event** names the ignored envMap entry
(the #186/#191 collision-event semantics) — never silent.

Note rule 3 **tightens ADR-0018**: the managed mode previously overrode an
author envMap `DATABASE_URL` silently; both modes now reject the ambiguity at
admission.

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
  are **admission errors in both modes** (behavioral tightening of ADR-0018's
  silent override; v1alpha1, acceptable).
- Rotation semantics differ by mode and are documented: managed mode rolls a
  new Revision on DSN change (checksum annotation); BYO inherits envMap
  semantics (a Secret edit does **not** roll a Revision — redeploy to pick it
  up).
- The wake/pooling contract (pool idle < gateway idle 60s; connect timeout
  ≥ 10s; T_both ≈ 13s app-dominated) gets a canonical user-facing home:
  `docs/guides/postgres-binding.md`.
- `spec.secrets.envMap` remains fully supported for every non-`DATABASE_URL`
  secret and as the escape hatch for exotic layouts.
