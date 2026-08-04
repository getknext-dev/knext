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
- [x] **Amended by #475 — the BYO opt-in is WITHDRAWN (see the amendment section below).**
- [ ] Build the cluster-local, authenticated `{app}-revalidator` consumer (after Tier-A correctness;
  re-evaluate whether closed PR #27 is salvageable first). **Shipping it is what makes the flag live
  again** — `revalidationDeferred` starts consulting `provisionKafkaSource` and the reconciler's
  retained, unit-tested `buildKafkaSource` call site re-opens.

## Amendment (2026-08, #475): the bring-your-own consumer path is withdrawn

**This is a capability removal, not a defaulting change.** The decision above kept
`provisionKafkaSource` as a real, documented option: setting it asserted that *you* had deployed the
consumer, and the operator would then create the `KafkaSource` for you. The docs stated that contract
plainly ("setting it is an assertion that you have deployed your own external consumer").

That contract was never real. knext never specified what the consumer had to be beyond its **name**
(`{app}-revalidator`) — not the CloudEvent types it receives, not its authentication, not how it is
expected to call `revalidateTag()`, and nothing tested any of it. An option whose only specification
is a Service name cannot be implemented against, so the honest description is that the path is
**withdrawn**, not that it was "gated" or "deferred".

**Instrument: inertness, not rejection.** `revalidationDeferred` now ignores the field entirely, so
no `KafkaSource` is created on any value. The field is still **accepted**:

- Rejecting it would narrow `v1alpha1` **in place**, which ADR-0017 §2.1 reserves for a new API
  version — admission rejection is observably identical to a CEL `self != true` rule, and the CLI
  never emitted this field, so hand-authored and GitOps manifests are the entire affected population.
- The same validator gates the **fail-closed reconciler**, so a rejection would stop a stored CR from
  being reconciled *at all* — no database binding, no ksvc, no NetworkPolicy, no warm-floor — firing
  on operator upgrade with **no user action**. `ValidateNextAppSpecUpdate`'s own doc comment already
  refuses the weaker version of that outcome.
- ADR-0017 explicitly permits the semantic change: a field for a capability that has not shipped may
  become inert, announced in release notes and surfaced as a status condition.

**Observability.** `queue: kafka` keeps the non-fatal `RevalidationDeferred` condition
(`ConsumerNotProvisioned`); setting the withdrawn flag reports reason `ProvisionKafkaSourceInert`
plus a transition-gated Warning event, so an ignored setting is visible in `kubectl describe` rather
than silent. The condition message no longer instructs anyone to set the flag.

**What is not lost.** Cache invalidation was never dependent on this: `revalidateTag()` is fleet-wide
through the shared Redis-backed cache. What is deferred is *asynchronous* revalidation over a queue.
