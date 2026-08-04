# ADR-0016: Asynchronous ISR revalidation & the Kafka queue (deferred consumer)

- Status: Accepted
- Date: 2026-06-23
- Deciders: knext architect
- Related: ADR-0001 (operator = single source of truth), ADR-0003 (Connect + buf transport),
  ADR-0004 (BackendService CRD), issue #95 (dangling Kafka revalidator sink), closed PR #27

## Context

This decision previously lived as a "Revalidation status (DEFERRED, #95)" addendum bolted onto
ADR-0003 (a *transport* ADR). It is a distinct, user-facing decision — `spec.revalidation` is now a
CRD surface and the docs reference it — so it is promoted to its own ADR.

knext's ISR / data cache is **Redis** (`cache.provider: redis`, the `cache-handler.js`):
`revalidateTag` / `revalidatePath` delete shared Redis keys, so invalidation is **fleet-wide**
across all pods/zones already — no cross-pod fan-out is needed for correctness within an app. The
open question is cross-**zone** / event-driven revalidation: the operator could provision a Knative
`KafkaSource` whose sink delivers domain events to an `{app}-revalidator` consumer. That consumer
was never built — provisioning the KafkaSource produced a **dangling sink** pointing at a service
that does not exist (#95).

## Decision

**Gate the KafkaSource behind an explicit opt-in; default it OFF; keep the `{app}-revalidator`
consumer design-now / build-later.**

- `spec.revalidation.provisionKafkaSource` (`*bool`, default nil/false) — only when `true` does the
  operator provision the `KafkaSource`. The default reconcile creates **no** dangling infra.
- When `revalidation.queue == "kafka"` but the opt-in is unset, the operator surfaces a non-fatal
  `RevalidationDeferred` status condition (reason `ConsumerNotProvisioned`) and keeps `Ready=True` —
  the deferral is observable, not silent.
- Enabling the opt-in asserts the operator **deploys its own** `{app}-revalidator` consumer; that
  consumer, when built, will be a cluster-local Knative service (ADR-0004 posture) with an
  authenticated CloudEvent → `revalidateTag()` ingress (it is a mutating surface — ADR-0015 / the
  no-unauthenticated-mutating-endpoint rule applies).

## Options considered

| Option | Verdict | Why |
|---|---|---|
| Build the `{app}-revalidator` consumer now | Rejected | Large new authenticated CloudEvent ingress + service, depends on the shelved routing layer (PR #27); premature before Tier-A correctness |
| **Gate provisioning behind an opt-in; defer the consumer (chosen)** | Accepted | Removes the dangling sink now with a small, fully-tested change; the consumer is a clean opt-in follow-up; deferral is observable |
| Drop the Kafka path entirely | Rejected | Loses the cross-zone event mechanism the SCS model needs long-term |

## Consequences

- Default deploys no longer create a `KafkaSource` with a sink pointing nowhere.
- **Backward-compat (intentional):** an existing CR with `revalidation.queue: kafka` and no opt-in
  stops getting a (dangling) KafkaSource and instead surfaces `RevalidationDeferred`. Re-enable with
  one field once a consumer is deployed.
- The cross-zone async revalidation story (SCS domain events) remains designed-but-unbuilt; this ADR
  is the record of where that line sits.

## Action items

- [x] `provisionKafkaSource` opt-in + `RevalidationDeferred` condition in the reconciler (#95/#99).
- [x] Docs (`docs/operator/kafka-eventing.md`, the docs-site operator page) state the consumer is
  build-later.
- [x] **Amended by #475:** the opt-in is now **rejected at admission** as `not implemented`, not
  merely defaulted off. Defaulting off left an accepted flag for an unbuilt consumer — a user could
  set `provisionKafkaSource: true` and get a KafkaSource sinking into a Service that never comes up.
  The gate lives in `validation.ValidateNextAppSpec` (shared by the webhook and the fail-closed
  reconciler), so "no dangling source" is a property of the operator, not of the webhook being
  reachable. The FIELD is retained so the item below stays non-breaking.
- [ ] Build the cluster-local, authenticated `{app}-revalidator` consumer (after Tier-A correctness;
  re-evaluate whether closed PR #27 is salvageable first). **Shipping it is what removes the #475
  gate** — delete `validateProvisionKafkaSource` and the reconciler's KafkaSource block goes live
  again.
