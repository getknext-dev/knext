# Kafka Eventing & Revalidation

Integrating deeply with Next.js' App Router architecture, the Operator manages the complex infrastructure required for **Asynchronous Incremental Static Regeneration (ISR)**.

When a Next.js application executes a `revalidateTag()` or `revalidatePath()`, the Vercel architecture requires that the regeneration of that requested route does not block the active user's HTTP request. 

To achieve parity on Kubernetes, the `kn-next-operator` relies on an Event-Driven architecture powered by Knative Eventing and Kafka.

## Declarative Config

```yaml
spec:
  revalidation:
    queue: "kafka"
    kafkaBrokerUrl: "kafka-cluster-kafka-bootstrap.kafka.svc:9092"
```

## How It Works

When the Reconciler parses the configuration above, it bypasses standard application routing and dynamically scaffolds a Knative `KafkaSource`. 

Instead of adding heavy Knative Eventing Go-module dependencies to the controller binary, the Operator integrates via generic `unstructured.Unstructured` mappings:

1. **Consumer Group**: Automatically generates a localized consumer group (e.g., `myapp-revalidation`) to parallelize work over multiple replicas.
2. **Topic**: Instructs the KafkaSource to consume explicitly from `[app-name]-revalidation`.
3. **Sink Routing**: Routes all consumed events directly to the `myapp-revalidator` Knative Service.

This process explicitly abstracts the message-broker plumbing away from developers. OpenNext's built-in Kafka queue adapter receives the regeneration signals flawlessly as standard HTTP webhooks, ensuring ISR logic remains fully Serverless and scales correctly from zero.
