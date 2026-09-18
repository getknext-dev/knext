# ADR-0052: Knative Functions as a build-only primitive; proto stays the typed-client source of truth

Status: Accepted (design only) · Date: 2026-09 · Depends on: ADR-0001, ADR-0002, ADR-0003, ADR-0004, ADR-0035, ADR-0048 · Amends: ADR-0004

> **Founder direction refined (2026-09):** support **all languages Knative Functions supports** (full
> polyglot — this decisively confirms proto-first over signature-first), and add **Bun as a
> first-class JS/TS function runtime** (single-exec, per ADR-0048). Decisions 10–15 capture this.
> Both design gates reviewed the delta: architect **SIGN-OFF** (one wording fix, folded into
> Decision 10); system-designer **BLOCK pending constraints**, all folded in as Decisions 13–15 +
> revised Decisions 6/8/11/12 + Action items.

## Context
Founder direction (2026-09): *integrate Knative Functions so the CLI generates typed TypeScript
client functions for a Next.js app* — a tRPC-class DX where the app imports a generated typed client
and calls a scale-to-zero backend like a local function — and support the full Knative-Functions
language set plus a Bun runtime for JS/TS.

Most of this is **already specified**: ADR-0002 (polyglot backends, Next.js stays the HTTP gateway,
**`.proto` = single source of truth**, design-now/build-after-maturity), ADR-0003 (transport =
Connect + buf; **tRPC explicitly rejected as TS-only/non-polyglot**), ADR-0004 (`BackendService` CRD,
cluster-local h2c, operator injects `<NAME>_SERVICE_URL`, and CLI glue = server-only `connect-es`
wrappers + `'use server'` Server Actions + a JSON-over-HTTP facade). So "generate a typed TS client"
is largely ADR-0004.

Two genuinely new questions: **(i)** the type source of truth — proto vs a TS/Go function signature;
**(ii)** whether Knative `func` (buildpacks, CloudEvents, `func deploy`) is a *deploy* primitive or
only a *build* tool.

## Decision
1. **Proto stays the single source of truth** (ADR-0002/0003 unchanged). The DX goal is met by an
   ergonomic `connect-es` client, **not** by inferring types from a function signature. Signature-first
   is the tRPC model ADR-0003 already rejected on the record; adopting it would be a *new superseding
   ADR*, not this one.
2. **`func` is an optional build/package tool only** — it produces the OCI image a `BackendService` CR
   references (ADR-0004 `image`). Its buildpacks are acceptable **iff** the built image serves a
   **Connect or gRPC handler on the `h2c` port** (ADR-0004); `func`'s native CloudEvents entrypoint is
   not used for gateway calls (untyped — defeats the goal).
3. **Deployment flows exclusively through the `BackendService` CR the operator reconciles.**
   `func deploy` and any `func`-initiated cluster write are **prohibited** — the ADR-0001 auto-BLOCK
   class (second writer of Knative-Service shape). A guard test must assert the deploy path never
   shells `func deploy` / `kn service`.
4. **Endpoints are runtime, types are build-time.** The generated client reads `<NAME>_SERVICE_URL`
   from operator-injected env *at call time*; baking a cluster URL at codegen time is a skew bug + a
   hardcoded-host violation (scs-zones). Seam: proto → types (build); operator env → endpoint (runtime).
5. **End-user auth — the codegen enforces it, does not merely document it.** The **JSON facade is off
   by default**; Server Actions and the facade are *public POST endpoints* (`'use server'` = "runs on
   the server," not "unreachable"). The generator **must not emit a mutating Server-Action / facade
   wrapper without a fail-closed end-user auth check in its body**, enforced at the gateway before the
   backend call. This is the *end-user* plane — distinct from the gateway→backend token (Decision 13);
   neither may be conflated with or relaxed by the other.
6. **Cold-start & idempotency.** A server-only call pays backend scale-from-zero *on top of* any
   gateway cold start (stacked on first hit). Current measured Knative scale-from-zero is **~1.4–1.5s
   on a healthy cluster** (`docs/release/eks-bunexec-bench.md`; ~2–2.1s on burstable nodes); ADR-0048
   Amendment 5 measured ~3.4s on a *saturated* cluster. Either way **the platform path dominates**
   (see Decision 12) — the fast process boot buys no cold-start win. Therefore: (a) an explicit Connect
   deadline shorter than the gateway request timeout; (b) latency-critical backends may opt out of
   scale-to-zero (`min-scale: 1`); (c) **no automatic retry on non-idempotent methods** — a retry
   across a cold-start timeout double-applies a mutation; mutating methods require idempotency keys, and
   Server-Action-retry × Connect-retry stacking is addressed, not left implicit.
7. **Runtime proto skew fails closed.** `buf breaking` gates the *source*, not the *deployed pair*
   (a v2 client calling a v1 backend). Backend and client pin the same proto module version; discovery
   exposes the served version so the gateway rejects an unknown method rather than 500-ing mid-mutation.
8. **Boundaries.** Codegen orchestration stays in the opt-in `@getknext/grpc` module; generated glue
   lands in `packages/lib/src/generated/` (gitignored) or the app template — **never** in
   `packages/kn-next` core or the operator's required path. The bun-compile primitive
   (`buildVinextExecutable`, `packages/kn-next/src/cli/vinext-build.ts`) **is** core and may be reused
   by the Bun func builder, but the **per-language template matrix, Connect/gRPC scaffolding, and any
   `func`/buildpack orchestration must not follow it into core** — they stay in `@getknext/grpc`. A
   **data-holding shared backend is itself a zone/SCS boundary**: no shared-database backdoor between
   zones; cross-zone data flows only via async events or the browser; the backend reaches its own store
   via Secret-injected env.
9. **Sequencing (ADR-0002).** This is **design + ADR only**; the typed-client/backend layer build is
   deferred until after Tier-A. Exception flagged (not assumed): the **Bun func runtime (Decision 12)**
   overlaps the already-active Bun/single-exec track (ADR-0048), so it *could* be prototyped there —
   a deliberate re-sequencing call for the founder.
10. **Full polyglot — all languages Knative Functions supports** (founder-directed). The decisive
    reason for proto-first: signature-first is TS-only. A backend exposes **Connect *or* gRPC over
    h2c, both from the same `.proto`** — gRPC's broad language coverage handles languages lacking a
    first-party Connect lib (Python/Rust/Java/Quarkus are gRPC or partial-Connect today); Connect where
    one exists (Go, TS/JS). The generated **typed TS client is always `connect-es`**: the **server-only**
    gateway client (ADR-0004) is a `@connectrpc/connect-node` client, configured with the **gRPC
    transport (`createGrpcTransport`)** to speak native gRPC over h2c against a gRPC-only backend, or
    the **Connect transport** against a Connect backend — one client library, transport selected per
    backend flavour. This works because the gateway→backend client is **server-side**
    (`createGrpcTransport` exists only in `connect-node`, not `connect-web`) and browsers reach
    backends only via the gateway's Connect/JSON facade, never gRPC directly. **The JSON facade stays
    at the gateway regardless of backend flavour — no grpc-gateway transcoding sidecar** (so ADR-0003's
    reason for rejecting raw gRPC does not apply here).
11. **knext ships Connect/gRPC-enabled function templates per language.** kn func's stock templates
    speak HTTP/CloudEvents — untyped, not the gateway contract. The typed contract is the function's
    `.proto`; knext owns a template matrix that scaffolds a Connect (or gRPC) handler on the `h2c` port
    per language. **A language enters the matrix only when it has (a) a maintained Connect/gRPC h2c
    server lib *and* (b) a supply-chain scan for that ecosystem (Decision 14).** "All languages" is
    bounded by both — state it honestly.
12. **Bun is a first-class JS/TS function runtime.** A knext func template builds/runs JS/TS on **Bun**
    and **compiles to a Bun single-exec** (ADR-0048, reusing `buildVinextExecutable`), serving
    `connect-es` over h2c. Its real edges are **smaller image, warm latency/throughput, and
    single-artifact ops — NOT a Knative cold-start win**: ADR-0048 Amendment 5 established the
    single-exec's fast process boot (61 ms, 14.5×) is swamped by the Knative scale-from-zero platform
    path (single-exec statistically tied with node), and the cross-cloud bench confirms cold start is
    **platform-bound**. **Reproducibility:** `bun build --compile --bytecode` embeds bytecode like the
    ADR-0035 V8 compile-cache layer — treat func images as **not bit-reproducible** (exclude/normalise
    from any reproducible-build assertion) until Bun bytecode determinism is measured.
13. **Backend-plane auth is per-language and fail-closed (security invariant).** ADR-0004's
    gateway→backend shared token is checked by a Connect interceptor on Connect backends; a **pure-gRPC
    backend has no Connect interceptor**, so **every language template MUST ship the token-verifying
    server interceptor** in that language's gRPC/Connect chain, **fail-closed, mutation-proved per
    template** (delete the check → the template's test goes red). `security.md` records NetworkPolicy as
    **CNI-conditional** (flannel — OKE GA, OrbStack — ships no NetworkPolicy controller), so a gRPC
    backend without a server-side token check is an **unauthenticated in-cluster mutating endpoint**.
    cluster-local NetworkPolicy is defense-in-depth, never the sole control.
14. **Supply-chain gate per language.** `security.md`'s gate scans images (Trivy) + npm today; each
    language template adds an ecosystem advisory surface (pip/cargo/go-mod/maven). A language enters the
    matrix only when its server image is **Trivy-scanned + SBOM'd + cosign-signed** like app images
    **and** an ecosystem advisory scan exists for its pinned Connect/gRPC + h2c server deps. State
    **where** the scan runs (knext CI scans the template; the user's scaffolded image is scanned only if
    `kn-next build` runs Trivy on it).
15. **gRPC status rides HTTP/2 trailers — the cold path must preserve them.** A `connect-es` gRPC
    client reads `grpc-status` from a trailer; if the cold h2c path (**activator buffer → queue-proxy**)
    strips it, a mutation that *succeeded* returns as missing-status → client retries → **double-apply**,
    defeating Decision 6c. Required: (a) verify `grpc-status` trailers survive the **through-activator
    cold path** (not just a warm direct dial — ADR-0004's generic "h2c verified" is insufficient);
    (b) the `connect-es` gRPC client treats a **missing status trailer as fail-closed and
    non-retryable**; (c) Connect's in-band status is more proxy-robust than gRPC trailers — a design
    reason to **prefer Connect where a first-party lib exists**, reinforcing Decision 10.

## Options considered
| Option | Type source | Polyglot | ADR-0001 safe | ADR change | DX |
|---|---|---|---|---|---|
| **A. Proto-first; `func` = build-only (chosen)** | `.proto` | yes (Connect *or* gRPC/h2c) | yes (operator deploys the CR) | ADR-0004 amend (this ADR) | tRPC-class via `connect-es` |
| B. Signature-first (`func` signature → client) | TS/Go signature | no (TS-only = ADR-0003's rejected tRPC) | yes | **new ADR superseding 0002+0003** | best single-language |
| C. `func`-native deploy (`func deploy`) | either | — | **NO — second cluster writer (ADR-0001 BLOCK)** | — | — |

## Consequences
- Keeps ADR-0002's polyglot/contract-first value and `buf breaking` versioning across all languages;
  delivers the DX without TS-only lock-in.
- **`func`'s value is its polyglot template breadth** (explicitly wanted), not just packaging. Cost:
  knext owns a **per-language Connect/gRPC template matrix + Bun builder + a per-language token
  interceptor + a per-ecosystem supply-chain scan**. This is the direction most tempted toward
  scope-drift (narrow adapter → general polyglot platform, CLAUDE.md §1) — held only by staying in
  `@getknext/grpc`, deferred, and opt-in. Leaking template/builder machinery into core is a BLOCK.
- **Bun runtime** ties the func layer to ADR-0048's single-exec toolchain — *one* runtime toolchain
  (satisfies "don't rewrite the runtime twice"), but a maintenance coupling and a Bun-on-PATH build
  dependency. Its edges are image/warm-latency/ops, **not** Knative cold start; func images are not
  bit-reproducible until Bun bytecode determinism is measured.
- Option C is barred by construction. Option B, if ever chosen, is a separate superseding ADR.

## Action items (typed-client/backend layer post-Tier-A; Bun runtime may ride the ADR-0048 track if re-sequenced)
- [x] **Bun `node:http2` gRPC spike (load-bearing) — PASS (2026-09;** `docs/release/bun-func-runtime-spike.md`**).**
      A `bun build --compile` single-exec called an h2c gRPC server via connect-node
      `createGrpcTransport` and read the gRPC status trailer correctly — **including against a pure
      grpc-go v1.83 backend** (22 ms), and against a connect-node server (14 ms), matching Node.
      Confirms Decision 10: the Bun gateway needs no Connect shim to reach gRPC-only, any-language
      backends. **Still open:** trailer survival through the **Knative activator cold path** (a proxy
      property, not a Bun one — needs a live/kind cluster).
- [ ] **Trailer survival:** verify `grpc-status` HTTP/2 trailers survive the **through-activator cold
      path**; the client treats a missing trailer as fail-closed non-retryable.
- [ ] **Per-language token interceptor:** each template ships the fail-closed token-verifying server
      interceptor; a **mutation-proof test** (delete the check → red), including a **flannel/no-
      NetworkPolicy** case proving the interceptor — not the CNI — is the control.
- [ ] **Per-language supply-chain:** a language enters the matrix only with Trivy + SBOM + cosign on
      its image *and* an ecosystem advisory scan on its pinned server deps.
- [~] **Bun func template — runtime mechanism proven locally (2026-09;** `docs/release/bun-func-runtime-spike.md`**).**
      A `bun build --compile` single-exec **serves** `connect-es`/gRPC over h2c (writes status
      trailers), ~60 MB. **Still to build:** the generator (proto + handler → `main` + `buf generate`
      + compile), the per-language/Bun token interceptor (D13); **still to measure:** Knative
      scale-from-zero cold start on-cluster (not process boot); exclude/normalise the `--bytecode`
      layer from reproducible-build assertions.
- [ ] Per-language template matrix: pin the Connect **or** gRPC h2c server lib per language; drop
      languages with neither.
- [ ] `func` emits image only; CLI renders/applies the `BackendService` CR (guard test: deploy path
      never shells `func deploy` / `kn service`). Fold codegen into `kn-next generate`, not a new path.
