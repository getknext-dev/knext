# ADR-0070: The Stable bar for the Bun single executable (v2)

- **Status:** **Proposed (2026-10-16).** Design only. It defines a bar; it graduates nothing, changes
  no runtime code, dispatches no compat run and edits no user docs. Ratified (or revised) at the v2
  Sprint 5 close design review, beside the vinext bar (#2061). Trigger-class (ADR, credential window
  definition, public-API tier of `selfContained`), so per `.claude/rules/workflow.md` (2026-09-22
  amendment) it is reviewed at sprint close, not gated per PR.
- **Issue:** #2406 (v2 Sprint 5, task V5, with #2061).
- **Amends (Proposed):** ADR-0060 Decision 7, only as it applies to graduation. See D5.
- **Relates to:** ADR-0036 and ADR-0048 (the compiled target), ADR-0054 Amendments 7–9 (bun-standalone
  ships compiled; the cost table), ADR-0056 Amendment 5 (the credential is 14 consecutive green
  independent runs per cell), ADR-0058 (the cell matrix), ADR-0060 (the self-contained capability),
  ADR-0063 (release lines; the opt-in knext-patched Bun toolchain), and
  [`docs/compat/bar-vinext-axis.md`](../compat/bar-vinext-axis.md) (the vinext bar, #2061).
- **Does not amend:** ADR-0058's v1.0 cell list, or anything in the 1.x lines. On every 1.x release
  the vinext executable stays Beta and the self-contained mode stays Experimental.

## Context

The founder's v2 direction (2026-10-09) graduates two things from Beta to Stable inside the v2 line:
vinext and the Bun single executable. Only vinext has a written bar (V0–V7, `bar-vinext-axis.md`,
still a proposal). The single executable has none, so nobody can decide whether it is Stable.

"The Bun single executable" covers three artifacts today, and they are not at the same stage. The
facts below were checked against `integration/v2` on 2026-10-16:

| Shape | What it is | Tier today | Compat evidence |
|---|---|---|---|
| **S0** standalone-on-Bun, disk mode | `next build`'s `server.js` compiled with `bun build --compile --bytecode`; route chunks stay on disk beside it (ADR-0054 A7) | **Stable** (the default build; one of the four node/bun × turbopack/webpack cells) | 792/0/0 on all four cells at the rc.1 ref (runs 36348532038, 36348537247 for the Bun cells); the 14-run window is in progress |
| **S1** standalone-on-Bun, self-contained | S0 with `selfContained: true`: route code, renderers and manifests embedded; the directory holds only the binary, `public/` and `.next/static/` (ADR-0060) | **Experimental** | empty-dir dispatches: turbopack **763/29/0** (run 36381524338), webpack **767/25/0** (run 36381530352), against 792/0/0 in disk mode |
| **S2** vinext-on-Bun executable | the whole vinext app compiled into one binary; `native/` (sharp) and `public/` beside it; `--self-contained` embeds those too | **Beta** | disk mode 1016 of 1099 on Next v16.3.6 (41 disclosed known-gap files); self-contained **719/48/0 of 778** (run 36387825975) against 728/38/12 in disk mode (run 36266774820) |

S0 already has a bar: the four-cell credential under ADR-0056. This ADR does not reopen it. The gap
#2406 names is S1 and S2.

What the existing machinery does and does not cover:

- **The empty-dir mode exists, but only on dispatch.** `KNEXT_SELF_CONTAINED=1` is a `workflow_dispatch`
  input on `test-e2e-deploy.yml` and `compat-vinext.yml` ("Never runs on schedule"). It is folded into
  the fingerprint (#1455) and records `served_from=empty-dir` (#1514). A dispatch never counts toward
  a credential (ADR-0056 D8), so **no self-contained cell can credential today**.
- **The empty-dir reds are root-caused.** Families A–D explain 29 of the 31 unique red files on S1
  (#1600 external-alias, #1601 residual gaps, #1602 runtime fs reads outside the closure, #1603
  ISR/PPR resume data). jev scored "every one is a real gap, not a harness artifact" at 0.06, which
  agrees with the triage: they are real.
- **Metrics are not at parity.** The S1 image serves `knext_up` and an uptime counter on `:9464`. It
  does not serve the golden-signal and cold-start metrics, the default process metrics, DB-pool drain
  on shutdown, or image-cache sync (#1523, documented on the build-pipeline docs page).
- **Native addons.** S1 fails the build on any `.node` file and names it
  (`standalone-native-addon-guard.test.ts`). S2 stages sharp into `native/` with an integrity manifest
  the runtime verifies before `dlopen`. #1516 tracks giving S1 the same staging.
- **Supply chain.** The full SBOM + Trivy + cosign gate runs on one image, the vinext executable,
  including an SBOM scan of the app's JS closure (`supply-chain.yml`). The S1 image gets an OS-layer
  Trivy scan with no SBOM and no signature (ADR-0054 A9 table). The JS closure embedded in the S1
  binary is invisible to Trivy (#1525). Two different patched-Bun artifacts exist, and they must not
  be confused:
  - the patched **base executable** (`bun-base-build.yml`) is CI-verification only and never shipped
    (ADR-0060 D4);
  - the knext-patched **toolchain** (`compile.bun: 'knext-patched'`, `bun-patched-release.yml`) is an
    opt-in user feature. It is published as a signed prerelease with pinned sha256 values, and it
    carries a retirement probe for oven-sh/bun#44059. The runtime embedded in the user's binary is still
    stock Bun.

  Nothing asserts that a credential run was compiled with stock Bun.
- **Cold start is a tie wherever it has been measured.** S1 against the default image: 2.07 s against
  2.93 s median, n=7 paired. That difference is inside the run-to-run spread, so the docs say "not (yet)
  a proven speed win". The four default cells cold-start within about 0.3 s of each other at about
  2.1–2.4 s. vinext single-exec against node-standalone measured 3401 ms against 3610 ms (ADR-0048 A5),
  a tie. Knative scheduling and container start dominate; process boot is a small share.
- **Rollback.** NextApp rollback is a traffic split between revisions (ADR-0014). The operator renders a
  different container command per shape: S1 and S2 leave the command to the image's default. #2043
  covers operator N→N−1 rollback. Nothing tests rolling back from one artifact shape to another.

## Decision

### D1 — Scope: S1 and S2, each graduating on its own

The bar covers the **self-contained single executable on both compiled shapes (S1, and S2 in both its
disk and self-contained forms)**. S0 stays under the existing four-cell credential and is not
re-credentialed. Each shape graduates independently: S1 may become Stable while S2 is still Beta, and
the reverse. Within S1, turbopack and webpack are separate cells and graduate separately.

### D2 — The exit criteria

A shape is Stable only when **every** criterion below holds and each one is backed by a scheduled or
per-PR **red-on-fail** check. A criterion met only by a one-off measurement or by review does not
count, with one exception: C5's A/B is a cluster measurement recorded in a ledger. For each criterion,
the table gives the check and its current state.

| # | Criterion (measurable) | Check (existing or to build) | State on 2026-10-16 |
|---|---|---|---|
| **C1** | **Compat cells and credential rule.** S1 has two cells, `bun-turbopack-sc` and `bun-webpack-sc`. Each needs 14 consecutive green, independent, scheduled runs on a frozen v2 rc tag, at least 2 h apart, with fresh caches and a separate runner, under every existing audit rule (ADR-0056 A5 D8–D11, unchanged). Each run must be green on every shard against the same manifest and denominator as the disk-mode cell, with **no self-contained-only quarantine**. S2's cell, `bun-vinext-sc`, uses the threshold the vinext bar ratifies (#2061), and its pass count must be at least that of S2 in disk mode at the same ref, with no new deterministic reds. The empty-dir mode is in the fingerprint, so a disk-mode run can never advance a self-contained cell. | Cells in `CREDENTIAL_CELLS` with a v2 scope, plus the scheduled empty-dir mode on the existing lanes: **to build, #2443**. The window audit (`scripts/compat-window-audit.mjs`) and the ledger (`scripts/compat-run-ledger.mjs`): exist. | **Not met.** Dispatch-only. Last runs red: 763/29, 767/25, 719/48 (runs above). Red families: #1600–#1603. No v2 credential pin exists yet (only the v1.0 and v1.3 refs). |
| **C2** | **Self-contained / empty-dir serving.** The binary boots and serves every compat route from a directory holding only the binary, static assets and `native/`, as ADR-0060 D2 defines it. That holds in the runtime image (no `node_modules` anywhere) and on a read-only root filesystem with only an operator-rendered writable tmp. | The lane's allowlist check (`scripts/e2e-deploy.sh`, `e2e-deploy-vinext.sh`, #1455): exists. The image e2e `standalone-self-contained-image.docker-e2e.test.ts` and the `self-contained-exec-e2e` CI job: exist. The read-only-root mount: **#1524** (open). The image variant: **#1457** (open). | **Partly met.** The image and exec e2e pass on the file-manager app; the read-only-root mount path is wrong (#1524); the scheduled lane is C1. |
| **C3** | **Native-addon policy.** S1 stages native addons into `native/` with an integrity manifest the runtime verifies before `dlopen`, as S2 already does. An addon that cannot be staged fails the build and names the file. An addon is never embedded in the binary. A sharp-using app serves an optimized image from the empty directory. Sharp is extracted lazily, to the writable tmp from C2. | The fail-loud guard (`standalone-native-addon-guard.test.ts`): exists. S1 staging plus a test that it stages and serves: **#1516** (open; this ADR adds the test to its exit). | **Not met for S1** (fails on any addon). **Met for S2** (`native/` with a verified manifest). |
| **C4** | **Metrics parity.** The S1 and S2 executables serve, on `:9464`, every metric family the disk-mode image serves (golden signals, cold-start, default process metrics). They also drain the DB pool on SIGTERM and sync the image-variant cache. The parity check holds an allowlist of accepted missing families, and that allowlist must be **empty** when a shape graduates. | A red-on-fail contract test that diffs the metric families of the two images: **#1523** (open; this ADR adds the test to its exit). FFI slow-call counter on the vinext executable: #2432. | **Not met.** S1 serves `knext_up` and uptime only. |
| **C5** | **Cold-start claim policy.** Graduation needs a paired OKE A/B: n ≥ 7 per arm, all pods on one node, warm image, pull time reported separately. Arm A is the S0 disk-mode image; arm B is the shape. B must be **non-inferior**: B's median may not exceed A's median by more than A's IQR. A *superiority* claim ("faster cold start") additionally needs ADR-0060 D7's win (B's median below A's by more than A's IQR) recorded in the cold-start ledger. Without that, docs may state a tie and the measured numbers, nothing more. | The A/B itself is a measurement, not CI: #1458 (S1) and #1461 (S2) run it into `docs/benchmarks/cold-start-ledger.md`. The red-on-fail guard against unsupported comparative claims in the docs: **to build, #2447**. Existing guards: `apps/docs/boot-claim-hygiene.test.ts` (one figure only) and `docs/compat/retracted-figures.json`. | **Non-inferiority not yet run as a graduation A/B.** The only S1 A/B (n=7) is 2.07 s against 2.93 s, inside the spread. That passes non-inferiority on its face, but it was not run to this protocol. No superiority claim is supported. |
| **C6** | **Supply chain.** Stable cells and release images are compiled with **stock released Bun only**. The knext-patched toolchain stays opt-in and outside the Stable promise, and the patched base executable stays CI-only (ADR-0060 D4). Every shipped single-exec image has an SBOM, a HIGH/CRITICAL scan that also covers the **embedded JS closure**, and a cosign signature with an SBOM attestation, like every other image (security.md). Every knext shim the shape depends on has a registered retirement probe. | SBOM, signature and the stock-Bun assertion: **to build, #2444**. Embedded-closure scan: **#1525** (open). The app-closure SBOM scan for the vinext image (`supply-chain.yml`): exists. Shim registry, probes and marker scan (`tests/upstream-retirement/`): exist. | **Not met for S1** (OS-layer Trivy only, no SBOM or signature, closure unscanned). **Partly met for S2** (closure SBOM scan exists). Stock-Bun assertion missing for both. |
| **C7** | **Rollback.** A user can leave the shape by config alone (`selfContained: false`, `build: 'turbopack'`, or `runtime: 'node'`) and redeploy. Traffic can split between a single-exec revision and a disk-mode or Node revision with every revision serving. The shared Redis ISR entry survives the switch. The operator renders the right command per revision. The docs carry the one-line opt-out. | A kind e2e across shapes: **to build, #2445**. Operator N→N−1 rollback: #2043 (separate). | **Not met.** No test exists. The old-operator compat shim (`server.js` exec relay) exists and covers skew, not rollback. |

Two cross-cutting conditions apply to every shape:

- **Node stays an option.** The Bun shape may graduate only while its builder's Node arm is selectable
  and itself Stable or in its own credential: `node × turbopack` and `node × webpack` for S1. For S2,
  vinext × node is Beta and has no compat arm yet (#1260); that does not block S2's Bun graduation, but
  S2's docs must say the Node arm is Beta. jev 0.79 that this condition belongs in the bar.
- **The vinext compat threshold is not restated here.** S2's compat number comes from the ratified
  vinext bar (#2061); this ADR adds only the single-exec criteria on top of it. jev 0.79 for
  delegating rather than restating.

### D3 — What Stable permits, and what it does not

**Permits, per graduated shape:**
- Listing the shape under **Stable** on the stability-tiers page and giving it **its own row** in the
  compatibility matrix, with its own credential status. Both are derived from the audit, not written
  by hand: guard **#2446**.
- Semver protection for its surface. For S1 that moves `selfContained` / `--self-contained` from
  Experimental to Stable. That is a public-API tier change, so the graduation PR is itself trigger-class.
- Saying "credentialed" for a cell only at 14/14 on that cell (unchanged from ADR-0056 A5).
- Stating the shape's measured cold start, and a tie with the default image, with the protocol named.

**Does not permit:**
- **Becoming the default.** The default stays the standalone (official-adapter) build in disk mode;
  S1 and S2 stay opt-in (`architecture.md` §4; jev 0.07 that graduation should allow a default change).
  A default change would need its own ADR and founder decision.
- **Any "faster" or "smaller cold start" claim** without C5's superiority evidence. Image-size
  statements are measurements and are allowed with their numbers.
- **Descoping Node**, or wording that implies Bun is required for a feature it is not.
- **Anything on 1.x.** 1.x docs keep vinext Beta and self-contained Experimental.

The stability page currently says vinext "stays Beta in every release; it is not on the path to
Stable". That sentence becomes false only when a v2 graduation PR lands. It is changed there, not in
this design PR (jev 0.26 for editing user docs now).

### D4 — Where the checks run

The scheduled empty-dir cells are a mode of the **existing** lanes (`test-e2e-deploy.yml`, and
`compat-vinext.yml` or its v2-line derivation), not a new workflow. This follows ADR-0060 D5. jev 0.53
against 0.47 for a new workflow, at low confidence (0.06). The deciding fact is that ADR-0060 D5
already chose this and the fingerprint machinery exists on those lanes. The price: editing
`test-e2e-deploy.yml` restarts every credential cell on it (ADR-0056 D3), so #2443 lands between
windows or on the v2 line's derived workflow.

### D5 — Amendment to ADR-0060 Decision 7 (Proposed)

ADR-0060 D7 says a track is "done" only with a cold-start **win**, and otherwise stays behind the
flag. For graduation, this ADR replaces "win" with **non-inferiority** (C5). A shape that ties the
default image on cold start, and meets C1–C4, C6 and C7, may be Stable as an opt-in. The win remains
the bar for any claim that it is faster. The reason: every cluster measurement so far is a tie,
because Knative scheduling and container start dominate. Requiring a win would make graduation
depend on a quantity the platform does not control. The other benefits (one artifact, no
`node_modules` in the image) do not stand in for compat, metrics or supply-chain parity. They only
stop a tie from being disqualifying. jev 0.98 for non-inferiority against 0.02 for a required win.

## Options considered

| Option | What it means | Verdict |
|---|---|---|
| **New ADR (chosen)** | A separate Proposed ADR defines the bar and points at ADR-0060, 0056, 0058 and the vinext bar | jev **0.87**. Graduation is its own decision, ratified at sprint close beside #2061 |
| Amend ADR-0060 | Append the bar to the self-contained ADR | jev 0.12. ADR-0060 is itself still Proposed and is about the capability, not about tiering. One small amendment to it (D5) is kept |
| Amend ADR-0058 | Add single-exec cells to the cell-matrix ADR | jev 0.00. ADR-0058 is about the v1.0 cells and must not move |
| A `docs/compat/bar-*.md` proposal only | Mirror the vinext bar file | jev 0.01. The bar changes a credential window definition and a public-API tier, which is ADR material |

| Scope option | jev |
|---|---|
| **S1 + S2, vinext compat delegated to #2061, S0 untouched (chosen)** | **0.98** |
| vinext executable only | 0.01 |
| self-contained standalone only | 0.01 |
| re-credential every compiled Bun artifact, S0 included | 0.00 |

| Credential window | jev |
|---|---|
| **ADR-0056 A5 unchanged: 14 consecutive green independent runs, ≥2 h, fresh caches, frozen rc, mode in the fingerprint (chosen)** | **1.00** |
| a smaller N for a new lane | 0.00 |
| M-of-N tolerance | 0.00 |
| two dispatched runs (ADR-0060 D7's compat half) | 0.00 |

Other choices: stock Bun only for Stable cells (**0.99**, against 0.01 for allowing the signed patched
toolchain and 0.00 for making it the default). Full metrics parity with an allowlist that must be empty
(**0.97**, against 0.03 for a disclosed subset). Stage native addons like vinext (**0.98**, against 0.02
for keeping fail-loud). A cross-shape rollback e2e (**1.00**). Reuse the open issues for checks they
already track, filing new ones only for uncovered checks (**0.98**).

## Consequences

- **Single-exec graduation becomes decidable.** Each criterion names a check, and a reviewer at sprint
  close can read a pass/fail per shape rather than a judgement.
- **No shape graduates soon.** Every criterion except S2's C3 is unmet today, and C1 alone is ≥14 runs
  (four to five days at three runs a cell a day) *after* the empty-dir reds are fixed and a v2 rc is
  pinned. That cost is deliberate: the bar is the same one the default cells meet.
- **CI cost.** Three more scheduled 16-shard cells. The shared pool (GitHub Free, 20 concurrent jobs)
  already carries 8 credential cells. #2443 must show the pool still fits, or schedule the
  self-contained cells only while their prerequisites are green.
- **A Proposed amendment to ADR-0060 D7** (D5). If the review rejects it, C5 reverts to requiring a
  win, and on today's evidence no shape can graduate.
- **Not covered, stated:** the shim-count ratchet in ADR-0060 D3 ("must not rise between sprint
  closes") is not a mechanical check today; it stays a sprint-close review item and is not part of this
  bar. Read-only-root behaviour on a cluster without an operator-rendered `emptyDir` is out of scope;
  C2 requires the rendered mount.

## Action items

| Check | Issue | Kind |
|---|---|---|
| Scheduled self-contained credential cells on the existing lanes, v2-scoped in the audit | **#2443** (new) | C1, C2 |
| SBOM + cosign for self-contained images; stock-Bun assertion on credential and release builds | **#2444** (new) | C6 |
| Cross-shape rollback kind e2e | **#2445** (new) | C7 |
| Docs guard: Stable tier and matrix row derived from the audit | **#2446** (new) | D3 |
| Docs guard: no comparative cold-start claim without a separated A/B | **#2447** (new) | C5 |
| Metric-family parity contract test (allowlist empty at graduation) | #1523 (existing, exit extended) | C4 |
| Embedded-closure SBOM scan, fail on HIGH/CRITICAL | #1525 (existing) | C6 |
| Native-addon staging for S1, plus a stage-and-serve test | #1516 (existing, exit extended) | C3 |
| Read-only-root cache `emptyDir` mount for S1 | #1524 (existing) | C2 |
| Empty-dir compat reds | #1600, #1601, #1602, #1603 (existing) | C1 |
| OKE A/B to the C5 protocol | #1458 (S1), #1461 (S2) (existing) | C5 |
| vinext compat threshold | #2061 (existing) | C1 (S2) |
| Ratify this ADR at the Sprint 5 close | #2406 | — |
