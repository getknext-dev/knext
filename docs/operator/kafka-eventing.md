# Kafka Eventing & Revalidation

> **Status (issue #95): DEFERRED — opt-in only.** The `{app}-revalidator` consumer service
> described below is **not yet shipped** (no tracked implementation; the routing PR #27 was closed
> without merging). To avoid wiring eventing to a non-existent sink, the operator **no longer
> provisions the KafkaSource by default**. It does so **only when you explicitly opt in**
> (`spec.revalidation.provisionKafkaSource: true`) **and** have deployed an external consumer for
> the `{app}-revalidation` topic yourself. With `queue: kafka` but no opt-in, the operator records a
> non-fatal `RevalidationDeferred` status condition (`Ready` stays `True`) and creates nothing. See
> ADR-0003 ("Revalidation status").

Integrating deeply with Next.js' App Router architecture, the Operator manages the complex infrastructure required for **Asynchronous Incremental Static Regeneration (ISR)**.

When a Next.js application executes a `revalidateTag()` or `revalidatePath()`, the Vercel architecture requires that the regeneration of that requested route does not block the active user's HTTP request. 

To achieve parity on Kubernetes, the `kn-next-operator` relies on an Event-Driven architecture powered by Knative Eventing and Kafka.

## Declarative Config

```yaml
spec:
  revalidation:
    queue: "kafka"
    # Default nil/false => NO KafkaSource is provisioned (consumer not yet built, #95).
    # Set true ONLY if you have deployed an external {app}-revalidator consumer yourself.
    provisionKafkaSource: true
    kafkaBrokerUrl: "kafka-cluster-kafka-bootstrap.kafka.svc:9092"
```

## How It Works

When `queue: "kafka"` **and** `provisionKafkaSource: true`, the Reconciler dynamically scaffolds a
Knative `KafkaSource`. (Without the opt-in, it provisions nothing and sets `RevalidationDeferred`.)

Instead of adding heavy Knative Eventing Go-module dependencies to the controller binary, the Operator integrates via generic `unstructured.Unstructured` mappings:

1. **Consumer Group**: Automatically generates a localized consumer group (e.g., `myapp-revalidation`) to parallelize work over multiple replicas.
2. **Topic**: Instructs the KafkaSource to consume explicitly from `[app-name]-revalidation`.
3. **Sink Routing**: Routes all consumed events to a `myapp-revalidator` Knative Service.

> **Caveat (#95):** the `myapp-revalidator` sink is **not shipped by knext**. When you opt in, you
> are asserting that you have deployed that consumer (it must consume the revalidation CloudEvents
> and call `revalidateTag()` against the Redis-backed cache). A first-class, knext-built revalidator
> remains design-now/build-later (ADR-0003 Option A), revisited after Tier-A correctness.
