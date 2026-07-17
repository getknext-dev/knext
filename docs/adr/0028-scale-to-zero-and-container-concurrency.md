# ADR-0028 — App scale-to-zero model, ContainerConcurrency default, and the DB connection wall

- **Status:** Accepted
- **Date:** 2026-07-17
- **Issue:** #377 (W2, part of the high-traffic wave #375). Relates to #376 (W1,
  concurrency→latency curve) and #378 (W3, breaking the connection wall).
- **Relates to / amends:** ADR-0001 (the operator is the single source of truth
  for the generated Knative Service and its autoscaling annotations),
  ADR-0026 (readiness/liveness are shallow so a scale-to-zero DB wake never flaps
  readiness — a prerequisite for scale-to-zero to work under load), and the
  scale-zero-pg database layer (the app's Postgres itself scales to zero and has
  a fixed `max_connections`).
- **Scope:** `spec.scaling` on the `NextApp` CRD
  (`api/v1alpha1/nextapp_types.go` — `MinScale`, `MaxScale`,
  `ContainerConcurrency`, and the new `PoolMax`), the autoscaling annotations +
  `containerConcurrency` stamped in `buildDesiredKsvc`
  (`internal/controller/nextapp_controller.go`), and the shared spec validation
  (`internal/validation/validate.go`, run by both the admission webhook and the
  reconciler).

## Context

knext apps run on Knative Serving and **scale to zero by default**: an idle app
drops to `min-scale: 0` and the next request wakes it. Reactive scale-out from
0→N is driven by three knobs on `spec.scaling`, but until now **no ADR captured
the model** — it was only implicit in the KPA annotations the operator writes.

Two problems motivated ratifying the model now:

1. **The default made reactive scale-out inert.** The operator defaulted
   `containerConcurrency = 100`. Knative's KPA adds a second replica when a pod's
   in-flight concurrency approaches its `containerConcurrency` target, so a
   single pod absorbed **100** concurrent requests before a 2nd pod was ever
   scheduled. Under bursty high-traffic load the app effectively **did not scale
   out** — the whole `max-scale: N` fan-out was dead weight — while per-request
   tail latency climbed on the one overloaded pod.

2. **Scaling out couples to a hard database wall.** Each app pod opens its **own**
   connection pool to its Postgres via `DATABASE_URL`. The shared scale-zero-pg
   primary has a fixed ceiling (`max_connections = 100`; the wake gateway caps at
   `GW_MAX_CONNS = 90`). So `peak_backend_conns ≈ maxScale × per-pod-pool-max`.
   **Lowering `containerConcurrency` scales an app to more pods sooner**, which
   directly raises connection pressure — the cheap latency fix (#377) makes the
   connection-exhaustion failure mode *easier* to hit. A low `containerConcurrency`
   must not be allowed to silently exhaust the database.

## Decision

### 1. The scale-to-zero model is ratified as-is (0→N, cost-first floor)

- **`minScale` (warm floor) defaults to `0`.** Idle apps scale to zero for cost;
  the first request pays a cold start (mitigated by the V8 bytecode cache and, for
  latency/write-critical apps, an opt-in `minScale: 1` warm pod). This is the
  cost/latency trade-off, made explicit: **`minScale: 0` = cheaper, occasional
  cold start; `minScale: 1` = one pod 24/7, no cold start on the critical path.**
- **`maxScale` defaults to `10`** — the reactive fan-out ceiling.
- **`containerConcurrency`** is the per-pod concurrent-request soft target that
  drives *when* Knative adds a pod. **Lower ⇒ scales to more pods sooner ⇒ lower
  tail latency under burst, but more pods and more DB connections.**

### 2. Lower the default `ContainerConcurrency` from 100 → 20 (W1-refinable)

The operator now defaults `containerConcurrency` to **`20`**
(`defaultContainerConcurrency` in the controller) when
`spec.scaling.containerConcurrency` is unset. `20` is a **defensible, documented
interim**: low enough that a burst actually triggers scale-out, high enough to
avoid pathological pod churn. The knob stays **fully overridable** via
`spec.scaling.containerConcurrency`.

**W1 (#376) owns the exact value** — it will publish the measured
concurrency→latency curve and this default is expected to be re-tuned within the
~10–20 band the architect suggested. The interim unblocks the high-traffic wave
without waiting on W1.

### 3. Enforce the connection-wall invariant (gate the lower cc)

Because a lower `containerConcurrency` raises DB connection pressure, the operator
MUST NOT let it silently exhaust the gateway/database. The bound is **not** the
raw Postgres `max_connections` (100): the wake gateway hard-caps at
`GW_MAX_CONNS = 90` (excess connections are refused with SQLSTATE `53300`
too_many_connections), and Postgres itself reserves connections for
`superuser_reserved_connections` (default 3), replication slots, and the wake
gateway's own probe. A spec sized against 100 would exhaust the 90 gateway cap
AND leave zero admin/replication headroom — defeating the very guard the cc=20
change makes necessary. So the enforced invariant budgets against the gateway cap
minus a reserve:

```
maxScale × poolMax ≤ MaxAppConnections       (MaxAppConnections = 80)

where 80 = GW_MAX_CONNS (90) − ~10 reserve
         (superuser_reserved_connections + replication + wake-probe headroom)
```

- A new **optional** `spec.scaling.poolMax` field declares the app's **per-pod DB
  connection-pool maximum**.
- **When `poolMax > 0`,** the shared validation
  (`ValidateNextAppSpec`, run by the admission webhook AND the fail-closed
  reconciler, so they cannot drift) **rejects** any spec where
  `maxScale × poolMax > 80`, and rejects a declared `poolMax` against an
  **unbounded** `maxScale: 0` (an unbounded fan-out can never fit a finite
  budget). `MaxAppConnections = 80` is the enforced named constant in
  `internal/validation`; `MaxConnections = 100` is retained alongside it purely
  to document the raw Postgres ceiling.
- **When `poolMax` is unset (`0`),** the check is **skipped** — the operator
  cannot verify a wall it does not know about. The wall still applies; it is
  documented **loudly** (ADR + `docs/operator/scaling-cold-start.md`) and the
  app owner remains responsible for keeping the product within the app budget
  (`maxScale × poolMax ≤ 80`) — or fronting Postgres with a pooler. This
  preserves back-compat for every existing CR that never set `poolMax`.

### 4. W3 (#378) owns breaking the wall

The invariant is a *constraint*, not the end state. Scaling an app wider than
`80 / poolMax` pods requires **decoupling instance count from backend
connections** — a shared, server-side transaction-mode pooler (e.g. PgBouncer /
CloudNativePG pooler) so many pods share a bounded set of backend connections.
That work is **explicitly out of scope here and owned by W3 (#378)**; this ADR
only makes the wall visible and enforced.

## Consequences

- **Reactive scale-out actually works** under high traffic: apps add pods at
  ~20 concurrent requests/pod instead of 100. This is a behavior change to every
  app that relies on the default; it is called out in the PR body.
- **A lower `containerConcurrency` cannot silently exhaust Postgres** when the app
  declares `poolMax` — the webhook/reconciler reject the offending spec at write
  time. Apps that don't declare `poolMax` are unaffected (documented wall only).
- **New `spec.scaling.poolMax` field** — additive/optional; the CRD and RBAC are
  regenerated (`make manifests generate`). No migration for existing CRs.
- **The default is interim.** W1 (#376) may re-tune `20`; W3 (#378) may relax the
  `maxScale × poolMax ≤ 80` wall once a shared pooler decouples the two. Both are
  tracked; this ADR is the anchor they amend.
- **Cost/latency trade-off is now explicit and documented** (the `minScale`
  floor + the `containerConcurrency` sooner-scale trade), so operators tune with
  the wall in view rather than discovering it as a connection-exhaustion outage.
