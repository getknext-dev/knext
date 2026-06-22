# ADR-0003: Transport & tooling — Connect + buf

Status: Proposed · Date: 2026-06 · Depends on: ADR-0002

## Context
The gRPC layer needs one contract to produce: (a) backend service stubs in multiple languages,
(b) a typed client the Next.js gateway calls server-side, and (c) a JSON-over-HTTP facade for
browsers/third parties. We must pick a transport + codegen toolchain.

## Decision
Use **Connect (connectrpc.com) + buf**:
- **buf** for proto management: `buf.yaml` (lint), `buf.gen.yaml` (codegen), `buf breaking`
  (back-compat in CI), optional BSR for sharing.
- **Connect** for transport: `connect-go` (backend services) and `connect-es` (TS client used by
  the Next.js gateway). The Connect protocol speaks **gRPC, gRPC-Web, and its own
  HTTP/1.1+JSON** from a single handler — so the "generated API routes / JSON facade" need **no
  separate transcoding gateway**.

## Options considered
| Option | One proto → gRPC + gRPC-Web + JSON | TS DX | Go DX | Extra infra | Browser-callable |
|---|---|---|---|---|---|
| **Connect + buf (chosen)** | ✅ native (Connect protocol) | ✅ first-class `connect-es` | ✅ `connect-go` | none | ✅ JSON/HTTP directly |
| raw gRPC + grpc-gateway | ⚠️ needs grpc-gateway for HTTP transcoding | ⚠️ `grpc-js`/`ts-proto`, clunkier | ✅ native | grpc-gateway sidecar/process + annotations | via gateway only |
| tRPC | n/a (TS-only) | ✅ | ❌ not polyglot | none | ✅ |

tRPC is rejected (TS-only — fails the polyglot requirement). grpc-gateway is Go-centric, needs
HTTP-annotation plumbing and a transcoding layer, and has weaker TS ergonomics.

## Why it fits the gateway model
- The gateway's **server-only client** = a `connect-es` client over HTTP/2 (h2c) to the
  cluster-local backend. Marked `import 'server-only'` so it never enters the browser bundle.
- The **JSON-over-HTTP facade** = mount a Connect router in a single Next.js catch-all route
  handler (`app/api/[service]/[...connect]/route.ts`) — one generated handler, not N hand-rolled
  routes. Browsers/third parties get JSON automatically via the Connect protocol.
- **Server Actions** = thin generated `'use server'` wrappers calling the same client, adding
  `revalidateTag(...)` per the existing `actions.ts` pattern.

## Consequences
- Add buf + connect plugins to `buf.gen.yaml`; outputs to `packages/lib/src/generated/`.
- End-to-end types: proto → `connect-es` messages → consumed by gateway/actions/routes.
- CI gains `buf lint` + `buf breaking` (proto versioning enforced).

## Action items
- [ ] `buf.gen.yaml` with `connect-go`, `connect-es`, `es` (message types).
- [ ] Catch-all Connect route-handler generator for the JSON facade.
- [ ] server-only client-wrapper + Server-Action generators.

## Revalidation status (ISR-over-Kafka routing — DEFERRED, #95)

The Kafka→revalidator routing this ADR's family describes (a domain event lands on Kafka →
a `{app}-revalidator` service consumes it → it calls `revalidateTag()` to invalidate every pod's
Redis-backed cache) is **deferred / build-later**. The `{app}-revalidator` consumer service has
**no tracked implementation** in source, and the ADR-0003 routing PR (**#27**) was **closed
without merging**.

Decision (issue #95, Option B): the operator **no longer provisions the KafkaSource by default**.
Provisioning a source whose sink (`{app}-revalidator`) is never deployed would deliver
revalidation events nowhere — a dangling control-plane→data-plane integration. Provisioning is now
**gated behind explicit opt-in**: `spec.revalidation.provisionKafkaSource: true` (default nil/false
⇒ no source). Setting kafka without opting in surfaces a non-fatal `RevalidationDeferred` status
condition (reason `ConsumerNotProvisioned`); `Ready` stays `True`.

Re-evaluate (build the consumer, Option A) once Tier-A correctness lands; until then this routing
is design-now/build-later.
