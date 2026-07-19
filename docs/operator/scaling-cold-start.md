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
| `PoolMax` | `poolMax` | enforces `maxScale × poolMax ≤ 80` (the app connection budget, ADR-0028) at admission **and** injects `KNEXT_DB_POOL_MAX` into the app container so `@knext/lib`'s `getDbPool()` caps the pg pool `max` at runtime (ADR-0029, #378) | *unset (no check, no env)* |

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
maxScale × poolMax > MaxAppConnections   (MaxAppConnections = 80, ADR-0028)

where 80 = GW_MAX_CONNS (90) − ~10 reserve
         (superuser_reserved_connections + replication + wake-probe headroom)
```

The bound is the **app connection budget `80`**, NOT the raw Postgres
`max_connections=100`: the wake gateway hard-caps at `GW_MAX_CONNS=90` (excess →
SQLSTATE `53300` too_many_connections) and Postgres reserves connections for
superuser/replication. Sizing against 100 would blow the 90 cap and leave zero
admin headroom.

- **`poolMax` unset (`0`)** → the check is **skipped** (the operator cannot guard
  a wall it does not know about). The wall still exists — it is documented here
  and in ADR-0028; you are responsible for keeping `maxScale × app_pool_max`
  under `80` yourself (or fronting Postgres with a pooler).
- **`poolMax` set with an unbounded `maxScale: 0`** → **rejected**: an unbounded
  fan-out can never fit a finite budget. Set a finite `maxScale`.
- **`poolMax` set with a finite `maxScale`** → accepted iff the product ≤ 80.

Example that is **rejected** at admission (and by the fail-closed reconciler):

```yaml
spec:
  scaling:
    maxScale: 10
    poolMax: 20   # 10 × 20 = 200 > 80 → rejected (ADR-0028 connection wall)
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
    poolMax: 5               # per-pod DB pool max => 10 × 5 = 50 ≤ 80 (app budget holds)
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
| Cap the reactive fan-out | `maxScale` — and set `poolMax` so the operator **enforces** `maxScale × poolMax ≤ 80`. |
| Break the connection wall (scale wider than 80/poolMax) | Front Postgres with a transaction-mode pooler — owned by **W3 (#378)**. |

**Invariant to respect:** with a declared `poolMax`, keep
`maxScale × poolMax ≤ 80` (the app connection budget = GW_MAX_CONNS 90 − reserve,
not the raw `max_connections` 100). The operator rejects specs that violate it
(ADR-0028); if you leave `poolMax` unset the check is skipped but the wall still
applies.

## Scheduled warm floor (`spec.scaling.warmSchedule`, ADR-0030 / #380)

For a **known** traffic pattern — a daily 08:00 peak, a scheduled campaign, a
business-hours window — you can pre-warm the app to a floor of `K` pods *during
declared windows* so the first request of the wave does **not** pay a cold
start. This is **scheduled, owner-authored** warming, and it composes with the
reactive KPA: **the schedule raises the min-scale floor during the window;
Knative's KPA still scales ABOVE the floor** on real traffic. Outside every
window there is **no floor**, so the app keeps its cost-friendly scale-to-zero
(`minScale: 0`) behaviour.

> **Honest framing (ADR-0030):** `warmSchedule` is **scheduled, NOT learned**.
> It warms only the windows you declare — it does not learn traffic and does not
> cap warm cost per tenant. The learned/heuristic controller (same-hour-last-week
> RPS percentile) and the per-tenant warm-budget cap are **deferred follow-ups**
> (see ADR-0030 §Deferred). The **DB-compute lockstep pre-warm** — warming the
> app's scale-to-zero Postgres compute during the same windows — is **shipped**
> (#388, see [DB-compute lockstep](#db-compute-lockstep-pre-warm-388--adr-0030-addendum)
> below).

### How it works

The **operator itself** owns the floor — there are **no extra objects** (no
CronJobs, no KEDA, no RBAC). On every reconcile the operator:

1. Evaluates your `warmSchedule` windows against **now**, each in its own
   `timezone` (default `UTC`), using the same 5-field cron parser Kubernetes uses.
2. Sets the ksvc `autoscaling.knative.dev/min-scale` annotation to
   `max(spec.scaling.minScale, active_window_replicas)` — where
   `active_window_replicas` is the largest `replicas` of any window that contains
   now (`0` if none).
3. `RequeueAfter`s the **next window boundary** (clamped 10s–1h) so the floor
   flips promptly at each `start`/`end` without waiting for an unrelated event.

Because the operator is the **single writer** of `min-scale`, the floor never
reverts and never thrashes. Outside every window the annotation is
`spec.scaling.minScale` (default `0`), so scale-to-zero is preserved. Removing the
schedule simply lets the next reconcile compute `min-scale = minScale` — no
cleanup of children (there are none).

> **Why not KEDA / an external CronJob?** KEDA scales through the Kubernetes
> `/scale` subresource, which a **Knative Service does not expose** — a KEDA
> ScaledObject on a ksvc errors and never materializes a floor. And an external
> CronJob patching `min-scale` gets **reverted every reconcile**: the operator
> rebuilds the ksvc annotations from spec on each pass (it is the source of truth,
> ADR-0001), so a second writer's patch is erased (and thrashes Revisions). The
> correct model is a **single writer**: the operator folds the schedule into the
> annotation it already owns. (See ADR-0030 §"Two mechanisms rejected".)

> **Trade-off — new Revision when the floor changes.** Changing the ksvc template
> `min-scale` annotation is a template change, so Knative rolls a **new Revision**
> when the effective floor actually changes (at a window boundary — twice per
> window, not on every reconcile). That is fine for a normal app but resets
> traffic to latest-ready — so **`warmSchedule` cannot be combined with a pinned
> traffic target** (`spec.traffic.revisionName`). As of #393 the operator's
> admission validation **rejects** that combination outright (webhook + fail-closed
> reconciler) with an actionable error; drop the pin or the `warmSchedule`.

### Fields (`WarmWindow`)

| Field | JSON tag | Effect | Notes |
|-------|----------|--------|-------|
| `Start` | `start` | Cron at which the floor engages | **5-field cron**, syntax-validated at admission; **required** |
| `End` | `end` | Cron at which the floor drops | **5-field cron**, syntax-validated; **required** |
| `Replicas` | `replicas` | The `min-scale` floor held while now ∈ [start,end) | **must be ≥ 1** and **≤ `maxScale`** (finite) |
| `Timezone` | `timezone` | Timezone the crons are evaluated in | IANA zone (e.g. `America/New_York`); defaults to `UTC` |

Validation (admission webhook + fail-closed reconciler) rejects an empty or
**malformed** `start`/`end` cron (validated with the same 5-field parser the
Kubernetes CronJob controller uses, so a bad cron fails at `kubectl apply` with
an actionable error rather than silently in the scheduler), `replicas < 1` (a
floor of 0 warms nothing — omit the window), and `replicas > maxScale` when
`maxScale` is finite (a floor cannot exceed the reactive ceiling).

### Example — warm on weekdays 08:00–20:00 New York time

```yaml
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: storefront
spec:
  image: registry.example.com/storefront@sha256:abc123...   # digest-pinned
  scaling:
    minScale: 0              # scale to zero OUTSIDE the windows (cost floor)
    maxScale: 10             # reactive ceiling; KPA scales above the warm floor
    containerConcurrency: 20
    warmSchedule:
      - start: "0 8 * * 1-5"     # 08:00 on weekdays
        end:   "0 20 * * 1-5"    # 20:00 on weekdays
        replicas: 3             # hold 3 warm pods across the business day
        timezone: America/New_York
      - start: "0 10 * * 6,0"    # 10:00 on Sat/Sun
        end:   "0 18 * * 6,0"    # 18:00 on Sat/Sun
        replicas: 2             # lighter weekend floor (timezone defaults to UTC)
```

During each window the operator holds the declared `min-scale` floor; the KPA
still adds pods above it under load. At all other times the app scales to zero.
(No KEDA and no CronJobs — the operator folds the schedule into the Knative
`min-scale` annotation it already owns.)

### DB-compute lockstep pre-warm (#388 / ADR-0030 addendum)

The pod floor alone removes only **half** the cold tax: during a warm window the
app's first query still cold-starts its scale-to-zero Postgres **compute** (the
wake + connection-pool re-establish half). The lockstep closes that half — and
it is **opt-in, on the database side**, because knext deliberately manages no DB
machinery (the DATABASE_URL contract; ADR-0025).

**You opt in by declaring the SAME windows on the app's `AppDatabase`**
(scale-zero-pg, `packages/scale-zero-pg`): it accepts a `spec.warmSchedule` with
the same `{start, end, timezone}` 5-field-cron shape (no `replicas` — a compute
is single-writer, so DB warm is binary):

```yaml
# NextApp (app pod floor)                     # AppDatabase (DB compute hold) — scale-zero-pg ns
spec:                                          spec:
  scaling:                                       appName: storefront
    warmSchedule:                                warmSchedule:          # same windows
      - start: "0 8 * * 1-5"                       - start: "0 8 * * 1-5"
        end:   "0 20 * * 1-5"                        end:   "0 20 * * 1-5"
        replicas: 3                                  timezone: America/New_York
        timezone: America/New_York
```

While a window is active, the scale-zero-pg **appdb operator holds ONE
authenticated connection** to the app's compute through the apps-gateway — the
gateway's idle scale-to-zero only arms when a compute has zero connections, so
the compute stays warm for the whole window no matter how little traffic the
app sees. The hold rides the ordinary wake path (the gateway stays the only
replica scaler — no CronJob, no second writer), and the held session completes
real SCRAM auth, so the first in-window query pays **neither** the compute wake
**nor** a cold-auth surprise. At window end the hold is released and the compute
sleeps on its usual idle window.

- **Boundary skew:** the pod floor flips within seconds; the DB hold within one
  appdb-operator resync (default 15s). Declare windows to open a minute ahead of
  the peak.
- **Cost while held:** one connection of the compute's `GW_MAX_CONNS` (90), a
  liveness ping per resync, and the compute's reserved cpu/mem for the window —
  the warm cost you declared.
- **Observability:** `WarmHold` condition on the AppDatabase
  (`True/WindowActive`, `False/WindowInactive|HoldFailed|InvalidWarmWindow`) and
  the `appdb_warm_hold_active` metric; the platform's phantom-keepalive alert
  subtracts declared holds. A hold failure degrades to the normal cold wake —
  it never blocks the app.
- Full DB-side reference: `packages/scale-zero-pg/docs/appdatabase-api.md`
  (§"Scheduled warm windows") and ADR-0030's 2026-07-18 addendum.

### Deferred follow-ups (ADR-0030)

- **Learned/heuristic warm controller** — schedule from same-hour-last-week RPS
  percentile (per-app, from already-scraped metrics). No ML until seasonality
  proves it; adds a control loop mutating the NextApp → its own ADR.
- **Per-tenant warm-budget cap** — analog to the ADR-0008 wake budget so
  over-warming cannot erode the scale-to-zero cost win; mispredict failure modes
  (cold storm / wasted cost) measured.

(The **DB-compute lockstep pre-warm** shipped 2026-07-18 as #388 — see the
section above and ADR-0030's addendum.)

## Burst buffering (`spec.scaling.targetBurstCapacity`, ADR-0032 / #411)

ADR-0028's `containerConcurrency` default makes reactive scale-out *fire*, and
`warmSchedule` (above) pre-warms *known* windows. Neither buffers a spike nobody
scheduled: on an **unpredicted** burst, the requests that land before new pods are
Running/Ready go straight to whatever pods already exist. Knative's
`autoscaling.knative.dev/target-burst-capacity` (TBC) annotation controls whether
the **activator** — the component in front of the pods that can queue requests —
stays in the request path to pace that burst into pods as they scale, instead of
letting the first Running pod absorb the whole spike directly.

```yaml
spec:
  scaling:
    maxScale: 10
    containerConcurrency: 20
    poolMax: 5                 # 10 × 5 = 50 ≤ 80 — connection budget still holds
    targetBurstCapacity: -1    # always keep the activator in path during a scale-up
```

- **`-1`** — always keep the activator in the path. Maximum burst tolerance, but
  every request pays an extra activator→pod hop while the KPA holds it there, not
  just during a burst. Best for apps that would rather take a small constant
  latency tax than risk an overload spike.
- **`>= 0`** — a numeric burst capacity in requests the activator buffers before
  Knative removes it from the path once it judges capacity sufficient.
- **Unset (default)** — the annotation is **not stamped**; the Knative cluster
  default (`200`) applies unmanaged, exactly as before this field existed
  (back-compat).

### The connection-wall interlock

TBC paces *when* a burst is released into pods — it does not raise how many pods
`maxScale` allows, and it does not change the `maxScale × poolMax ≤ 80` invariant
(ADR-0028/ADR-0029) enforced at admission. A buffered burst still ends up running
on up to `maxScale` pods, each still capped at `poolMax` connections. So:

- Turning on `targetBurstCapacity: -1` is **not** a substitute for sizing
  `maxScale`/`poolMax` correctly — re-check that product still holds ≤ 80 when you
  tune burst buffering.
- The safest posture for a bursty, connection-sensitive app is **both**: `-1` (or
  a numeric buffer) to pace the ramp, *and* a `maxScale`/`poolMax` pair that was
  already validated to fit the connection budget.

See [ADR-0032](../adr/0032-target-burst-capacity.md) for the full trade-off
record.

## KPA panic-window / panic-threshold (`spec.scaling.panicWindowPercentage` / `panicThresholdPercentage`, ADR-0033 / #413)

`targetBurstCapacity` (above) decides *whether the activator buffers* a spike,
`containerConcurrency` (ADR-0028) decides *what makes reactive scale-out fire*, and
`warmSchedule` decides *what gets pre-warmed for a known window*. None of the three
tune **how fast the Knative Pod Autoscaler (KPA) itself reacts** to a surge it did
not predict. The KPA normally evaluates a 60s "stable" window; on a burst it can
switch into a much shorter "panic" window and refuse to scale back down until the
panic period elapses. Two Knative annotations tune that behavior directly:

```yaml
spec:
  scaling:
    maxScale: 10
    containerConcurrency: 20
    poolMax: 5                       # 10 × 5 = 50 ≤ 80 — connection budget still holds
    panicWindowPercentage: 10        # shorter panic window = more reactive (Knative default: 10)
    panicThresholdPercentage: 200    # lower = trips panic mode sooner (Knative default: 200)
```

- **`panicWindowPercentage`** (`1`-`100`) — the panic-mode evaluation window as a
  percentage of the stable window. A smaller value makes the KPA look at a
  shorter, more reactive slice of recent traffic before deciding it is in a
  surge.
- **`panicThresholdPercentage`** (`>= 110`) — how far over the steady-state
  concurrency/RPS target trips panic mode. A lower value (closer to the `110`
  floor) panics on a smaller overshoot; the Knative default is `200` (double
  the target).
- **Unset (default)**, either or both — the corresponding annotation is **not
  stamped**; the Knative cluster defaults (`10%` / `200%`) apply unmanaged,
  exactly as before these fields existed (back-compat).

### The connection-wall interlock

Exactly like `targetBurstCapacity`, the panic knobs change the **rate** the KPA
ramps toward `maxScale`, not the `maxScale × poolMax ≤ 80` ceiling
(ADR-0028/ADR-0029) enforced at admission. A faster panic reaction can reach
`maxScale` sooner during a surge; it cannot exceed it, and every pod that comes
up is still capped at `poolMax` connections. So:

- A short panic window / low panic threshold is **not** a substitute for sizing
  `maxScale`/`poolMax` correctly — re-check that product still holds ≤ 80 when
  you tune the panic knobs.
- The safest posture for an app that needs a fast reaction to genuine surges is
  **both**: an aggressive panic-window/threshold pair to ramp quickly, *and* a
  `maxScale`/`poolMax` pair that was already validated to fit the connection
  budget.

### The KPA-class caveat

Both annotations are read by Knative's **KPA** autoscaler. They are silently
ignored if a ksvc's `autoscaling.knative.dev/class` is set to the HPA-backed
class instead. knext does not stamp a class annotation, so every ksvc runs
under Knative's default class (KPA) today — but if HPA-class support is ever
added for a specific workload, these knobs would silently stop applying for it.

See [ADR-0033](../adr/0033-panic-window-threshold.md) for the full trade-off
record.

## Summary

| Concern | Knob / mitigation |
|---------|-------------------|
| Cold start on critical path | `spec.scaling.minScale: 1` (keep warm) |
| Cold start only during known peaks | `spec.scaling.warmSchedule` (operator-owned scheduled min-scale floor, ADR-0030; no KEDA/CronJobs) + the SAME windows on the AppDatabase `spec.warmSchedule` for the DB half (#388) |
| Cost on idle read zones | `spec.scaling.minScale: 0` (scale to zero) |
| JS recompile on cold start | `spec.cache.enableBytecodeCache: true` (+ a `provider`) |
| DB pool re-establish | warm zone (`minScale: 1`) and/or transaction-mode pooler; during declared windows, AppDatabase `spec.warmSchedule` holds the compute warm (#388) |
| Connection storm | low `maxScale` + declare `poolMax` (operator enforces `maxScale × poolMax ≤ 80`, ADR-0028); a pooler caps it further |
| Reactive scale-out under burst | lower `containerConcurrency` (default now `20`, ADR-0028; W1/#376 refines) |
| Unpredicted traffic spike | `spec.scaling.targetBurstCapacity` (activator burst buffer, ADR-0032; still bound by the `maxScale × poolMax` wall) |
| Slow KPA reaction to an unpredicted surge | `spec.scaling.panicWindowPercentage` / `panicThresholdPercentage` (KPA reaction-speed tuning, ADR-0033; still bound by the `maxScale × poolMax` wall) |

knext exposes the scaling/cache knobs and this guidance; the database and its
connection pooler are operated outside knext.
