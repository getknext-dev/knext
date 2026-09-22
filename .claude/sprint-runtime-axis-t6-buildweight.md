# T6 — Firm the build-weight evidence for ADR-0054

**Status: DONE (audit).** jev picked `audit_and_tighten` over a full re-measure (0.87 vs 0.13;
defer 0.00). Exit criterion "build-weight re-measured + recorded" met as: V2 method audited, the
claim's conditionality made precise, ADR-0054 tightened.

## What T6 was for
The founder flagged inherited claims after the sibling **61 ms** cold-start number proved a
misleading warm-binary micro-bench. T6 asks the same of build-weight's **"vinext 31% larger."**

## Finding: the 31% is honest, but conditional — and it is NOT the misleading kind
Unlike 61 ms (which silently excluded the dominant cluster path), the V2 build-weight measurement
(`docs/wayfinder/v2-build-weight.md`, dated 2026-08-03, every number produced by commands in its §9,
3 arms: `next --webpack` / `next build` Turbopack / `vinext build` on `apps/file-manager`) is
self-qualifying and states its own counter-evidence:

| Comparison | vinext vs Next | who's lighter |
|---|---|---|
| Raw shipped bytes vs Turbopack `next build` | 37.14 vs 44.22 MB | **vinext −16%** |
| Raw shipped bytes vs `--webpack` | 37.14 vs 52.05 MB | **vinext −29%** |
| At image-opt parity (Next minus `sharp`) vs Turbopack | 37.14 vs 28.36 MB | **vinext +31%** |
| At image-opt parity vs `--webpack` | 37.14 vs 36.20 MB | vinext +2.6% |

So "vinext 31% larger" is true **only** at image-optimisation capability parity against the
Turbopack build. In raw bytes vinext ships *less*. The raw win is bought by omitting image
optimisation (`sharp` = 15.85 MB on the Next side) and by vinext shipping `@vercel/og` + stack
unconditionally (14.50 MB = 39% of its artifact, for apps using no OG images).

## Consequence for ADR-0054
ADR-0048's premise was "vinext is the **lighter** artifact." The honest verdict:
- **For an app that forgoes image optimisation:** vinext IS lighter (raw win stands).
- **For a capability-complete knext app** (image optimisation is ADR-0006 core): vinext is **not**
  lighter — +31% vs Turbopack, ≈tied with webpack.

The ADR's earlier "favours node / premise inverted" **overstated** it and was corrected to this
conditional read. Build-weight is therefore **not a vinext advantage for knext's target app**, but
neither is it a clean node win — it is a wash-to-slightly-vinext-heavier at parity. The load-bearing
point for #605 is unchanged: build-weight does **not** justify vinext-only.

## Why no full re-measure
V2 is dated (Next 16.2.10 + vinext beta.4); apps now pin beta.8, tree on 16.3.5. A full 3-arm
rebuild on the drifted toolchain risks the 16.3.x/beta-pin residue and would add run-to-run noise to
a claim that is already correctly conditional and reproducible via V2 §9. jev 0.87 to audit rather
than re-run. If the sprint-close gate wants a fresh number, the V2 §9 commands are the recipe.

## Distinct from image size
Do not conflate: **build weight** = standalone artifact bytes (above). **Image size** = the deployed
*container image* (OKE bench: vinext single-exec 42.9 MiB vs node-standalone 66.6 MiB). Image size is
vinext's one surviving real edge; it is a different measurement from build weight.
