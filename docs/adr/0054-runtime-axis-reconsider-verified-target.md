# ADR-0054: Reconsider the vinext-only target — adopt a verified 778/0 runtime axis for v1.0

- **Status:** **Accepted (2026-09-22) — founder decision.** (Was Proposed; the sprint-close gates
  reviewed it SIGN-OFF/ISSUES non-blocking, findings folded in.)
- **Supersedes** ADR-0048's *vinext-ONLY* mandate: vinext is no longer the only target. **Amends**
  ADR-0042 (default runtime), ADR-0036 (target matrix); the maintainer must reconcile ADR-0042/0050/
  0051 status lines + `.claude/rules/architecture.md §4` + `CLAUDE.md §3` (not an agent's to edit).
- **Relates to:** ADR-0048 Amendment 4/5, the #605 runtime-axis go/no-go, the compiled-path gate
  concerns (#1153/#1155/#1156/#1157).

## Verdict (Accepted 2026-09-22 — founder decision)

**Adopt `bun-standalone` as the v1.0 default runtime axis, packaged as a Bun bytecode
single-executable** (`bun build --compile --bytecode`), and **keep `vinext` as a supported opt-in
option.**

- **Default = bun-standalone + bytecode exec.** The runtime is Next's own `next build` standalone
  output (778/0 on the official suite, corroborated on Bun 1.4.0), compiled to a single bytecode
  executable to recover the fast process-boot, single-artifact-ops and smaller-image benefits that
  motivated the compiled path — now on a **full-parity** base instead of vinext's ~87%.
- **vinext stays an option** (founder-directed) — compat-gated, for the apps/edge cases where its
  own artifact shape is wanted. Not removed.
- **node-standalone is the uncompiled fallback.** 778/0 and simplest; re-selectable.

**HONEST FEASIBILITY CAVEAT — the compile step is unproven for standalone (jev 0.83 to record it
this way).** The `bun build --compile --bytecode` path in the tree today (`examples/bun-exec`,
`vinext-compile.mjs`) compiles **vinext's** nitro `.output` — **not** the Next.js standalone
`server.js` + `node_modules`. Compiling the standalone output is **net-new**: it may hit the
runtime-chunking failure mode that already broke vinext's compile once (bun-exec README, root cause
1), and **778/0 retention through the compile is unverified**. So the FIRST action is a feasibility
spike; if the compile cannot hold 778/0, the axis **ships uncompiled bun-standalone** (already
778/0) and the bytecode-exec packaging becomes a fast-follow, not a v1.0 blocker. The verified-parity
credential must not be forfeited for an unproven compile — that was ADR-0048's mistake, not to be
repeated inverted.

**The compiled path inherits the gate concerns** (system-designer/architect sprint-close review):
SIGTERM-drain + `:9464` metrics are bypassed when the operator runs a compiled binary (#1156/#1157);
the keep-alive guard's applicability must be measured on linux-x64 (#1153); there is no standalone
runtime-image template yet (#1155). These gate the default before it ships.

## Context

ADR-0048 (founder, 2026-08-27) made the compiled **vinext + Bun 1.4 single-executable** the *only*
build/runtime target, retiring the official-adapter node-standalone path. It rested on two measured
premises:

1. **A decisive cold-start win** — its table showed 61 ms cold median vs node's 884 ms.
2. **Build-weight** — vinext's single-executable was expected to be the lighter artifact.

Both have since been undercut by measurement — cold-start decisively, build-weight conditionally —
and a third axis has been verified that ADR-0048 never weighed:

- **Cold-start is TIED on a real cluster.** OKE, N=7 paired cold cycles, two operator-reconciled
  `NextApp` CRs (`.claude/oke-coldstart-bench.md`): node-standalone **3610 ms** (3143–3948) vs
  vinext single-exec **3401 ms** (3226–3761) median — ~6%, ranges fully overlap. Cold-start is
  Knative activate→schedule→container-create bound (~3.4 s), which swamps runtime boot. ADR-0048's
  **61 ms was a local warm-binary process-boot micro-bench** (`examples/bun-exec`, n=10, binary
  already page-cached) that excluded the cluster path — ADR-0048's own **Amendment 5** concedes
  this. A truly-cold local spawn is ~1.8 s. So cold-start **does not differentiate the axes**.
- **Build-weight is not the vinext win ADR-0048 assumed — measured honestly, it depends how you
  count.** #605 V2 (`docs/wayfinder/v2-build-weight.md`, dated 2026-08-03, commands in its §9):
  in **raw bytes vinext ships *less*** — 37.14 MB vs the Turbopack `next build`'s 44.22 MB (−16%)
  and the `--webpack` build's 52.05 MB (−29%). But that raw win is bought by **omitting image
  optimisation**: hold capability constant (subtract `sharp`, which vinext has no equivalent of)
  and vinext is **+31% vs the Turbopack build (37.14 vs 28.36 MB)** and ≈tied with webpack (+2.6%).
  vinext also ships `@vercel/og` + stack unconditionally — 14.50 MB, 39% of its artifact — for apps
  that use no OG images. **So for a capability-complete knext app (image optimisation is ADR-0006
  core), vinext is not the lighter artifact.** The premise "vinext builds lighter" holds only for
  apps that forgo image optimisation. *(T6 this sprint audited the V2 method — sound, dated,
  reproducible; a full re-measure was deferred (jev 0.87) as toolchain drift would add noise to an
  already-conditional claim, not signal.)*
- **Two verified 778/0 axes exist.** node-standalone is 778/0 (the official-suite credential — the
  verified-adapter north star) but ADR-0048 made it un-selectable. **bun-standalone** (`next build`,
  boot on Bun 1.4.0) is **778/0, corroborated this session** across two green runs
  (`35652804130`, `35659440363`; PR #1139). Meanwhile the shipped vinext artifact is **~92% @ Next
  16.2 / ~87% @ 16.3.5**, with an 84-file 16.3.x residue (multi-cause: build-layout ENOENT,
  asset-path 404s, React-internals skew, vite-build failures), an ESM-only app contract (ADR-0051,
  excludes CommonJS apps), and a high-complexity build path (vite→nitro→compile).

vinext's surviving measured advantages — per ADR-0048's **Amendment 5**, stated here in full so this
demotion is not made off a one-sided list — are a **smaller image** (42.9 vs 66.6 MiB), **faster
warm-request latency/throughput** (ADR-0048 §benchmark: vinext single-exec **1103 req/s** vs
bun+turbopack **714** / node **630**, i.e. bun-standalone is **~35% slower warm** than the vinext
incumbent it would demote — *local `examples/bun-exec` measurement, same micro-bench family as the
61 ms cold number, so treat it as a warm-serving indicator, not a cluster figure*), a
**single-artifact operational story**, and a faster **process boot** that pays off only off the
Knative path (image prewarming / non-Knative hosts). None of these outweighs the north-star gap
(778/0 vs ~87%) or survives the tied cluster cold-start — but the decision must weigh them, not
delete them.

## Decision (as accepted — see the Verdict above)

**Stop making the compiled vinext single-executable the *only* target.** The v1.0 default is a
verified **778/0** axis, restoring the verified-adapter credential path — specifically
**bun-standalone (`next build` → Bun 1.4.0) packaged as a bytecode single-executable**, with
**vinext kept as an opt-in option** and node-standalone as the uncompiled fallback.

bun-standalone delivers full node-parity compat (778/0), the same cluster cold-start as everything
else, `next build` simplicity (no vite→nitro→compile authoring path, no ESM-only contract), and is
Bun-native — what the "fork vinext to run on Bun" idea was reaching for, at full compat and zero
fork. The **bytecode-exec packaging** (founder-directed) then aims to recover the boot / single-
artifact / image-size wins on top of that full-parity base — **subject to the feasibility spike in
the Verdict**: the warm-throughput gap (vinext 1103 vs ~714 req/s) is a steady-state property the
compile does not erase, which is itself part of why vinext stays a selectable option.

**Keep vinext as an opt-in, compat-gated target** for its one real edge (image size) — not the
default, not the only option. Demote its weekly lane from shipped-artifact gate to experimental.

## Options considered

Warm-throughput column added per the sprint-close architect gate (evidence symmetry — price the axis
where the recommendation *loses*, not only where it wins). Throughput is a **local `examples/bun-exec`
warm measurement** (ADR-0048 §benchmark), not a cluster figure.

| Option | Compat | Cluster cold-start | Warm throughput (local) | Build | Image | Verdict |
|---|---|---|---|---|---|---|
| **node-standalone** | **778/0** (credential) | ~3.6 s | 630 req/s (1.00×) | `next build`, simple | 66.6 MiB | Strong; retired by ADR-0048. Re-selectable is the fallback. |
| **bun-standalone** | **778/0**, corroborated (Bun 1.4.0) | ~3.4 s (tied) | ~714 req/s (1.13×) — **~35% below vinext** | `next build` on Bun, simple | **not measured** (reintroduces `node_modules`; not assumed = node) | **RECOMMENDED** — verified + Bun-native + simple; the throughput cost is the acknowledged trade. |
| **vinext single-exec** (ADR-0048 status quo) | ~87% @16.3.5, 84-file residue | 3401 ms (tied) | **1103 req/s (1.75×)** | vite→nitro→compile, complex, ESM-only | **42.9 MiB** | Cold-start + build-weight premises collapsed; but keeps a real warm-throughput + image edge → opt-in, not dropped. |
| **Fork vinext to be Bun-native** | unknown | — | — | core rewrite; Bun's bundler can't do RSC graph separation | — | **Rejected** — bun-standalone already delivers Bun-native at 778/0 with no fork. |

**Why the recommendation still stands despite losing the throughput column:** the north-star axis is
*verified compat* (778/0 vs ~87%), and cold-start — what a scale-to-zero user actually pays — is
tied. A ~35% warm-throughput edge does not buy back a forfeited verified-adapter credential. But it
is a real cost of the recommendation and is why vinext stays a supported opt-in, not dropped.

## Consequences

- **Restores the north star.** A 778/0 axis becomes user-selectable again, so verified-adapter
  status (official-suite pass, listed in the Next.js docs) is reachable for the shipped artifact —
  which vinext-only forfeited for a ~87% target.
- **Public surface changes — CLI + config, NOT the CRD** (corrected per the sprint-close
  system-designer gate). If node/bun-standalone becomes selectable, the CLI `build` target surface
  and `kn-next.config.ts` schema change (public-API trigger, mechanically detectable). It does **not**
  need a CRD roll: `nextapp_types.go` already carries `Runtime: bun|node` **independent** of `Build`
  (no CEL cross-field rule), and the operator reconciles it — so this hits **no #548 operator-first
  upgrade-order hazard**. The earlier "CRD-adjacent" wording overstated it.
- **No shipped packaging path yet — a hard prerequisite, not a flag flip.** The app template
  (`templates/app/Dockerfile.hbs`) is vinext-single-exec only; there is no standalone runtime image
  in the tree. Adopting bun-standalone means authoring a new image + entrypoint that carries the
  drain supervisor + metrics sidecar (see next point). Tracked as tech debt (standalone image
  template; SIGTERM-drain e2e; :9464 metrics parity).
- **Drain + metrics are bypassed on the bun-standalone container path** (system-designer gate). The
  operator forces `["bun","run","server.js"]` for `build!=vinext && runtime=bun`
  (`nextapp_controller.go`), which drops knext's `node-server.ts` supervisor (SIGTERM drain, `:9464`
  metrics, `NODE_COMPILE_CACHE`). The standalone drain has never been exercised under Bun — a
  load-bearing scale-to-zero failure mode. Must be closed before this axis ships (tracked).
- **HTTP transport + keep-alive guard (correctness, architect gate).** bun-standalone serves `next
  build` output over **`node:http`**, whose `Bun.serve` sibling reset was fixed at Bun 1.4.0 (why the
  node-lane keep-alive guard self-disables ≥1.4.0). So bun-standalone likely does **not** need the
  always-on `Connection: close` guard that ADR-0048 Amendment 4 calls load-bearing for the compiled
  target — but this must be **measured on linux-x64** (the platform the reset reproduces on), not
  assumed (tracked).
- **Multi-target coherence must be decided, not assumed (architect gate — "don't rewrite the runtime
  twice").** This ADR implies up to three targets (bun-standalone default, node-standalone fallback,
  vinext opt-in). ADR-0048 rejected dual-target on cost grounds (two matrices, two supply-chain
  surfaces). This is only acceptable if all targets keep **one shared config/CRD/operator/
  `RuntimeContract`** (ADR-0036's answer). The accepted ADR must reaffirm that shared contract
  explicitly or state an N-target policy pricing the lane/SBOM/docs cost (tracked).
- **vinext demoted to opt-in.** Its compat lane becomes experimental; its 16.3.x residue support
  effort is no longer on the v1.0 critical path.
- **bun-standalone needs a scheduled lane — the load-bearing gap under this whole recommendation.**
  Its 778/0 is *verified-once* (two dispatch runs on 1.4.0), not *credentialed*; a scheduled
  Bun-1.4.0 lane with a written N-consecutive-nights bar (the node lane's contract class) moves it
  verified→credentialed. The recommendation rests on this; it is not a chore.
- **Rules + downstream ADRs must be reconciled** (maintainer): `architecture.md §4` + `CLAUDE.md §3`,
  **and** the Accepted ADRs that also encode vinext — **ADR-0042** (vinext default runtime),
  **ADR-0051** (ESM-only vinext contract), **ADR-0050** (vinext ISR-Redis), **ADR-0036** — else four
  Accepted ADRs contradict this one.
- **Decision-churn bar.** This is the 4th runtime-axis decision in ~4 months (0036→0042→0048→0054).
  The accepted axis must carry an explicit "what measurement would reopen this" clause.
- **Honest about the trade this reverses:** ADR-0048 chose the stronger form (only, not default) on
  a cold-start premise that a real cluster has since tied. This ADR does not paper over that — it
  is the "discovered fact that invalidated the prior plan" escalation trigger, realized.

## Action items

**Accepted 2026-09-22 (founder). Sequenced — the feasibility spike gates whether the bytecode-exec
packaging is v1.0 or a fast-follow.**

1. **FEASIBILITY SPIKE (first, blocks the packaging decision).** Can the Next.js **standalone**
   output (`server.js` + `node_modules`) be `bun build --compile --bytecode`-compiled to a single
   executable that **still passes 778/0**?
   **THE crux (founder-flagged): dynamic imports.** Next's standalone server resolves routes at
   runtime via its manifests (`pages-manifest.json`, `app-paths-manifest.json`, `middleware-manifest`,
   the flight/font/next-image chunks) with dynamic `require()`/`import()` whose specifiers `bun build
   --compile` cannot see statically — so the chunks are simply **not embedded** in the binary and 404
   at runtime. This is the exact failure that broke vinext's compile once (bun-exec README, root cause
   1: a runtime-chunked server). The spike stands or falls on solving it. Candidate directions to
   evaluate (not yet decided):
   - **Generated static-barrel entry** — read the manifests at build time and emit a wrapper that
     statically `import`s every route/chunk module, so bun's bundler sees the whole graph and inlines
     it. Preferred if it holds parity.
   - **Pre-bundle then compile** — `bun build` (or the app's own bundler) into one
     statically-analyzable entry first, then `--compile` that.
   - **Embed-as-file + runtime path load** — `Bun.embeddedFiles` / `with { type: "file" }` for chunks
     the server loads by path, keeping the manifest's runtime resolution but from embedded bytes.
   - **Emit a non-chunked server** — a Next/adapter build flag that inlines routes (what pinning a
     vinext version did as a stopgap).
   Deliverable: a compiled standalone binary that passes the 778-test suite, or a documented
   dead-end. **If it holds → bun-standalone-bytecode is the v1.0 default. If it does not → ship
   uncompiled bun-standalone (already 778/0) as v1.0** and make bytecode-exec a fast-follow; the
   verified credential is never forfeited for an unproven compile. *(new issue — spike/prototype)*
2. **Compiled-path gate fixes (gate the default before it ships):** standalone runtime-image
   template (#1155), SIGTERM-drain e2e under the compiled/`bun run server.js` path (#1156), `:9464`
   metrics parity on `runtime=bun` (#1157), keep-alive guard verification on linux-x64 (#1153).
3. **Credential the axis:** scheduled Bun-1.4.0 lane with a written "credentialed" bar (#1147, #1158)
   — moves verified-once → credentialed. The v1.0 verified-adapter claim rests on this.
4. **Maintainer reconciles** `architecture.md §4` + `CLAUDE.md §3` **and** the downstream Accepted
   ADRs — **ADR-0042** (default runtime → now bun-standalone), **ADR-0048** (was vinext-ONLY →
   superseded, vinext is an option), **ADR-0051/0050/0036** — so nothing contradicts this ADR.
   *(#1149, #1151)*
5. **vinext stays a supported option** (founder-directed) — its lane stays live (not deleted), and
   the 84-file 16.3.x residue (#1148) is worked at option-priority, not v1.0-critical.
6. **CLI `build` surface:** add the bun-standalone(+exec) target to `kn-next.config.ts` `build` and
   the validator; keep `vinext` accepted. *(new issue; public-API trigger)*
7. **Reopen bar** (#1154): record in this ADR what measurement reopens the decision — e.g. a
   sustained compat regression on the chosen axis, or the spike disproving the compile.
5. Price the N-target cost / reaffirm the shared `RuntimeContract` (#1152); add the reopen bar (#1154).
6. If vinext is demoted, re-scope the replacement compat bar (PR #1137) to the chosen axis.

**Gate review record:** `.claude/close-verdict-architect.md`, `.claude/close-verdict-sysdesigner.md`.
