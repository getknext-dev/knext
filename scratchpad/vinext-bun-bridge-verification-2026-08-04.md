# vinext → `bun --compile` bridge: verification findings (2026-08-04)

**Question asked:** ADR-0036 names the `vinext → .output/server/index.mjs → bun build --compile
--bytecode` bridge as "**unproven** … the #1 risk P1 must retire … if that bridge can't produce a
running binary, that is the NO-GO trigger." Prove or disprove it on a minimal App-Router sample.

**Answer: the bridge WORKS. YES — verified end to end, twice, on two different vinext major
lines.** The NO-GO trigger does not fire.

---

## 0. Read this first — the task premise was stale

The bridge was **not** unproven when this task was written. ADR-0036's own action-item log records it
as built and fixed months ago:

- **P3 increment 1 (#447)** landed `examples/bun-exec/` — the recipe, the bespoke bun entry, and the
  `RuntimeContract` wiring.
- **#460** root-caused and fixed the two bugs that made the first binary 404 outside its build dir.
- The ADR's close-out (2026-07-28) rejects the target **for reasons that have nothing to do with the
  bridge** — no distribution-separated cold-start win (Run 26), `next/image` lost under vinext, and
  no green compat lane.

The "#1 risk / unproven bridge" sentence quoted in the task is from the **P1 feasibility section
(2026-07-20)**, which the later action items supersede. This is the workflow.md **"discovered fact
that invalidates the plan"** escalation trigger, and it is flagged rather than quietly worked around.

So this session did not build a new spike. It **independently re-verified the existing recipe from a
clean state** and produced the measurements the task asked for, plus three findings the existing
recipe and README get wrong or do not cover.

---

## 1. Versions actually used (measured, not assumed)

| component | version | note |
|---|---|---|
| `bun` | **1.3.5** | ADR's Run-26 forensics used 1.3.14 |
| `node` | v24.14.0 | harness only |
| `vinext` (recipe pin) | **0.0.19** | MIT |
| `vinext` (current on npm) | **1.0.0-beta.4** | ADR cites 1.0.0-beta.2 — upstream has moved |
| `nitro` | 3.0.1-alpha.2 | recipe pin; **not a dependency at all** under vinext beta.4 |
| `vite` | 7.3.6 (pin) / 8.2.0 (beta.4 path) | |
| `next` | **not installed** | see §5 — vinext replaces Next; there is no `next` package |
| host | darwin 25.5.0, Apple Silicon; Docker/OrbStack 29.4.0 | |

## 2. The exact pipeline that works

```
bun install --frozen-lockfile
./node_modules/.bin/vite build          # vinext() + nitro({preset:'bun', entry:'./knext-bun-entry.mjs'})
                                        #   → .output/server/index.mjs  (+ .output/public)
bun build --compile --minify --bytecode \
    --target=bun-linux-x64-musl \
    .output/server/index.mjs --outfile knext-bun-exec-linux-x64
```

**Correction to the ADR text:** the ADR describes the bridge as "vinext (**Nitro node preset**) →
.output/server/index.mjs → bun build --compile". The working recipe uses the **nitro `bun` preset**,
not the node preset, with a bespoke entry. The node preset is not what was proven.

### Verified running — routes probed on the compiled binary

Run from a **clean directory** containing only the binary + `.output/public` (no `.output/server`,
no `node_modules` — asserted, not assumed):

| route | result |
|---|---|
| `GET /` (SSR page) | 200, rendered HTML |
| `GET /api/health` (route handler) | 200 `{"status":"ok","target":"bun-exec"}` |
| `GET /slow` (2 s handler) | 200 `drained-ok` |
| `GET /definitely-not-a-route` | 404 |
| `GET /item/:id` (**dynamic page**, added by this spike) | 200, param bound |
| `GET /api/echo/:slug` (**dynamic handler**, added by this spike) | 200 `{"echoed":"hello"}` / `{"echoed":"world"}` |
| `POST /api/cache/invalidate` no token | **401 fail-closed** |
| `POST /api/cache/invalidate` + Bearer | 200 |
| `GET :9091/metrics` | 200, Prometheus text |

**New coverage:** the shipped example had **no dynamic route**. This spike added `app/item/[id]/page.tsx`
and `app/api/echo/[slug]/route.ts` and confirmed dynamic segments and param binding survive
`--compile --bytecode` on both vinext lines. That dimension was previously untested.

## 3. Sizes (real numbers)

| artifact | bytes | |
|---|---|---|
| binary, `bun-darwin-arm64` | 61 MB | |
| binary, `bun-linux-x64-musl` | **100,544,401 (96 MB)** | ship target |
| binary, `bun-linux-arm64-musl` | 95,621,651 (91 MB) | |
| **image** `FROM alpine:3.22` + binary + `.output/public`, amd64 | **109,060,359 (109 MB)** | |
| image, arm64, + `apk add libstdc++ libgcc` | 107,299,377 (107 MB) | the one that actually runs |

**ADR-0036's ~90–110 MB estimate is CONFIRMED.** The embedded Bun runtime dominates; the app is
noise. The "5 MB alpine image" idea remains wrong.

## 4. Cold start — feasibility numbers only

> **This is NOT the ADR-0036 P1b OKE A/B and must not be cited as one.** Single machine, one app, no
> node arm, no interleaving. It measures feasibility, nothing comparative.

**Container start → first successful `/api/health`**, `docker run` → first 200, arm64, n=12:

```
min 220.2  p50 241.9  p90 259.1  max 279.2 ms
220, 228, 231, 233, 235, 236, 242, 246, 248, 248, 259, 279
```

Tight, no slow mode locally — the ~10.5 s tail in benchmark Runs 24/26 is a cluster property and did
not reproduce on a laptop, which is consistent with the ADR's own conclusion that it is cluster-level.

**Decomposition** — the container number is dominated by Docker, not the app:

```
docker container-start floor (`docker run alpine true`): p50 330.8 ms   [not directly comparable*]
compiled binary native boot -> first 200 (vinext 0.0.19): p50  26.7 ms  (n=12, 26..28, one 1739 ms cold-page-cache first run)
compiled binary native boot -> first 200 (vinext beta.4): p50  35.1 ms  (n=10, 34..45)
```

\* the floor harness waits for container **exit**, the cold-start harness only until first response,
so the floor is not a strict subtrahend. Reported for scale, not arithmetic.

**~27–35 ms of app boot against Next standalone's ~1957 ms is the real, reproducible finding** — and
it matches the ADR's Run 13 microbenchmark. It is also exactly what the ADR says does *not* survive
to end-to-end cold start, because boot is a small fraction of it.

## 5. What breaks — the honest list

1. **`FROM alpine` + the binary alone DOES NOT RUN. This is a live bug in the recipe's own
   documented ship shape.** The `-musl` targets are **not statically linked**:
   ```
   Error loading shared library libstdc++.so.6: No such file or directory (needed by /app/server)
   Error loading shared library libgcc_s.so.1: No such file or directory (needed by /app/server)
   Error relocating /app/server: _ZSt20__throw_length_errorPKc: symbol not found   (+ ~30 more)
   ```
   Container exits **127**. Fix: `RUN apk add --no-cache libstdc++ libgcc` (+2 MB). ADR-0036's table
   says the image is "`FROM alpine` + the single binary"; that is **wrong as written**. It was never
   caught because every prior validation ran the binary on a host or a base that already had these.
2. **`next` is not a dependency, so "the official Next.js adapter" has no meaning on this path.**
   vinext is a separate reimplementation. Every parity claim must come from the compat suite; nothing
   about Next's own version applies.
3. **Upstream pin is deep and brittle.** The recipe pins `vinext@0.0.19` + `nitro@3.0.1-alpha.2` — an
   **alpha** and a pre-1.0 — because 1.0.0-beta.2 emitted a runtime-chunked server `--compile` could
   not embed (#460). vinext is now **1.0.0-beta.4** and still beta.
4. **Upgrading vinext is not a version bump, it is a toolchain migration.** `vinext@1.0.0-beta.4`
   fails on Vite 7 with `SyntaxError: The requested module 'vite' does not provide an export named
   'parseSync'` — it requires **Vite 8**, and drops the `nitro` package entirely.
5. **What did NOT break:** no native-module failure, no dynamic-`require` failure, no `node:` builtin
   divergence, no top-level-await problem. The failure modes the task hypothesised did not occur.

## 6. Finding that contradicts the current README

**`vinext@1.0.0-beta.4` + Vite 8 IS self-contained.** Built and run from a clean dir with only the
binary + `.output/public`: all 12 routes above pass, including both dynamic ones. The README states
the newer betas "emit a runtime-chunked server that `--compile` cannot embed → the binary 404s
outside its build dir". That was true of **beta.2**; it is **no longer true of beta.4**. Its
`.output/server/` is still visibly chunked (`_ssr/rsc.mjs`, `_ssr/ssr.mjs`), yet `bun build` bundles
35 modules and embeds them — so chunked-on-disk no longer implies not-embeddable.

Consequence: the alpha/pre-1.0 pin in finding 3 is **probably no longer necessary**. Anyone reviving
this path should re-test the modern pin rather than inherit the alpha. Not proposed as a change here
— the target is rejected for 1.0 and this is a spike.

## 7. Bottom line

| question | answer |
|---|---|
| Does the bridge produce a running binary? | **YES** — verified on vinext 0.0.19 **and** 1.0.0-beta.4 |
| NO-GO trigger fires? | **No** |
| Image size | **109 MB** (amd64, alpine) — ADR's 90–110 MB confirmed |
| Cold start (local, feasibility) | container p50 **242 ms** (n=12, 220–279); binary's own boot p50 **27 ms** |
| What breaks | bare-alpine missing `libstdc++`/`libgcc` (exit 127); beta upgrade forces Vite 8; vinext still beta |

**What this does NOT establish**, and no one should read it as establishing: that `bun-exec` is
faster end to end. ADR-0036 was rejected on the A/B, the compat lane, and `next/image` — **not** on
the bridge. Retiring the bridge risk changes none of those three. The ADR's re-open trigger (same app
both arms, interleaved ABBA, digest-asserted, stratified by mode) is untouched by this work.

## 8. Reproducing

Spike artifacts: `examples/bun-exec/.spike/` (gitignored — build outputs are 60–100 MB each).

```
cd examples/bun-exec
bun install --frozen-lockfile && ./build.sh darwin-arm64     # or linux-x64 / linux-arm64
node .spike/probe.mjs <appPort> <metricsPort>                # route probes
node .spike/probe-dyn.mjs <appPort>                          # dynamic-route probes
node .spike/coldstart.mjs <image> linux/arm64 12 /api/health # cold-start distribution
node .spike/baseline.mjs 12 <binary> <cwd>                   # docker floor + native boot
```

Nothing in `packages/kn-next`, the operator, the CRD, or the CLI was modified. No cluster was
touched.
