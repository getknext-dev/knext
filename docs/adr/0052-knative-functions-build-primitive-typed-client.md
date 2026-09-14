# ADR-0052: Knative Functions as a build-only primitive; proto stays the typed-client source of truth

Status: Proposed (design only) · Date: 2026-09 · Depends on: ADR-0001, ADR-0002, ADR-0003, ADR-0004 · Amends: ADR-0004

## Context
Founder direction (2026-09): *integrate Knative Functions so the CLI generates typed TypeScript
client functions for a Next.js app* — a tRPC-class DX where the app imports a generated typed client
and calls a scale-to-zero backend like a local function.

Most of this is **already specified**: ADR-0002 (polyglot backends, Next.js stays the HTTP gateway,
**`.proto` = single source of truth**, design-now/build-after-maturity), ADR-0003 (transport =
Connect + buf; **tRPC explicitly rejected as TS-only/non-polyglot**), ADR-0004 (`BackendService` CRD,
cluster-local h2c, operator injects `<NAME>_SERVICE_URL`, and CLI glue = server-only `connect-es`
wrappers + `'use server'` Server Actions + a JSON-over-HTTP facade). So "generate a typed TS client"
is largely ADR-0004.

Two genuinely new questions: **(i)** the type source of truth — proto vs a TS/Go function signature;
**(ii)** whether Knative `func` (buildpacks, CloudEvents, `func deploy`) is a *deploy* primitive or
only a *build* tool.

Reviewed by the architect and system-designer gates (both SIGN-OFF on the decision below; the design
brief's "no ADR change" claim was wrong — this amendment is required).

## Decision
1. **Proto stays the single source of truth** (ADR-0002/0003 unchanged). The DX goal is met by an
   ergonomic `connect-es` client, **not** by inferring types from a function signature. Signature-first
   is the tRPC model ADR-0003 already rejected on the record; adopting it would be a *new superseding
   ADR*, not this one.
2. **`func` is adopted as an optional build/package tool only** — it produces the OCI image a
   `BackendService` CR references (ADR-0004 `image`). Its buildpacks are acceptable **iff** the built
   image serves a **Connect handler on the `h2c` port** (ADR-0004); `func`'s native CloudEvents
   entrypoint is not used for gateway calls (untyped — defeats the goal).
3. **Deployment flows exclusively through the `BackendService` CR the operator reconciles.**
   `func deploy` and any `func`-initiated cluster write are **prohibited** — they are a second writer
   of Knative Service shape, the ADR-0001 auto-BLOCK class. A guard test must assert the deploy path
   never shells `func deploy` / `kn service`.
4. **Endpoints are runtime, types are build-time.** The generated client reads `<NAME>_SERVICE_URL`
   from operator-injected env *at call time*; baking a cluster URL at codegen time is both a skew bug
   and a hardcoded-host violation (scs-zones). Clean seam: proto → types (build); operator env →
   endpoint (runtime).
5. **Security — the codegen enforces auth, it does not merely document it.** Two distinct planes:
   the gateway→backend shared token (ADR-0004) authenticates *the gateway to the backend*, and is
   **not** end-user auth. The **JSON facade is off by default**; Server Actions and the facade are
   *public POST endpoints* (`'use server'` = "runs on the server," not "unreachable"). The generator
   **must not emit a mutating Server-Action / facade wrapper without a fail-closed end-user auth check
   in its body**, enforced at the gateway before the backend call. Backends stay `cluster-local` (no
   public ingress).
6. **Cold-start & idempotency.** A server-only call now pays backend scale-from-zero (~1.4s measured,
   see `docs/release/eks-bunexec-bench.md`) on top of any gateway cold start (~2.8s worst-case first
   hit). Therefore: (a) an explicit Connect deadline shorter than the gateway request timeout;
   (b) latency-critical backends may opt out of scale-to-zero (`min-scale: 1`); (c) **no automatic
   retry on non-idempotent methods** — a retry across a cold-start timeout double-applies a mutation;
   mutating methods require idempotency keys, and Server-Action-retry × Connect-retry stacking is
   addressed, not left implicit.
7. **Runtime proto skew fails closed.** `buf breaking` gates the *source*, not the *deployed pair*
   (a v2 client calling a v1 backend). Backend and client pin the same proto module version;
   discovery exposes the served version so the gateway rejects an unknown method rather than 500-ing
   mid-mutation.
8. **Boundaries.** Codegen orchestration stays in the opt-in `@getknext/grpc` module; generated glue
   lands in `packages/lib/src/generated/` (gitignored) or the app template — **never** in
   `packages/kn-next` core or the operator's required path, and `func`/buildpack machinery must not
   leak into core (scs-zones core-vs-app). A **data-holding shared backend is itself a zone/SCS
   boundary**: it must not become a shared-database backdoor between zones; cross-zone data still flows
   only via async events or the browser, and the backend reaches its own store via Secret-injected env.
9. **Sequencing unchanged (ADR-0002).** This is **design + ADR only**; build is deferred until after
   Tier-A correctness. The founder's "go ahead" authorizes the design gate + this ADR, **not** a
   re-sequenced build.

## Options considered
| Option | Type source | Polyglot | ADR-0001 safe | ADR change | DX |
|---|---|---|---|---|---|
| **A. Proto-first; `func` = build-only (chosen)** | `.proto` | yes | yes (operator deploys the CR) | ADR-0004 amend (this ADR) | tRPC-class via `connect-es` |
| B. Signature-first (`func` signature → client) | TS/Go signature | no (TS-only = ADR-0003's rejected tRPC) | yes | **new ADR superseding 0002+0003** | best single-language |
| C. `func`-native deploy (`func deploy`) | either | — | **NO — second cluster writer (ADR-0001 BLOCK)** | — | — |

## Consequences
- Keeps ADR-0002's polyglot/contract-first value and `buf breaking` proto-versioning; delivers the
  founder's DX without TS-only lock-in.
- **Risk (recorded):** once `func` is forced to serve Connect over h2c, it may buy little over
  ADR-0004's existing container template — a plain `BackendService` container template may remain
  simpler. The build-time spike (action item) decides whether `func` earns its place at all.
- Option C is barred by construction. Option B, if ever chosen, is a separate superseding ADR.

## Action items (when scheduled, post-Tier-A)
- [ ] Build-time spike: confirm a `func`-built container serves Connect over h2c and scales to zero on
      the target networking layer — else drop `func` in favour of the ADR-0004 container template.
- [ ] `func` emits image only; the CLI renders/applies the `BackendService` CR (no `func deploy`).
      Add a guard test that the deploy path never shells `func deploy` / `kn service`.
- [ ] Fold codegen into the existing `kn-next generate` (ADR-0002 action item), not a new deploy path.
- [ ] Generator emits a fail-closed end-user auth check in every mutating Server-Action/facade wrapper;
      facade off by default; gateway→backend token-auth + cluster-local NetworkPolicy per ADR-0004.
- [ ] Idempotency-key contract for mutating methods; explicit Connect deadlines; discovery exposes the
      served proto version for fail-closed skew handling.
