# Plan — Bun 1.4 as a runtime option, vinext as a builder option, separated by an adapter

> **Status: IMPLEMENTED and GATE-CLEARED. Pending a commit (local GPG) and one founder decision.**
>
> Architect: **SIGN-OFF** (round 2). System designer: **SIGN-OFF** (round 5, after four BLOCK rounds).
> Every blocker is closed; the two attacks that survive are observationally identical to the correct
> implementation on all four expressible config cells, which is a limit of the domain, not a gap.
> The one open item is the founder ruling on ADR-0048 (the default), where both gates recommend
> Option A: leave the default at `node + turbopack`.
>
> ORIGINAL STATUS LINE (kept, it was wrong about the gates having not run):
> Track A item 1, and Track B B1–B4, are built, tested and mutation-proved (37 mutations declared,
> 37 red, each with a negative control green first and a byte-identical restore). Two items are
> bounded by things outside this machine and are recorded as such in §8 rather than claimed.
> §6's escalation triggers still apply to B2's schema/CRD change: the gates have NOT run.

## 8. Completion status — what was built, and what is genuinely outstanding

| item | state | evidence |
|---|---|---|
| A1 compile-cache diagnostic | **done** | narrows by Bun version; measured on real 1.3.5 + 1.4.0 in both directions; 6/6 mutations red |
| A2 keep-alive ≥1.4 self-disable | **no code needed; empirical half blocked** | logic already correct + unit-tested. Three harnesses (`Bun.serve`, `node:http`, node-fetch@2/globalAgent) all failed to see red on the *affected* 1.3.5 — #188 was observed on `ubuntu-latest`, this machine is Darwin/arm64 |
| A3 pin bump | **CI-bound** | needs the lanes green on 1.4.x. Ordering finding: the keep-alive guard auto-disables the instant the pin moves, so the bump and A2's re-verification are one event |
| B1 artifact contract | **done** | `adapters/artifact-contract.ts` + 19 interface-level tests; 9/9 red |
| B2 `build` axis | **done** | config + CRD (additive, enum, absence = turbopack) + validator + CR builder; 15 tests; 7/7 red; operator suite green |
| B3 vinext builder | **done** | descriptor bound to the REAL artifact; 7 reality tests; 7/7 + 4/8 red |
| B4 combination coverage | **done** | dispositions enumerated FROM the contract; 8 tests; 4/8 red |

### The correction that made B3 tractable

An earlier draft of this plan said B3 required "adopting vinext as a dependency" as net-new work.
**That was wrong.** `examples/bun-exec` already depends on `vinext@1.0.0-beta.4`, already ships the
in-process nitro entry (`knext-bun-entry.mjs`, which wraps nitro's real request pipeline to
re-provide the RuntimeContract), and already builds `.output/server/index.mjs`. The earlier check
looked at `packages/` and the root manifests and not at `examples/`.

So B3's three parts — adopt vinext, implement the in-process entry, prove it on a minimal
App-Router sample — were **already done** under ADR-0036. What had never been done was connecting
that implementation to the contract, which is what landed: the descriptor is now asserted against
the sample's *actual built output*, not against prose.

### What remains genuinely outstanding

- **`kn-next build` cannot drive a vinext build for a user's app.** The sample uses its own
  `build.sh`. This is why `vinextBuilder.available === false`, and a test asserts that `build.ts`
  contains no vinext path — it fails the day someone adds one, prompting the flag to flip rather
  than letting the CLI build something the validator still refuses.
- **The design gates have not run** on B2's config-schema + CRD change.
- **A2 and A3** as bounded above.

## 0. The correction that shapes everything below

An earlier draft of this plan said the expensive part was relaxing a CEL admission rule enforcing
`bun ⇒ vinext`, and that `bun + turbopack` was "rejected". **Both are wrong against the tree.**
Measured, not read:

| claim in the ADRs | actual state of `main` |
|---|---|
| `bun ⇒ vinext` enforced fail-closed by CEL on the CRD | **No such rule.** The string `vinext` does not appear in `api/v1alpha1/nextapp_types.go` at all, so no rule there can reference it. |
| `bun + turbopack` is "rejected" | **It is the shipped meaning of `runtime: bun`.** `config.ts:269` — *"Runtime to execute the Next.js standalone server.js: 'bun' or 'node'"*. The CRD says the same (`nextapp_types.go:105`). |
| a `build: turbopack \| vinext` axis exists on config and CRD | **It exists nowhere.** No `build` key in `config.ts`, none in the CRD. |
| vinext is being adopted | **Still not a dependency.** No `packages/vinext`, absent from every manifest — unchanged since ADR-0036 recorded it in July. |

ADR-0036 and ADR-0042 describe a matrix that was **designed and never built**. ADR-0042 is Accepted
but sits at `current_phase: 0`.

**So the two halves of this request are wildly asymmetric:**

- **Bun as a runtime option — already shipped.** `runtime: bun` runs Next standalone under Bun
  today, with per-file bytecode precompilation (`build.ts:120-137`, ~12 s/build). There is no API
  to add. The only work is Bun **1.4** readiness.
- **vinext as a builder option — entirely net-new.** New axis, new dependency, new adapter
  implementation.

## 1. The separation: adapter pattern

The user's framing is right, and ADR-0036 already reached it (lines 115-118):

> `RuntimeContract` applies to all three cells, via exactly **TWO** implementations:
> turbopack → the supervisor; vinext → one shared in-process entry (**both** node+vinext and
> bun+vinext).

The load-bearing insight: **implementations are keyed by the artifact shape a builder emits, not by
the (build, runtime) pair.** That is what makes this a 2-implementation problem rather than a
4-cell matrix, and it is why the axes genuinely separate.

```
  Builder adapter          artifact shape          Runtime adapter
  ───────────────          ──────────────          ───────────────
  turbopack  ──emits──►  .next/standalone   ──►  supervisor: spawn server.js
   (next build)                                    under node OR bun          ← runtime is a
                                                                                 parameter here,
  vinext     ──emits──►  nitro .output      ──►  in-process entry, BUN only:
   (vite/rolldown)          (bun preset)            the built entry calls bun's
                                                  global serve() — node exits 1
```

- **`build` selects the builder adapter** → decides the artifact shape.
- **`runtime` parameterises execution of that shape** → does *not* select an implementation.
- **`RuntimeContract` is the interface both implementations satisfy** — health, metrics on `:9091`,
  drain-on-SIGTERM, the mutating-endpoint auth rule. It is already exercised as a contract
  (`examples/bun-exec/test/runtime-contract.test.ts`).

The seam is the **artifact contract**: what a builder promises and a runtime consumes (entry path,
whether it is spawnable vs in-process, whether it is bundleable). Compatibility becomes a property
of that contract, not an enumerated table — so a new builder or runtime is an adapter, not a matrix
edit and a CEL rule.

Today `node-server.ts` **is** the supervisor implementation (spawns `STANDALONE_SERVER_PATH`,
metrics sidecar, SIGTERM drain). It is the concrete first adapter; nothing needs inventing for it.

## 2. Track A — Bun 1.4 as a runtime option (small, do it first)

No API change. Ship #807's three items, then re-baseline:

1. Teach the #309 compile-cache diagnostic **both** probe shapes — 1.4 returns a *path* for a
   healthy dir; check whether that currently mis-classifies healthy as unhealthy.
2. The Bun ≤1.3 keep-alive guard self-disables on ≥1.4 "where the underlying bug is fixed
   upstream" — that branch has never been exercisable and now is.
3. Re-baseline via **#188's bun-version dispatch knob**, then bump the CI pin off **1.3.14**
   deliberately (it was pinned because 1.4.0 "redded every lane", #806).

**Then re-measure the verdict that retired this cell on paper.** ADR-0036 rejected `bun + turbopack`
because it "was measured to only tie node, not win" — a *performance* verdict on Bun ≤1.3, not a
capability failure. Bun 1.4 makes it **stale, not wrong**. Re-run it; record in the cold-start
ledger. If it still ties, `runtime: bun` stays a supported option that nobody should default to,
and we say so plainly rather than deleting it.

## 3. Track B — vinext as a builder option (large, gate it)

| step | content | exit |
|---|---|---|
| B1 | Define the **artifact contract** explicitly — the seam in §1. One interface, two implementors. | contract test both adapters run against |
| B2 | Add the **`build` axis** to `kn-next.config.ts` + CRD, default `turbopack`, additive at `v1alpha1` | `--dry-run=server --validate=strict` preflight; **operator/CRD first, then CLI** (#548) |
| B3 | Adopt vinext as a dependency; implement the in-process entry adapter | minimal App-Router sample first — ADR-0036 warns `file-manager` is a poor first target (uses `sharp`, relies on adapter hooks) |
| B4 | Compat coverage per admitted combination, honestly scoped | no combination claimed green without a red-on-fail check |

**Do not couple B to a default flip.** ADR-0042's Phase 5 flips the default to `bun + vinext`.
Which combinations are *valid* and which is *default* are separate questions, and conflating them is
exactly what collapsed the matrix into a single coupled target before. **Recommendation: default
stays `node + turbopack`**, the only all-apps-verified path — which keeps the hard rule ("never make
anything but the node/official-adapter target the default") intact instead of amending it.

## 4. What the adapter separation buys

- **`bun + turbopack` stops being a special case.** It is "the standalone shape, executed by bun" —
  already what the code does. No cell to re-admit.
- **~~`node + vinext` costs nothing extra.~~ RETRACTED — the cell is not capable.**
  Measured: `node examples/bun-exec/.output/server/index.mjs` exits 1 (`ReferenceError`), because
  the built artifact is nitro's BUN preset. The original claim came from ADR-0036 prose. Old text: ADR-0036 already says both vinext cells share one entry,
  so admitting node+vinext is a parameter, not an implementation. ADR-0042 Decision 2 excluded it as
  a *scope* reduction, not a capability finding — worth confirming it builds and serves, since
  "excluded" and "broken" are not the same and the text does not settle which.
- **The CEL rule never needs writing.** Compatibility lives in the artifact contract. The invariant
  ADR-0036 wanted enforced fail-closed is better expressed as "no runtime adapter accepts a shape it
  cannot execute" — a typed seam, not a cluster-side string comparison.

## 5. What this does not resolve

- **ADR-0042 ↔ ADR-0006 unreconciled for remote image sources.** `parseImageParams` rejects every
  non-root-relative URL; no `remotePatterns` support, so that Next capability 400s by construction
  on the vinext path. Widening vinext's role does not fix it.
- **#758 — CSS has no Phase-3 criterion**, and is absent from `docs/compat-matrix.md`. Re-confirmed
  zero-hit in both files today. A builder option whose stylesheet pipeline has no criterion is not
  one anyone should pick.
- **#755** — nothing guards the entry shape the "app is embedded in the binary" result rests on.
- **#785** — no vinext publish lane exists (`ci.yml:1112`), so the closure SBOM has no digest to
  attest onto.

## 6. Escalation triggers

Track A trips **none** — it is a version bump and a re-measurement on an existing, shipped option.

Track B trips three: **amends ADR-0042** (Decision 2, and the Phase-5 default scope); **config
schema + CRD** (the new `build` axis); and **a hard rule** if the default moves (§3 recommends it
does not, but the decision is in scope and must be stated).

## 7. Recommendation

**Split them and ship Track A now.** It is small, it is needed regardless, it touches no API, and it
answers whether `runtime: bun` is worth recommending — which is information Track B's design should
have before it starts.

**Hold Track B for the design gates**, and start it at B1. Defining the artifact contract *first* is
what makes the axes separable; adding the `build` key before the seam exists would reproduce the
coupled-target problem with extra config.
