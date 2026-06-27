---
name: knext-deploy
description: >-
  Deploy and operate a knext zone with the kn-next CLI and the NextApp Custom
  Resource: build + push the image, deploy (which emits a digest-pinned NextApp
  CR the Go operator reconciles into a scale-to-zero Knative Service), roll back /
  canary by traffic split, create per-PR preview environments, and clean up. Use
  this skill whenever running the kn-next CLI (build/deploy/rollback/preview/
  cleanup), authoring or editing a NextApp CR, wiring secrets (DATABASE_URL,
  tokens) / scaling bounds / cache / network policy onto a deployment, or asking
  "how do I deploy / roll back / scale / inject secrets" for a knext app.
---

# Deploying with `kn-next` + the `NextApp` CR

knext's control plane has one rule (**ADR-0001**): the **Go operator is the single
source of truth** for cluster state. The CLI's job is strictly **build → push →
emit a `NextApp` Custom Resource (CR)**; the operator reconciles that CR into a
Knative Service. The CLI never applies raw Knative manifests.

```
kn-next build   →  build image + upload static assets to object storage
kn-next deploy  →  push image (digest) + kubectl apply a NextApp CR
operator        →  reconciles the CR → Knative Service (+ probes, NetworkPolicy, PVC…)
```

## The CLI commands

Run these from the app directory (it loads `kn-next.config.ts`; see `knext-app`).

| Command | What it does | Key flags |
| --- | --- | --- |
| `kn-next build` | `next build` (standalone) + upload static assets to object storage | — |
| `kn-next deploy` | Build/push the image **digest-pinned**, then apply the `NextApp` CR | `-n/--namespace`, `--dry-run` |
| `kn-next rollback [app]` | Shift serving traffic to a prior Knative Revision (CR `spec.traffic` patch only) | `--to <revision>`, `--canary <n>` (0–100), `-n/--namespace` |
| `kn-next preview` | Create/destroy a per-PR ephemeral env as a `<app>-pr-<n>` CR | `--pr <n>`, `--branch <name>`, `-n/--namespace` |
| `kn-next cleanup` | Tear down a deployed app + its scoped resources | `--ignore-not-found`, `-n` |

**Images are digest-pinned and `:latest` is rejected** — both CLI-side (the CR
builder refuses any ref without `@sha256:`) and at the operator admission webhook.

### Rollback / canary

```bash
kn-next rollback storefront                       # revert to latest-ready revision
kn-next rollback storefront --to storefront-00002 # pin 100% to a revision
kn-next rollback storefront --to storefront-00002 --canary 20  # 20% latest-ready / 80% pinned
```

Rollback is a pure traffic decision (no rebuild): it patches `spec.traffic` on the
CR and the operator renders Knative traffic targets.

## The `NextApp` CR (the platform contract)

`kn-next deploy` emits this; you can also author it directly for GitOps. Every
field below is real (`apps.kn-next.dev/v1alpha1`). Minimal Postgres-backed zone:

```yaml
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: storefront
  namespace: shop
spec:
  image: REG/storefront@sha256:<digest>   # required, digest-pinned (:latest rejected)
  runtime: node                            # node (default) | bun
  healthCheckPath: /api/health             # drives readiness/liveness probes
  scaling:
    minScale: 0                            # scale-to-zero
    maxScale: 6
    containerConcurrency: 80               # bound DB fan-out: maxScale × pool_max
  resources:
    cpuRequest: "250m"
    memoryRequest: "512Mi"
    cpuLimit: "1000m"
    memoryLimit: "1Gi"
  cache:
    provider: redis                        # redis | memory
    url: redis://redis.shop.svc:6379
    keyPrefix: storefront
    enableBytecodeCache: true              # NODE_COMPILE_CACHE on a PVC → fast cold starts
  secrets:
    envMap:                                # individual env vars from K8s Secret keys
      DATABASE_URL:   { secretName: storefront-db,      secretKey: uri }
      PAYLOAD_SECRET: { secretName: storefront-payload, secretKey: secret }
    envFrom: [storefront-extra]            # whole Secrets, optional
  security:
    networkPolicy: true                    # default-on L3/L4 isolation
```

### Field cheat-sheet
- **`image`** — must be `@sha256:`-pinned. **`runtime`** — `node`|`bun`.
- **`scaling`** — `minScale`/`maxScale`/`containerConcurrency` (defaults `0/10/100`).
- **`secrets.envMap`** (`{secretName, secretKey}` per var) / **`secrets.envFrom`**
  (`[secretName]`) — the **only** way to inject `DATABASE_URL`, tokens, etc.
  Secrets live in K8s Secrets, never in config/images/URLs.
- **`cache.enableBytecodeCache`** — persist V8 bytecode on a PVC across cold pods.
- **`revalidation`** — `{ queue: kafka, kafkaBrokerUrl, provisionKafkaSource }` for
  ISR revalidation (opt-in; the consumer is design-now/build-later).
- **`traffic`** — `{ revisionName, canaryPercent }` (set by `kn-next rollback`).
- **`security.networkPolicy`** — default-on internal-only NetworkPolicy.
- **`observability`** — metrics/RUM/tracing (default-off tracing).

## Rules
- **knext does not provision databases or brokers.** It injects the *secret*
  (`spec.secrets`); the cluster runs Postgres (CloudNativePG) / Kafka (Strimzi).
- **Never** apply raw Knative Service/Route manifests out-of-band — go through the
  CR + operator (ADR-0001).
- **Never** use `:latest` or an unpinned tag — it's rejected.
- Fleet: the CLI is one-app-per-invocation; deploy N zones with a CI loop over each
  app's `kn-next.config.ts`.

## Related skills
- `knext-app` — the `kn-next.config.ts` + adapter wiring the CLI consumes.
- `knext-lib` / `postgres` — how the app uses `DATABASE_URL` + pooling at runtime.
- `knative-kubernetes` — operator reconcile internals, KPA autoscaling, networking.
- `scs-zones` — composing many zones (data sovereignty, async events).
