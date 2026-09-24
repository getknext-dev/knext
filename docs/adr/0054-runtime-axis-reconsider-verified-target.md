# ADR-0054: Reconsider the vinext-only target — adopt a verified 778/0 runtime axis for v1.0

- **Status:** **Accepted (2026-09-22) — founder decision.** (Was Proposed; the sprint-close gates
  reviewed it SIGN-OFF/ISSUES non-blocking, findings folded in.) **Amended** by Amendment 6
  (2026-09-22) and **Amendment 7 (2026-09-23)** — Amendment 7 retires the uncompiled bun-standalone
  fallback below and makes the v1.0 surface the full bytecode-cached cell matrix. **Amendment 7's
  Decision 2 is amended by ADR-0058 (2026-09-24, Proposed):** the six-cell matrix stays the goal,
  and v1.0 credentials four cells (node/bun × turbopack/webpack).
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

> **Superseded by Amendment 7 (2026-09-23):** the uncompiled fallback in this paragraph no longer
> holds. Bytecode caching is mandatory for every supported cell, and the compile now works (#1225),
> so bun-standalone ships only as the compiled `--bytecode` executable. Text kept as history.

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
   - **nft-trace-driven embed (founder-directed, leading candidate).** @vercel/nft already enumerates
     the full runtime file set of a dynamically-loading server — that trace IS the `.next/standalone`
     tree — so drive the embed from it rather than from bun's static analysis: parse the standalone
     tree / `.next/server/**/*.nft.json` into an explicit include set, then emit a generated barrel
     that statically `import`s every traced module (or hand bun the explicit set). This reuses Next's
     own dependency truth and builds on `adapters/standalone-bun-exports.ts`, which already reads and
     heals that trace for the bun path. Preferred if it holds parity.
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
   **→ Superseded by Amendment 7:** the "ship uncompiled" branch is retired; the compiled exec is a
   hard prerequisite, and 778/0 on it is still to be run.
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

## Amendment 6 — the standalone packaging path, and the supervisor as the standalone RuntimeContract (2026-09-22)

Design-gated on issue #1155 (system-designer design + architect co-sign, both ratified). This
Amendment records the **axis-local** consequences of that design; the durable operator↔image
**boundary invariant** it rests on lives in its own document, **[ADR-0055](0055-operator-image-startup-boundary.md)**,
because that invariant governs every target and outlives this axis line (this is the 4th
runtime-axis decision in ~4 months, and this ADR carries its own reopen bar — a durable invariant
does not belong inside a document designed to be superseded).

Two things this ADR left open are now answered:

1. **The "no shipped packaging path yet" gap is closing.** This ADR made bun-standalone the v1.0
   default but consequence-noted that `next build` standalone output had no runtime image in the
   tree (`templates/app/Dockerfile.hbs` is vinext-single-exec only). #1155 authors that image +
   supervisor entrypoint per ADR-0055. **No CRD roll** — bun-standalone is the existing
   `build:turbopack` + `runtime:bun` pair; the `Build` enum (`turbopack;vinext`) and `Runtime` enum
   (`bun;node`) are unchanged, so there is no #548 operator-first hazard.

2. **Multi-target coherence (the "must be decided, not assumed" consequence; #1152) is answered:
   the supervisor (`node-server.ts`) IS the standalone `RuntimeContract` implementation.** It is the
   standalone-target implementation of the same contract `templates/app/runtime-contract.mjs.hbs`
   provides in-process for vinext — one shared contract, three implementations (bun-standalone /
   node-standalone / vinext), not three runtimes. The acceptance suite is written **target-agnostic**
   and run against all three, which is what keeps *"don't rewrite the runtime twice"* true rather
   than merely asserted.

**One honest correction folded in (architect condition C2):** the earlier concern that the
compat-gated `--require` preload silently no-ops under Bun is **falsified** — `bun --require` runs
the preload, and `scripts/e2e-deploy.sh:489` applies it unconditionally for both runtimes, so the
778/0 runs **were** preloaded. The real, narrower gap is that the suite boots the **raw**
`server.js`+preloads, never the `node-server.ts` supervisor this design ships — so 778/0 certifies
the harness boot path, not the supervisor-wrapped entrypoint, on **both** runtimes. Tracked as
**#1172**, closed by the target-agnostic conformance suite above; do **not** swap `--require`→`--preload`.

The bytecode-`--compile` feasibility spike (action item 1) is **independent** of #1155: the image +
supervisor are needed whether the axis ships compiled or uncompiled. ADR-0055 §C6 records that only
the entry-file **shape** differs if the spike succeeds; the invariant holds regardless.

## Amendment 7 — bun-standalone ships compiled; the v1.0 surface is the full bytecode-cached cell matrix (2026-09-23)

- **Status:** Accepted (2026-09-23) — founder decisions recorded on #1218 (the matrix, then the
  mandatory-bytecode addendum). Records a decision already made; it does not reopen the axis.
- **Supersedes, within this ADR:** the Verdict's feasibility-caveat fallback ("ships uncompiled
  bun-standalone … bytecode-exec packaging becomes a fast-follow") and action item 1's "if it does
  not → ship uncompiled bun-standalone as v1.0". Both are kept above, unedited, as the decision
  history; this Amendment is what now holds where they conflict.
- **Relates to:** ADR-0056 (the per-cell credential against a frozen RC ref), ADR-0039 (the frozen
  set), ADR-0055 (the operator↔image boundary the compiled entry sits behind), #1166, #1225.

### Context

This ADR accepted bun-standalone as the v1.0 default *on the condition* that the
`bun build --compile --bytecode` step was proven for Next's standalone output, and wrote an explicit
escape hatch: if the compile could not hold, ship **uncompiled** bun-standalone (`bun server.js`) as
v1.0 and make the bytecode executable a fast-follow. The #1166 spike reached exactly that verdict
several times over, on a wrong diagnosis: that Bun's compiled binary could not resolve bare /
exports-mapped specifiers from Next's disk-loaded server runtime.

Two things changed on 2026-09-23:

1. **The founder widened and hardened the v1.0 bar (#1218).** v1.0 is credentialed on **every
   supported runtime × builder cell** — node/bun × vinext/turbopack/webpack — and **bytecode
   caching is mandatory for every cell**. Bun cells ship as a `bun build --compile --bytecode`
   single executable; node cells ship with the V8 compile cache (`NODE_COMPILE_CACHE`) persisted
   through an image-baked layer or a mounted volume. **A cell without live bytecode caching is not
   a supported cell.** **vinext × node is a supported cell** (the open question on #1218 is closed
   that way). Under this bar the uncompiled fallback stopped satisfying the supported-cell
   definition at all, independently of whether the compile worked.
2. **The compile works (#1225, merged).** The "wall" was not a Bun limitation. A
   `bun build --compile` executable does not read `package.json` at runtime by default, so
   disk-loaded code could not resolve exports-mapped specifiers; `compile.autoloadPackageJson: true`
   restores it. turbopack × bun now builds as a compiled `--bytecode` executable with: a disk
   closure that keeps Next's `*.external` singletons and every module literally required from
   `.next/server/**` on disk (one instance each — this fixed a 500-vs-404 `NoFallbackError` split
   found in review); a **fail-closed** bytecode verifier (the build refuses an executable that was
   not compiled to bytecode, and the CLI re-verifies it); `STANDALONE_SERVER_EXEC` so the ADR-0055
   supervisor spawns the executable, keeping SIGTERM drain, `after()` and `:9464` metrics
   (`standalone-drain` docker e2e 6/6 on linux/amd64).

### Decision

1. **The uncompiled bun-standalone path is retired as a v1.0 ship and is not a supported cell.**
   bun-standalone ships as the compiled `--bytecode` executable (#1225). "A dead end is a success"
   no longer applies to #1166: the compiled executable is a hard prerequisite for every Bun
   standalone cell. The uncompiled `bun server.js` shape may still exist as a harness boot path
   (see "not yet true" below), but nothing may claim it as a supported, shippable or credentialed
   configuration.
2. **The supported v1.0 surface is the full matrix**, each cell with bytecode caching **live** (not
   merely configured) and each credentialed per ADR-0056 — 14 consecutive scheduled credential
   nights on the official suite against a frozen RC tag, per-cell window keyed on the cell's own
   fingerprint:

   | cell | bytecode mechanism | builder exists | status today |
   |---|---|---|---|
   | turbopack × bun | compiled `--bytecode` exec | yes | exec ships (#1225); official suite **not yet run on the exec** |
   | turbopack × node | V8 compile cache | yes | 778/0 verified on the raw `server.js` harness boot; compile cache liveness unasserted (#1221) |
   | vinext × bun | compiled `--bytecode` exec | yes | current default; weekly lane, below node-parity (bar: `docs/compat/bar-vinext-axis.md`) |
   | vinext × node | V8 compile cache | yes | **supported by decision; compile-cache wiring not built** |
   | webpack × bun | compiled `--bytecode` exec | **no** (#1219) | not buildable yet |
   | webpack × node | V8 compile cache | **no** (#1219) | not buildable yet |

3. **The default is unchanged by this Amendment.** This ADR's Verdict makes bun-standalone the v1.0
   default; the code default is still **vinext** (`DEFAULT_BUILDER_ID = "vinext"`,
   `artifact-contract.ts`). The flip (#1183) waits on the credential, as before. The default is one
   credentialed cell among several, not a different bar.

**Trade-off note.** The alternative the founder rejected was to keep the uncompiled escape hatch:
bun-standalone would then have been credentialable today (the raw-`server.js` Bun lane already ran
778/0 twice on Bun 1.4.0), at the cost of a Bun cell with no bytecode caching — i.e. shipping the
Bun axis without the cold-start mechanism that motivated it. Mandatory bytecode buys a uniform
promise ("every supported cell is bytecode-cached, and that is checked") and pays for it in
schedule: the Bun cells' 778/0 evidence was earned on the uncompiled artifact and **does not
transfer** to the compiled one, so their credential restarts from zero on the exec, and one more
artifact shape (the compiled standalone exec) joins the supply-chain surface. The compile also
moves some work onto the disk: `app-page(-turbo).runtime.prod.js` now loads from disk **without**
bytecode to preserve single-instance identity, so the cold-start gain is smaller than a full embed
would give and is not yet measured on a cluster (#1226).

### What is NOT yet true (stated so nobody reads this Amendment as a credential)

- **The official compat suite has not been run on the compiled executable.** The Bun axis of
  `scripts/e2e-deploy.sh` still boots raw `server.js`, so the Bun 778/0 on record certifies the
  uncompiled shape this Amendment retires. The compiled exec's evidence today is compat-smoke 11/11
  on `apps/file-manager`, 18/18 fixture probes and the drain e2e — smoke, not the suite.
  Computed-path requires in Next's server core are only catchable by the suite.
- **The webpack builder does not exist** (#1219), so two of the six cells cannot be built.
- **vinext × node has no compile-cache wiring**, and **no cell has an assertion that bytecode
  caching is live** — the fail-closed verifier checks the Bun executable at build time, not that a
  running pod uses it, and nothing checks node cells at all (#1221). The standalone template's node
  stage bakes no compile cache; node cells rely on the operator-injected `NODE_COMPILE_CACHE`
  consumed by `node-server.ts`.
- **Known follow-ups on the compiled exec:** #1226 (Pages Router require-hook aliasing and custom
  `cacheHandler` files are outside the disk-closure scan; cluster cold-start of the compiled exec vs
  the pre-fix build is unmeasured), #1227 (Bun 1.4.0 compiled executables are SIGKILLed on
  darwin-arm64 for an invalid code signature — local dev on Mac). Not verified on OKE or kind yet.
- **No credential exists for any cell.** ADR-0056's pin is `null`; rc.1 is a founder action gated
  on every cell's prerequisites.
- **Downstream text still encodes the old bar** in maintainer-owned files (`.claude/rules/
  architecture.md §4`, `CLAUDE.md §3`) — listed on the PR that lands this Amendment, not edited by
  it.

### Consequences

- The Bun cells' credential clock starts on the compiled exec, not on the uncompiled evidence. Until
  the Bun credential lane boots the executable, a green Bun night says nothing about what ships.
- #1166 closes on the suite result, not on #1225 alone; its "formal recommendation" deliverable is
  this Amendment.
- Six cells × one shared contract: the N-target cost that #1152 was opened to price is now a
  six-cell matrix (two bytecode mechanisms, three builders), all behind the one `RuntimeContract`
  and operator of Amendment 6 / ADR-0055. #1152 prices it against this table.
- Reopen bar (#1154), extended: this Amendment is reopened if the compiled exec cannot reach 778/0
  on the suite after the disk-closure follow-ups, or if a cell's bytecode mechanism is shown to be
  dead in a running pod and cannot be made live — in either case the founder decides whether that
  cell leaves the supported set; the fallback is **not** silently to ship it uncompiled.

### Action items

1. Point the Bun compat lane (early-warning first, then the Bun credential cron) at the compiled
   executable instead of raw `server.js`; run the official suite on it. *(#1166)*
2. Build the webpack builder on node + bun. *(#1219)*
3. Wire the node compile cache for vinext × node, and assert bytecode caching is **live** in every
   cell's running artifact, fail-closed. *(#1221)*
4. Close the disk-closure blind spots and measure the compiled exec's cluster cold start. *(#1226)*
5. Resolve compiled-exec code signing on darwin-arm64 for local dev. *(#1227)*
6. Wire each remaining cell to a credential cron with a `<runtime>-<builder>` lane id (ADR-0056
   action item); only then is rc.1 cuttable. *(founder: cut rc.1)*
7. Flip `DEFAULT_BUILDER_ID` to bun-standalone once that cell is credentialed. *(#1183)*
8. **Maintainer:** reconcile `.claude/rules/architecture.md §4` and `CLAUDE.md §3` with this
   Amendment (see the PR body for the exact lines).
