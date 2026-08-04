# Kafka Eventing & Revalidation

> **Status (issues #95, #475): DEFERRED — and the BYO opt-in is WITHDRAWN.** The
> `{app}-revalidator` consumer service described below is **not yet shipped** (no tracked
> implementation; the routing PR #27 was closed without merging). The opt-in
> `spec.revalidation.provisionKafkaSource` used to say "I have deployed that consumer myself" — but
> knext never specified or tested that sink contract, so the option is **withdrawn** and the field
> is now **INERT**: it is still accepted (rejecting it would narrow `v1alpha1` in place, which
> ADR-0017 §2.1 reserves for a new API version, and would wedge stored CRs on the fail-closed
> reconciler), but **no KafkaSource is created on any value**. `queue: kafka` records a non-fatal
> `RevalidationDeferred` condition (`Ready` stays `True`); setting the flag additionally reports
> reason `ProvisionKafkaSourceInert` and a Warning event. See ADR-0003 ("Revalidation status") and
> ADR-0016.

Integrating deeply with Next.js' App Router architecture, the Operator manages the complex infrastructure required for **Asynchronous Incremental Static Regeneration (ISR)**.

When a Next.js application executes a `revalidateTag()` or `revalidatePath()`, the Vercel architecture requires that the regeneration of that requested route does not block the active user's HTTP request. 

To achieve parity on Kubernetes, the `kn-next-operator` relies on an Event-Driven architecture powered by Knative Eventing and Kafka.

## Declarative Config

```yaml
spec:
  revalidation:
    queue: "kafka"
    # provisionKafkaSource is INERT (#475): the BYO {app}-revalidator consumer path is
    # withdrawn, so the field is ignored on every value. Leave it unset.
    kafkaBrokerUrl: "kafka-cluster-kafka-bootstrap.kafka.svc:9092"
```

## How It Works

When `queue: "kafka"` **and** `provisionKafkaSource: true`, the Reconciler would dynamically
scaffold a Knative `KafkaSource` — the shape described below. That path is currently **unreachable**:
the flag is ignored (#475) until the sink consumer ships, so the operator provisions nothing and
sets `RevalidationDeferred`. The construction is retained and unit-tested
(`internal/controller/kafka_source.go`) so it is ready for that day.

Instead of adding heavy Knative Eventing Go-module dependencies to the controller binary, the Operator integrates via generic `unstructured.Unstructured` mappings:

1. **Consumer Group**: Automatically generates a localized consumer group (e.g., `myapp-revalidation`) to parallelize work over multiple replicas.
2. **Topic**: Instructs the KafkaSource to consume explicitly from `[app-name]-revalidation`.
3. **Sink Routing**: Routes all consumed events to a `myapp-revalidator` Knative Service.

> **Caveat (#95, #475):** the `myapp-revalidator` sink is **not shipped by knext**, and the
> bring-your-own alternative is withdrawn rather than merely defaulted off — knext never specified
> what that consumer had to be, so it was a contract in name only. A first-class, knext-built
> revalidator remains design-now/build-later (ADR-0003 Option A), revisited after Tier-A
> correctness; shipping it is what makes the flag live again.

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
| Consumer | `{app}-revalidator` — **not built; deferred (#95)** | You deploy producers + consumers |
| Provisioned by knext | **Nothing today** — `provisionKafkaSource` is inert/ignored (#475) | **Nothing** — no broker, no topic, no consumer |
| Delivery guarantee | None promised; ISR is best-effort/idempotent by nature | **Your responsibility** (see idempotency below) |

Routing domain events through `spec.revalidation` hits a dead end: the topic is ISR-scoped, the
consumer is not built by knext (so the opt-in is inert), and the operator provisions only a
`KafkaSource` (never a broker) even when it is live. The fields involved are exactly (from `api/v1alpha1/nextapp_types.go`, `RevalidationSpec`):
`queue`, `kafkaBrokerUrl`, `provisionKafkaSource` — nothing about domain topics or your consumer groups.

### Cross-zone domain events are an application concern

Run your **own** Kafka — a cluster broker (e.g. Strimzi) or a managed Kafka — and your own producers
and consumers inside each zone's service. **knext provisions no broker for this.** Its only role is
to inject the broker **credentials** into your app's environment via `spec.secrets.envMap`.

`spec.secrets.envMap` maps an **environment variable name** to a specific key inside a Kubernetes
Secret. Each entry has exactly two fields — `secretName` and `secretKey` (both required) — and the
operator renders it as a `secretKeyRef` env var on the workload:

```yaml
apiVersion: apps.kn-next.dev/v1alpha1
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
