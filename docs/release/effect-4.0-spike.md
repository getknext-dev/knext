# Effect-TS 4.0 authoring-layer spike — findings (ADR-0053 C3)

Fenced throwaway spike (per ADR-0053) measuring whether Effect 4.0 as the Bun-function authoring layer
costs anything at the module/boot layer — the number ADR-0053 C3 said "bounds or kills the idea."
Effect version: **4.0.0-rc.115** (the current RC; `beta` tag is 4.0.0-beta.107). Local, Apple Silicon;
the on-cluster Knative scale-from-zero leg is cluster-gated and NOT measured here (flagged).

## Setup
- Same proto (`ping.v1.PingService.Echo`) + connect-node as `bun-func-runtime-spike.md`.
- **baseline** = plain connect-node handler. **effect** = handler body authored as an `Effect`, invoked
  via **one `Effect.runPromiseExit` per RPC** (the thin seam ADR-0053 C5 mandates — Effect never owns
  the h2c listener or trailer/status writing).
- Both `bun build --compile`d to single-execs.

## Results
| metric | baseline (connect-node) | Effect 4.0-rc.115 | delta |
|--------|-------------------------|-------------------|-------|
| single-exec bundle | 59.6 MB | 59.7 MB | **+0.1 MB (~0.2%)** |
| boot → listening, median of 5 | ~2.6 ms | ~2.7 ms | **~+0.1 ms (within noise)** |
| h2c gRPC serve (compiled binary) | GRPC_OK | **GRPC_OK** | works |

## Conclusions
- **Effect-the-library is essentially free at import/boot + bundle.** Its tree-shaken closure adds ~0.1 MB
  to the ~60 MB single-exec, and `import 'effect'` + `runPromiseExit` per RPC adds no measurable process
  boot cost. The C3 concern — "Effect runtime-init on every scale-from-zero" — does **not** manifest for a
  handler that only uses `Effect.succeed`/`runPromiseExit`. The static case clears.
- **The thin seam works end-to-end:** an Effect-authored handler serves native h2c gRPC through the
  compiled single-exec (`GRPC_OK pong:hi`), confirming ADR-0053 C5's `runPromiseExit`-per-RPC design.

## What this spike deliberately does NOT clear (the load-bearing risks stay)
- **Eager resource-acquiring Layers (ADR-0053 C3 adversarial hole).** This handler acquires no external
  resources. The real cold-start risk is an Effect `Layer` that connects PG/Redis **eagerly at Runtime
  construction**, pulling the fresh-pod connect tail (7–20 s, `cold-start-ledger.md`) back into the cold
  path. The measurement here says *Effect used minimally is cheap*; it does **not** license eager Layers.
  ADR-0053's "resource-acquiring Layers must be lazy" constraint is the load-bearing one and is untested.
- **On-cluster Knative scale-from-zero** — the process-start→first-RPC number here is bare-process boot,
  not the ~1.4–1.5 s platform floor (`eks-bunexec-bench.md`). Needs kind or a funded cluster.
- **The C2 build-gate blocker (retry × cold-start double-mutation)** — the fault-injection exactly-once
  arm is unbuilt (needs a mutating handler + datastore + idempotency key). Remains the hard build blocker.

## Upstream (adopt→find→PR flywheel)
No Effect 4.0-rc.115 API mismatch or bug surfaced in this minimal transport-authoring spike — `Effect` +
`Exit` + `runPromiseExit` behaved as documented, compiled clean under `bun build --compile`. (A richer
spike exercising Layers/Schedule/interruption under `bun --compile` is where 4.0-rc mismatches are more
likely to appear — that is the next contribution surface.)

## Verdict for the ADR-0053 build phase
The static cost gate (C3 bundle + boot) is **GREEN** for minimal Effect use. Proceed to the build only
behind the two unresolved gates: the **lazy-Layer** discipline (or the cold-start tail returns) and the
**C2 idempotency/retry build-gate blocker**. Effect-the-library is cheap; Effect-used-wrong is not.

> Scratch: session scratchpad `effect-spike/` (proto, connect-es gen, baseline/effect servers, client,
> both compiled binaries). Throwaway per ADR-0053 — not committed.
