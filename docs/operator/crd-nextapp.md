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
```yaml
spec:
  image: ghcr.io/org/repo/app:latest
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
```

> The `containerConcurrency` default was lowered from `100` to `20` in ADR-0028
> so reactive scale-out is not inert under high traffic. Declare `poolMax` to let
> the operator enforce the connection-wall invariant `maxScale × poolMax ≤ 80`
> (the gateway cap `GW_MAX_CONNS=90` minus an admin/replication reserve, not the
> raw Postgres `max_connections=100`).
> See [`scaling-cold-start.md`](./scaling-cold-start.md#high-traffic-profile-377-adr-0028).

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

Note: when `spec.database` is set (either mode below), it **owns**
`DATABASE_URL`/`DATABASE_URL_RO` — an `envMap` entry for the same name is
rejected by the validating webhook on create and on any update that introduces
the conflict (no silent precedence). CRs that already carried the conflict
before this rule are grandfathered (ratcheted): they keep reconciling,
`spec.database` wins, and the operator records a Warning event naming the
ignored `envMap` entry. Every other env var is fair game.

### `database` (Optional)
Declares the app's Postgres. Two mutually-exclusive modes — **binding**
(`secretRef`: bring your own DB) and **managed** (`enabled: true`: inline
provisioning).

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
  both on the next reconcile (for a previously managed app, see
  [switching modes](#switching-database-modes) below).
- Provisioning knobs (`tier`, `readReplicas`, `quotas`, `keepOnDelete`) are
  rejected alongside `secretRef` (they are managed-mode-only), and `secretRef`
  is rejected alongside `enabled: true` — one mode per app.
- Pool-timeout contract (pool idle **<** the gateway's 60 s window, connect
  timeout **≥** 10 s) + the worked scale-zero-pg example: see the
  [Postgres binding guide](../guides/postgres-binding.md).

**Managed mode (`enabled: true`).** Declares an **inline** [scale-zero-pg](../guides/unified-config-database.md) database
that the operator auto-provisions and wires into `DATABASE_URL` — the app and its
database sleep at zero and wake together on one visitor request. This is the
**unified-config** flagship (ADR-0006). You do **not** hand-write a `DATABASE_URL`
`envMap` entry: the operator provisions the DB, mirrors its credential Secret into
your app's namespace, and injects `DATABASE_URL` (and `DATABASE_URL_RO` when
`readReplicas: true`) for you.

```yaml
spec:
  database:
    enabled: true            # false/absent => bring-your-own via secretRef (above)
    tier: cold               # cold = scale-to-zero (default) | warm = ~0.4s wake
    readReplicas: true       # also injects DATABASE_URL_RO
    quotas:                  # per-app noisy-neighbour bound (all fields optional)
      cpu: "1000m"
      cpuRequest: "250m"
      mem: "1Gi"
      memRequest: "256Mi"
      maxConnections: 100
    keepOnDelete: false      # false => deleting the NextApp reclaims the Neon timeline
```

- **`appName` is derived, never set by you** — the operator computes a
  plane-globally-unique name from your NextApp's own `(namespace, name)` and records
  it on `status.databaseAppName`. This is the security seam: a NextApp can only ever
  bind the database minted for **its own** identity, never another namespace's DB.
- **Hard-gate:** the app is **not** deployed (no Knative Service) until its database
  reports `Ready` (`status.conditions[DatabaseReady]`). A `cold` DB reaches `Ready` in
  ~seconds. This prevents booting an app that would crash-loop on a missing DSN.
- **Teardown:** deleting the NextApp deletes the database (and reclaims its Neon
  timeline) via a finalizer, unless `keepOnDelete: true`.
- **BYO:** use `secretRef` (binding mode, above) to point at an external or existing
  database; the raw `secrets.envMap` recipe also still works when `spec.database`
  is fully omitted.

See the [unified-config guide](../guides/unified-config-database.md) for the full flow,
sizing notes, rotation behavior, and required RBAC.

#### Switching database modes

**Managed → binding (or removing `spec.database` entirely) never deletes your
managed database.** A spec edit is not a destruction order: the provisioned
database (and its data) keeps running, and the operator flags it instead:

- condition `DatabaseOrphaned=True` (reason `ModeSwitched`) names the retained
  database, plus a one-time `Warning` event (`DatabaseOrphaned`) at switch time;
- the new `secretRef` binding works immediately and independently
  (`DatabaseReady=True/Bound`);
- `status.databaseAppName` stays set so you (and the operator) can still find
  the orphan.

You resolve the orphan one of three ways:

1. **Delete it manually** — `kubectl delete appdatabase <databaseAppName>
   -n scale-zero-pg`. The next reconcile clears `DatabaseOrphaned` and
   `status.databaseAppName`.
2. **Switch back to managed** (`enabled: true`) — the operator rebinds the
   **same** database (the name is derived from your app's identity, so no
   duplicate is provisioned) and drops the flag. Your data is exactly where
   you left it.
3. **Delete the NextApp** — the delete-time finalizer reclaims the orphaned
   database as usual. A `keepOnDelete: true` set while the app was managed is
   still honored downstream (the underlying timeline is retained even though
   the database object is reclaimed).

The mirrored `<name>-db` credential Secret is also retained until the NextApp
is deleted (older Revisions may still reference it).

### `preview` (Optional)
Enables ephemeral GitOps isolation for Pull Request testing. See [GitOps Previews](./gitops-preview.md).
```yaml
spec:
  preview:
    enabled: true
    branch: "feat/new-ui"
    prId: "123"
```
