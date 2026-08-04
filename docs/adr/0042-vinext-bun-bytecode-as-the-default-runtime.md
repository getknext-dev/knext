# ADR-0042: vinext + Bun `--compile --bytecode` as the default runtime

- **Status:** **Accepted (2026-08-04) — founder decision.** The direction *and* the default flip are
  accepted. Delivery is phased (below); the flip itself lands at Phase 5 and is gated on the exit
  criteria there, not on this ADR alone.
- **Amends:** **ADR-0036** — its `Status` line, its close-out verdict *"Rejected for 1.0 (measured)"*,
  and its clause *"What is explicitly NOT authorised: making `bun-exec` the default."* It does **not**
  supersede ADR-0036: that document remains the load-bearing engineering record — the `RuntimeContract`
  enumeration, the opaque-binary supply-chain rule, the one-CRD invariant, and the two benchmark runs
  that argued *against* this decision. Superseding it would retire exactly the evidence that must stay
  visible.
- **Depends on:** ADR-0001 (operator = single source of truth), ADR-0007 (the official-suite gate),
  ADR-0017 (`v1alpha1` additive-only), ADR-0035 (baked compile cache), ADR-0037 (image caching),
  ADR-0040 (CR field validation pattern).
- **Requires amendment of (Phase 5, not now):** `.claude/rules/architecture.md` §4 and `CLAUDE.md`
  §3/§10, which currently make the official Next.js Deployment Adapter API the default and only
  all-apps-verified path.

## Context

### The decision, and the reasoning that makes it coherent

The founder decided on 2026-08-04: **go with vinext on bun-exec bytecode, as the default.** Asked
whether `--compile` was required given bun contributes only ~13% of the measured boot gap, the answer
was explicit:

> *"the compile is required because the bytecode is mandatory — the only reason vinext looks good is
> it's compatible with bun bytecode compile, which gives us a great cold start performance."*

**That reframes the whole trade, and the earlier analysis was answering the wrong question.** The
"bun is only 13%" figure came from decomposing ADR-0036 Run 13: Next standalone ~852 ms → `node +
vinext` ~317 ms → bun-compiled ~237 ms. It measured bun's marginal contribution *given* vinext. But
`node + vinext` was never a candidate: bytecode is the objective, and vinext is the **enabler** — the
only build shape that feeds `bun build --compile --bytecode`. Judged as "which runtime is fastest",
vinext's own boot win is the headline; judged as "how do we ship bytecode", vinext is a means and
`--compile` is the end.

Recorded because the distinction will not be obvious to a later reader: **`node + vinext` is NOT a
supported cell under this ADR.** It carries most of vinext's boot win, and it is still rejected,
because it produces no bytecode.

### What the motive is NOT

Map #605 was opened on a different premise — *"the nextjs build is heavier and vercel specific"* — and
#607 **refuted it by measurement**: at capability parity a Turbopack standalone build is 28.36 MB
against vinext's 37.14 MB (**vinext is 31% larger**); Next ships **zero** `@vercel/*` runtime packages
while vinext ships `@vercel/og` and its 14.50 MB stack **unconditionally** (39% of its artifact). This
ADR does not rest on build weight, and no future argument for it should cite that premise.

### The evidence against this decision, carried in full

A decision record that hides the disconfirming measurement is worthless.

**ADR-0036 Run 26** (arms interleaved ABBA, 12 pairs — the only admissible A/B to date):

| | node (baked compile cache) | bun-exec (compiled, bytecode) |
|---|---:|---:|
| p50 cold start | **2.52 s** | **2.30 s** |
| paired median (node − bun) | +0.07 s | |
| sign split | 7 / 5 | |
| ranges | **overlapping end to end**; neither arm sub-1s | |

**Run 24** — the apparent 4.5× win — is **withdrawn**: its signal was mode mixture, a ~10.5 s regime
switching on mid-run. Its ~470 ms fast-mode advantage did not reproduce; the sign reversed.

**The dominant cold-start risk is not the runtime.** That ~10.5 s regime is **cluster-level**: Run 26
saw it switch on in both arms within one pair. A build target moving the fast mode by 0.07 s buys
nothing against a 4× effect. This is ADR-0037 territory and is a **precondition** on any future
end-to-end number from that cluster.

**ADR-0036's own counter-argument, also carried:** the Run 26 A/B has a real comparability defect — the
arms **served different applications**, and the measured endpoint was the service root where they
differ. The node arm was the *simpler* page, so the bias plausibly favoured node, and a fair rerun
could move toward bun-exec. ADR-0036 earned only the narrow claim: *no separated win between these two
apps*.

**The re-open trigger did not fire.** ADR-0036 named a falsifiable trigger (same app by digest,
endpoint recorded, ABBA-interleaved, build-flag provenance tied to the deployed digest, stratified by
mode, and then distribution separation). No such run exists. This ADR is re-opened by **founder
direction**, not by the trigger — recorded so the trigger stays meaningful.

### What the bridge verification established (2026-08-04)

Branch `spike/vinext-bun-bridge-verification`; findings in
`scratchpad/vinext-bun-bridge-verification-2026-08-04.md`.

ADR-0036 named the `vinext → bun --compile` bridge as the **NO-GO trigger**. It does not fire:

- **The bridge works end to end** — `vinext build` (nitro **bun** preset, *not* the node preset
  ADR-0036 describes) → `bun build --compile --minify --bytecode --target=bun-linux-x64-musl`. Verified
  from a clean directory with only the binary + `.output/public` (`.output/server` asserted absent):
  SSR, route handler, dynamic routes, correct 404, auth-gated `POST /api/cache/invalidate` (401 without
  token / 200 with), and `:9091/metrics`.
- **Image 109,060,359 B (109 MB)** — ADR-0036's 90–110 MB range **confirmed**; binary 100,544,401 B.
- **Container cold start p50 241.9 ms** (n=12, arm64, range 220–279); the binary's own boot p50 26.7 ms.
- **Not an A/B.** One machine, one app, no node arm, no interleaving. It must not be cited as one. The
  ~10.5 s tail did not reproduce locally, consistent with it being cluster-level.

**Three findings that correct this ADR's predecessors:**

1. **`FROM alpine` + the binary alone DOES NOT RUN.** The `-musl` targets are **not statically
   linked**: missing `libstdc++.so.6` / `libgcc_s.so.1`, ~30 relocation errors, **exit 127**.
   ADR-0036's image row is wrong as written; the image needs `apk add libstdc++ libgcc`. Never caught
   because prior validation always ran where those already existed.
2. **`vinext@1.0.0-beta.4` + Vite 8 IS self-contained**, contradicting `examples/bun-exec`'s README.
   That claim is true of **beta.2**, not beta.4 — so the `nitro@3.0.1-alpha.2` / `vinext@^0.0.19`
   dead-end pin is probably no longer needed.
3. **Upgrading vinext is a toolchain migration, not a bump** — beta.4 fails on Vite 7
   (`does not provide an export named 'parseSync'`), requires **Vite 8**, and drops `nitro` entirely.

Nothing broke that was hypothesised to: no native-module, dynamic-require, `node:` builtin, or
top-level-await failure.

### The dependency being adopted

From #606, sourced to vinext's own repo and registry data:

- **Conformance is real:** vinext runs `vercel/next.js`'s own e2e deploy corpus nightly —
  **93.3% overall / 97.4% on the in-scope subset**, 799 files, vs Next v16.2.6. Caveat: the 97.4% comes
  from a hand-maintained exclusion map applied **at read time**, so reclassification moves the headline
  retroactively. **93.3% is the tamper-resistant figure.**
- **Not an adapter implementation.** No `NextAdapter` / `adapterPath` / `onBuildComplete` in vinext's
  source. vinext and the official adapter are **alternative strategies, not layers**.
- **No stability promise.** "beta" is a version-string label: no stability section, no support policy,
  no 1.0 exit criteria. **Zero** breaking-change changelog entries *despite* `1.0.0-beta.0` hard-requiring
  Vite 8 — so the changelog cannot be used to assess upgrade risk.
- **Concentration:** 72% of 90-day commits from two authors; 155 open issues, including 25
  `adapter-api-e2e` issues filed from Next.js deploy-suite CI failures in May 2026, still open.
- **The project recommends its competitor for the mature case:** *"If you need a mature, well-tested way
  to run Next.js outside Vercel, OpenNext is the safer choice."*
- **Hard peers become user-app migration burden:** Vite 8, React 19.2.6, ESM.

## Decision

1. **Adopt vinext + `bun build --compile --bytecode` as knext's default runtime**, on the cold-start
   motive, with **bytecode as the mandatory objective**.
2. **`--compile` is required.** `node + vinext` is explicitly **not** a supported cell: it produces no
   bytecode, which is the point of the change.
3. **One config surface, one CRD, one operator, one `RuntimeContract`** — unchanged from ADR-0036. If
   the vinext path ever needs its own CRD, operator, or config, **this decision is invalid at that
   point**.
4. **The official Next.js compat *corpus* is retained as the gate, run against vinext.** Adopting
   vinext costs the **adapter API**, not the **corpus** — vinext itself drives that corpus, so a
   `KNEXT_BUILD=vinext` lane in knext's own harness keeps red-on-fail falsifiability against *knext's*
   artifact. This is the single most consequential finding in this ADR and it is what makes the
   credibility loss bounded rather than total.
5. **The default flip lands at Phase 5**, gated on its exit criteria. Phases 0–4 are authorised now.

## Consequences

**Structural capability losses — consequences, not footnotes.**

1. **`next/image` optimization is LOST.** vinext auto-stubs `sharp`; request-time optimisation exists
   only via a Cloudflare Images binding, which does not exist on Knative. Measured (#607 §5):
   `/_next/image` returns **200 `image/png`, 181,277 B — byte-for-byte the source**, against Next's
   **1,609 B `image/avif` (112× reduction)**. ADR-0006 declares image optimisation shipped and required.
   **Because `node + vinext` is not a supported cell and bytecode is mandatory, the usual escape —
   "image apps fall back to node" — means falling back to the *old* default entirely.** This is the
   sharpest open question and is escalated below.
2. **Build-time static generation was not observed.** #607 §5 measured **0 prerendered HTML files** from
   the vinext arm vs Next's **15 routes / 14 HTML files**. vinext documents `generateStaticParams` as
   supported, so this is **not established** as a defect versus a configuration gap — but for a
   scale-to-zero product, prerendered HTML is precisely what makes a cold path cheap. Resolve in Phase 3.
3. **Dev React observed in a production server** — #607 saw the vinext production standalone server
   loading `react/cjs/react.development.js`. If it reproduces, it is a shipping blocker on its own.
4. **knext's webpack/turbopack adapter hooks do not apply.** vinext is Vite/rolldown and **silently
   ignores** `adapterPath` (#607 measured **0** references in the vinext output). The `RuntimeContract`
   must be re-provided by a **bespoke knext bun entry** wrapping vinext's handler, delegating to nitro's
   **real** request handler (not `useNitroApp().fetch`, which does not route — #460).
   `examples/bun-exec` is the working reference, including its load-bearing metrics-stopped-last drain
   ordering (now guarded — #448/#649).
5. **The bun compat lane has never been green** — 4 of 4 scheduled runs red, **deterministically**:
   identical shards, files and failure counts every run. Two documented mechanisms, one of which
   (edge-sandbox outbound `fetch()` never resolving) **persists on Bun canary 1.4.0**, so it is not
   version-gated.
6. **Supply chain: a `bun --compile` binary is opaque to Trivy and syft.** ADR-0036's rule is carried
   forward as **binding**: SBOM generated from the **pre-compile dependency closure**, attached as a
   cosign attestation; HIGH/CRITICAL scan against that closure; cosign signing and digest pinning
   unchanged.
7. **Upstream posture inverts.** The official adapter moves *with* Next.js. vinext is a reimplementation
   whose drift becomes **knext's problem**, with no stability promise and hard peers that propagate into
   **users' applications**.
8. **Verified-adapter status is forfeited as an *adapter* credential** at the flip. `CLAUDE.md` §2 calls
   it the north-star credibility lever. Retaining the corpus (Decision 4) preserves falsifiability but
   not the credential.
9. **The image needs `apk add libstdc++ libgcc`** — the musl targets are not statically linked.
10. **Nothing is removed by this decision.** `examples/bun-exec` stays, the node path stays until
    Phase 6 decides its fate, ADR-0035's baked compile cache stays.

## Phased plan

Ordered by risk retired per unit of work. Phases 2 and 3 run concurrently with 1 — both are cheap and
either can invalidate the flip.

**Phase 0 — bridge proof. DONE (2026-08-04).** See above. NO-GO trigger did not fire. Residual: reproduce
self-containment on **current** vinext (beta.4 + Vite 8) rather than the `^0.0.19` pin, since pinning to
abandoned pre-releases is not a shipping posture. The spike indicates beta.4 *is* self-contained.

**Phase 1 — measure the axis. (Reversible.)** Two arms: `node+turbopack` (control) and
`bun+vinext-compiled`. **Precondition:** ADR-0037 image prewarm in place — now proven on OKE to remove a
median **2293 ms** and a 75th-percentile **3.9 s** (#471), and the ~10.5 s tail otherwise controlled.
While that tail fires, no end-to-end number from that cluster is admissible.
**Exit:** a run satisfying all five ADR-0036 re-open conditions, showing **distribution separation**.

**Phase 2 — stand up the compat bar BEFORE any user-visible claim. (Reversible — additive CI.)** Build the
`KNEXT_BUILD=vinext` lane per Decision 4. **Exit:** red-on-fail; a first recorded result; an exclusion set
where every entry carries observed run IDs, mechanism and upstream provenance, **pinned per run** — never
a read-time-applied classification like vinext's own; `docs/compat-matrix.md` updated with the delta.

**Phase 3 — resolve the capability blockers. (Reversible — produces findings.)** **Exit:** (a) image
optimisation — a working path under vinext on Knative, or an accepted documented regression with a
fail-closed rule the CLI and operator both enforce; (b) build-time static generation — works, or the loss
is measured and accepted; (c) the dev-React observation reproduced or refuted. **This phase is most likely
to invalidate the flip. Run it early.**

**Phase 4 — surface. (Partially irreversible.)** Additive `build: turbopack | vinext` enum on
`kn-next.config.ts` and `NextAppSpec`, validated per ADR-0040 (spec precondition inside
`ValidateNextAppSpec`, reusing the single existing inline branch — the count guard enforces exactly one),
mirrored in the CLI. **Exit:** `build: vinext` deployable opt-in; one CRD, one operator, one
`RuntimeContract` with exactly two implementations; `sigterm-drain-e2e` and `sigterm-hardcap-e2e`
parameterised over both images.
**Irreversibility:** a shipped `v1alpha1` field cannot be removed (ADR-0017 §2.1), only deprecated and
ignored. First step that cannot be fully unwound.

**Phase 5 — the default flip. (Irreversible in practice.)** Exit: Phase 1 separation shown; Phase 2 lane
green or honestly scoped; Phase 3 resolved; `architecture.md` §4 and `CLAUDE.md` §3/§10 amended; breaking
change in release notes; upgrade order **operator/CRD first, then CLI**.

**Phase 6 — decide the node track's fate.** Only after Phase 5 has data.

## What must NOT be done

- **Do not rewrite the runtime twice.** Exactly **two** `RuntimeContract` implementations. A third is a
  **STOP**.
- **One CRD, one operator, one config surface** — ADR-0036, verbatim.
- **Do not narrow `v1alpha1` in place** (ADR-0017 §2.1), including via a CEL rule that rejects a
  previously-valid stored CR — that is a narrowing *in effect*.
- **Do not flip the default silently, per-app implicitly, or as a side effect of Phase 4.**
- **Do not ship an opaque compiled binary without** the pre-compile-closure SBOM, the HIGH/CRITICAL scan
  against it, and the cosign attestation.
- **Do not pin `nitro@3.0.1-alpha.2` / `vinext@^0.0.19` as shipping dependencies.** Phase 0 reference
  points, not a product.
- **Do not cite #607's macOS boot numbers, ADR-0036's Run 24, or the Phase 0 spike's 241.9 ms as
  cold-start A/B evidence.** #607 §8 disclaims transferability; Run 24 is withdrawn; the spike is not an A/B.
- **Do not claim "passes the official compatibility suite"** once the corpus is reduced. Name the delta.
- **Do not pull deferred scope along** — gRPC/`BackendService` (ADR-0002/0004) and zones/PWA/MFE stay
  design-now-build-later.

## Escalated — still needs the founder

1. **What happens to `next/image` apps?** Measured loss is 112×. With `node + vinext` excluded and
   bytecode mandatory, the options are: (a) accept the regression, reversing ADR-0006 for the default
   path; (b) keep the **node + turbopack** track alive for image apps — which makes dual-track permanent
   and is the only option that preserves ADR-0006; (c) build a knext-owned optimiser — new scope, and the
   closest thing here to PaaS drift. **This is the sharpest open question.**
2. **Is losing build-time static generation acceptable**, if Phase 3 finds it is a real loss? For a
   scale-to-zero product this may matter more than images.
3. **Is being downstream of vinext acceptable on these terms** — beta, no stability promise, two-author
   concentration, zero labelled breaking changes despite a breaking Vite 8 bump, a project that
   recommends OpenNext for mature use, and peers that become *users'* migration burden?
4. **Does 1.0 ship on this?** `docs/V1_ROADMAP.md` does not commit the `bun-exec` target; making it the
   default changes what 1.0 is.
5. **What happens to the official node compat lane** — completed for the credential, paused, or
   abandoned? Note the streak reset to 1 on 2026-08-03 and that run's log has expired, so its cause is
   unrecoverable.

## Action items

- **A1** Reproduce self-containment on current vinext + Vite 8 (Phase 0 residual).
- **A2** Two-arm OKE A/B under the five admissibility conditions. Precondition: ADR-0037 prewarm.
- **A3** `KNEXT_BUILD=vinext` lane, red-on-fail, evidence-carrying exclusions, compat-matrix delta.
- **A4** Resolve image optimisation, static generation, dev-React (feeds Escalation 1 and 2).
- **A5** Additive `build` field per ADR-0040; both drain e2e gates parameterised.
- **A6** Record vinext's licence, maintenance posture, and abandonment exit stance.
- **A7** Amend `architecture.md` §4 and `CLAUDE.md` §3/§10 — **gated on Phase 5**.
- **A8** Name an owner for vinext upstream health.
- **A9** Add `apk add libstdc++ libgcc` to the compiled image, with a test that the binary runs from a
  clean alpine.
