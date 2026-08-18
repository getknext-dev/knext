# file-manager, same source: vinext+bytecode (warm entry) vs node — OKE cold-start A/B (2026-08-18)

**Sitting:** `fm-fair-20260818T184426Z`. **Arms:** `fm-vinext` (vinext beta.4 + `bun --compile
--minify --bytecode`, **eager-warm entry**) vs `fm-node` (`next build --webpack`, node 22, standalone,
`NODE_COMPILE_CACHE`). **Same-app by construction:** both images built from one source tree,
both digests stamped `dev.knext.app.id=fm-src-fcd5e86eb80f232c` (`crane mutate`), the harness's
same-app gate green on every sample. **Env identical** (11 vars incl. Redis/PG/GCS). **PG held warm**
via `deploy-spike/pg-keepwarm.yaml`. Driver `abba.sh 3` (ABBA-interleaved); analysis
`abba-analyze.mjs`.

## Result — the direction REVERSED once the lazy entry was fixed

| | n | median | IQR | range |
|---|---|---|---|---|
| **fm-vinext** (warm entry) | 6 | **2450 ms** | [2165, 3508] | 1950–15010 |
| **fm-node** | 5 | **3780 ms** | [3770, 3780] | 3570–4160 |

- median difference **−1330 ms (vinext faster)**; Hodges-Lehmann **−1390 ms**
- Mann-Whitney U=8, z=−1.278, **p=0.201 — not significant** at n=5/6
- **distribution separation: NO** (driven by one vinext outlier)

Same numbers with the 15,010 ms outlier stated separately: vinext `1950 2150 2210 2690 3780`
(median **2210 ms**) vs node `3570 3780 3780 3770 4160` (median **3780 ms**) — the two ranges then
overlap only at a single point (3780/3570). **The outlier is most plausibly the first pull of the
freshly `crane mutate`-minted digest** (created ~20 min before the run; both digests verifiably
cached on both nodes after the sitting) — stated as likely attribution, not fact.

One `fm-node` sample **lost, correctly**: its k6 Job never completed within 600 s (`peak pods = 0` —
the probe itself never launched); the harness refused to count it.

## Why the reversal, in one line each

- **Yesterday (lazy entry, PG cold, DIFFERENT builds):** vinext 5.55 s vs node 3.34 s — inadmissible
  as a runtime A/B, and vinext was paying ~1.2 s lazy app-graph evaluation *after readiness* plus a
  ~2.3 s PG wake on its first render.
- **Today (warm entry, PG warm, SAME build):** vinext 2.45 s vs node 3.78 s. The entry now evaluates
  the app graph at startup, overlapped with the readiness window (`WARMED:… ms=480` on OKE); node
  still boots its full standalone server (~2.6 s to `Ready` even with the compile cache) *inside* the
  critical path.
- The two prior sittings did not contradict this one — they measured a different entry, a different
  cache state, and (yesterday) a different application.

## What this does and does not settle

- **Does not clear ADR-0036's separation bar** (p=0.201, ranges overlap). It is a directionally
  consistent median shift on the first *admissible* same-app real-app sitting, nothing stronger.
- **Does not transfer to the toy A/B** (#759 record): that measured the *lazy* entry on a 5-route app
  where there is almost no app graph to warm — its result stands for what it measured.
- **The warm entry is the variable that moved.** Same cluster, same day, same source: lazy entry
  slower than node; warm entry faster than node. The fix is gated (`WARMED:` asserted in the alpine
  e2e, mutation-proved).
- n=5/6 with one likely-pull outlier. A 6-block rerun with pre-pulled digests (or ADR-0037
  `imagePrewarm`) is the cheap way to a publishable claim.

## Cold-start budget after both fixes (from the pod-level decomposition)

| phase | ms |
|---|---|
| Knative wake + schedule + container start | ~1600 |
| boot → LISTENING (bytecode shell) | ~400–500 |
| app-graph evaluation | **overlapped** (480 ms, hidden) |
| render + data (PG warm) | ~300–600 |

**Sub-second end-to-end cold start is now an infrastructure problem** — probe cadence, activator
path, scheduler — not an application problem. The app-side contribution is ~0.8–1.0 s.

## Raw samples (ms)

```
fm-vinext: 2210 3780 2690 15010 2150 1950
fm-node:   3780 3570 3780 3770 4160          (+1 lost: k6 job timeout, peak pods 0)
```
