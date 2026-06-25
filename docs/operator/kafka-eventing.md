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

## Scope: ISR revalidation vs cross-zone domain events

> **TL;DR — `spec.revalidation.kafka` is NOT a domain-event bus.** It exists **only** for Next.js
> ISR / data-cache revalidation. If you are building a multi-zone Self-Contained System (SCS) and
> want to route **business** events (invoices, stock moves, order placed) between zones, do **not**
> use `spec.revalidation`. That is an application concern — bring your own broker and your own
> producers/consumers. See `.claude/rules/scs-zones.md` (cross-zone integration = async domain events).

### What knext's Kafka plumbing is (and is not)

| | `spec.revalidation.kafka` (this feature) | Cross-zone domain events (your app) |
| --- | --- | --- |
| Purpose | Trigger Next.js ISR / data-cache revalidation | Propagate business facts between zones |
| Topic | `{app-name}-revalidation` (operator-named) | You define them |
| Consumer | `{app}-revalidator` — **opt-in & deferred (#95)**, you deploy it | You deploy producers + consumers |
| Provisioned by knext | A Knative `KafkaSource` **only** when `provisionKafkaSource: true` | **Nothing** — no broker, no topic, no consumer |
| Delivery guarantee | None promised; ISR is best-effort/idempotent by nature | **Your responsibility** (see idempotency below) |

Routing domain events through `spec.revalidation` hits a dead end: the topic is ISR-scoped, the
consumer is opt-in and not built by knext, and the operator provisions only a `KafkaSource` (never a
broker). The fields involved are exactly (from `api/v1alpha1/nextapp_types.go`, `RevalidationSpec`):
`queue`, `kafkaBrokerUrl`, `provisionKafkaSource` — nothing about domain topics or your consumer groups.

### Cross-zone domain events are an application concern

Run your **own** Kafka — a cluster broker (e.g. Strimzi) or a managed Kafka — and your own producers
and consumers inside each zone's service. **knext provisions no broker for this.** Its only role is
to inject the broker **credentials** into your app's environment via `spec.secrets.envMap`.

`spec.secrets.envMap` maps an **environment variable name** to a specific key inside a Kubernetes
Secret. Each entry has exactly two fields — `secretName` and `secretKey` (both required) — and the
operator renders it as a `secretKeyRef` env var on the workload:

```yaml
apiVersion: kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: orders-zone
spec:
  image: registry.example.com/orders-zone@sha256:...   # digest-pinned, never :latest
  secrets:
    envMap:
      # ENV_VAR_NAME: { secretName, secretKey }  — the real EnvMapEntry shape
      KAFKA_BROKERS:
        secretName: orders-kafka-credentials
        secretKey: brokers
      KAFKA_SASL_USERNAME:
        secretName: orders-kafka-credentials
        secretKey: username
      KAFKA_SASL_PASSWORD:
        secretName: orders-kafka-credentials
        secretKey: password
```

That is the whole contract: knext **binds the Secret**, the cluster runs the broker, and your zone's
code reads `KAFKA_BROKERS` (etc.) from `process.env` to connect. knext does not provision the broker,
create topics, manage consumer groups, or relay messages for domain events.

> Secrets only ever live in Kubernetes Secrets — never in the `NextApp` manifest, the image, or a
> URL (see `.claude/rules/security.md`). `envMap` references a Secret you created; it does not embed
> the value.

### Idempotency is the application's job (no exactly-once)

knext provides **no exactly-once delivery** for domain events — it provisions nothing for them. Kafka
gives you at-least-once, so your consumers **will** occasionally see a duplicate. The
idempotent-consumer contract is yours to implement: record the processed event's id in the **same
database transaction** as the side effect it produces, and skip events whose id is already recorded.
Because each zone owns its own data store (`.claude/rules/scs-zones.md`), that processed-event marker
lives in the consuming zone's database — never in another zone's.
