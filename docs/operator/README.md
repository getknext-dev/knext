# Knative Next.js Operator (`kn-next-operator`)

The `kn-next-operator` is a Kubernetes Operator built with Kubebuilder that serves as the control plane for the `kn-next` ecosystem. It transforms standard Kubernetes clusters into a seamless, "Vercel-equivalent" Platform-as-a-Service (PaaS) for Next.js applications deployed on OpenNext and Knative.

## Architecture & Responsibilities

Instead of relying on fragile, static YAML manifests generated during CI/CD, the Operator shifts the deployment model to a **Declarative Reconciliation Loop**. 

Cluster administrators or CI/CD pipelines apply a single Custom Resource named `NextApp`. The Operator continuously monitors this resource and automatically provisions, updates, and self-heals the underlying Knative and Kubernetes infrastructure required to run the Next.js application at scale.

## Core Components

Detailed documentation for each of the core subsystems managed by the Operator is available below:

- **[The NextApp CRD (`NextApp`)](./crd-nextapp.md)**: The OpenAPI specification and schema definition for deploying Next.js apps.
- **[The Reconciler](./reconciler.md)**: The core Go-based controller loop that manages Knative Services, PVCs, and ServiceAccounts.
- **[GitOps Preview Environments](./gitops-preview.md)**: Dynamic scale-to-zero capabilities and namespace isolation for Pull Request lifecycles.
- **[Kafka Eventing & Revalidation](./kafka-eventing.md)**: Asynchronous Incremental Static Regeneration (ISR) bound via `KafkaSource`.
