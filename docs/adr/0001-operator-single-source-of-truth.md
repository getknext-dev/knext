# ADR-0001: The Go operator is the single source of truth for cluster state

Status: Accepted (codifying existing intent) · Date: 2026-06

## Context
knext has two paths that write Kubernetes state: the **operator** (`packages/kn-next-operator`,
Go/Kubebuilder) reconciling a `NextApp` CR into a Knative Service + ServiceAccount +
bytecode-cache PVC + (optional) KafkaSource + image cache; and the **TS deploy CLI**
(`packages/kn-next/src/cli/deploy.ts`) which shells `kubectl apply` directly. Two writers of the
same cluster state causes drift, race conditions, and an unclear reconciliation owner.

## Decision
The **operator is the sole authority for cluster state.** All desired state is expressed as a
`NextApp` (and future `BackendService`) custom resource; the operator reconciles it. The CLI's
job ends at **build → push image → apply/patch the CR**. No tool other than the operator
creates or mutates Knative Services, PVCs, ServiceAccounts, KafkaSources, etc.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| **A. Operator-only writer (chosen)** | One reconciler, GitOps-friendly, drift-correcting, clear ownership | Requires CLI refactor; operator must cover every field |
| B. CLI-only (`kubectl apply`) | Simple, no operator | No reconciliation/self-heal; imperative; no GitOps; current drift |
| C. Both (status quo) | — | Two writers, races, ambiguous truth — actively harmful |

## Consequences
- `deploy.ts` must be refactored: drop direct `kubectl apply` of Knative/infra manifests;
  instead render a `NextApp` CR and `kubectl apply` **only the CR** (or use server-side apply).
- The operator's `NextAppSpec` must be a superset of what the CLI previously templated
  (scaling, cache, storage, secrets, revalidation, observability already present).
- Enables Phase-2 control-plane consolidation in the maturity plan.

## Action items

### A1-schema — field-map audit (completed)

Every cluster mutation in `deploy.ts`/`shared.ts` mapped to `NextAppSpec`:

| CLI config field | deploy.ts mutation | NextAppSpec field | Status |
|---|---|---|---|
| `scaling.minScale` | annotation `autoscaling.knative.dev/min-scale` | `Spec.Scaling.MinScale` | already present |
| `scaling.maxScale` | annotation `autoscaling.knative.dev/max-scale` | `Spec.Scaling.MaxScale` | already present |
| `scaling.cpuRequest` | container resources.requests.cpu | `Spec.Resources.CPURequest` | already present |
| `scaling.memoryRequest` | container resources.requests.memory | `Spec.Resources.MemoryRequest` | already present |
| `scaling.cpuLimit` | container resources.limits.cpu | `Spec.Resources.CPULimit` | already present |
| `scaling.memoryLimit` | container resources.limits.memory | `Spec.Resources.MemoryLimit` | already present |
| `storage.provider` | env `STORAGE_PROVIDER` | `Spec.Storage.Provider` | already present |
| `storage.bucket` | env `GCS_BUCKET_NAME` / `CACHE_BUCKET_NAME` | `Spec.Storage.Bucket` | already present |
| `storage.region` | env `CACHE_BUCKET_REGION` (S3/MinIO) | `Spec.Storage.Region` | **added A1-schema** |
| `storage.endpoint` | env `S3_ENDPOINT` (MinIO) | `Spec.Storage.Endpoint` | **added A1-schema** |
| `cache.provider` | env `CACHE_PROVIDER` | `Spec.Cache.Provider` | already present |
| `cache.url` | env `REDIS_URL` | `Spec.Cache.URL` | already present |
| `cache.keyPrefix` | env `REDIS_KEY_PREFIX` | `Spec.Cache.KeyPrefix` | **added A1-schema** |
| `healthCheckPath` | readiness/liveness probe path | `Spec.HealthCheckPath` | already present |
| `secrets.envFrom` | container envFrom | `Spec.Secrets.EnvFrom` | already present |
| `secrets.envMap` | container env secretKeyRef | `Spec.Secrets.EnvMap` | already present |
| `observability.enabled` | annotations + env `KN_APP_NAME` | `Spec.Observability.Enabled` | already present |
| `runtime` | (not yet wired in CLI) | `Spec.Runtime` | **added A1-schema** |
| knative-manifest `containerConcurrency=100` | ksvc containerConcurrency | `Spec.Scaling.ContainerConcurrency` | already present |
| knative-manifest `timeoutSeconds=300` | ksvc template timeout | `Spec.TimeoutSeconds` | **added A1-schema** |

Infrastructure manifests (`postgres.yaml`, `redis.yaml`, `minio.yaml`) applied by `deploy.ts:153`
are **operator-external** resources. Per ADR-0001 the CLI must stop applying these directly.
These are app-level resources out of scope for the NextApp CR in v1alpha1; deferred to a
future `InfrastructureSpec` CRD expansion or side-car operator.

- [x] Audit every cluster mutation in `deploy.ts`/`shared.ts`; map each to a `NextApp` field.
- [x] Add any missing fields to `NextAppSpec`; regenerate CRD.
- [ ] Refactor CLI to emit + apply the CR only. Add a `--dry-run` that prints the CR. (A1-cli)
- [ ] Remove/clarify the Go `packages/cli` vs TS CLI overlap (separate cleanup).
