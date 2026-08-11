# Knative Next.js Operator (`kn-next-operator`)

The `kn-next-operator` is a Kubernetes Operator built with Kubebuilder that serves as the control plane for the `kn-next` ecosystem. It reconciles a single `NextApp` custom resource into the Knative and Kubernetes objects needed to run a Next.js application — built with the official Next.js Adapter (`output:'standalone'`) — as a scale-to-zero service on Knative.

knext is a **narrow Next.js-on-Knative deployment adapter, not a general-purpose PaaS**. It matches Vercel's *compute* layer (scale-to-zero, comparable to Fluid Compute); it is not a Vercel-equivalent platform, and it does not aim to be one. See [Architecture & Features §10](./ARCHITECTURE.md#10-what-the-operator-deliberately-does-not-do) for the scope boundary.

## Architecture & Responsibilities

Instead of relying on fragile, static YAML manifests generated during CI/CD, the Operator shifts the deployment model to a **Declarative Reconciliation Loop**. 

Cluster administrators or CI/CD pipelines apply a single Custom Resource named `NextApp`. The Operator continuously monitors this resource and automatically provisions, updates, and self-heals the underlying Knative and Kubernetes infrastructure required to run the Next.js application at scale.

## Core Components

Detailed documentation for each of the core subsystems managed by the Operator is available below:

- **[Architecture & Features](./ARCHITECTURE.md)**: Start here. The control loop and its watch semantics, the pure status-verdict engine, admission validation, the deletion finalizer's blast-radius limits, every feature (image prewarm, network policy, database binding, traffic/scaling), the security posture, and what the operator deliberately does *not* do.
- **[The NextApp CRD (`NextApp`)](./crd-nextapp.md)**: The OpenAPI specification and schema definition for deploying Next.js apps.
- **[The Reconciler](./reconciler.md)**: The core Go-based controller loop that manages Knative Services, PVCs, and ServiceAccounts.
- **[GitOps Preview Environments](./gitops-preview.md)**: Dynamic scale-to-zero capabilities and namespace isolation for Pull Request lifecycles.
- **[Kafka Eventing & Revalidation](./kafka-eventing.md)**: Asynchronous Incremental Static Regeneration (ISR) bound via `KafkaSource`.
- **[Per-zone Scaling & Cold-start Tuning](./scaling-cold-start.md)**: When to keep a zone warm (`minScale: 1`) vs scale to zero, bounding database fan-out, and the bytecode-cache / pooler mitigations.
- **[Postgres under Scale-to-Zero](./postgres-scale-to-zero.md)**: The cluster-infra recipe for safely running Postgres behind a scale-to-zero zone — the CloudNativePG `Pooler` (PgBouncer, transaction mode), the transaction-mode ORM caveats, and the serverless-Postgres option.
