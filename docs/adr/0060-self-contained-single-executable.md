# ADR-0060: The self-contained single executable — both compiled shapes, opt-in

- **Status:** **Accepted, pending the sprint-close design gate (2026-09-26).** Records founder
  decisions taken on 2026-09-26 (plan "single-exec dynamic imports, end to end", milestone
  *Self-contained single-exec*, #1450–#1464). Trigger-class (ADR; it names a CLI flag and a config
  key, #1454), so the architect and system designer review it at sprint close per
  `.claude/rules/workflow.md`. It becomes a user-visible feature only through the flag, and the
  flag's default is off.
- **Replaces the draft** "ADR-0060: The vinext single-executable build base: nitro bun preset or
  vinext's own prod server" (PR #1341, never merged). The number is kept. The draft's subject — a
  new vinext build base — becomes **phase V3** of this ADR (#1462), and its evidence is carried in
  the V3 section below rather than lost.
- **Amends:** ADR-0048 (cross-reference, see its Amendment 6: the single executable is the artifact
  shape for both runtimes, and Amendment 5's "cold start = process boot" is the premise the OKE A/B
  here tests) and ADR-0054 Amendment 7 (cross-reference, see its Amendment 8: compiled bun cells may
  ship self-contained behind the flag; bytecode coverage of included modules is measured, not
  assumed). **Does not amend** ADR-0058: the v1.0 cell list is unchanged.
- **Relates to:** ADR-0036 and ADR-0042 (the compiled target and bytecode), ADR-0055 (the image
  declares its own start; the supervisor), ADR-0056 (per-cell credential windows and fingerprints),
  ADR-0059 (the build-time bake).

## Context

knext compiles its Bun cells into single executables (`bun build --compile --bytecode`). Two
compiled shapes ship today, and **neither is self-contained**:

1. **Next `output: 'standalone'` (turbopack/webpack × bun — the four-cell v1.0 credential's Bun
   half, ADR-0058).** `packages/kn-next/src/adapters/standalone-compile.mjs` compiles only what
   Next's `server.js` reaches statically, so the executable replaces `bun server.js` and nothing
   else. Everything Next loads by a *computed path at request time* — every route chunk under
   `.next/server/**`, the `*.runtime.prod.js` renderers, the manifests — stays **on disk beside the
   binary, with no bytecode**, resolved through `compile.autoloadPackageJson` (ADR-0054 A7). The
   runtime image (`templates/runtime-standalone/Dockerfile.standalone.hbs:113-152`) therefore copies
   the whole `.next/standalone` tree plus `node_modules`, and its entrypoint runs
   `bun run /app/knext-entry.mjs`, which spawns the binary: two processes. This is knext's largest
   dynamic-import surface and its largest untapped bytecode surface.
2. **vinext on the nitro bun preset (vinext × bun, v1.x).** Already runs from `$bunfs` except
   `sharp` (the `native/` directory) and `public/`. The `.output/server/node_modules` sidecar exists
   only in CI.

Making either shape self-contained needs the same three Bun primitives, all upstream work in
flight:

| primitive | upstream | state (2026-09-26) |
|---|---|---|
| `--include` with path fidelity | oven-sh/bun#44059 (ours) | ready for review; 19/19 build tests pass on the patched build, 0/19 on system Bun |
| exe-dir resolution of what stays on disk | oven-sh/bun#44053 | a maintainer bot is implementing; no PR yet |
| multi-file native addons (sharp) | oven-sh/bun#44063 | a maintainer bot is reproducing |

Two facts discovered while planning constrain the carrier:

- The #44053/#44063 fixes live in the **runtime base executable** that Bun embeds into every
  compiled binary, not in the `bun` that runs the build. Swapping the build toolchain cannot carry
  them; only `compile.executablePath` (unused today) or a knext-side JS shim can.
- Consumers build with **their own Bun** (CLAUDE.md §9). A `patchedDependencies` entry or a Bun that
  exists only in knext's CI never reaches a user.

Two invariants follow, and every part of this ADR is written against them:

- **I1 — path fidelity.** Anything embedded keeps its build-time relative path under `$bunfs`, so
  code that computes `join(dirname, x)` finds it.
- **I2 — execPath anchoring.** Anything *not* embedded resolves from `dirname(process.execPath)`,
  never from the working directory.

What the cold-start evidence says today, stated before the decision because it limits the claim:

- OKE, N=7 paired: node-standalone **3610 ms** vs vinext single-exec **3401 ms** median, ranges
  overlapping — a **tie** (ADR-0048 Amendment 5, ADR-0054). Knative scale-from-zero is dominated by
  activate → schedule → container create; process boot is a small part of it.
- The #1341 spike's prod-server base (vinext app fully embedded) was **335 ms slower** at the OKE
  median than the nitro base (n=10 each, permutation p=0.16, not significant), despite a faster local
  boot (183 vs 241 ms). The gap is not attributed.
- Locally, first execution of a large compiled binary costs **1789 ms cold vs 83 ms warm**, and
  eager sharp extraction adds **≈375 ms** to the first request.

So a Knative cold-start win from self-containment is **a hypothesis this ADR sets up to test**, not
a result it relies on.

## Decision

1. **Self-contained is an opt-in capability of both compiled shapes.** `kn-next build
   --self-contained` / `selfContained: true` in `kn-next.config.ts` (#1454), default **off**, routed
   per target. With the flag off, build output is byte-identical to today (that is #1454's exit
   test). Disk mode stays the default until the lanes in (5) prove parity; making self-contained
   the default is a separate, later decision this ADR does not take.
2. **Self-contained means:** the binary boots and serves every route from a directory holding only
   the binary, `public/` (or `.next/static`) and `native/` — no `node_modules/`, `.next/` or
   `.output/`. Everything else is embedded under I1, and whatever is legitimately left on disk
   (sharp, public assets) resolves under I2.
3. **Ship-side carrier: knext-side shims only, each with a retirement path.** Workarounds for the
   missing primitives are JS shims, vite/Bun build plugins or compile-script logic in
   `packages/kn-next/src/adapters/*`. Each carries an `@knext-shim <id>` marker and a registry entry
   whose probe runs the upstream repro against the **pinned** Bun / vinext and asserts the bug is
   still present (#1450). A probe going red on a version bump means "upstream fixed — delete shim
   X", and **the shim is deleted in the same PR as that bump.** The shim count must not rise
   between sprint closes.
4. **Verify-side carrier: a patched Bun base executable, CI-only, never shipped.** A Cloud Build
   pipeline builds `bun-linux-{x64,arm64}-musl` from a pinned upstream SHA plus `patches/bun/*`, with
   an SBOM, a cosign signature and a sha256 (#1452). It is consumed through `compile.executablePath`
   behind `KNEXT_BUN_BASE_EXE` to *test* upstream PRs (#44059/#44053/#44063) and to run the lanes
   ahead of a Bun release. It is **not** published, not a default, and not a supported user
   configuration.
5. **The lane pattern: an empty-dir mode on the existing lanes, not new jobs.** The deploy scripts
   gain a `KNEXT_SELF_CONTAINED=1` mode that copies only the binary, static assets and `native/`
   into a fresh directory and fails if `node_modules/`, `.next/` or `.output/` is present (#1455).
   The mode is part of the **compat-window fingerprint** (ADR-0056), so a self-contained window and a
   disk-mode window can never be mixed. The same 16 shards and the same ledger are reused.
6. **Order of work: a shared foundation, then two tracks.** The foundation is F1–F6 (#1450–#1455).
   The **Next standalone track (N1–N3) leads**, because it carries the v1.0 credential. The
   **vinext nitro track (V0–V2)** runs in parallel on disjoint files (`standalone-*` vs
   `vinext-*`). The #1341 prod-server base is **V3** (#1462) and starts only after V2 exits.
7. **"Done" for a track is both of these, measured:**
   - **Cold start:** an OKE A/B, n ≥ 7 per arm, paired, all pods on one node, warm image, image
     pull reported separately. Arm A = today's shipped image; arm B = self-contained. The win is
     **B's median below A's median by more than A's IQR**.
   - **Compat parity from an empty dir:** the lane in (5) on the self-contained binary scores at
     least the cell's current disk-mode pass count, with no new deterministic reds, on two
     consecutive runs.

   If the cold-start criterion is not met, the capability **stays behind the flag** and the track
   is recorded as not done. The remaining self-containment benefits (one artifact, no
   `node_modules` in the image) do not substitute for the measured win.

## Options considered

The facts in the table are measurements unless marked *(est.)* or *(unmeasured)*.

| Option | Cold start | Image / binary size | Upstream risk | Security surface | Verdict |
|---|---|---|---|---|---|
| **(a) Self-contained as the default now** | OKE win unproven: last two cluster A/Bs are a tie (3401 vs 3610 ms) and a 335 ms loss (not significant); +1789 ms cold first-exec locally | binary grows ≈3.9× the embedded JS (≈+100 MB for a full standalone tree *(est.)*) | high: depends on 3 unmerged Bun primitives; every user build hits the shims on day one | smaller image, no `node_modules` layer; new writable-tmp need for sharp | rejected — ships an unmeasured claim to every user and breaks the "prove parity first" rule |
| **(b) Opt-in behind a flag, lanes + OKE gate (chosen)** | measured per track by the A/B in Decision 7 before any claim | same growth, paid only by opt-in users; pull time reported separately | contained: shims are registered, probed and deleted on the fixing bump | same as (a), limited to opt-in; base-exe stays in CI | **chosen** — the only option that turns the hypothesis into a measurement without exposing defaults |
| **(c) Never (disk mode only)** | today's numbers: route chunks and renderers load as source, no bytecode | unchanged (image carries `.next/standalone` + `node_modules`) | none | unchanged (a `node_modules` tree in every Bun image) | rejected — forfeits the largest untapped bytecode surface and the upstream work that is the credibility lever |
| **(d) Ship a patched Bun base executable to users** | would remove the shims' overhead *(unmeasured)* | same as (a)/(b) | lowest shim debt, but knext becomes a Bun distributor tracking an unmerged fork | **largest**: a knext-built runtime binary in every user image, needing its own SBOM, signing, CVE response and release cadence | rejected — founder decision A: the base executable is verification-only |

(b) is the recommendation because the cold-start win is exactly the unproven quantity: (a) assumes
it, (c) never learns it, and (d) buys a permanent supply-chain obligation to shave shim cost off a
win nobody has measured yet.

## Consequences

**Positive**

- A path to a Bun artifact with bytecode on route code, not only on the framework core, and to
  images with no `node_modules` layer.
- Every knext workaround has a machine-checked retirement trigger, so upstream fixes turn into
  deletions rather than accumulating debt.
- The upstream PRs (bun#44059 and the tests we run on #44053/#44063) are useful to Bun whether or
  not knext's flag ever becomes a default.

**Honest risks (each has the measurement that decides it)**

- **Included modules may get no bytecode.** Embedding a module is not the same as compiling it to
  bytecode. The #1341 spike proved *embedding* (all 159 server chunks deleted from disk, every route
  still served) but no verifier has yet shown bytecode on an included module. #1451's
  `bytecode-exec-verify` on an included chunk is the killing measurement: if it fails, the Next
  track becomes self-containment only and its cold-start criterion is at risk.
- **The OKE result may stay a tie.** Two of two cluster measurements so far are a tie or a
  not-significant loss. If N3/V2 repeat that, the feature stays flag-only and "done" fails, as
  Decision 7 says.
- **Binary growth ≈3.9× the embedded JS** (≈+100 MB for a full standalone tree, an estimate). Pull
  time is reported separately in the A/B; a large first-exec cost is tested by an eager-extract arm
  (C) against the lazy one (B).
- **Read-only root filesystems vs sharp extraction.** Embedded sharp must be extracted to `$TMPDIR`
  at run time (lazily, on the first image request, so `/api/health` does not pay ≈375 ms). A pod
  with a read-only root filesystem and no writable tmp cannot do that; the fix would be an
  operator-rendered `emptyDir`, which is a CRD change and returns to the design gate.
- **Next's `require-hook` may reject `$bunfs` paths** (N1). The fallback is an
  embedded-path → disk alias shim with a registry entry against a Next.js issue.
- **Credential clocks.** A self-contained cell is a new fingerprint; its window starts from zero and
  borrows nothing from the disk-mode window.

**Neutral**

- The v1.0 cell list (ADR-0058) does not change. The flag is a packaging mode of an existing cell,
  not a new cell.

## Phase V3 — the vinext prod-server base (the #1341 draft, carried forward)

The draft proposed building the vinext executable from vinext's own Node prod server
(`startProdServer`) instead of nitro's bun preset, because that is the path Cloudflare's nightly
deploy suite runs and every nitro-only bug knext has filed upstream comes from the gap. Its
measurements (vinext 1.0.0-beta.12, Bun 1.4.2, 778-file corpus, one run each; runs 36008799337 and
35986509462):

| | nitro base | prod-server base (embedded) |
|---|---|---|
| official deploy suite, 16/16 shards | 717 / 61 | 746 / 32 (32 files fixed, 3 new reds) |
| knext compile shims | S1, S3–S6, S9 (+ S2, S7, S8, S10) | S2, S7, S8, S10 + a ~40-line entry |
| OKE cold start, `/api/health` TTFB, n=10 | median 1886 ms | median 2221 ms (+335 ms, p=0.16) |

That direction stands, but as **V3 (#1462), after V2**, rebased onto this ADR's foundation: the
embed step uses F2 (#1451), its React-external and staged-React workarounds become registered shims
against vinext#3485/#3486, and the 3 new reds and the unexplained +335 ms must be attributed before
it can ship even behind a flag. Nitro-only shims are retired only once V3 is the vinext default.

## Action items

| id | issue | what | exit |
|---|---|---|---|
| F1 | #1450 | retirement harness: registry, probes against the pinned Bun/vinext, `@knext-shim` marker scan | both halves mutation-proved red |
| F2 | #1451 | shared embed module (extra entrypoints, I1 assertions, unembedded-dynamic report) | computed import/require resolve from an empty dir on stock Bun; bytecode proven on ≥1 included module |
| F3 | #1452 | patched Bun base-exe pipeline, CI-only | cosign verify in CI; reproducible sha256 or documented delta |
| F4 | #1453 | this ADR | accepted at the sprint-close gate |
| F5 | #1454 | `--self-contained` / `selfContained`, default off | byte-identical default output |
| F6 | #1455 | empty-dir lane mode + fingerprint | guard reds on a planted `node_modules`; fingerprint changes with the mode |
| N1 | #1456 | Next: embed `.next/server/**`, renderers, manifests; `$bunfs` `distDir` anchor | turbopack and webpack serve every route from an empty dir |
| N2 | #1457 | self-contained `Dockerfile.standalone` variant | no `node_modules` in the image; kind boot; Trivy clean |
| N3 | #1458 | Next exit: bun lanes in empty-dir mode + OKE A/B/C | Decision 7 |
| V0 | #1459 | re-baseline vinext disk-mode compat on beta.12 | number published; below 715 escalates |
| V1 | #1460 | vinext nitro: embed the plan + public, strict requires, lazy sharp, `$bunfs` read-stream shim | 13/13 file-manager routes from an empty dir |
| V2 | #1461 | vinext exit: compat-vinext in empty-dir mode + OKE A/B | Decision 7 |
| V3 | #1462 | prod-server base on the foundation (after V2) | the draft's result reproduced from an empty dir; gaps attributed |
| U | #1463 | upstream queue (Bun, vinext, new Next.js asks) | every item has a dated state |
| D | #1464 | user docs: "Self-contained binary" section | content-hygiene green; lands with the first track to exit |

Deliberately deferred: self-contained as the default; the OTel runtime-string `require` class;
Windows `$bunfs`; eager vs lazy bytecode for included modules (after N3/V2); trace-driven Docker
`COPY` (#1419); moving F3 from a fork to Bun canary (only when #44053 and #44063 are both there).
