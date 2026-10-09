# ADR-0003: Transport & tooling — Connect + buf

Status: Proposed · Date: 2026-06 · Depends on: ADR-0002 · Amended 2026-10-09 (see the amendment at the end)

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

> **Promoted to [ADR-0016](0016-async-isr-revalidation.md).** This addendum is retained for history;
> the async-ISR-revalidation decision (the `provisionKafkaSource` opt-in + `RevalidationDeferred`
> condition) now lives in its own ADR — edit ADR-0016 going forward.

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

## Amendment (2026-10-09) — Rust first wave, connect-go v2, read/write/stream split

**Status of this amendment: Accepted.** It encodes founder decisions of 2026-10-09 (v2 plan Q10,
Q13, Q15, Q16, Q17; jev scores in the plan) that the architect and system-designer gates signed off
as part of the plan. The base ADR's own status line is left as written. Trigger-class (ADR, CRD,
security, core-vs-app boundary); per the 2026-09-22 workflow amendment it is reviewed at sprint
close, not as a merge gate. **The build it unlocks does not start until the founder's `CLAUDE.md`
sections 4, 5 and 6 edits are merged** — that is the exit criterion of the task that carries this
amendment.

### Context

The Decision named `connect-go` for backends and `connect-es` for the gateway client. Zone
functions (ADR-0002 amendment) add Rust to the first wave beside Go, and the glue has to say what a
read, a write and a stream become in a Next.js zone, which this ADR left open.

### Decision

1. **Rust is first-wave beside Go.** Rust functions use **connect-rust, pinned to the 0.9.x line**
   with its protobuf runtime (buffa) via the `buf.build/connectrpc/rust` plugins. The library is
   pre-1.0, so the pin is part of the decision, and **the Connect conformance suite runs in CI for
   the Rust template** as a gate. If conformance cannot be held, the fallback is `tonic` (gRPC over
   h2c), which ADR-0052 D10 already supports. connect-rust 1.0 is not required.
2. **Go uses `connect-go` v2** (the new major), not v1.
3. **Proto-only contracts.** One `.proto` produces every language's stubs; no OpenAPI import.
4. **A read, a write and a stream are different generated shapes:**

   | RPC | Generated as |
   |---|---|
   | Unary with `idempotency_level = NO_SIDE_EFFECTS` | a **server-only query function** using `'use cache'` with tags (cached server function) |
   | Any other unary | a **`'use server'` action**, followed by `updateTag` for the affected tags |
   | Server-streaming | an **RSC or route handler only** — never an action |

   The generator **refuses** to emit an action for a streaming RPC, and refuses an RPC with no auth
   option (ADR-0004). **A cached read keys on the verified user identity** (`sub`, produced by the
   user's `authorize()` hook), never on the token; the token is minted *inside* the cached function
   so two users never share a cache entry. This closes the cross-user cache leak that a wrong key
   would open.
5. **Generated client policy:** an explicit Connect deadline shorter than the gateway timeout;
   **retry only `NO_SIDE_EFFECTS` methods**; mutating methods carry an idempotency key
   (ADR-0052 D6). A missing `grpc-status` trailer is fail-closed and non-retryable (ADR-0052 D15).
6. **Transport default is switchable and the cold-start spike decides it** (h2c against HTTP/1.1
   with `connect-node`; Q11: switchable 0.70). The `createGrpcTransport` path stays available for
   gRPC-only backends (ADR-0052 D10).

### Consequences

- The Rust template carries a pre-1.0 dependency risk, contained by the pin, the conformance gate
  and the `tonic` fallback.
- `buf breaking` runs against the **deployed baseline** (the proto version recorded in the live
  `BackendService` status), not only the source (ADR-0052 D7).
- The JSON-over-HTTP facade described above stays off by default; enabling it is an explicit opt-in
  with the same auth requirement as an action (ADR-0052 D5).

### Action items

- [ ] `buf.gen.yaml` gains `connect-go` v2 and the connect-rust plugins; Rust template conformance
      job in CI.
- [ ] Generator: query function, action and streaming-handler shapes, and the refusal cases.
- [ ] Two-user cache test: the same RPC read by two users never shares an entry (mutation-proved).
