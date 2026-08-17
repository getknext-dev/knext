# vinext + bun bytecode vs node — OKE cold-start A/B (2026-08-17)

**Sitting:** `abba-20260817T205200Z`. **Cluster:** OKE `context-ckmva7v7zvq`, 2 nodes, amd64, flannel.
**Arms:** `p1b-bunexec` (vinext + `bun build --compile --minify --bytecode`) vs `p1b-node`
(`npx next build --turbopack`, node 24.14.0). **Driver:** `benchmarks/scale-to-zero-oke/abba.sh 6`,
ABBA-interleaved, 6 blocks. **Analysis:** `benchmarks/scale-to-zero-oke/abba-analyze.mjs`.

## Result

**No significant difference, and the direction favours node.** vinext + bytecode did **not** reproduce
its in-container advantage on the cluster.

| Metric | p1b-bunexec | p1b-node |
|---|---|---|
| n (usable) | 11 | 12 |
| median | **3050 ms** | **2450 ms** |
| IQR | [2390, 6900] | [2168, 2825] |
| range | 1820–12320 | 2040–11640 |

- median difference **+600 ms** (bunexec slower); Hodges-Lehmann **+550 ms**
- Mann-Whitney **U=50, z=−0.985, p=0.325** — **not significant**
- **distribution separation: NO** — ranges overlap heavily

**ADR-0036's bar is distribution separation, not a median difference. This run does not clear it, and
it does not clear it in the direction the flip needs either.**

## Stratified by mode — required, not optional

Both arms went bimodal late in the sitting, so a bare median is inadmissible (ADR-0036 D6/D7: *no bare
median across a mode mixture; stratify by mode*). Split at 8 s:

| | fast mode | slow mode |
|---|---|---|
| **bunexec** | n=8, median **2815 ms**, range 1820–3400 | n=3: 12320, 10400, 10740 |
| **node** | n=10, median **2405 ms**, range 2040–3170 | n=2: 10300, 11640 |

Fast mode only: difference **+410 ms** (bunexec slower), Mann-Whitney **p=0.477** — still not
significant, same direction.

**The slow mode is temporal, not per-arm.** It fired at bunexec sample positions 9, 10, 11 and node
positions 10, 12 — i.e. the tail of the sitting, on both arms. That is the drifting bimodal slow mode
ADR-0036 documents and the reason Run 24 was withdrawn. ABBA interleaving is what kept it from
loading onto one arm; it is also why a longer sitting is not automatically a better one.

## What this does and does not settle

**Settles:** the cold-start motive for the flip is **not demonstrated on OKE**. Two independent
readings (pooled and fast-mode-only) agree on direction and magnitude, and neither is significant.

**Does not settle:**

- It does **not** show node is faster. p=0.325/0.477 means *no difference was demonstrated either
  way*, on n≈11 per arm with a heavy right tail. Do not invert this into a claim for node.
- It does **not** contradict the in-container bytecode result. That measured `--bytecode` on vs off
  **within one arm** (~33%, 30/0 paired) and is about **runtime boot**. This measures node-vs-bun
  **end-to-end on Knative**, where cold start is dominated by scheduling and image pull. Both can be
  true: bytecode makes boot faster, and boot is not what dominates here.
- It is **one sitting**. ADR-0036 D5 forbids pooling across sittings, so this cannot be merged with
  earlier runs to raise n.

## Why the boot win does not show up

Cold start here is **scheduling- and pull-bound**. The bunexec image is **42.9 MB compressed**, ~89%
of it the embedded Bun runtime; the node image carries a baked V8 compile cache (ADR-0035) rather than
a 92 MB runtime. A boot advantage measured in tens of milliseconds is invisible against a cold path
measured in seconds — and a larger pull works against it.

## Admissibility

- **Same-app precondition: SATISFIED and machine-checked.** Every sample recorded
  `arms-same-app=yes` from `dev.knext.app.id = app-159989384ca3275f` on both deployed digests. This is
  the condition whose failure withdrew Run 25/26.
- **1 sample lost, correctly.** `p1b-bunexec-20260817T210500Z` aborted with *INADMISSIBLE A/B: the
  declared app id could not be read* — a registry lookup timeout. The harness refused to measure
  rather than produce an unprovable number. Reported, not dropped.
- **Not admissible as a Phase 1 pass regardless of outcome:** `P1-pre-2` (slow-mode tail controlled)
  is unmeasured, and the slow mode visibly fired during this sitting. The node arm also still has no
  committed build recipe in the repo.

## Reproducing

```bash
benchmarks/scale-to-zero-oke/abba.sh 6 <sitting> default
benchmarks/scale-to-zero-oke/abba-analyze.mjs <sitting>
```

Raw per-sample files are in `benchmarks/scale-to-zero-oke/results/` — **gitignored**, so they exist
only in the working tree that produced them. The per-arm values are transcribed here so the analysis
survives the tree:

```
bunexec: 1820 3280 2630 2150 3400 3050 1850 3000 12320 10400 10740
node:    2160 2060 2460 2480 2710 2040 2170 2440 2370 10300 3170 11640
```
