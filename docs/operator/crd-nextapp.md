# The `NextApp` Custom Resource Definition (CRD)

The `NextApp` CRD is the unified interface for deploying Next.js applications (built with `output:'standalone'` via the official adapter) onto Knative. It abstracts the underlying Knative Services, PVCs, ServiceAccounts, and Eventing bindings into a single declarative API.

## API Version & Kind
```yaml
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
```

## Specification (`Spec`)

The `spec` defines the desired state of the Next.js application.

### `image` (Required)
The absolute OCI registry path to the Next.js container image (built from `output:'standalone'`).
Must be **digest-pinned** (`@sha256:...`); the operator rejects `:latest` and tag-only refs
at admission (mutable tags break rollbacks and provenance — see `.claude/rules/security.md`).
```yaml
spec:
  image: ghcr.io/org/repo/app:v1.2.3@sha256:abc123...   # digest-pinned, never :latest
```

### `runtime` (Optional)
Selects the process that executes the standalone server: `"node"` (default) or `"bun"`.
```yaml
spec:
  runtime: "bun"
```

> **Warning — runtime flips and bytecode-built images:** an image built by `kn-next build` with `runtime: bun` has its server-side JavaScript precompiled to Bun bytecode and **only boots under Bun**. Setting this field to `node` for such an image makes the pod exit immediately with a `FATAL` message (a deliberate loud failure instead of a silent crash-loop) — switching a bytecode-built app back to Node requires **rebuilding the image** with `runtime: node` (or `KNEXT_BUN_BYTECODE=0`). Images built for `node` run under either runtime.

### `scaling` (Optional)
Controls the autoscaling behavior of the underlying Knative Service.
```yaml
spec:
  scaling:
    minScale: 1               # Minimum active pods / warm floor (Default: 0, scale to zero for cost)
    maxScale: 10              # Maximum pods during burst traffic (Default: 10)
    containerConcurrency: 20  # Concurrent requests per pod before Knative adds a pod (Default: 20, ADR-0028; W1/#376 refines)
    poolMax: 5                # Optional per-pod DB pool max; when set the operator enforces maxScale × poolMax ≤ 80 (ADR-0028)
    warmSchedule:             # Optional SCHEDULED warm floor (ADR-0030, #380); no KEDA needed
      - start: "0 8 * * 1-5"     # 5-field cron: warm floor begins (08:00 weekdays)
        end:   "0 20 * * 1-5"    # 5-field cron: warm floor ends (20:00 weekdays)
        replicas: 3             # min-scale floor held during the window (>= 1, <= maxScale)
        timezone: America/New_York # IANA timezone; defaults to UTC
```

> The `containerConcurrency` default was lowered from `100` to `20` in ADR-0028
> so reactive scale-out is not inert under high traffic. Declare `poolMax` to let
> the operator enforce the connection-wall invariant `maxScale × poolMax ≤ 80`
> (the gateway cap `GW_MAX_CONNS=90` minus an admin/replication reserve, not the
> raw Postgres `max_connections=100`).
> See [`scaling-cold-start.md`](./scaling-cold-start.md#high-traffic-profile-377-adr-0028).

> `warmSchedule` pre-warms the app to a floor of `replicas` pods **during declared
> windows**: on every reconcile the **operator** evaluates the windows against now
> (in each window's timezone) and sets the ksvc
> `autoscaling.knative.dev/min-scale` to `max(minScale, active-window replicas)`,
> RequeueAfter'ing the next window boundary (the Knative KPA still scales above the
> floor). The operator is the **single writer** of min-scale — no CronJobs, no
> KEDA (KEDA cannot scale a Knative Service; see ADR-0030) — so the floor never
> reverts. This is **scheduled, owner-authored** warming — **not learned
> prediction**. Empty => min-scale falls back to `minScale` (default scale-to-zero).
> **Cannot** be combined with a pinned `spec.traffic.revisionName` (a min-scale
> change rolls a new Revision and would reset the pin) — this is a **hard admission
> rejection** as of #393, not just advice. See
> [`scaling-cold-start.md`](./scaling-cold-start.md#scheduled-warm-floor-specscalingwarmschedule-adr-0030--380)
> and [ADR-0030](../adr/0030-scheduled-warm-floor.md) (incl. the deferred
> learned-controller / DB-lockstep / warm-budget follow-ups).

### `storage` (Optional)
Binds the Next.js Server Actions (e.g., `<input type="file" />`) to a cloud storage provider.
```yaml
spec:
  storage:
    provider: "gcs"           # or "s3", "local"
    bucket: "my-gcs-bucket"
```

### `cache` (Optional)
Configures the Unified Remote Cache (Redis) and V8 Bytecode caching layer.
```yaml
spec:
  cache:
    provider: "redis"
    url: "redis://redis.default.svc.cluster.local:6379"
    enableBytecodeCache: true   # Provisions a shared PVC for the runtime code cache
    bytecodeCacheSize: "1Gi"    # Size of the requested PVC
```

`enableBytecodeCache` covers **both** runtimes from one field: Node's `NODE_COMPILE_CACHE` (always) and Bun's runtime transpiler cache (added when `runtime: bun`), on the same PVC. Cache growth is bounded only by `bytecodeCacheSize` — there is no eviction — and both runtimes fail open (serving is unaffected) if the volume fills up or is unwritable.

### `revalidation` (Optional)
Configures Asynchronous ISR Regenerations.
```yaml
spec:
  revalidation:
    queue: "kafka"
    kafkaBrokerUrl: "kafka-cluster-kafka-bootstrap.kafka.svc:9092"
```

### `env` (Optional)
Sets plain, **non-secret** environment variables on the app container — feature
flags and runtime tuning such as `KNEXT_CACHE_CONTROL_NORMALIZE` (see the
[Configuration Reference](../../README.md#cache-control-normalization-knext_cache_control_normalize)).
Values are stored verbatim in the resource, so anything sensitive (API keys,
connection strings, tokens) belongs in `secrets` below instead.
```yaml
spec:
  env:
    KNEXT_CACHE_CONTROL_NORMALIZE: "0"
    FEATURE_FLAG_BETA: "on"
```
Rules:
- Names must be valid environment variable identifiers (`[A-Za-z_][A-Za-z0-9_]*`).
- The reserved names `HOSTNAME`, `PORT`, `K_SERVICE`, `K_REVISION`, and
  `K_CONFIGURATION` are rejected when you apply the resource — they are managed
  by the platform, and overriding them would break request routing.
- If an `env` name collides with a platform-managed variable or with a
  `secrets.envMap` mapping, the `env` entry is ignored and a Warning event is
  recorded on the resource (visible in `kubectl describe nextapp <name>`)
  explaining which side won.
- **`secrets.envFrom` is different**: it injects every key of a Secret, and the
  platform cannot see those keys when it builds the container. If an `env` name
  matches a key inside an `envFrom` Secret, the `env` value **wins at runtime**
  (Kubernetes applies `envFrom` first, then explicit variables on top). Keeping
  `env` names and `envFrom` Secret keys disjoint is your responsibility.

### `secrets` (Optional)
Maps Kubernetes `Secret` resources directly into the Next.js environment variables.
This is the CR's mechanism for **secret-backed** environment variables (plain
config flags go in `env` above): `envFrom` injects every key of a Secret;
`envMap` maps a single env var name to a specific Secret key.
```yaml
spec:
  secrets:
    envFrom:
      - "database-credentials"
      - "stripe-api-keys"
    envMap:
      DATABASE_PASSWORD:
        secretName: database-credentials
        secretKey: password
```

Note: when `spec.database` is set, it **owns**
`DATABASE_URL`/`DATABASE_URL_RO` — an `envMap` entry for the same name is
rejected by the validating webhook on create and on any update that introduces
the conflict (no silent precedence). CRs that already carried the conflict
before this rule are grandfathered (ratcheted): they keep reconciling,
`spec.database` wins, and the operator records a Warning event naming the
ignored `envMap` entry. Every other env var is fair game.

### `database` (Optional)
Binds the app's Postgres. The only mode is **binding** (`secretRef`): bring
your own database — knext provisions and manages nothing. (The operator's
former managed provisioning mode was removed; see
[ADR-0025](../adr/0025-remove-managed-database-mode.md).)

**Binding mode (`secretRef`) — ADR-0019.** Binds an *existing* Secret in the
app's namespace as `DATABASE_URL` (and optionally a read-only DSN as
`DATABASE_URL_RO`). Typed sugar over the `secrets.envMap` recipe — the operator
injects through the exact same `SecretKeyRef` machinery, so precedence rules
are identical:

```yaml
spec:
  database:
    secretRef:               # -> env DATABASE_URL
      name: shop-db          # Secret in the app's namespace (DNS-1123)
      # key: DATABASE_URL    # default
    roSecretRef:             # optional -> env DATABASE_URL_RO
      name: shop-db          # key defaults to DATABASE_URL_RO, so one Secret
                             # carrying both keys binds with no key config
```

- **No provisioning, no hard-gate:** a missing Secret surfaces on the pod as
  `CreateContainerConfigError` until it appears (exactly the `envMap` semantics);
  rotating the DSN in-place does **not** roll a new Revision (redeploy to pick it up).
- `status.databaseSecretName` records the bound Secret; condition
  `DatabaseReady=True` with reason `Bound`. Removing `spec.database` clears
  both on the next reconcile.
- `roSecretRef` requires `secretRef` — a read-only binding cannot stand alone
  (the block's one intra-field validation rule).
- Pool-timeout contract (pool idle **<** the gateway's 60 s window, connect
  timeout **≥** 10 s) + the worked scale-zero-pg example: see the
  [Postgres binding guide](../guides/postgres-binding.md).

### `preview` (Optional)
Enables ephemeral GitOps isolation for Pull Request testing. See [GitOps Previews](./gitops-preview.md).
```yaml
spec:
  preview:
    enabled: true
    branch: "feat/new-ui"
    prId: "123"
```
