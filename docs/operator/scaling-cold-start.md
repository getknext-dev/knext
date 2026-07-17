# Per-zone scaling & cold-start tuning under scale-to-zero

knext zones run on Knative and scale to zero by default. A zone that is at zero
replicas pays a **cold start** on the next request: pod scheduling, the Node
runtime + JS parse, framework boot, and — for a stateful framework like Payload —
**database connection-pool re-establishment**. Latency-critical or write-critical
zones (e.g. an accounting/ledger zone) usually cannot afford that on the request
path, while read-heavy zones happily trade a little tail latency for the cost
savings of scaling to zero.

This guide covers the per-zone knobs the operator exposes, the defaults it
applies, and how to tune them. It is **scope-honest**: knext exposes these knobs
and the guidance below; it does **not** manage the database or its connection
pooler.

> Cross-links: data-sovereignty + per-zone PostgreSQL rules in
> [`.claude/rules/scs-zones.md`](../../.claude/rules/scs-zones.md). Postgres
> connection-storm mitigation (transaction-mode pooler) is described under
> [Database pool re-establishment](#database-pool-re-establishment-the-other-half-of-cold-start)
> below.

## The knobs (all real `NextApp` fields)

All fields below are defined on the `NextApp` CRD in
`packages/kn-next-operator/api/v1alpha1/nextapp_types.go` and reconciled in
`packages/kn-next-operator/internal/controller/nextapp_controller.go`.

### `spec.scaling` (`ScalingSpec`)

| Field | JSON tag | Maps to | Operator default (when `spec.scaling` is unset) |
|-------|----------|---------|--------------------------------------------------|
| `MinScale` | `minScale` | `autoscaling.knative.dev/min-scale` annotation | `0` |
| `MaxScale` | `maxScale` | `autoscaling.knative.dev/max-scale` annotation | `10` |
| `ContainerConcurrency` | `containerConcurrency` | Knative `spec.template.spec.containerConcurrency` | `20` (was `100` — lowered in #377 / ADR-0028) |
| `PoolMax` | `poolMax` | *validation only* — the per-pod DB pool max used to enforce `maxScale × poolMax ≤ max_connections` (ADR-0028) | *unset (check skipped)* |

The defaults are asserted by the reconciler test
`reconcile_output_test.go` →
`"defaults containerConcurrency to 20 (#377, ADR-0028) and timeout to 300 when scaling/timeout are unset"`:

- `min-scale` = `"0"`, `max-scale` = `"10"`,
- `containerConcurrency` = `int64(20)`.

In the controller, the annotation defaults are set in `buildDesiredKsvc` and
overridden from `spec.scaling`; `containerConcurrency` defaults to
`defaultContainerConcurrency` (`= 20`) and is overridden only when
`spec.scaling.containerConcurrency > 0`.

> **Why 20, not 100 (ADR-0028).** At `containerConcurrency: 100` a single pod
> absorbed **100** concurrent requests before Knative added a second replica, so
> the reactive `max-scale: N` fan-out was effectively **inert** under bursty
> high-traffic load. `20` is a documented, defensible interim; **W1 (#376)**
> refines the exact value from the measured concurrency→latency curve. The knob
> stays fully overridable via `spec.scaling.containerConcurrency`. A **lower**
> `containerConcurrency` scales to **more** pods sooner, which raises DB
> connection pressure — see the connection-wall guard below.

### `spec.cache` (`CacheSpec`, the cold-start-relevant fields)

| Field | JSON tag | Effect |
|-------|----------|--------|
| `EnableBytecodeCache` | `enableBytecodeCache` | Provisions a `{app}-bytecode-cache` PVC and sets `NODE_COMPILE_CACHE` |
| `BytecodeCacheSize` | `bytecodeCacheSize` | PVC storage request; defaults to `512Mi` when unset |

When `spec.cache.enableBytecodeCache` is true the operator creates a
`PersistentVolumeClaim` named `{app}-bytecode-cache`
(`nextapp_controller.go:241-243`), sized from `spec.cache.bytecodeCacheSize` and
**defaulting to `512Mi`** when unset (`nextapp_controller.go:237-239`; asserted by
`reconcile_output_test.go:285` *"defaults the PVC size to 512Mi when
BytecodeCacheSize is unset"*). The PVC is mounted at `/cache/bytecode`
(`nextapp_controller.go:431-432`).

> **Gotcha (as-built):** `NODE_COMPILE_CACHE` is only set when a cache
> **`provider`** is also configured — the env var is emitted inside the
> `spec.cache.provider != ""` block (`nextapp_controller.go:350-358`), pointing at
> `/cache/bytecode/latest`. Asserted by `reconcile_output_test.go:303` *"mounts the
> PVC but omits NODE_COMPILE_CACHE when no cache Provider is set"*. Set
> `spec.cache.provider` (e.g. `redis`) alongside `enableBytecodeCache` to actually
> activate the V8 compile cache.

## What a cold start costs, and what mitigates it

A request that wakes a scaled-to-zero zone pays, roughly in order:

1. **Pod scheduling + container pull** — infra-level; bounded by image size and
   node warmth. Not tunable from `NextApp`.
2. **Node runtime start + JS parse/compile** — *mitigated by the V8 bytecode
   cache.*
3. **Framework boot** (Payload reads its config, builds its schema, etc.).
4. **Database connection-pool re-establishment** — *mitigated by a transaction-mode
   pooler in front of Postgres.*

### V8 bytecode cache (`spec.cache.enableBytecodeCache`)

Node's `NODE_COMPILE_CACHE` persists compiled V8 bytecode to disk, so a fresh
process skips re-parsing and re-compiling the application's JavaScript. knext
persists this cache on a PVC (so it survives pod churn / scale-from-zero rather
than being rebuilt on every cold start). Enable it on any zone whose cold start
matters:

```yaml
spec:
  cache:
    provider: redis            # required for NODE_COMPILE_CACHE to be emitted
    enableBytecodeCache: true
    bytecodeCacheSize: 1Gi     # optional; defaults to 512Mi
```

This removes the JS recompile cost. It does **not** remove framework boot or the
database pool re-establish — those are addressed below.

### Database pool re-establishment (the other half of cold-start)

Each Next.js instance opens its **own** connection pool to its zone's Postgres via
`DATABASE_URL` (see `getDbPool` in `packages/lib/src/clients.ts`, which constructs
a `pg.Pool` from `process.env.DATABASE_URL`). A cold start means establishing
those TCP + TLS + auth handshakes on the request path. Two mitigations:

- **Keep the zone warm** (`minScale: 1`) so the pool is already established — see
  below.
- **Put a transaction-mode connection pooler in front of Postgres** (e.g. PgBouncer
  / the CloudNativePG pooler). A pooler lets each instance's pool re-establish
  cheaply against the pooler rather than the primary, and — critically — **caps the
  total backend connection count** regardless of how many instances Knative spins
  up. This is the mitigation for the connection-storm problem described next.

knext does not provision the database or the pooler; it owns the zone's
scaling knobs and wires `DATABASE_URL` from a K8s Secret.

## Keep latency/write-critical zones warm

For a zone where a cold start on the request path is unacceptable — a ledger /
accounting / write zone — set `minScale: 1`. The zone keeps at least one instance
running, so it never pays cold-start scheduling, framework boot, or DB-pool
re-establish on a user request. The trade-off is cost: one instance runs 24/7.

Read-heavy zones (catalog, marketing, content) should stay at `minScale: 0` to
scale to zero and save cost; their occasional cold start is acceptable, and the
bytecode cache keeps it short.

## Bound database fan-out

`maxScale` is the ceiling on how many instances Knative will run for a zone. Each
instance holds its own DB pool, so:

```
peak_backend_conns ≈ maxScale × app_pool_max
```

where `app_pool_max` is the per-instance `pg.Pool` max (the `pg` default is 10).
A high `maxScale` therefore risks a **connection storm** that can exhaust Postgres
`max_connections` under load.

For **write zones**, prefer **lower `maxScale` + higher `containerConcurrency`**:
fewer, busier instances each handle more concurrent requests, so you get a
**predictable, bounded** connection count instead of a wide fan-out. For example a
zone capped at `maxScale: 3` with `containerConcurrency: 200` admits up to 600
concurrent requests across at most 3 instances and at most `3 × app_pool_max`
backend connections.

A **transaction-mode connection pooler caps `peak_backend_conns`** regardless of
`maxScale`, decoupling instance count from real backend connections — this is the
robust fix when you cannot keep `maxScale` low. Use both: a sane `maxScale` and a
pooler.

### The connection-wall guard (`spec.scaling.poolMax`, ADR-0028)

Because #377 lowered the default `containerConcurrency` (an app now scales to
**more** pods, **sooner**), the connection-storm risk above is easier to hit.
The operator can **enforce** the wall for you: declare your per-pod pool max in
`spec.scaling.poolMax` and the operator (via `internal/validation`, the same
code the admission webhook runs) **rejects** any spec where

```
maxScale × poolMax > max_connections   (max_connections = 100, ADR-0028)
```

- **`poolMax` unset (`0`)** → the check is **skipped** (the operator cannot guard
  a wall it does not know about). The wall still exists — it is documented here
  and in ADR-0028; you are responsible for keeping `maxScale × app_pool_max`
  under `max_connections` yourself (or fronting Postgres with a pooler).
- **`poolMax` set with an unbounded `maxScale: 0`** → **rejected**: an unbounded
  fan-out can never fit a finite ceiling. Set a finite `maxScale`.
- **`poolMax` set with a finite `maxScale`** → accepted iff the product ≤ 100.

Example that is **rejected** at admission (and by the fail-closed reconciler):

```yaml
spec:
  scaling:
    maxScale: 10
    poolMax: 20   # 10 × 20 = 200 > 100 → rejected (ADR-0028 connection wall)
```

Breaking the wall itself — e.g. a shared server-side pooler so instance count no
longer maps 1:1 to backend connections — is owned by **W3 (#378)**.

## Worked example

Two zones in the same product: a write-heavy `ledger` zone and a read-heavy
`catalog` zone.

### Write-heavy zone — kept warm, bounded fan-out

```yaml
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: ledger
spec:
  image: registry.example.com/ledger@sha256:abc123...   # digest-pinned, never :latest
  scaling:
    minScale: 1              # never cold-start on the critical write path
    maxScale: 3              # low ceiling => predictable backend connection count
    containerConcurrency: 200 # fewer, busier instances
  cache:
    provider: redis
    enableBytecodeCache: true
    bytecodeCacheSize: 1Gi
```

- `minScale: 1` keeps a warm instance with an established DB pool.
- `maxScale: 3` × `app_pool_max` bounds `peak_backend_conns`; a transaction-mode
  pooler in front of Postgres caps it further.
- The bytecode cache keeps the rare scale-up (1 → 3) cheap.

### Read-heavy zone — scale to zero for cost

```yaml
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: catalog
spec:
  image: registry.example.com/catalog@sha256:def456...   # digest-pinned, never :latest
  scaling:
    minScale: 0              # scale to zero when idle — save cost
    maxScale: 10             # operator default; wide fan-out is fine for read traffic
    # containerConcurrency omitted => operator default 20 (ADR-0028)
  cache:
    provider: redis
    enableBytecodeCache: true  # keep the cold start short when traffic returns
```

- `minScale: 0` lets the zone scale to zero between traffic bursts.
- The bytecode cache shortens the cold start the next request pays.
- If this zone reads Postgres, still front it with a pooler so a `maxScale: 10`
  fan-out cannot storm the database.

## High-traffic profile (#377, ADR-0028)

For an app that takes sustained, bursty traffic and must scale out **reactively**
(not sit inert behind a high `containerConcurrency`), start from this profile and
tune from there. It keeps the cost-friendly `minScale: 0` floor by default and
relies on the lowered default `containerConcurrency` to trigger scale-out early:

```yaml
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: storefront
spec:
  image: registry.example.com/storefront@sha256:abc123...   # digest-pinned
  scaling:
    minScale: 0              # cost floor — scale to zero when idle (set 1 to pin a warm pod)
    maxScale: 10             # reactive fan-out ceiling
    containerConcurrency: 20 # = operator default; low => a 2nd pod is added early under burst
    poolMax: 5               # per-pod DB pool max => 10 × 5 = 50 ≤ 100 (wall holds)
  cache:
    provider: redis
    enableBytecodeCache: true  # keep each scale-up cheap
```

Tuning guidance for the three knobs:

| Goal | Move |
|------|------|
| Trigger scale-out sooner / cut tail latency under burst | **Lower** `containerConcurrency` (adds pods earlier). W1 (#376) publishes the curve. |
| Cut cost / accept a cold start on the first request | `minScale: 0` (default). |
| Never cold-start on the critical path | `minScale: 1` (one warm pod, 24/7 cost). |
| Cap the reactive fan-out | `maxScale` — and set `poolMax` so the operator **enforces** `maxScale × poolMax ≤ 100`. |
| Break the connection wall (scale wider than 100/poolMax) | Front Postgres with a transaction-mode pooler — owned by **W3 (#378)**. |

**Invariant to respect:** with a declared `poolMax`, keep
`maxScale × poolMax ≤ 100`. The operator rejects specs that violate it (ADR-0028);
if you leave `poolMax` unset the check is skipped but the wall still applies.

## Summary

| Concern | Knob / mitigation |
|---------|-------------------|
| Cold start on critical path | `spec.scaling.minScale: 1` (keep warm) |
| Cost on idle read zones | `spec.scaling.minScale: 0` (scale to zero) |
| JS recompile on cold start | `spec.cache.enableBytecodeCache: true` (+ a `provider`) |
| DB pool re-establish | warm zone (`minScale: 1`) and/or transaction-mode pooler |
| Connection storm | low `maxScale` + declare `poolMax` (operator enforces `maxScale × poolMax ≤ 100`, ADR-0028); a pooler caps it further |
| Reactive scale-out under burst | lower `containerConcurrency` (default now `20`, ADR-0028; W1/#376 refines) |

knext exposes the scaling/cache knobs and this guidance; the database and its
connection pooler are operated outside knext.
