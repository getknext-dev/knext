# The `NextApp` Custom Resource Definition (CRD)

The `NextApp` CRD is the unified interface for deploying OpenNext applications onto Knative. It abstracts the underlying Knative Services, PVCs, ServiceAccounts, and Eventing bindings into a single declarative API.

## API Version & Kind
```yaml
apiVersion: kn-next.dev/v1alpha1
kind: NextApp
```

## Specification (`Spec`)

The `spec` defines the desired state of the Next.js application.

### `image` (Required)
The absolute OCI registry path to the Next.js container image built by OpenNext.
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
    enableBytecodeCache: true   # Provisions a shared PVC for V8 compilation cache
    bytecodeCacheSize: "1Gi"    # Size of the requested PVC
```

### `revalidation` (Optional)
Configures Asynchronous ISR Regenerations.
```yaml
spec:
  revalidation:
    queue: "kafka"
    kafkaBrokerUrl: "kafka-cluster-kafka-bootstrap.kafka.svc:9092"
```

### `secrets` (Optional)
Maps Kubernetes `Secret` resources directly into the Next.js environment variables.
```yaml
spec:
  secrets:
    envFrom:
      - "database-credentials"
      - "stripe-api-keys"
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
