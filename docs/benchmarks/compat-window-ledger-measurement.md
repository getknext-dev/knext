# Compat-window ledger measurement (sprint-3 A3)

**Measurement only — no decisions.** This is the data input the ADR-0007 amendment (sprint-3 A6,
#850) is required to wait for. It records what the retained `compat-run-ledger` artifacts say
about the v1.0 14-night window: every restart, its cause, and where the clock would stand under
the current rule and under the counterfactual window shapes the amendment must choose between.

Measured 2026-09-05. Latest scheduled run at measurement time: 2026-09-04 (run 33851332032); the
2026-09-05 nightly had not yet fired.

## Method

Data source: the `compat-run-ledger` artifact of every retained `test-e2e-deploy.yml` run, plus
run metadata (`headSha`, `createdAt`, `event`) from the Actions API, plus two
`compat-window-fingerprint` artifacts, plus `git` on the fetched `origin/main` history.

```sh
# 1. Enumerate runs (147 total; 83 scheduled)
gh run list --repo getknext-dev/knext --workflow=test-e2e-deploy.yml --limit 250 \
  --json databaseId,event,createdAt,conclusion,headBranch,headSha > runs.json

# 2. Download every retained ledger (loop over run ids)
gh run download <id> --repo getknext-dev/knext -n compat-run-ledger -D dl-<id>

# 3. Per-restart source correlation
git rev-list --count <prevNightSha>..<curNightSha>
git diff --name-only <prevNightSha> <curNightSha>   # grep packed inputs packages/{kn-next,lib,db}/
                                                    # and harness inputs (workflow, scripts/e2e-*,
                                                    # test/deploy-tests-manifest.*)
```

Coverage: **44 of 44 scheduled runs from 2026-07-28 onward have a retained ledger** (39 node-lane,
5 bun-lane). No scheduled run before 2026-07-28 has one (the ledger + fingerprint artifacts begin
with #545 S1, merged 2026-07-28). All 44 ledgers carry `runAttempt: "1"` — **zero re-runs in the
entire retained history**, extending #850's earlier 32-run check.

Ledger-schema note: ledgers before #695 (≤ 2026-08-06 here) carry raw shard summaries with no
`complete`/`status` fields; for those nights completeness was derived from the shard ids (all of
`1/M..M/M` present exactly once). The fingerprint script (`scripts/compat-window-fingerprint.mjs`)
has existed in exactly one version since 2026-07-28 (commit `6a6ebe3a`, unmodified since), so the
packed component is **content-anchored (per-file bytes + mode, tarball bytes excluded) for the
whole measured history** — every packed-digest delta below is a real packed-content difference.

## 1. Night-by-night ledger — node lane (39 nights, 2026-07-28 → 2026-09-04)

Digests abbreviated to 8 hex chars. `pkg shas` = per-package packed content digests
(core/lib/db). `next` provenance (recorded, never frozen) was **constant across every retained
night**: ref `v16.2.0`, tarball `e43cbf1a`. The node lane's ledgers do not record a
`runtimeVersion` (only the bun lane's do); the workflow's node pin (`node-version: 24`) is inside
the harness digest.

| date | runId | green | fingerprint | harness | packed | pkg shas (core/lib/db) | versions |
|---|---|---|---|---|---|---|---|
| 2026-07-28 | 30333571518 | GREEN | *none — pre-fingerprint night* | — | — | — | — |
| 2026-07-29 | 30427197358 | GREEN | 55bd1c3c | 7b11b469 | 60504835 | aa26087d/5e4ff03e/0ae671de | 0.3.0/0.2.0/0.2.1 |
| 2026-07-30 | 30518209404 | GREEN | 55bd1c3c | 7b11b469 | 60504835 | aa26087d/5e4ff03e/0ae671de | 0.3.0/0.2.0/0.2.1 |
| 2026-07-31 | 30609544684 | GREEN | 55bd1c3c | 7b11b469 | 60504835 | aa26087d/5e4ff03e/0ae671de | 0.3.0/0.2.0/0.2.1 |
| 2026-08-01 | 30687194887 | GREEN | 55bd1c3c | 7b11b469 | 60504835 | aa26087d/5e4ff03e/0ae671de | 0.3.0/0.2.0/0.2.1 |
| 2026-08-02 | 30735484416 | GREEN | 55bd1c3c | 7b11b469 | 60504835 | aa26087d/5e4ff03e/0ae671de | 0.3.0/0.2.0/0.2.1 |
| 2026-08-03 | 30790778590 | **NOT GREEN** — 15/16 shards, shard 16 produced no summary (the #695 night) | 43349a5f | 16398329 | 60504835 | aa26087d/5e4ff03e/0ae671de | 0.3.0/0.2.0/0.2.1 |
| 2026-08-04 | 30882760738 | GREEN | 8d099f93 | d24f0892 | b5c0bbae | 7f20f3f1/5e4ff03e/0ae671de | 0.3.0/0.2.0/0.2.1 |
| 2026-08-05 | 30979973943 | GREEN | c44d5e85 | d24f0892 | 7bdd819d | 58612a4d/ed4e0b5e/672db782 | 0.3.0/0.3.0/0.3.0 |
| 2026-08-06 | 31076109243 | GREEN | c44d5e85 | d24f0892 | 7bdd819d | 58612a4d/ed4e0b5e/672db782 | 0.3.0/0.3.0/0.3.0 |
| 2026-08-07 | 31149348286 | GREEN | 37edc694 | b0b70d06 | 7bdd819d | 58612a4d/ed4e0b5e/672db782 | 0.3.0/0.3.0/0.3.0 |
| 2026-08-08 | 31239550517 | GREEN | 37edc694 | b0b70d06 | 7bdd819d | 58612a4d/ed4e0b5e/672db782 | 0.3.0/0.3.0/0.3.0 |
| 2026-08-09 | 31294965728 | GREEN | 37edc694 | b0b70d06 | 7bdd819d | 58612a4d/ed4e0b5e/672db782 | 0.3.0/0.3.0/0.3.0 |
| 2026-08-10 | 31356989667 | GREEN | 37edc694 | b0b70d06 | 7bdd819d | 58612a4d/ed4e0b5e/672db782 | 0.3.0/0.3.0/0.3.0 |
| 2026-08-11 | 31459242158 | GREEN | 37edc694 | b0b70d06 | 7bdd819d | 58612a4d/ed4e0b5e/672db782 | 0.3.0/0.3.0/0.3.0 |
| 2026-08-12 | 31565302791 | GREEN | 8698abc6 | a0b25c61 | 45a89d1d | 9c3fcda8/ed4e0b5e/672db782 | 0.3.0/0.3.0/0.3.0 |
| 2026-08-13 | 31669242641 | GREEN | 8698abc6 | a0b25c61 | 45a89d1d | 9c3fcda8/ed4e0b5e/672db782 | 0.3.0/0.3.0/0.3.0 |
| 2026-08-14 | 31771823777 | GREEN | 8698abc6 | a0b25c61 | 45a89d1d | 9c3fcda8/ed4e0b5e/672db782 | 0.3.0/0.3.0/0.3.0 |
| 2026-08-15 | 31863085065 | GREEN | 8698abc6 | a0b25c61 | 45a89d1d | 9c3fcda8/ed4e0b5e/672db782 | 0.3.0/0.3.0/0.3.0 |
| 2026-08-16 | 31925582335 | GREEN | 8698abc6 | a0b25c61 | 45a89d1d | 9c3fcda8/ed4e0b5e/672db782 | 0.3.0/0.3.0/0.3.0 |
| 2026-08-17 | 31993151936 | GREEN | 8698abc6 | a0b25c61 | 45a89d1d | 9c3fcda8/ed4e0b5e/672db782 | 0.3.0/0.3.0/0.3.0 |
| 2026-08-18 | 32097443183 | GREEN | 8698abc6 | a0b25c61 | 45a89d1d | 9c3fcda8/ed4e0b5e/672db782 | 0.3.0/0.3.0/0.3.0 |
| 2026-08-19 | 32214131442 | GREEN | 9e4ad6fe | a0b25c61 | caa89a7a | 7f5d4efe/ed4e0b5e/672db782 | 0.3.0/0.3.0/0.3.0 |
| 2026-08-20 | 32330221781 | GREEN | 2af54202 | a0b25c61 | 21750db4 | bb1fa32d/ed4e0b5e/672db782 | 0.3.0/0.3.0/0.3.0 |
| 2026-08-21 | 32445502038 | GREEN | 94eacb13 | 6c78eb50 | fb8e2fd0 | 5021a95f/df5daab5/672db782 | 0.3.0/0.3.0/0.3.0 |
| 2026-08-22 | 32550380562 | GREEN | 166fdded | 6c78eb50 | d9809f14 | ce61c4b0/df5daab5/672db782 | 0.3.0/0.3.0/0.3.0 |
| 2026-08-23 | 32616853402 | GREEN | c188961e | 6c78eb50 | 8a090fd5 | f6bf0d8d/df5daab5/672db782 | 0.3.0/0.3.0/0.3.0 |
| 2026-08-24 | 32688792926 | GREEN | c188961e | 6c78eb50 | 8a090fd5 | f6bf0d8d/df5daab5/672db782 | 0.3.0/0.3.0/0.3.0 |
| 2026-08-25 | 32807321526 | GREEN | a6232743 | 6c78eb50 | 965c94aa | 41518130/df5daab5/672db782 | 0.3.0/0.3.0/0.3.0 |
| 2026-08-26 | 32928797270 | GREEN | 13896669 | 6c78eb50 | 7c525b0e | a0e7e2a8/9890c376/24d58206 | 0.3.1/0.3.1/0.3.1 |
| 2026-08-27 | 33081172139 | GREEN | c2ce7501 | 6c78eb50 | 4e3d3674 | 9e8249e2/9890c376/24d58206 | 0.3.1/0.3.1/0.3.1 |
| 2026-08-28 | 33185048759 | GREEN | 7706d7f9 | 6c78eb50 | f3612757 | 34e4a225/9890c376/24d58206 | 0.3.1/0.3.1/0.3.1 |
| 2026-08-29 | 33247088878 | GREEN | c2ce7501 | 6c78eb50 | 4e3d3674 | 9e8249e2/9890c376/24d58206 | 0.3.1/0.3.1/0.3.1 |
| 2026-08-30 | 33303635814 | GREEN | c2ce7501 | 6c78eb50 | 4e3d3674 | 9e8249e2/9890c376/24d58206 | 0.3.1/0.3.1/0.3.1 |
| 2026-08-31 | 33379468182 | GREEN | c2ce7501 | 6c78eb50 | 4e3d3674 | 9e8249e2/9890c376/24d58206 | 0.3.1/0.3.1/0.3.1 |
| 2026-09-01 | 33488326431 | GREEN | c2ce7501 | 6c78eb50 | 4e3d3674 | 9e8249e2/9890c376/24d58206 | 0.3.1/0.3.1/0.3.1 |
| 2026-09-02 | 33606106247 | GREEN | 7706d7f9 | 6c78eb50 | f3612757 | 34e4a225/9890c376/24d58206 | 0.3.1/0.3.1/0.3.1 |
| 2026-09-03 | 33731449658 | GREEN | c2ce7501 | 6c78eb50 | 4e3d3674 | 9e8249e2/9890c376/24d58206 | 0.3.1/0.3.1/0.3.1 |
| 2026-09-04 | 33851332032 | GREEN | c2ce7501 | 6c78eb50 | 4e3d3674 | 9e8249e2/9890c376/24d58206 | 0.3.1/0.3.1/0.3.1 |

Headline: **38 of 39 nights are green on test results** — the sum of `failed` across every
reported shard of every retained node night is **zero**, and the one non-green night (2026-08-03)
is the known evidence-incompleteness night (shard 16/16 produced no summary; run 30790778590),
not a test failure.

## 2. Restart history — node lane

38 fingerprinted nights → 37 night-to-night transitions → **17 fingerprint changes (46 % of
transitions), 15 distinct fingerprints.** "source moved" compares the two nights' `headSha`;
"inputs touched" is the git-verified count of files in the interval diff that feed the moved
component (packed inputs = `packages/{kn-next,lib,db}/`; harness inputs = the workflow +
`scripts/e2e-*` + `test/deploy-tests-manifest.*`).

| restart date | fp prev→new | component moved | source moved (headSha) | packed inputs touched | harness inputs touched | package delta | green run len killed |
|---|---|---|---|---|---|---|---|
| 08-03 | 55bd1c3c→43349a5f | harness | yes `0bcfec29..0e097d67` (10 commits) | 0 | 1 (workflow) | — | 5 |
| 08-04 | 43349a5f→8d099f93 | harness+packed | yes `0e097d67..70539cef` (13 commits) | 7 | 1 (manifest) | core content, same 0.3.0 | 0 |
| 08-05 | 8d099f93→c44d5e85 | packed | yes `70539cef..cfbdc23b` (11 commits) | 52 | 0 | core content +17 files; lib 0.2.0→0.3.0; db 0.2.1→0.3.0 | 1 |
| 08-07 | c44d5e85→37edc694 | harness | yes `daff506a..7b4d23f4` (3 commits) | 0 | 1 (workflow, −108/+69 lines) | — | 2 |
| 08-12 | 37edc694→8698abc6 | harness+packed | yes `7b4d23f4..d16734ee` (15 commits) | 15 | 1 (workflow) | core content, same 0.3.0 | 5 |
| 08-19 | 8698abc6→9e4ad6fe | packed | yes `bf1d3fdc..66ea5ef7` (3 commits) | **0** | **0** | core content, same 0.3.0 | 7 |
| 08-20 | 9e4ad6fe→2af54202 | packed | yes `66ea5ef7..9a1aa50b` (12 commits) | 8 | 0 | core content, same 0.3.0 | 1 |
| 08-21 | 2af54202→94eacb13 | harness+packed | yes `9a1aa50b..781376b7` (9 commits) | 35 | 1 (workflow) | core + lib content (+4 files), same 0.3.0 | 1 |
| 08-22 | 94eacb13→166fdded | packed | yes `781376b7..c1b962db` (21 commits) | 42 | 0 | core content +6 files, same 0.3.0 | 1 |
| 08-23 | 166fdded→c188961e | packed | yes `c1b962db..d5c4c9f2` (5 commits) | 4 | 0 | core content, same 0.3.0 | 1 |
| 08-25 | c188961e→a6232743 | packed | yes `39337cf3..55732d47` (8 commits) | 10 | 0 | core content, same 0.3.0 | 2 |
| 08-26 | a6232743→13896669 | packed | yes `55732d47..c2483e68` (9 commits) | 10 | 0 | all three 0.3.0→0.3.1 (version-bump release) | 1 |
| 08-27 | 13896669→c2ce7501 | packed | yes `c2483e68..ddadaff5` (3 commits) | 3 | 0 | core content, same 0.3.1 | 1 |
| 08-28 | c2ce7501→7706d7f9 | packed | **NO — same commit `ddadaff5`** | 0 | 0 | core content, same 0.3.1 | 1 |
| 08-29 | 7706d7f9→c2ce7501 | packed | **NO — same commit `ddadaff5`** | 0 | 0 | core content, same 0.3.1 | 1 |
| 09-02 | c2ce7501→7706d7f9 | packed | **NO — same commit `ddadaff5`** | 0 | 0 | core content, same 0.3.1 | 4 |
| 09-03 | 7706d7f9→c2ce7501 | packed | **NO — same commit `ddadaff5`** | 0 | 0 | core content, same 0.3.1 | 1 |

The 08-19 row is nondeterminism too, at a moving commit: the interval's 3 commits touched only
`packages/kn-next-operator/`, `docs/`, and `examples/` — zero packed inputs, zero harness inputs
— yet `@getknext/core`'s packed content digest moved.

### Cause tally (17 restarts)

| cause class | restarts | share | notes |
|---|---|---|---|
| packed change with packed inputs actually touched in the interval | 7 | 41 % | 08-05, 08-20, 08-22, 08-23, 08-25, 08-26, 08-27. One of these (08-26) is a pure release version-bump (0.3.0→0.3.1 on all three packages). |
| **packed change with ZERO source change (nondeterministic rebuild)** | **5** | **29 %** | 08-19 (interval touched nothing packed), 08-28, 08-29, 09-02, 09-03 (identical `headSha`). |
| harness + packed together | 3 | 18 % | 08-04, 08-12, 08-21 — merges touching both halves. |
| harness only | 2 | 12 % | 08-03, 08-07 — workflow/manifest edits. |
| node-version change | 0 | 0 % | The workflow's `node-version: 24` pin (harness digest) never changed across any restart interval; the node lane's ledger does not record the resolved runtime version. |
| next-version change | 0 | 0 % | `nextRef v16.2.0` / tarball `e43cbf1a` constant across all 38 fingerprinted nights; suite provenance is recorded-not-frozen and never moved. |
| unclassifiable | 0 | 0 % | Every restart classifies. |

Caveat on the first row: where packed inputs were touched, a merge-caused digest change and a
nondeterministic flip are indistinguishable — the 7/17 "merge-caused" figure is an upper bound.

## 3. The frozen-commit flip — the pack is nondeterministic in CI

From 2026-08-27 through 2026-09-04, **nine consecutive nightly runs all built the identical
commit `ddadaff5c6ee9f888dbfdc8e8f9fa2b1b2fdc614`** (`main` did not move — sprint 2's M3 merge
never happened). The packed component nonetheless alternated between exactly two values:

```
08-27  A (packed 4e3d3674, core 9e8249e2)
08-28  B (packed f3612757, core 34e4a225)
08-29  A
08-30  A
08-31  A
09-01  A
09-02  B
09-03  A
09-04  A
```

**4 flips in 8 transitions at a frozen commit.** Controlled-for variables, verified from the
`Prepare prebuilt next + harness` job logs of the 09-02 (B) and 09-03 (A) runs:

| variable | 09-02 (B) | 09-03 (A) |
|---|---|---|
| repo commit | `ddadaff5` | `ddadaff5` |
| runner image | ubuntu-24.04 `20260823.283.1` | ubuntu-24.04 `20260823.283.1` |
| node toolcache | 24.19.0 | 24.19.0 |
| dependency install | `pnpm install --frozen-lockfile` | `pnpm install --frozen-lockfile` |
| fingerprint script | `6a6ebe3a` (sole version ever) | `6a6ebe3a` |

Localisation, from the retained fingerprint artifacts of those two runs: the A/B difference is
**entirely inside `@getknext/core`'s packed content** — `@getknext/lib` and `@getknext/db` digests
are byte-identical across A and B, the core file **count** (134) and the full file **path set**
(including hash-named `dist/chunk-*.js`) are identical, and the version (0.3.1) is identical. So
one or more same-named files inside the tsup-built core `dist/` differ in bytes (or mode) between
two builds of the same source with the same toolchain. Which file cannot be recovered for past
nights — the `compat-workspace` artifact carrying the tarballs has `retention-days: 1`, and the
fingerprint artifact records per-file paths but per-package (not per-file) digests. Naming the
file requires a fresh repeated-build reproduction (not attempted here; measurement scope).

Relation to the 2026-09-04 discovered-fact measurement on #850: that measurement (three packs on
one machine at `agent/s2-tail`, one digest `fb964074…`) established that *re-packing an existing
build* is stable. The nightly re-**builds** from source each night; it is the build, not the pack,
that is bimodal. Both measurements stand; they measure different steps.

## 4. Where the 14-night clock stands (streak models)

Node lane, 38 fingerprinted scheduled nights, computed over the full retained history. "Standing"
= the streak alive after the 2026-09-04 night. Every model also requires the night green.

| window model | restart trigger | longest streak ever | span | standing today | nights still needed for 14 |
|---|---|---|---|---|---|
| **current rule (ADR-0039 / V1_ROADMAP §3)** | red night or ANY fingerprint change | **7** | 08-12→08-18 | **2** | 12 |
| harness-component only | red night or harness change | **15** | 08-21→09-04 | **15** | 0 — already ≥14 |
| packed-component only | red night or packed change | 7 | 08-05→08-11 | 2 | 12 |
| adapter-package only (`@getknext/core` content) | red night or core content change | 7 | 08-05→08-11 | 2 | 12 |
| green-only (fingerprint annotated, never fatal) | red night only | **32** | 08-04→09-04 | **32** | 0 — already ≥14 |

Rate framing for the current rule: 17 restarts in 37 transitions (0.46/night); **9 restarts fell
inside the most recent 14 nights (08-22→09-04)** — a span in which `main` was frozen from 08-27
onward. At the frozen-commit flip rate measured in §3 (4/8 transitions), the probability of 13
consecutive stable transitions — i.e. of a 14-night window opening — is on the order of
0.5¹³ ≈ 1/8000 **even if nothing merges at all**.

Per-lane (the runtime-axis reading of "axis"):

| lane | cadence | retained nights | test-green nights | longest window (current rule) | standing |
|---|---|---|---|---|---|
| node | nightly | 39 | 38 (the 39th is the 08-03 missing-shard night) | 7 | 2/14 |
| bun | weekly (Sundays; 08-02…08-30) | 5 | 0 — every night `failed: 3` (the deterministic #710 red; bun 1.3.14 recorded in-ledger) | 0 | 0/14 |
| vinext / compiled | no lane exists | 0 | — | — | no data possible |

## 5. Restarts avoided under the per-axis scope, both readings

The sprint-2 close report's draft skeleton uses "axis" in the **lane/target** sense
(sub-decision 2: a node-axis window may not back a claim about the compiled path). Under that
reading, **0 of 17 restarts would have been avoided (0 %)**: every measured restart is a
fingerprint change on the node lane itself, and scoping the *claim* per axis changes what the
window certifies, not when it restarts. The restart economics live entirely in sub-decision 3.

Under the **fingerprint-component** reading (a separate clock per frozen-set component):

| axis window | restarts avoided | share | standing today |
|---|---|---|---|
| harness axis (ignores packed churn) | 12 of 17 (the packed-only restarts) | 71 % | 15 — would already exceed 14 |
| packed axis (ignores harness churn) | 2 of 17 (the harness-only restarts) | 12 % | 2 |
| both axes tracked separately | 12 avoided on the harness clock, 2 on the packed clock; the 3 harness+packed restarts reset both | — | harness 15 / packed 2 |

For calibration of sub-decision 3's "narrow the fingerprint" option: narrowing packed to the
adapter package alone buys **nothing** (`@getknext/core` is the component that always moves —
§4 row 4), and 5 of its 12 solo restarts were not caused by any source change (§2).

## 6. Facts that bear on the amendment's premises (stated plainly)

1. **The amendment skeleton's premise (i) does not survive this measurement as written.** It
   says content-anchoring means "a no-op merge does not restart the window" and that packed-only
   restarts "were nights where shipped bytes genuinely differed." The bytes did differ — but for
   **5 of 17 restarts (29 %) no merge of any kind caused them**: 4 occurred at the identical
   commit with identical toolchain, and 1 in an interval whose commits touched no packed input.
   The restart cause is CI build nondeterminism inside `@getknext/core`, not shipping activity.
   Content-anchoring (correctly) removed tarball-byte churn; it cannot remove build-output churn.
2. **The window is unreachable under the current rule even with a total merge freeze.** #850
   framed 14 stable nights as requiring "a fortnight in which nothing that lands alters the
   packed tarballs." `main` then froze for 9 nights — and the window restarted 4 times anyway
   (§3). This is the "unreachable anchor" configuration the skeleton's own options table names
   as the failure mode of keep-and-accept, now measured rather than hypothesised.
3. **Test failures remain a non-obstruction, now over the full history.** 0 test failures in 38
   fingerprinted node nights, 0 re-runs in 44 of 44 retained ledgers. The single non-green night
   is evidence-incompleteness (08-03), already the subject of #695's fix.
4. **The suite-provenance design decision is validated by absence:** `NEXTJS_REF`/next-tarball
   never moved in 38 nights, and caused 0 restarts. Node-version likewise 0. Every restart is
   harness- or packed-attributable; nothing was unclassifiable.
5. **A per-lane window changes certification, not reachability** (0 % restarts avoided, §5); a
   per-component or reshaped window changes reachability materially (§4: harness-axis and
   green-only models are already ≥14 today).
6. **Scale check on #850's original numbers:** the issue measured 10 restarts / 27 nights /
   longest 7 / standing 2 over 07-28→08-24. The full history says 17 restarts / 38 nights /
   longest 7 / standing 2 — same shape, and the restart *rate* did not improve after the
   fingerprint-anchoring work landed, because anchoring was never the binding constraint.

Point 1 is a discovered fact in the workflow.md sense for the A6 amendment: the amendment text
drafted at sprint-2 close attributes all packed restarts to genuine shipping activity, and the
ledger contradicts that attribution. It does not invalidate sub-decisions 1–2 (content-anchoring
stays correct as a rule; axis scoping is untouched by it), but sub-decision 3 must be made
against §2–§4's numbers, including the frozen-commit flip.

## Limits

- Nothing earlier than 2026-07-28 is measurable (no retained ledgers; the artifact did not exist).
- The flipping file inside `@getknext/core` cannot be named from retained artifacts (per-package
  digests only; the tarball-bearing artifact expires after 1 day). A repeated-build reproduction
  is the follow-up if A6 needs the mechanism, not just the rate.
- Where a restart interval did touch packed inputs, merge-caused change and a coincident
  nondeterministic flip are indistinguishable; 7/17 "merge-caused" is therefore an upper bound.
- The frozen-commit flip rate (4/8) has small n; treat it as "order of one flip every two nights,"
  not a precise probability.
