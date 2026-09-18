# ADR-0053: Effect-TS 4.0 as an opt-in Bun-function authoring layer

Status: Accepted (design only) · Date: 2026-09 · Amends: ADR-0052 (Decisions 8, 11, 12) · Depends on: ADR-0001, ADR-0002, ADR-0048, ADR-0052 · Sequencing: build post-Tier-A; a **throwaway fenced spike** is re-sequenced early (founder-directed, parallel to the bun-func spike)

> Both design gates (architect + system-designer, Opus) **SIGN-OFF conditional** on this ADR encoding
> the constraints below. They independently converged. (Both ran before ADR-0052 landed on `main` and
> flagged the sequencing precondition — now satisfied: ADR-0052 is on `main`, so this amendment is
> anchored in-repo, not in session lore.)

## Context
Founder direction (2026-09): **early-adopt Effect-TS 4.0 (beta)** as a backend-authoring framework and
**contribute fixes upstream** on mismatches — the same adopt→find→PR play running against
cloudflare/vinext (#3204/#3226/#3241; CLAUDE.md §2 verified-adopter north star). ADR-0052 fixed the
backend *contract* (proto → Connect/gRPC over h2c, polyglot). The open question is *how a TS/Bun
function's Connect handler is authored*. Effect offers typed-errors-as-values, structured concurrency
(fibers), dependency injection, and managed interruption that map onto scale-to-zero's
cancellation/failure profile. Effect is **TS-only**, so it can never be the polyglot layer — it is an
implementation detail of one template.

## Decision
Adopt **Effect 4.0 as an opt-in authoring layer for the Bun-function template only**, over ADR-0052's
**unchanged** proto contract. Effect is **implementation, never contract** (proto stays source of
truth, ADR-0052 D1). Hard fence: **zero Effect dependency in `@getknext/core`, the operator, CLI
dispatch, and the node/vinext default runtime** — Effect lives only in `@getknext/grpc` / the generated
Bun-func handler template (ADR-0052 D8 restated for one more piece of authoring machinery). Pin an
**exact beta**; upgrade version-by-version. **Effect must be removable from the shipped template
without touching the proto contract or wire behaviour** — the `connect-es` handler stands on its own
with Effect as a layered convenience. That removability is what makes a beta dependency here safe.

## Options considered
| Option | Contract source | Beta blast radius | Positioning | Verdict |
|---|---|---|---|---|
| **A. Effect 4.0 fenced opt-in authoring layer (chosen)** | proto (unchanged) | bounded to one opt-in template | narrow adapter held by the fence | **chosen** |
| B. Effect on stable 3.x, migrate to 4.0 later | proto | same | same | rejected — defeats the finding-generating purpose; migration cost, no fame upside |
| C. Effect anywhere useful incl. core/CLI | proto | **unbounded — a beta defect bricks the default path** | drifts to general backend platform | rejected — auto-fails the fence |
| D. No Effect; plain `connect-es` handlers | proto | none | narrowest | **the abort/fallback target** of Option A |

## Consequences
- Delivers real Bun-func authoring DX + an **upstream-contribution flywheel** — each landed
  `Effect-TS/effect` PR is a credential (fame-first). A 4.0 breaking change dents only an opt-in
  template a user chose; it can never brick knext or a default-path app.
- **Costs:** a moving-target maintenance tax on the template/generator/guard per beta bump (knext eats
  it, not the user), and a stranded-beta risk mitigated by **Option D removability**.
- **Effect is an authoring convenience, NEVER a marketed knext platform capability.** Positioning drifts
  in the marketing before the code — docs must never headline "knext gives you Effect" (same honesty
  register as ADR-0052's own caveat). The narrow-adapter identity is defined by the **default path**
  (node/vinext Next.js on Knative), from which Effect is *provably* absent by the guard below.

## Constraints the ADR carries (from both gates)

### C1 — Core-fence guard = closure + bundle + dependency-direction (not a grep)
Held to the standard of the Bun-free-CLI guard (`packages/kn-next/src/__tests__/cli-node-runtime.test.ts:167-292`,
which has *two* teeth: a source import-closure walk **and** a shipped-`dist/` bundle scan). A naive
`grep core for 'effect'` is decoration. The guard must close four holes:
1. **Transitive leak via the package graph** — Effect in `@getknext/grpc` is fine *until a core module
   imports from `@getknext/grpc`*. Assert **dependency direction**: `@getknext/core` (+ its dist
   closure) must not depend on `@getknext/grpc` at all, **plus** the closure walk. This is the real fence.
2. **Type-only imports** — `import type { Effect } from 'effect'` erases at runtime but drags Effect's
   conceptual surface into core's public contract. **Forbid Effect type-imports in core** and make the
   guard catch them.
3. **Scan the forbidden artifact, don't allowlist the allowed one** (workflow.md "prefer scanning").
   Assert the core dist bundle + operator are Effect-free; do NOT maintain an allowlist of template dirs.
4. **Drop the vacuous Go-operator clause** — Effect is TS-only; "operator never imports effect" is green
   because its subject can't exist. Decoration by workflow.md's own standard; mark N/A.
Mutation-prove: add `import 'effect'` (and `import type`) to a core module → guard reds. Host in the
existing closure family (`scripts/lib/knext-closure.mjs` / `adapter-import-closure.mjs` / `bun-app-closure.mjs`).

### C2 — Idempotency/retry fail-closed (BUILD-GATE BLOCKER; security invariant)
**The kill hazard both gates independently surfaced.** Effect's headline feature is *managed retries*
(`Effect.retry`/`Schedule`) — a **new in-handler retry plane** that ADR-0052 D6c never contemplated
(D6c reasoned about *client/transport* retry only). An Effect-authored mutating handler is the single
most likely place in the system to silently reintroduce an auto-retry.
- **Extend D6c to name in-handler (Effect) retry as a second forbidden plane** on non-idempotent methods.
  The default template attaches **no `Schedule`** to a mutation's top-level effect.
- Discipline ("don't attach a Schedule") is a guard-both-halves problem that decays. The durable fix is
  **idempotency-key-by-construction (D6c) threaded to the datastore**, so *any* retry plane — client,
  transport, or a stray Effect `Schedule` — is idempotent **by construction**, not reviewer vigilance.
  **Mandatory for mutating wrappers.**
- **Cold-start-timeout corruption path (concrete):** the cold-start ledger
  (`docs/benchmarks/cold-start-ledger.md`) shows **7–20 s PG-path tails**, past normal client deadlines.
  A mutation runs; the client deadline fires mid-flight across the activator cold path; the fiber must be
  **interrupted** and its finalizers may **only release resources, never resubmit the mutation**.
- **A missing gRPC status trailer is fail-closed non-retryable** (ADR-0052 D15).
- **Enforcement:** mutation-proved (delete the guard → an Effect mutating handler's no-auto-retry test
  reds). **No Effect-authored *mutating* endpoint ships until this is green.** The spike may prove
  transport/authoring first and defer this, but it is a hard build-phase blocker.

### C3 — Cold-start / bundle cost (the number that bounds or kills it)
Effect's runtime init runs on every scale-from-zero. Gating measurement **before any build**, in the
ledger's canonical in-cluster harness, n≥8 cold:
- **(a)** process-start → first-RPC-served, bare `connect-node` Bun handler vs the same handler in
  Effect — isolating **Effect runtime/Layer-init** as the delta — against the ~1.4–1.5 s platform floor
  (`docs/release/eks-bunexec-bench.md`) and the product-path ~3.1 s median / 7–20 s PG tail
  (`docs/benchmarks/cold-start-ledger.md`).
- **(b)** single-exec **bundle-size delta** (Effect 4.0 tree-shaken closure) vs the ~60 MB baseline
  (`docs/release/bun-func-runtime-spike.md`) — a bigger image re-enters cold *pull*.
- **Adversarial hole:** Effect **Layers that eagerly acquire external resources at Runtime construction
  pull dependency-connect INTO the cold path** — re-importing the exact fresh-pod PG/Redis connect tail
  the ledger spent seven iterations fighting. **Constraint: resource-acquiring Layers must be
  lazy/deferred, never eager at Runtime build.** If Effect init consumes a meaningful fraction of the
  Bun <1 s self-warm budget, the idea is **bounded to warm-heavy backends**, not general.

### C4 — Auth fail-closed under Effect's model (ADR-0052 D5/D13)
- **D5:** auth is the **first effect** in the sequence; its failure is a typed error → `Code.Unauthenticated`.
  Hazard: with Effect DI (Layers/Context), a **mis-provided auth Layer fails as a *defect* (`die`), not a
  typed error** — require **die → deny**, never die → an INTERNAL a proxy might treat as retryable.
  Absent auth context = deny; DI construction failure = deny.
- **D13:** the token interceptor stays at the **connect-node interceptor layer, outside the Effect** —
  Effect never mints or wraps the raw token. Mutation-proved per template.

### C5 — Thin seam + supply chain + boundary
- **Adapter seam:** the connect-node router registers a plain `(req, ctx) => Promise<Response>`; Effect
  is invoked **inside** via exactly **one `runPromiseExit` per RPC**, resolving before the handler
  returns. Effect never owns the h2c listener, the server loop, or trailer/status writing (that stays
  connect-node's, D15). The Effect typed-error channel → Connect `Code` + trailers is a **total mapping**;
  an unmapped Effect *defect* → `Code.Internal` with **no stack/message leaked to a trailer**. This seam
  is also the **Option-D removability boundary**.
- **Supply chain (security.md):** exact-pin (no floating `beta`/range); the beta's transitive closure
  passes the **same Trivy/npm-audit HIGH/CRITICAL gate with no beta exemption**; it appears in the image
  SBOM; if `@getknext/grpc` publishes, it is under the publish-blocking npm-audit gate. Plus: a **named
  owner + manual upgrade cadence** (Dependabot can't track a beta channel), and a **documented rollback**
  to Option D (the thin seam is what enables it).
- **Core-vs-app boundary (scs-zones):** `effect` appears **only** in `@getknext/grpc` + the generated
  template; opt-in/app-level through the correctness phase, not promoted to core (same line as SW/MFE/PWA).

## Action items (spike now, build post-Tier-A)
- [ ] **Fenced prototype spike (throwaway, uncommitted like `bun-grpc-spike/`):** one Effect-4.0 Connect
      handler compiled as a Bun single-exec (reuse the `bun-func-runtime-spike.md` pattern); measure C3
      (a)+(b) locally (process boot + bundle) and note the on-cluster Knative cold-start leg as
      cluster-gated; **fault-injection arm** — deadline/interrupt a mutation mid-flight, assert the write
      applied **exactly once** via the idempotency key (the retry×cold-start double-mutation is a
      distributed-timing bug no unit test catches). File any Effect-4.0 mismatches upstream to
      `Effect-TS/effect`, tracked like the vinext PRs.
- [ ] **Core-fence guard (C1)** in the closure family, mutation-proved.
- [ ] **Idempotency/retry build-gate (C2)** — the hard blocker; mutation-proved before any Effect
      mutating endpoint ships.
- [ ] **Auth fail-closed (C4)** survives Effect expression; mutation-proved per template.
- [ ] Productionised template stays post-Tier-A in `@getknext/grpc`.
