# ADR-0048: vinext + Bun 1.4 single-executable as the ONLY build/runtime target

- **Status:** **Accepted (2026-08-27) — founder decision.** Supersedes the draft that recommended
  keeping `node + turbopack` as the default; the founder chose the stronger form: not a new default,
  the **only** option.
- **Supersedes:** ADR-0048-draft (`drafts/0048-draft-build-runtime-separation.md`).
- **Amends:** ADR-0042 Decisions 1, 2 and 5 (the phased flip becomes a single target);
  ADR-0036's build×runtime matrix (four cells collapse to one).
- **Amends a hard rule.** `.claude/rules/architecture.md` states *"never make anything but the
  node/official-adapter target the default."* This ADR sets the official-adapter target aside
  entirely. `.claude/rules/` is not an agent's file to edit — **the maintainer must amend that rule
  or this ADR contradicts it.** Recorded here rather than left implicit.

## Context

The separation work (ADR-0048-draft, Track B) built a build×runtime contract with four expressible
cells. Measuring them ended the question rather than informing it.

## Decision

**`build: vinext` + `runtime: bun` (1.4.0+), compiled to a single executable with
`bun build --compile --minify --bytecode`, is the only supported target.** `turbopack` and
`node` are retired as user-selectable options.

## The measurement this rests on

All arms: `examples/bun-exec`, app id `app-6bf934d9091b5c24`, route `/api/health`, responses verified
**byte-identical** (35 bytes, sha256 `7b872305fef5c052`, no compression). Cold start = spawn → first
HTTP response with a status, fresh process and port per sample, n=10.

| variant | cold median | p95 | vs node | req/s | vs node |
|---|---|---|---|---|---|
| node + turbopack | 884 ms | 1029 | 1.00× | 630 | 1.00× |
| bun 1.4 + turbopack | 703 ms | 882 | 1.26× | 714 | 1.13× |
| bun 1.4 + turbopack + bytecode | 554 ms | 692 | 1.59× | 537 | 0.85× |
| vinext single-exec (bun 1.3.5) | 121 ms | 286 | 7.28× | 1053 | 1.67× |
| **vinext single-exec (bun 1.4.0)** | **61 ms** | **131** | **14.50×** | **1103** | **1.75×** |
| bun 1.3.5 + turbopack | — | — | — | — | **does not serve** |

It wins **both** axes. Its p95 (131 ms) beats node's *best* sample (809 ms) by 6×, and for
scale-to-zero the tail is what users feel.

## Options considered

| option | consequence |
|---|---|
| Keep `node + turbopack` default, vinext opt-in (the draft's recommendation) | Keeps the hard rule unamended and the compat suite meaningful. Forgoes a measured 14× cold start on the product's headline feature. |
| Flip the default, keep node supported | Two supported paths, two compat matrices, two supply-chain surfaces. Halves the simplification the numbers argue for. |
| **Single target (CHOSEN)** | Maximum cold-start win; one path to test, document and support. Costs the all-apps-verified path, and binds the product to a pre-1.0 third-party dependency. |

## Consequences, including the ones against

**Accepted honestly rather than argued away:**

1. **vinext is `1.0.0-beta.x` and is a Cloudflare project** (`https://vinext.dev`,
   `github.com/cloudflare/vinext`). The sole supported path now depends on a pre-1.0 dependency the
   project does not control.
2. **The official Next.js compatibility suite no longer covers the shipped path.**
   `docs/compat-matrix.md` has zero vinext coverage and the Bun axis is ❌ "first green pending".
   The north star — verified-adapter status — is *unreachable* until a vinext-axis suite is green.
   This is the largest cost and it is strategic, not technical.
3. **`kn-next build` has no vinext path** and the **scaffolded Dockerfile cannot produce a runnable
   nitro image**. Both must land before this decision is executable; see Action items.
4. **Binary size**: 69.9 MB (arm64). A real deployment cost the benchmark does not price.
5. **`node + vinext` is not a fallback.** Measured: `node .output/server/index.mjs` exits 1
   (`ReferenceError`) because the artifact is nitro's **bun** preset. There is no node escape hatch
   from this decision.
6. **Bun 1.4.0 is the floor, not a preference.** Bun 1.3.5 cannot serve the standalone tree at all
   (HTTP 500, `Expected CommonJS module to have a function`), and halves the single-exec's
   cold-start win (121 ms vs 61 ms).

## BLOCKED: the decision is not executable today (measured 2026-08-27) — **RESOLVED, see Amendment 3**

**Consequence #1 arrived immediately.** The reference app cannot build the mandated target.

file-manager was ported to the vinext toolchain and three obstacles were cleared (the root vite
override, Tailwind-under-Vite, a missing entry sibling). `vite build` now succeeds. The COMPILE step
does not:

```
error: "rsc_exports" is not declared in this file
  at .output/server/_ssr/rsc2.mjs
```

Established as an **upstream vinext bug**, not a Bun or knext one:

- the **uncompiled** output fails identically (`bun .output/server/index.mjs` -> HTTP 500);
- all four `--compile`/`--minify`/`--bytecode` combinations fail the same way;
- vinext **beta.4 and beta.8** both fail;
- `examples/bun-exec` compiles cleanly on the *same* versions.

The emitted module lists `rsc_exports` in an **export** while declaring it nowhere, and
`_runtime.mjs` does not define it. The bundle exports a symbol that does not exist.

**Therefore:** the target is declared, tooled and enforced in code, but **no production app in this
repo can build it**. `examples/bun-exec` must NOT be deleted — it is the only artifact source, and
the contract reality test binds to it. Full detail: `docs/benchmarks/EXPERIMENTS.md` E9.

## Amendment 2 — image optimization does not survive the single executable (2026-08-28)

**Status: RESOLVED by Amendment 3 (2026-09-03).** The blocking fact below was *disproved*: the
"no external native module is reachable" claim held only for routes that go through module
resolution. `process.dlopen` on an absolute real path works inside the compiled binary, so sharp's
JavaScript is bundled and its native addon ships beside the executable
(`packages/kn-next/src/adapters/sharp-addon-dlopen.mjs` + `vinext-compile.mjs`), keeping its
`@img` directory layout because the addon links libvips by relative rpath. CI-verified against the
real production image: `/_next/image` answers 200 `image/avif`, 2,116 bytes optimized from a
181,277-byte source. The A/B/C/D table below is therefore obsolete — the single executable keeps
image optimization, so the trade it prices no longer exists. Kept for the record:

**Original text: OPEN. This escalates to the founder** under `.claude/rules/workflow.md` on two
separate triggers: a discovered fact that invalidates the plan, and a change that
contradicts an existing ADR. It is recorded, not resolved.

`/_next/image` cannot optimize on the compiled single executable. Four independent routes
were tried and measured — vinext's plugin option, vinext's public `setImageOptimizer`,
a knext-side route intercept with a dynamically-required sharp, and a static `sharp`
import letting Bun embed the N-API module. The full evidence is `docs/benchmarks/EXPERIMENTS.md`
E13; the two load-bearing facts:

- vinext gates image optimization on the **Cloudflare Workers assets binding**
  (`env?.ASSETS`) and types it as `"cloudflare-images" | "none"`. Nothing registered on
  the node/bun platform can reach it. This is upstream's shape, not a knext bug.
- Inside a `bun build --compile` binary, **no external native module is reachable** —
  `createRequire` sees only the embedded graph, and a static import compiles but fails at
  runtime with `Could not load the "sharp" module`.

**Why this matters more than it looks.** `CLAUDE.md` records image optimization as the
project's biggest functional gap until ADR-0006 closed it. This ADR, as written, reopens
it. A migration that silently drops a Tier-A capability is the exact failure this repo's
rules exist to prevent, so it does not get decided inside an implementation task.

**The trade, priced (n=5, same app, same route):**

| target | cold start (median) | image optimization |
| --- | --- | --- |
| node + standalone (status quo) | 2670 ms | yes |
| vinext, uncompiled, under bun | 879 ms | **yes** |
| vinext single executable (this ADR) | 469 ms | **no** |

Keeping image optimization costs **~410 ms of cold start** — and the uncompiled vinext
path is still **3x faster than the node standalone it replaces**.

**Options, with a recommendation.**

| option | cold start | image opt | cost |
| --- | --- | --- | --- |
| **A. Ship the uncompiled vinext output under bun** *(recommended)* | 879 ms | yes | keeps `node_modules` + sharp in the image; gives up the single-file artifact |
| B. Ship the single executable, accept no image optimization | 469 ms | no | reopens the ADR-0006 gap; contradicts "gate every feature on the compatibility suite" |
| C. Replace sharp with a bundleable WASM codec | 469 ms | unverified | **unmeasured** — no WASM encoder has been tried here; do not treat as available |
| D. Ship both targets, image optimization documented as single-exec-only | both | partial | reintroduces the two-target split this ADR exists to remove |

**Recommendation: A.** It keeps every capability the project already claims, still
delivers the large majority of the measured win (2670 → 879 ms), and leaves the single
executable available later if C is ever proven. B trades a documented capability for
410 ms, which is the wrong direction for a project whose north star is verified
correctness rather than benchmark position.

**What shipped regardless of the choice.** The route intercept
(`packages/kn-next/src/adapters/vinext-image-optimizer.ts`) works, is covered by 16 tests,
and is what makes option A real today. It is also the piece option C would reuse — only
the codec behind it would change. Nothing here is wasted by picking A or C.

## Action items

1. `build.ts`: add the vinext build path (`vite build` → nitro `.output` → `bun build --compile`).
   **DONE (Amendment 3):** `buildVinextExecutable` (`cli/vinext-build.ts`) is wired into
   `kn-next build` for the nitro shape — compile + bytecode + sharp-native staging, Bun 1.4 floor.
2. `templates/app/Dockerfile.hbs`: ship the single executable, not `.next/standalone`. **DONE** —
   the scaffolded Dockerfile ships the binary (`CMD ["/app/server"]`).
3. Operator: teach `nextapp_controller.go` the in-process shape — today its only shape-aware branch
   hardcodes `bun run server.js`. **DONE (Amendment 3):** `spec.build == "vinext"` leaves the
   container command to the image's own CMD; mutation-proved by
   `build_ksvc_command_test.go`.
4. CRD: widen `spec.build`'s enum to admit `vinext` **in the same change** as item 3, never before.
   **DONE (Amendment 3), in the same change** — `Enum=turbopack;vinext`, and the CLI now resolves
   its vinext default EXPLICITLY into the CR (`cr-builder.ts`), because wire-absence permanently
   means turbopack (ADR-0017) and omitting it would make the operator exec `bun run server.js`
   into an image that has no server.js.
5. Enforce the Bun 1.4.0 floor in the validator and the CRD. **CLI half DONE**
   (`vinext-build.ts` refuses < 1.4.0); a CRD-side floor is not expressible — the Bun version
   lives inside the image, not in the CR.
6. Compat: stand up a vinext-axis suite run, and mark `docs/compat-matrix.md` honestly until it is
   green — no row may claim verified while unverified. **STILL OPEN** — the docs site states the
   compiled path is measured-per-feature, not suite-verified.
7. **Maintainer:** amend `.claude/rules/architecture.md`'s official-adapter-default rule.
   **STILL OPEN.**

## Amendment 3 — bytecode means the single executable, and it ships whole (founder-directed, 2026-09-03)

Two facts arrived after Amendment 2 and changed its terms:

1. **Image optimization works inside the compiled binary** (see Amendment 2's resolution above) —
   the capability loss that motivated recommending the uncompiled Option A is gone.
2. **The build blocker fell.** The `rsc_exports` upstream failure that made the reference app
   unbuildable no longer reproduces: `apps/file-manager` compiles with
   `--compile --minify --bytecode` and serves — the CI production-image probe passes against the
   real Alpine/musl image.

**Founder decision:** *"Make vinext the only builder when the user chooses bun with bytecode."*
Concretely:

- **Bytecode belongs to exactly one builder.** The per-file standalone bytecode pass
  (`standalone-bun-bytecode.ts`, `KNEXT_BUN_BYTECODE`) is **retired and deleted**. It bought cold
  start (554 ms vs 703 ms) but cost throughput (537 req/s vs 714 — the per-module CommonJS
  conversion taxes every module boundary), while the whole-bundle compile wins both axes
  (61 ms, 1103 req/s). One bytecode story, not two.
- **Action items 3 + 4 executed in one change**, exactly as the CRD comment demanded: enum
  widened, operator taught the shape, CLI emits the resolved builder explicitly.
- **Upgrade order is load-bearing (#548):** a CRD that predates `"vinext"` rejects the new CR
  under `--validate=strict` — loud, before the cluster is touched. Operator/CRD first, then CLI.
