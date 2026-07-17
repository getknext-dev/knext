# ADR-0029 — Connection wall: BYO transaction pooler + operator-enforced cap

- **Status:** Accepted
- **Date:** 2026-07-17
- **Issue:** #378 (W3, part of the high-traffic wave #375). Concludes the
  connection-wall arc opened by #376 (W1, concurrency→latency baseline) and
  #377 (W2, ADR-0028 — the `maxScale × poolMax ≤ 80` cap).
- **Relates to / amends:** ADR-0028 (ratified the scale-to-zero model, lowered
  `containerConcurrency` 100→20, and made `spec.scaling.poolMax` a *validation-
  only* admission gate — this ADR makes that declared cap **real at runtime**),
  ADR-0019 (the `DATABASE_URL` secretRef binding — this ADR keeps it unchanged),
  ADR-0001 (the operator is the single source of truth for the generated Knative
  Service env), and the scale-zero-pg wake-on-connect gateway (the sleep
  authority a BYO pooler MUST sit behind).
- **Scope:** the decision *not* to ship a managed pooler; the operator env
  injection `spec.scaling.poolMax → KNEXT_DB_POOL_MAX` (`buildKsvcEnv` in
  `internal/controller/nextapp_controller.go`); the runtime cap in
  `@knext/lib`'s `getDbPool()` (`packages/lib/src/clients.ts`); and the BYO-
  pooler placement guidance (`docs/operator/postgres-scale-to-zero.md`).

## Context

ADR-0028 (W2) established the connection wall: each app pod opens its **own** pg
pool to its Postgres via `DATABASE_URL`; the shared scale-zero-pg primary has a
fixed ceiling (`max_connections = 100`, wake gateway `GW_MAX_CONNS = 90`), so
`peak_backend_conns ≈ maxScale × per-pod-pool-max`. Lowering
`containerConcurrency` (the W2 latency fix) scales an app to more pods sooner,
which *raises* connection pressure — making exhaustion (`53300 too_many_connections`)
easier to hit. W2 enforced the invariant `maxScale × poolMax ≤ 80` at admission
but left W3 (#378) to decide how to **break** the wall for apps that need to
scale wider.

The owner deferred the ship-vs-BYO decision to "after W1 baseline." Two W2
findings frame it:

1. **W1 (#376) hit NO wall at achievable load.** The baseline soak showed
   headroom — reactive scale-out on the cc=20 default did not saturate the
   gateway cap at the loads the harness could generate. There is **no evidence a
   platform-shipped pooler is needed now.**
2. **The W2 system-designer raised two forward-flags:**
   - **(a) multi-tenant aggregate exhaustion** — the `≤ 80` cap bounds *one*
     app; N co-tenant apps on one shared plane can still collectively exhaust
     the primary. (Bounded here as a documented operator responsibility;
     tracked for a future aggregate-budget mechanism.)
   - **(b) declared-vs-runtime `poolMax` drift** — `spec.scaling.poolMax` was
     validation-only, so an app could pass the `maxScale × poolMax ≤ 80` check
     yet its pg `Pool` could open **more** than `poolMax` connections/pod,
     silently blowing the very budget the operator gated. **This ADR closes
     flag (b).**

## Decision

### 1. BYO transaction pooler + operator-enforced cap — NOT a managed pooler

The platform does **not** ship or own a transaction pooler. The default remains
**BYO transaction pooler behind the gateway + the operator-enforced cap**, for
three reasons:

- **W1 showed headroom.** No wall was hit at achievable load, so shipping a
  managed pooler would solve a problem the baseline does not exhibit — premature
  infrastructure the platform then has to run, secure, and upgrade forever.
- **W2's cap already enforces the budget.** `maxScale × poolMax ≤ 80` is a hard
  admission gate; combined with the runtime cap (§2) it makes the budget both
  declared and real without new moving parts.
- **BYO keeps the platform lean and avoids a `DATABASE_URL` topology change.**
  Shipping a managed transaction pooler would change the `DATABASE_URL` contract
  (an app-facing ADR-0019 change → blind-trio trigger) and force the transaction-
  mode prepared-statement / session-state caveats on **every** app whether or not
  it needs multiplexing. BYO scopes those caveats to the apps that opt in.

### 2. Close the declared-vs-runtime `poolMax` drift (W2 flag b)

When `spec.scaling.poolMax` is declared (> 0), the operator **injects it into the
app container as `KNEXT_DB_POOL_MAX`** (`buildKsvcEnv`), and `@knext/lib`'s
`getDbPool()` **caps the pg pool `max` at that value**:

- **Precedence — minimum wins.** The effective `max` is
  `min(app request, KNEXT_DB_POOL_MAX)`, where the app request is its
  `DB_POOL_MAX` env (per-zone override) or the bounded default (5). An app may be
  **more** conservative than the operator budget; it can **never** open more than
  the operator-declared cap. The operator cap is authoritative — an app cannot
  opt out of the budget.
- **No cap ⇒ no-op.** When `poolMax` is unset, the operator injects **no**
  `KNEXT_DB_POOL_MAX` env (the documented-only wall of ADR-0028 §3), and the app
  keeps its `DB_POOL_MAX`/default. Back-compat holds for every CR that never set
  `poolMax`.

This makes the number the operator gates at admission the number the pool
actually opens at runtime — the drift is closed. No CRD/RBAC change: `poolMax`
already exists (W2); this ADR only adds an env derived from it.

### 3. BYO pooler MUST sit BEHIND the wake-on-connect gateway

A BYO transaction pooler (PgBouncer ≥ 1.21 / pgcat) MUST be placed **behind** the
scale-zero-pg gateway:

```
app pods ──► gateway (wake-on-connect) ──► pooler ──► compute-<app> (0↔1)
```

- **Never in front.** A pooler in front holds a persistent TCP connection to keep
  its backend pool warm; that would keep the gateway awake forever and the
  compute would never scale to zero — the gateway must remain the sole sleep
  authority.
- **`server_idle_timeout < GW_IDLE_MS` is mandatory.** The pooler's idle backend
  connections to `compute-<app>` must drain before the gateway's idle window
  elapses, or the pooler pins the compute awake and breaks scale-to-zero. With
  `GW_IDLE_MS = 60000`, use e.g. `server_idle_timeout = 30`.

### 4. Transaction-mode caveats (BYO owner's responsibility)

Transaction pooling is what makes a pooler effective under scale-to-zero (a
backend connection is returned to the pool at the end of *every transaction*),
but no client owns a stable server session, so **session state breaks**:
server-side `SET`/`RESET`, `LISTEN`/`NOTIFY`, SQL `PREPARE`/`DEALLOCATE`, session
advisory locks, and `WITH HOLD` cursors do not carry across transactions.
**Server-side prepared statements** are the important exception:

- **Preferred:** run **PgBouncer ≥ 1.21 / pgcat** with prepared-statement support
  (`max_prepared_statements`), so protocol-level prepared statements (what most
  drivers/ORMs use) work transparently.
- **Otherwise:** disable server-side prepared statements in the driver —
  `?pgbouncer=true` (Prisma), `prepare: false` (Drizzle / `postgres.js`), avoid
  the named-statement form (`pg`).

Session-mode pooling is an escape hatch only; it pins one backend connection per
client for the whole session and **defeats the connection-storm protection**.

### 5. A managed pooler is a DEFERRED (reserved) future option

Shipping a platform-managed transaction pooler is **reserved**, not rejected. If
a hosted-pooler need emerges — e.g. the multi-tenant aggregate-exhaustion flag
(§Context 2a) forces a shared, platform-owned backend-connection budget, or a
soak at higher load than W1 could reach demonstrates the wall — the platform may
ship a pooler as a **separate Deployment behind the gateway** with a `pool_mode`
field on the CRD and per-tenant server-conn quotas (reusing the #89 tenant-quota
+ ADR-0008 wake-budget vocabulary). That is a future ADR + `DATABASE_URL`-topology
/ blind-trio trigger; this ADR only declines to do it **now**.

## Consequences

- **The declared cap is now real.** `spec.scaling.poolMax` bounds the pg pool at
  runtime via `KNEXT_DB_POOL_MAX`, closing the W2 system-designer's drift flag —
  an app can no longer pass admission then open more connections than it declared.
- **No new platform infrastructure.** The platform ships no pooler; apps that
  need to scale wider than `80 / poolMax` pods bring their own transaction pooler
  behind the gateway per the guidance (`docs/operator/postgres-scale-to-zero.md`
  §4-bis). Placement + `server_idle_timeout` are documented as hard requirements.
- **The `DATABASE_URL` contract is unchanged** (ADR-0019). The app still points
  `DATABASE_URL` at the gateway; the pooler sits on the DB-plane side of the
  gateway. No blind-trio `DATABASE_URL` trigger fires.
- **Back-compat.** No CRD/RBAC change; no env injected when `poolMax` is unset;
  every existing CR keeps its `DB_POOL_MAX`/default behavior.
- **Deferred, tracked:** (a) a platform-managed pooler (reserved, future ADR);
  (b) multi-tenant aggregate backend-connection budgeting (documented operator
  responsibility today). OKE validation that an app respects the `poolMax` cap
  under load is the harness-fan-out (#382) follow-up.
