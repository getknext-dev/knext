# ADR-0036: Optional vinext + Bun single-executable build target

- **Status:** **Rejected for 1.0 (measured)** — 2026-07-28. Proposed 2026-07-20 (founder-directed);
  node/turbopack was and remains the default. See the close-out at the bottom of this file for the
  measurements, what they do and do not establish, and the **named re-open trigger**.
- **Supersedes (in part):** the blanket "vinext/`bun --compile` path is deprecated" stance in
  `.claude/rules/architecture.md` §4 and `CLAUDE.md` §3 — narrowly, for a *compiled build target*,
  not a return to hand-rolling a Nitro runtime.
- **Relates to:** ADR-0035 (baked compile cache, the node path's own cold-start fix),
  the runtime decision recorded in memory `knext-runtime-decision-coldstart` (2026-06-20).

## Context

### The measured wall
Cold-start decomposition on OKE this session (benchmark `docs/benchmarks/scale-to-zero-oke.md`,
runs 8–12) attributed the node/official-adapter path's warm-cache boot:

| segment | median | owner |
|---|---|---|
| node process floor | ~75 ms | node |
| **Next.js `standalone/server.js` own boot** | **~1957 ms (≈70%)** | **upstream — knext cannot cross it** |
| knext supervisor (bundle load) | ~847 ms | knext (#441/#443) |

Even after ADR-0035 (baked `NODE_COMPILE_CACHE`, −393 ms) and #443 (supervisor deferral, chasing
~790 ms), the node path has a **hard floor ≈ Next's own server boot (~2 s)**. knext cannot optimise
below it without upstream changes.

### Why the June "keep Node" decision does not refute this
Memory `knext-runtime-decision-coldstart` recorded "Bun ≈ Node cold start, keep Node." That bench —
and the existing `spec.runtime: bun` knob (`nextapp_types.go:105`) and the `runtime=bun` path in
`packages/kn-next/src/cli/build.ts` — compare node vs bun **both running the same Next.js
`standalone/server.js`**. They tie because both boot Next's server. That is a *different thing* from a
**vinext build compiled to a Bun `--compile --bytecode` single executable**, which does not boot Next's
standalone server at all and is therefore not subject to the ~1957 ms. The founder's prior experience
(vinext + `bun --bytecode` single executable on a ~5 MB alpine image, "amazing" cold start) is this
second path. So the ask is genuinely new territory, not a re-run of a settled comparison.

### P1 feasibility spike findings (2026-07-20 — corrects earlier assumptions in this ADR)
A feasibility spike (`scratchpad/vinext-bun-feasibility.md`) returned **CONDITIONAL-GO**:
- **Core premise CONFIRMED:** `bun build --compile --bytecode` works and cross-compiles to
  `linux-x64-musl` / `linux-arm64-musl`; a trivial compiled app boots in **~2–4 ms** — i.e. it does
  bypass Next's ~1957 ms server boot. This is the whole reason to do it, and it holds.
- **The ADR's build pipeline is NOT a native path.** vinext (currently **1.0.0-beta.2**) emits only
  Cloudflare Workers + Nitro presets — it has **no bun/single-executable output**. The only bridge is
  `vinext (Nitro node preset) → .output/server/index.mjs → bun build --compile`, which is **unproven**.
  **This is the #1 risk P1 must retire before anything else.** If that bridge can't produce a running
  binary, that is the NO-GO trigger.
- **`next/image` optimization is LOST under vinext** (it auto-stubs `sharp` in prod) — so apps that use
  optimized images (ADR-0006) are **`bun-exec`-ineligible and fall back to `node`**, caught by the
  compat gate. This narrows `bun-exec`'s addressable app set.
- **The knext webpack adapter hooks don't apply** — vinext is Vite/rolldown and ignores
  webpack/turbopack config, `adapterPath`, and the `next build --webpack` pin. The `RuntimeContract`
  must be re-provided by a **bespoke knext bun entry** wrapping vinext's handler (net-new work).
- **`file-manager` is a poor FIRST target** (uses `sharp`; relies on adapter hooks). P1 proves the
  pipeline + bun entry on a **minimal App-Router sample** (no sharp, no adapter hooks) first;
  `file-manager` may simply be a fallback-to-node app under this ADR's own rule.

### State of the world in-repo (grounding)
- vinext is **not** a dependency today (no `packages/vinext`, no reference in manifests). Adding it is
  part of this work. The `migrate-to-vinext` skill provides the migration tooling.
- `kn-next build` exists (`build.ts`) with a `runtime=bun` branch — the run-Next-standalone-under-bun
  path, **not** vinext-compile. Target B below is additive to it, not a replacement.

## Decision

Support an **optional** build target that produces a Bun `--compile --bytecode` single executable from
a **vinext** build, shipped in a minimal alpine image — while **keeping node/turbopack as the default
and only verified-for-all-apps target**. One `kn-next.config.ts`, one `NextApp` CRD, one operator, one
runtime contract. The targets differ ONLY at the build+image layer.

| | Target `node` (default) | Target `bun-exec` (opt-in) |
|---|---|---|
| build | turbopack / `next build` → `.next/standalone` | `vinext build` |
| compile | — | `bun build --compile --bytecode --target=bun-linux-<arch>-musl` |
| image | multi-stage alpine, node runtime + baked compile cache (ADR-0035) | `FROM alpine` + the single binary (**~90–110 MB** — `bun --compile` embeds the ~57 MB Bun runtime; the "5 MB" idea is wrong, corrected by the P1 spike) |
| runtime process | supervisor spawns `server.js`; `:9091` metrics in the supervisor | the binary IS the server (no Next standalone, no spawn); `:9091` served **in-process** at listen-time |
| verification | official compat suite (shipped) | official compat suite against the bun image (gate) |

## Amendment (2026-07-22, founder-directed): build and runtime are DECOUPLED axes

The original decision above framed two *coupled* targets (`node`=turbopack, `bun-exec`=vinext). This
is refined: **the build system and the runtime are independent user choices.** The user picks a
**build** and a **runtime** separately; the model is a build×runtime matrix, not a single target flag.

**Two config axes** (both on `kn-next.config.ts` and the `NextApp` CRD):
- **`build: turbopack | vinext`** — `turbopack` = Next's own `next build` (turbopack/webpack) →
  `.next/standalone`; `vinext` = the Vite/rolldown Next reimplementation → nitro `.output`.
- **`runtime: node | bun`**.

> **State correction (2026-08-30) — this section is a SPECIFICATION, and three of its state
> claims were being read as descriptions of shipped behaviour.** Two readings came straight from
> here and both were wrong, which is why the correction sits at the top of the section rather than
> in a footnote. Measured against `main`:
>
> | claimed below | actual state of `main` |
> |---|---|
> | `bun ⇒ vinext` "enforced fail-closed by CEL admission on the CRD" | **Never implemented, and now deliberately abandoned.** No CEL rule constrains `build` against `runtime`; `nextapp_types.go` states the reason — the two axes are connected by the artifact *shape* a builder emits and a runtime must accept, never by a rule pairing the two names, and encoding compatibility in the CRD would pin a policy into every cluster where changing it needs a CRD roll rather than a CLI release. |
> | `bun` + `turbopack` is **rejected** | **It is the shipped meaning of `runtime: bun`** — "run the Next standalone server under Bun". The rule specified below would have rejected the combination knext actually ships. |
> | the `build` axis exists on `kn-next.config.ts` and the CRD | **True as of ADR-0048** (`config.ts:290`, `nextapp_types.go:158`), and it was not when this ADR was written. ~~The CRD enum admits only `turbopack`; the CLI type knows `vinext`. That gap is intentional and its reasoning is in `nextapp_types.go`.~~ **Gap closed 2026-09-03 (ADR-0048 Amendment 3):** the enum admits `turbopack;vinext` and the operator reconciles the single-exec shape (image CMD, no forced command). |
>
> The decision below is not being rewritten — it may still be the right one. What is corrected is
> the tense: read the table as *what was specified*, and the operator's field comments as *what
> is*.

**Valid combinations (3) — the sole invariant is `bun ⇒ vinext`:**

| | build: `turbopack` (Next) | build: `vinext` |
|---|---|---|
| **runtime: `node`** | ✅ **node+turbopack** — today's default: `.next/standalone` + the supervisor spawns `server.js` | ✅ **node+vinext** — vinext → nitro **`node-server`** preset; run `node .output/server/index.mjs` |
| **runtime: `bun`** | ❌ **rejected** — turbopack's Next-standalone output is not the bun single-exec path | ✅ **bun+vinext** — vinext → nitro **`bun`** preset → `bun --compile --bytecode` single executable |

- **turbopack is node-only** (its `.next/standalone` output runs under node).
- **vinext runs on either runtime** — nitro `node-server` preset for node, nitro `bun` preset + `--compile` for bun.
- **bun requires vinext** — enforced fail-closed by CEL admission on the CRD (reject `runtime: bun` +
  `build: turbopack`) and mirrored by the CLI validator, per the validate-at-admission pattern (#435/#454).
- **Default is unchanged:** `build: turbopack, runtime: node` — the only all-apps-verified path. The
  other two cells are opt-in and compat-gated exactly as the original decision states.
- **Retires the pre-existing `runtime: bun` + Next-standalone combo.** The original ADR listed
  "`runtime: bun` (existing: Next standalone under bun)" as an additive option. Under `bun ⇒ vinext`
  that combo (bun + turbopack) is now **rejected** — bun requires a vinext build. The implementation
  PR must call out this breaking change: the new CEL rule fails such a CR at `kubectl apply`, and the
  operator's handling of any pre-existing stored `runtime: bun`+standalone CR (reject-with-guidance
  via `computeStatusVerdict`, not panic) must be specified. Acceptable at `v1alpha1` (ADR-0017); that
  combo was measured to only tie node, not win.
  **Amended by ADR-0040 (2026-08-04):** "not panic" stands; "via `computeStatusVerdict`" does not.
  That rejection is a **spec precondition** — decidable from the spec alone, before any child state
  is observed — so it belongs in `validation.ValidateNextAppSpec` and surfaces through the single
  pre-existing inline branch, not as a new verdict input. See ADR-0040 §"Where the code goes".

**RuntimeContract applies to all three cells, via exactly TWO implementations:**
- **turbopack → the supervisor** (node+turbopack, today): supervisor spawns `server.js`, `:9091` in the supervisor.
- **vinext → one shared in-process entry** (both node+vinext and bun+vinext): the vinext `.output`
  server runs *directly* (node+vinext: `node .output/server/index.mjs`; bun+vinext: the `--compile`d
  binary), with `:9091` served **in-process** — **node+vinext does NOT use the turbopack supervisor.**
  This keeps a single RuntimeContract entry across both vinext cells (minimal drift, per the
  "one everything-else" principle). That entry must delegate to nitro's **real request handler** — not
  `useNitroApp().fetch` (see #460: that does not route) — so the entry-routing bug affects **both**
  vinext cells, not just bun, and fixing it once serves both.

**#460 reframed:** the *self-containment* half of #460 is specific to the **bun+vinext** cell — only it
uses `bun --compile`, and only the older nitro/vinext versions bundle the server into the binary
(measured: alpha bundles → self-contained; the recipe's newer betas emit a runtime-chunked layout that
`--compile` can't embed). node+vinext runs the `.output` tree under node and needs no embedding. The
RuntimeContract-entry routing bug is shared by both vinext cells.

## Options considered

| Option | Cold start vs ~2s node floor | Maintenance | Compat risk | Verdict |
|---|---|---|---|---|
| Node-only, keep optimising (#443, warm floors) | bounded by ~1957 ms Next boot | lowest | none | keep as default, not sufficient alone |
| `runtime: bun` (existing: Next standalone under bun) | ~ties node (same server boot) | low | low | already exists; not the win |
| **vinext → bun `--compile --bytecode` single-exec** | **potentially bypasses the 1957 ms** | **higher (vinext fidelity + a 2nd runtime contract impl)** | **higher (vinext feature coverage)** | **chosen, OPT-IN, compat-gated, measure-first** |
| Rewrite a bespoke Nitro-style runtime | unknown | highest — the exact thing prior ADRs forbid | high | rejected |

## Consequences

- **Two build targets, one everything-else.** The cost the old "don't rewrite the runtime twice" rule
  feared is capped by forcing both targets through a single `RuntimeContract` and one CRD/operator.
  **If `bun-exec` ever needs its own CRD/operator/config, that is a STOP signal** — the decision is
  invalid at that point.
- **`RuntimeContract` — full enumeration (both targets MUST satisfy all of it).** Under-specifying
  this is how the two targets silently drift; this session already saw deferring the `:9091` listen
  break `sigterm-drain-e2e`. The contract:
  1. **Health:** shallow `/api/health` (no PG/Redis dial, ADR-0026); deep health where applicable.
  2. **Metrics:** Prometheus on **`:9091`, served in-process at listen-time** (node: in the supervisor;
     bun-exec: in the binary) — bound early so a scrape while the runtime is up is answered.
  3. **Graceful shutdown on SIGTERM:** drain in-flight requests **and run Next.js `after()` callbacks**
     before exit (security.md / graceful-shutdown rule), within the grace cap.
  4. **Redis ISR/data-cache handler** wiring (`cache-handler.js` equivalent) — present and functional.
  5. **Bearer-authenticated, fail-closed mutating routes** `POST /api/cache/invalidate` and
     `DELETE /api/cache/events` (`CACHE_INVALIDATE_TOKEN`) — **dropping or unauthenticating these in the
     bun binary is a security.md hard-rule violation (no unauthenticated mutating endpoints).**
  6. Operator env-injection contract (DATABASE_URL, cache, HOSTNAME/PORT, etc.).
  7. **ADR-0027 module-state seam:** state the bun-exec equivalent of the `globalThis`
     `Symbol.for('knext.lib.*')` seam + the standalone-seam-alive guard, or an explicit N/A with reason.
  P2 extracts this contract; CI's `sigterm-drain-e2e` / `sigterm-hardcap-e2e` gates are parameterised
  over BOTH images, and a compat/contract check asserts routes 1–6 on the bun image.
- **Supply chain — a `bun --compile` binary is OPAQUE to Trivy/syft.** Scanning the shipped image goes
  blind, defeating security.md's SBOM-per-image + fail-on-HIGH gate. Therefore for `bun-exec`: the
  **SBOM is generated from the lockfile / pre-compile dependency closure** and attached as a **cosign
  attestation**; the **HIGH/CRITICAL scan runs against that pre-compile closure**, not the compiled
  binary; **cosign image signing + digest pinning apply unchanged**. Record this as a build-pipeline
  requirement, not an afterthought.
- **vinext fidelity bounds honesty.** vinext is a separate Vite-based reimplementation; not every Next
  feature is covered. `bun-exec` is only offered for apps that pass the **official compat suite** on the
  bun image. An app that fails compat on `bun-exec` **falls back to `node`** — same north-star bar as
  today. This is an explicit opt-in per app, never a silent default flip.
- **Default unchanged.** `node`/turbopack stays the default and the only path assumed to work for every
  app. No existing deployment changes. `bun-exec` is selected explicitly.
- **New external dependency (vinext) + Bun cross-compile/musl surface** (`sharp`/native deps for
  next/image must work under bun+musl or be excluded from the bun-exec target). Both are real risks the
  spike must retire.
- **The whole case rests on one measurement.** If the P1 OKE A/B does not show `bun-exec` decisively
  beating the ~2 s node floor **with distribution separation** (the bar this project adopted after two
  burst-knob conclusions failed to reproduce), the target is not shipped — the ADR is then recorded as
  "measured, did not deliver," and node-only stands.

## Action items (phased; measure gates the build)

- **P0** — this ADR (founder approves the vinext-deprecation amendment; done by acceptance).
- **P1a — retire the pipeline risk FIRST (feasibility done → build-through next).** On a **minimal
  App-Router sample** (no `sharp`, no adapter hooks), prove `vinext (Nitro node preset) →
  .output/server/index.mjs → bun build --compile --bytecode --target=…-musl` produces a **running
  binary** that serves requests. If it cannot, **NO-GO** — stop and record it.
- **P1b — bun entry + measure.** Add the bespoke bun entry providing the `RuntimeContract` (health;
  `:9091` in-process; SIGTERM drain + `after()`; auth cache routes). Then OKE cold-start A/B
  (`node`-baked vs `bun-exec`) via the alternating-pairs method (run 6), published as a benchmark run.
  **Gate: distribution-separated win, or stop.** Record **vinext's license + maintenance posture +
  abandonment exit stance** (it is currently beta) — a shipping target cannot depend on an unmaintained
  upstream.
- **P3 config decision:** resolve whether `bun-exec` is a new `buildTarget` field or a third
  `spec.runtime` value **in the P3 PR** (architect flagged that `spec.runtime: bun` vs `bun-exec` will
  confuse users — prefer folding into one knob). Amend this ADR in place with the outcome.
- **P2 — `RuntimeContract`.** Extract the full contract (all 7 items above); implement it for the
  bun-exec binary; parameterise CI `sigterm-drain-e2e` / `sigterm-hardcap-e2e` over both images; add a
  contract check asserting the health/metrics/auth-cache routes on the bun image. **Add a startup-order
  test (both targets):** the binary must not accept its first request before the health/`:9091`
  listeners are up — nothing covers readiness-vs-metrics-vs-first-request ordering today.
- **P3 — build pipeline.** `kn-next build --target bun-exec` (or via a new `buildTarget` config field /
  the existing `spec.runtime`); the second Dockerfile (Dockerfiles are hand-maintained, not templated —
  #439 context).
  - **P3 increment 1 (landed, #447):** a self-contained, opt-in recipe under `examples/bun-exec/` proves
    the `vinext → .output/server/index.mjs → bun --compile --bytecode` sequence and the bespoke bun entry
    providing the `RuntimeContract` (health / in-process `:9091` / SIGTERM drain + `after()` / fail-closed
    Bearer cache route). Reproducible in-repo proof **only** — NOT wired into `kn-next build`, the
    operator, the CRD, or CI's main gates, and it cites no cold-start number (the P1b OKE A/B is still the
    gate).
  - **P1b OUTCOME (2026-07-21, #460 — the recipe does not yet produce the self-contained binary it
    targets; this is a fixable recipe-config gap, NOT a bun limitation):** the P1b OKE A/B could not
    run *as currently built*. Deployed as a container (binary only, or binary + `.output/`), this
    recipe's compiled binary serves the framework 404 for *every* route. Root cause is the build
    approach, not `bun --compile`: the recipe uses `nitro({ preset: 'bun' })` and then
    `bun --compile .output/server/index.mjs`, but the **nitro bun preset loads its route/SSR chunks
    dynamically from `.output/` at runtime** (resolving deps like `react-dom` via `createRequire`
    against absolute `.output/` paths), so `--compile` of `index.mjs` embeds only that entry's static
    graph — the routes are not in the binary. It "worked" in #447's RuntimeContract validation, the
    P1a/P2 spikes, and benchmark run 13 only because all three ran the binary **from its build
    directory**, where `.output/` + node_modules resolve. **A truly self-contained single binary IS
    achievable** — the founder previously shipped exactly that (binary only, nothing else) — so the
    fix is to make the build emit a **single fully-bundled server** (e.g. inline the dynamic route
    imports / single-chunk output) so `--compile` embeds everything. Until the recipe produces that
    portable binary (#460), the distribution-separated-win gate is **deferred, not failed**. Node arm
    end-to-end cold start measured at ~2.4s median with an intermittent ~11s tail (benchmark run 16).
  - **P1b UPDATE (2026-07-22, #460 FIXED — the recipe is now self-contained):** two coupled bugs were
    root-caused and fixed in `examples/bun-exec`: (1) the newer beta pins emitted a runtime-chunked
    server — reverted to the founder's proven combo (nitro `3.0.1-alpha.2` / vinext `^0.0.19`) that
    bundles the server so `bun --compile` embeds the routes; (2) overriding nitro's `entry` had dropped
    vinext's route injection AND `useNitroApp().fetch` bypassed nitro's real request pipeline — the
    entry now `import`s `#nitro/virtual/polyfills` first (restores route bundling) and delegates to
    srvx's `serve` (nitro's real handler), keeping in-flight counting / SIGTERM drain / in-process
    `:9091` / fail-closed Bearer auth. **OKE-validated on the linux/musl binary run from a clean dir**
    (only `.output/public` shipped): `/api/health` 200, `/` 200, `:9091/metrics` 200, cache route
    401-without-token / 200-with-token, SIGTERM drain → exit 0. Ship shape corrected: binary +
    `.output/public` (~90–110 MB), not binary-only. **`bun-exec` status: recipe self-contained (#460
    resolved); the P1b distribution-separated-win A/B is now runnable and still PENDING** — no
    cold-start win is claimed until that A/B runs (and the ~600 ms regime also needs image caching).
  - **P1b RECORD CORRECTION (2026-07-26, benchmark Run 24 — a record update, NOT an amendment to this
    decision):**
    1. **Run 17 is SUPERSEDED/CONFOUNDED and must not be cited as the P1b A/B result.** It states both
       arms were deployed "0-CPU-request"; that was false for the node arm, which carried
       `requests.cpu=100m` / `limits.cpu=1` (revision `p1b-node-00002`, created before Run 17 ran), so
       it measured build target and CPU guarantee together on a cluster it itself calls "heavily
       contended". A second confound Run 17 did not state: the arms used **different readiness probes**
       (node `httpGet /api/health`, bun-exec a bare `tcpSocket`) — a tcpSocket probe passes as soon as
       the process binds a listener, while an httpGet additionally requires serving a request, so the
       arms were gated on different definitions of "ready", in bun's favour.
    2. **The "~11 s intermittent tail" is TARGET-INDEPENDENT, not a node-arm property.** The
       attribution above (sourced to run 16) is corrected: Run 24 measured the same tail at the same
       magnitude on the **bun-exec** arm (10.42–10.77 s, sitting inside node's 10.28–11.01 s). This is
       an existence claim, which the sample count supports; no claim is made about the *rate* in each
       arm — Fisher's exact on the mode mix gives p = 0.37, consistent with chance at n=10.
    3. **The P1b gate now has a PRECONDITION:** the tail must be understood or eliminated (ADR-0037
       image-caching / pre-pull territory) before *any* end-to-end cold-start number from this cluster
       can settle it. While the tail fires it swamps any runtime delta — Run 24's arms both span
       ~1.7–11.0 s, so distribution separation is unreachable regardless of build target.
    **`bun-exec` status is unchanged: PENDING.** Run 24 claims no win — its headline p50 delta
    (10.47 s → 2.29 s) is explicitly an artifact of mode mix and is marked not-quotable; the fast-mode
    delta (~470 ms) is provisional pending reproduction.
- **P4 — compat gate.** Official compat suite against the bun image; document supported feature subset +
  fallback-to-node guidance.
- **P5 — docs + benchmark.** User-facing "choosing a build target" page (qualitative); benchmark A/B.

## What is explicitly NOT authorised by this ADR
- Making `bun-exec` the default, or flipping any app to it without explicit opt-in.
- A second CRD, operator, or config surface for the bun path.
- Resurrecting the old vinext epic (#11) wholesale, or a bespoke Nitro runtime.
- Presenting `bun-exec` as faster before the P1 OKE A/B produces a separated result.

---

## Close-out (2026-07-28) — Rejected for 1.0, with a named re-open trigger

This ADR proposed an **opt-in, compat-gated** compiled build target, and made its own ship test
explicit: `bun-exec` ships only if the P1 OKE A/B shows a **distribution-separated win**. Two runs
have now measured it. The bar is not met, so the target does not ship for 1.0.

### What was measured

| run | design | result |
|---|---|---|
| Run 24 | arms **sequential** | node p50 10.47 s vs bun-exec 2.29 s — later **withdrawn** |
| Run 26 | arms **interleaved**, ABBA within pair, 12 complete pairs | node p50 **2.52 s**, bun-exec **2.30 s**; paired median (node − bun) **+0.07 s**; sign split 7/5; ranges overlapping end to end |

Run 24's apparent 4.5× win was an artifact of *when* each arm ran, not what it was: the ~10.5 s slow
mode switched on mid-run. That is also the finding that makes the sequential design invalid here —
a comparison whose signal is mode mixture cannot be read unless the arms were interleaved. Run 24's
provisional ~470 ms bun-exec fast-mode advantage did not reproduce either; the sign reversed, so it
is **withdrawn rather than pending**.

### The reasoning, including the argument against this decision

Three independent reasons, any one sufficient:

- **It cannot address the dominant risk.** The threat to the cold-start claim is the ~10.5 s regime,
  and Run 26 shows it switching on in **both arms within one pair of each other**. It is
  cluster-level, not runtime-level. A build target that moves the fast mode by 0.07 s buys nothing
  against a 4× effect.
- **The cost is structural, not incremental.** A bespoke bun entry re-providing `RuntimeContract`;
  `next/image` optimization is **lost** under vinext, so ADR-0006 apps are `bun-exec`-ineligible and
  fall back to node; and the bun compat lane has never been green. This ADR permits the target only
  as **compat-gated** — it has no green gate, so it is not shippable regardless of any benchmark.
- **An indefinitely-open ADR is an attention tax.** It reappears in every sprint plan and benchmark
  discussion and consumes design-gate time on a target nobody is authorised to ship.

**The strongest argument against rejecting** is recorded here rather than omitted: the A/B has a
real comparability defect — the two arms **served different applications** (`p1b-node` renders a
4000-byte Next document at `/`, `p1b-bunexec` a 1397-byte vinext page; they agree only at
`/api/health`), and the measured endpoint was the service root, where they differ. The node arm was
the *simpler* page, so the bias plausibly favoured node — meaning a fair rerun could move toward
bun-exec. That is a genuine reason for doubt, and it loses only because the three reasons above do
not depend on the delta's sign.

### What is honestly established, and what is not

- **Established:** on these two apps, at this endpoint, interleaved in one sitting, the arms do not
  separate. The measured artifact **was** bytecode-compiled — verified by extracting the binary from
  the deployed digest and fingerprinting it against **version-matched** controls (Bun 1.3.14), so
  this tested the artifact the ADR actually proposes.
- **Not established:** that `bun-exec` cannot win. "No separated win **between these two apps**" is
  weaker than "no separated win", and only the weaker claim is earned.
- Separately confirmed by microbenchmark (Run 13): a vinext build boots far faster than Next
  standalone — ~317 ms on node, ~237 ms compiled, against ~852 ms. **That advantage is real and does
  not survive to end-to-end cold start**, because boot is a small fraction of it. Most of that win is
  vinext, not bun.

### Re-open trigger (falsifiable, not "if someone feels like it")

Re-open this ADR when a benchmark run satisfies **all** of:

1. **same application on both arms**, asserted by image digest, not by inspection;
2. the **requested endpoint recorded** in the run's own write-up;
3. arms **interleaved**, ABBA within pair;
4. **build-flag provenance tied to the deployed digest** (a build label, not forensics);
5. results reported **per sitting and stratified by mode**, never pooled;

and then shows **distribution separation** — not a median difference with overlapping ranges.

Those conditions are the Track D admissibility checklist in `docs/SPRINT_2.md`; the harness work
that makes them cheap to satisfy is tracked as S8 and is worth doing on its own merits, since the
same defects would corrupt any future A/B.

### Consequences

- `examples/bun-exec` **stays as an example**, not a build target. It is a working reference for the
  compiled path and its drain ordering, and it is where the load-bearing metrics-stopped-last
  behaviour is documented.
- The default remains the official Next.js adapter on node. `.claude/rules/architecture.md` §4's
  amendment permitting an opt-in compiled target is unchanged in principle — it is simply not
  exercised for 1.0.
- No runtime code is removed by this decision.
