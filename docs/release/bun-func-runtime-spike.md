# Bun func runtime — prototype spike (ADR-0052 Decisions 10 & 12)

Re-sequenced prototype (founder-directed) to de-risk the ADR-0052 Bun function runtime **before** the
post-Tier-A build. Proves the mechanism end-to-end; not productionised (that stays in `@getknext/grpc`
per ADR-0052 Decision 8).

## What was proven (all local, direct-dial h2c)
Toolchain: Bun 1.4.2, connect-es v2 (`@connectrpc/connect` + `@connectrpc/connect-node`), buf 1.55,
Go 1.26 / grpc-go v1.83.

| # | test | result |
|---|------|--------|
| Client, interpreted | Bun `createGrpcTransport` → connect-node gRPC server, h2c | GRPC_OK 33 ms |
| **Client, `bun --compile` single-exec** | → connect-node gRPC server, h2c | **GRPC_OK 14 ms** |
| **Client, `bun --compile` single-exec** | → **pure grpc-go** server, h2c | **GRPC_OK 22 ms** |
| Server, interpreted | Bun connect-node h2c server ← compiled Bun client | GRPC_OK 17 ms |
| **Server, `bun --compile` single-exec** | Bun h2c gRPC server ← compiled Bun client | **GRPC_OK 16 ms** |

**Conclusions:**
- A Bun single-exec **calls** native h2c gRPC via connect-node's `createGrpcTransport` (rides
  `node:http2`) and reads the `grpc-status` **trailer** correctly — including against a **pure
  grpc-go** backend. This closes ADR-0052's load-bearing question: the Bun gateway needs **no Connect
  shim** to reach gRPC-only, any-language backends (Decision 10).
- A Bun single-exec **serves** h2c gRPC (writes status trailers) — a compiled Bun binary is a valid
  `BackendService` image (Decision 12: the Bun func runtime).
- Single-exec size ≈ 60 MB (Bun runtime embedded) — one artifact; goes in a distroless/alpine base.

## Author-facing template shape (the "Bun func")
A user authors two files; knext generates the rest and compiles a single-exec:
```
myfunc/
  service.proto        # the contract — SOURCE OF TRUTH (ADR-0052 D1: proto-first)
  handler.ts           # 'use'-free business logic implementing the service methods
  # --- knext-generated / boilerplate ---
  gen/service_pb.ts    # buf generate (protoc-gen-es v2)
  main.ts              # connectNodeAdapter({routes}) on http2 h2c server + token interceptor
```
Build (what `kn-next` would run): `buf generate` → `bun build --compile main.ts --outfile server` →
that binary is the `BackendService` image entrypoint. Deployment is still the operator via the
`BackendService` CR — **never `func deploy`** (ADR-0052 D3).

## Still open (not provable without a cluster / more code)
- **Activator cold-path trailer survival** (ADR-0052 D15): all tests here were direct-dial. Whether
  `grpc-status` trailers survive Knative's `activator → queue-proxy` cold path is a *proxy* property,
  not a Bun one — needs a live Knative cluster (a local **kind** cluster avoids cloud cost).
- **Per-language token interceptor** (D13), **supply-chain scan** (D14), and the generator emitting the
  fail-closed auth wrapper (D5) — all unbuilt; this spike only exercised the transport/runtime.
- **Bun func Knative cold start** — measure on-cluster; process-boot speed does **not** buy a
  scale-from-zero win (the cross-cloud bench showed cold start is platform-bound).

Working code: session scratchpad `bun-grpc-spike/` (proto, connect-es + go stubs, client/server, both
compiled). Not committed — prototype only.
