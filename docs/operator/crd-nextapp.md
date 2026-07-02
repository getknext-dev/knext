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

### `scaling` (Optional)
Controls the autoscaling behavior of the underlying Knative Service.
```yaml
spec:
  scaling:
    minScale: 1              # Minimum active pods (Default: 0)
    maxScale: 10             # Maximum pods during burst traffic (Default: 10)
    containerConcurrency: 100 # Max concurrent requests per pod
```

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

### `preview` (Optional)
Enables ephemeral GitOps isolation for Pull Request testing. See [GitOps Previews](./gitops-preview.md).
```yaml
spec:
  preview:
    enabled: true
    branch: "feat/new-ui"
    prId: "123"
```
