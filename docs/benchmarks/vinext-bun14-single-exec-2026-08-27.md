# vinext single-exec vs Next standalone — Bun 1.4, bytecode, single executable

**Date:** 2026-08-27 · **Host:** Darwin/arm64 laptop under load · **App:** `examples/bun-exec`,
app id `app-6bf934d9091b5c24` **identical across all five arms** (this is what makes it an A/B and
not five different apps).

## Method

- **Cold start** = `spawn(t=0)` → first HTTP response carrying a status. Fresh process, fresh port,
  every sample. Deliberately NOT "time to log ready", which flatters an in-process entry that logs
  before it can serve. n=10.
- **Throughput** = completed requests/sec, concurrency 20, 5 s, after 200 discarded warmup requests.
- **Route: `/api/health`** — `force-dynamic`, and verified **byte-identical on every arm**: 35 bytes,
  sha256 `7b872305fef5c052`, no compression anywhere.

## Results

| variant | cold median | min | p95 | vs node | req/s | vs node |
|---|---|---|---|---|---|---|
| node + turbopack (standalone) | 884 ms | 809 | 1029 | 1.00× | 630 | 1.00× |
| bun 1.4 + turbopack (standalone) | 703 ms | 593 | 882 | 1.26× | 714 | 1.13× |
| bun 1.4 + turbopack + **bytecode** | 554 ms | 288 | 692 | 1.59× | 537 | 0.85× |
| **vinext single-exec** (bun 1.3.5) | 121 ms | 85 | 286 | 7.28× | 1053 | 1.67× |
| **vinext single-exec** (bun 1.4.0) | **61 ms** | **38** | **131** | **14.50×** | **1103** | **1.75×** |
| bun 1.3.5 + turbopack | — | — | — | — | — | **does not serve** |

## Findings

**1. The single executable is ~14× faster to first response, and wins throughput too.** 61 ms vs
884 ms. Its p95 (131 ms) is better than node's *best* sample (809 ms) by 6×. For scale-to-zero the
tail matters more than the median, and the tail is where the gap is widest.

**2. Bun 1.4 doubles the single-exec's cold-start advantage over 1.3.5** — 61 ms vs 121 ms, same
app, same build recipe, only the compiling Bun differs.

**3. Bun 1.3.5 cannot serve the standalone tree at all.** HTTP 500:
`Expected CommonJS module to have a function` / `Failed to load external module next`. Bun 1.4.0
serves the identical tree at 200. So `runtime: bun` on turbopack is not merely faster on 1.4 — on
this app it is the difference between working and not.

**4. The bytecode pass buys cold start and COSTS throughput.** 1.59× faster to start, but 0.85×
the requests/sec. Confirmed over three further reps (635→555, 674→601, 595→442 req/s), so it is a
real trade rather than noise. It is the right trade for scale-to-zero and the wrong one for an
always-warm service. Cost to produce: 41.2 s for 1105 files.

## A correction worth recording

The first run measured `/` and produced the opposite throughput conclusion — vinext at **0.50×**
node. That was an artifact, not a result: on `/` the single-exec serves **10,958 uncompressed bytes**
against the standalone's **6,646 gzipped** — a different page entirely (different sha), with no
`content-encoding`. It was being charged for 65% more bytes with compression off.

Checking payload equivalence before believing a throughput number is the whole lesson. The
corrected figure is 1.75×, not 0.50× — the sign of the conclusion flipped.

## Caveats

- A loaded laptop, not the cluster. **Absolute milliseconds are not deploy numbers**; the ratios
  between arms on identical hardware are the signal. Cluster cold start also carries scheduling,
  image pull and DNS, which dominate and are measured separately in the cold-start ledger.
- Single app, single route. `/api/health` isolates runtime and request-path cost; it does not
  exercise RSC rendering, data fetching or ISR.
- The single-exec arms are `--compile --minify --bytecode` Mach-O binaries (66.8 MB on 1.3.5,
  69.9 MB on 1.4.0). Binary size is a real deployment cost this table does not price.
