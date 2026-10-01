# GKE cold start: Node vs Bun with bytecode caching, and how to minimise each phase (2026-10-01)

**Questions** (founder, 2026-10-01). On GKE: (1) are the cold-start numbers the same for Node and
Bun *with bytecode caching*, phase by phase, and what does bytecode caching buy each runtime?
(2) What minimises each phase?

**Answers.**

1. **No, they are not the same.** With bytecode caching verified live in both, Bun × turbopack
   wakes **~0.7 s faster** than Node × turbopack on this cluster (2998 vs 3733 ms, −734 ms, Holm
   p = 0.0015, n = 11 each; replicated in a second run, −665 ms, Holm p = 6.5e-5). The gap sits
   in **boot** (bound → listening −471 ms: Bun's compiled executable reaches `listen` in ~230 ms vs
   Node's ~590 ms) and partly in **listening → first byte** (−229 ms, not significant after Holm).
   Activation and scheduling are identical. **The gap is a property of the CPU**: on a
   `c3-standard-4` node the same pair differs by only 94 ms (1879 vs 1973 ms, Holm p = 0.21) —
   Bun still binds ~0.2 s sooner, but the post-listen leg is identical. (The 2026-09-30 OKE
   sitting's totals tie at n = 10 is consistent with that: faster CPUs, smaller gap.)
2. **What bytecode buys:** Node's baked `NODE_COMPILE_CACHE` is worth **~0.27 s** per wake
   (3733 vs 4007 ms off, p = 0.003, Holm 0.095); Bun's `--bytecode` is worth **~0.54 s**
   (2998 vs 3537 ms off, Holm p = 0.005). Even with **both** caches off Bun is still 0.47 s faster.
   And Bun's **self-contained** executable — which also compiles the route and instrumentation
   chunks to bytecode — is a further **−0.96 s** (2043 ms, Holm p = 0.0002): the largest
   runtime-side saving measured (only the faster machine family beat it).
3. **The biggest lever is not Knative and not the runtime: it is the scaffolded app's
   instrumentation.** The ~1.3–1.5 s "listening → ready" phase is not a lazy first request; it is
   the app's `instrumentation.ts` `register()` eagerly evaluating a 1.7 MB chunk (`@vercel/otel`,
   `@cerbos/grpc`, `minio`, `prom-client`) **right after `listen`**, even though tracing is off and
   `registerNode()` returns on its first line. Making `register()` skip that import when tracing is
   off saves **−0.91 s (Bun) / −0.82 s (Node)** per wake (Holm p ≤ 0.0014). A warm-up request
   before readiness (#1761) saves **nothing** (−0.10 s Bun, n.s.; +0.00 s Node) because nothing
   is lazy — the work is already running from `listen`. On the infrastructure side, moving the
   same pods from `e2-standard-4` to `c3-standard-4` nodes saves **−1.28 s (Bun) / −1.95 s
   (Node)**, and a 4-CPU limit (the ceiling of a startup CPU boost) saves −0.68 s on `e2`.

Ranked levers with sizes and where each ships: [How to minimise](#how-to-minimise-ranked).

## Setup

Same cluster, harness and apps as the morning's GKE sitting
([`cold-start-phase-breakdown-gke-2026-10-01.md`](cold-start-phase-breakdown-gke-2026-10-01.md)):
`knext-coldstart` (zonal Standard, `us-central1-a`, 3 × `e2-standard-4`, VPC-native, Dataplane V2
off, k8s 1.35.8, containerd 2.2.7), Knative Serving 1.16 + Kourier, the knext operator from PR
#1762 (the ARP primer is off for every arm here). App: the 2026-09-30 release-cell app (default
scaffold, `next` 16.3.5, `@getknext/core` 1.0.0-rc.2, one `force-dynamic` page that fetches
`/api/items`), images by digest:

| cell | image |
|---|---|
| Bun × turbopack (baseline) | `bench-cells-bun-turbopack@sha256:386c1c36…` |
| Node × turbopack (baseline) | `bench-cells-node-turbopack@sha256:c8d290ee…` |

**One variable per arm.** Every variant image is built `FROM` the baseline digest and changes one
file (Cloud Build `270c586e…`/`6f1ec278…`, `docker buildx`, recipe in
[`gke/variants/`](../../scripts/bench-cold-start-phases/gke/variants/)), or the
arm is the baseline image with one `NextApp` field or env var changed
([`gke/nextapps-runtime-min.yaml`](../../scripts/bench-cold-start-phases/gke/nextapps-runtime-min.yaml)).
Each arm's rendered Knative Service was read back before any wake
([`gke/verify-arms.sh`](../../scripts/bench-cold-start-phases/gke/verify-arms.sh)): identical
command, probes (`GET /api/health`, no `periodSeconds` — Knative's aggressive probing), resources
(250m/512Mi requests, 1 CPU/1 Gi limits), volumes and env, except for the named variable. No
Knative Service was patched by hand; everything went through `NextApp` CRs.

| arm | the one difference |
|---|---|
| `bc-bun-nobc` | the standalone executable recompiled from the image's own tree with the image's own `standalone-compile` **without `--bytecode`** (verifier confirms: entry pragma `// @bun @bun-cjs`, no `@bytecode`) |
| `bc-bun-script` | `STANDALONE_SERVER_EXEC=""` → the supervisor runs the uncompiled `bun server.js` |
| `bc-bun-sc` | the **self-contained** executable (`--self-contained 1`: 231 modules incl. 41 from `.next/server` embedded, 5 route chunks bytecode-verified), started through the shipped self-contained compat shim |
| `bc-node-nocc` | `NODE_DISABLE_COMPILE_CACHE=1` (Node's documented opt-out) |
| `bc-bun-noinstr` / `bc-node-noinstr` | `.next/server/instrumentation.js` replaced by `module.exports = { register: async () => {} }` |
| `bc-bun-warm` / `bc-node-warm` | entry wrapper that GETs `/api/health` on localhost every 20 ms from process start until the first 200, then hands off to the unchanged supervisor |
| `bc-bun-rwfs` | `security.readOnlyRootFilesystem: false` (the pod then has no `emptyDir` volume) |
| `bc-bun-cpu4` | `resources.cpuLimit: "4"` (request unchanged) |
| `bc-bun-twin` / `bc-node-twin` | spec-identical twins of the baselines, woken only on a `c3-standard-4` node |

**Instrument.** The in-cluster per-phase harness from the morning sitting
([`scripts/bench-cold-start-phases/`](../../scripts/bench-cold-start-phases/), GKE copies in
`gke/`), unchanged except: `gke/drive.py` can place an arm on one node pool (`arm@pool` cordons the
other pools for that wake only) and reads `dns-probe.js` from the parent directory (the morning copy
pointed at a file that only existed one level up), and `gke/cold-cycle.mjs` finds the phase agent of
any node by label (for the new pool). Phases, clocks and statistics are as in the
[OKE doc's Method](cold-start-phase-breakdown-2026-10-01.md#method). New tooling:
[`gke/compare.py`](../../scripts/bench-cold-start-phases/gke/compare.py) prints per-phase tables
with **Holm correction across every p-value in one table family** (exact two-sided Mann-Whitney,
bootstrap 95% CI of the median difference, 4000 resamples).

Two combined phases are reported because two phase boundaries are runtime-dependent: "first log
line from either container" (3|4) is Bun's executable for Bun but queue-proxy for Node, and
"ready" (5|6) is the earliest of three signals whose order differs by runtime. **`3+4` (bound →
listening) and `5+6` (listening → first byte) are the fair runtime comparisons.**

**Interleaving and placement.** Run A (bytecode family): 6 arms × 11 rounds, 09:00–09:28 UTC.
Run B (minimisation): 8 arms × 10 rounds, 09:33–10:02 UTC. Run C (machine family): 4 arms × 10
rounds, 10:04–10:28 UTC. Rotating arm order every round; every wake waited for all arms at zero;
every image pre-pulled on every node (`prepull-*` DaemonSets; **zero `Pulling` events** across all
186 wakes). **0 wakes excluded** (66 + 80 + 40, all HTTP 200 with the `items:50` marker). The c3
node was cordoned during Runs A and B.

## Part 1 — Node vs Bun, with bytecode verified on and off

### Is bytecode caching actually live? (evidence, not assumption)

- **Node.** A spec-identical evidence pod (`bc-node-ccdebug`: the baseline image +
  `NODE_DEBUG_NATIVE=COMPILE_CACHE`, never timed) logged
  `resolved path /app/.next/standalone/.next/compile-cache + v22.23.2-x64-9de703df-65532` and then
  **536 `V8 code cache … was accepted` lines, 0 rejected**, for `next/dist/server/**`, the
  turbopack runtime and the route chunks the bake warmed
  ([`evidence-node-compile-cache-on.txt.gz`](data/cold-start-gke-runtime-and-minimisation-2026-10-01/evidence-node-compile-cache-on.txt.gz)).
  The same pod with `NODE_DISABLE_COMPILE_CACHE=1` logged `Disabled by NODE_DISABLE_COMPILE_CACHE`
  for both processes and read nothing
  ([`evidence-node-compile-cache-off.txt`](data/cold-start-gke-runtime-and-minimisation-2026-10-01/evidence-node-compile-cache-off.txt)).
  The baked cache is accepted under the read-only root filesystem (it only fails to *persist*
  new entries, which it does not need to). In the measured pods the supervisor's
  compile-cache health check stayed silent (status `active`). **Gap found:** the 116 modules
  the **supervisor** process loads (`/app/node_modules/**`, `knext-entry.mjs`) are *not* in the
  bake — only the Next child is — so the supervisor compiles from source on every cold start.
  Small (it runs in parallel with the child), but free to fix.
- **Bun.** In a running pod of the baseline image, PID 1 is `bun run server.js` (the supervisor)
  and **PID 12's `/proc/12/exe` is `/app/.next/standalone/knext-standalone-exec`** — the measured
  process is the compiled executable. Running the repo's own verifier
  (`bytecode-exec-verify.mjs`) against that file in the pod: marker
  `knext-standalone-exec:f63c88…` found under a `// @bun @bytecode @bun-cjs` pragma, with the
  constant-pool copy present → **`ok: true`**, sha256 `2ddfee9c…`. The no-bytecode variant built
  for the OFF arm fails the same check ("compiled WITHOUT --bytecode"). A control recompile *with*
  bytecode reproduced the shipped binary's size to within 4 KB (112.20 MB), so the OFF arm is the
  shipped recipe minus one flag. **Scope caveat:** the stock (non-self-contained) executable only
  carries bytecode for what `server.js` reaches statically (`next/dist/server/**`); the route and
  instrumentation chunks are loaded from disk as plain JS. That is exactly what the
  self-contained arm changes.

### Per phase, both runtimes, bytecode ON (Run A, n = 11 each)

| phase (median ms · IQR) | Node + compile cache | Bun + bytecode | Bun − Node | p | Holm p |
|---|---|---|---|---|---|
| 1 activation | 203 · 40 | 216 · 53 | +14 | 0.38 | 1 |
| 2 scheduling | 44 · 15 | 54 · 17 | +10 | 0.15 | 1 |
| 3 sandbox + containers | 867 · 38 | 787 · 47 | −79 | 2.8e-6 | 0.0002 |
| 4 runtime boot | 594 · 80 | 230 · 24 | −364 | 2.8e-6 | 0.0002 |
| **3+4 bound → listening** | **1494** · 102 | **1023** · 58 | **−471** | 2.8e-6 | **0.0002** |
| 5 listening → ready | 1948 · 246 | 1496 · 203 | −452 | 8.5e-5 | 0.003 |
| 6 forward + render | 35 · 47 | 240 · 78 | +205 | 8.2e-5 | 0.003 |
| **5+6 listening → first byte** | **1948** · 238 | **1719** · 203 | **−229** | 0.013 | 0.27 |
| 5z app: listening → first `/api/health` 200 | 1573 · 378 | 1360 · 113 | −213 | 0.24 | 1 |
| **total request → first byte** | **3733** · 271 | **2998** · 295 | **−734** | 3.4e-5 | **0.0015** |

Holm family = all 60 p-values of Run A (six comparisons × ten phases). Run B's baselines replicate
it: total −665 ms (3156 vs 3822, n = 10 each, p = 1.1e-5), bound → listening −475 ms.

### What bytecode contributes, per runtime (Run A)

| phase (median ms) | Node ON | Node OFF | **Node: cache buys** | Bun ON | Bun OFF (no `--bytecode`) | **Bun: bytecode buys** | Bun uncompiled (`bun server.js`) | Bun self-contained |
|---|---|---|---|---|---|---|---|---|
| 1 activation | 203 | 207 | 4 | 216 | 203 | −13 | 210 | 192 |
| 2 scheduling | 44 | 51 | 7 | 54 | 49 | −5 | 56 | 56 |
| 3 sandbox + containers | 867 | 866 | −1 | 787 | 842 | 54 | 826 | 713 |
| 4 runtime boot | 594 | 634 | 40 | 230 | 453 | **222** | 487 | 90 |
| 3+4 bound → listening | 1494 | 1538 | 45 | 1023 | 1297 | **274** | 1309 | 809 |
| 5+6 listening → first byte | 1948 | 2237 | **289** | 1719 | 1991 | **272** | 1911 | 972 |
| 5z first `/api/health` 200 | 1573 | 1762 | 189 | 1360 | 1642 | 281 | 1605 | 783 |
| **total** | **3733** | **4007** | **274** (p = 0.003, Holm 0.095, CI [113, 510]) | **2998** | **3537** | **538** (p = 1.3e-4, Holm 0.005, CI [290, 710]) | 3466 (+468, Holm 0.0005) | **2043** (−956, Holm 0.0002, CI [−1159, −744]) |

- **Node's compile cache buys ~0.27 s**, almost all of it in the first request after listen
  (the bake drives `/api/health`, so those chunks are cached), only ~40 ms at boot. Its Holm p
  (0.095) misses 0.05 in a 60-test family; raw p = 0.003 and the CI excludes zero.
- **Bun's `--bytecode` buys ~0.54 s**, split evenly between boot (−222 ms) and the first
  request (−272 ms). Compiling without bytecode is no better than not compiling at all
  (3537 vs 3466 ms): the executable's value is the bytecode, not the bundling.
- **Both caches off, Bun is still faster than Node** (3537 vs 4007 ms, −470 ms, Holm 0.005):
  Bun's own startup is faster independent of caching.
- **Self-contained Bun is the best runtime configuration measured: 2043 ms**, because it is the
  only one in which the post-listen chunk evaluation (see Part 2) runs from bytecode. It is not
  the default today (opt-in `selfContained`), and it requires the operator's compat shim.

**Verdict on "node + bytecode ≈ bun + bytecode at every phase": no.** Activation, scheduling and
(after correction) the post-listen leg are statistically the same; **boot is not** (Node needs
~0.47 s longer from bind to listen), and the totals differ by ~0.7 s. Bytecode caching narrows
nothing between them — it helps Bun more than Node, in absolute terms.

## Part 2 — minimising each phase

### What "listening → ready" is made of (traced)

`first-request.mjs` (new, [`gke/first-request.mjs`](../../scripts/bench-cold-start-phases/gke/first-request.mjs))
starts the server inside a pod of the bench image (same 1 CPU limit, read-only root, same node
type) and times `/api/health` from the moment `:3000` accepts:

| variant (n = 3 each) | listen | first `/api/health` | second | first `/` |
|---|---|---|---|---|
| Node + compile cache | 530–573 | **1075–1099** | 12–27 | 165–258 |
| Node, cache off | 585–591 | 1172–1189 | 12–36 | 199–369 |
| Bun executable + bytecode | 191–234 | **1000–1063** | 6–7 | 184–192 |
| Bun, uncompiled | 471–504 | 1176–1247 | 6–8 | 158–172 |
| **Bun executable, first request 2 s *after* listen** | 191–194 | **54–60** | 6 | 148 |
| **Node, first request 2 s *after* listen** | 535 | **163** | 12 | 174 |
| **Bun executable, `register()` a no-op** | 175–209 | **371–385** | 6–15 | 157–174 |

If the first request waits 2 s, it costs 54–163 ms: **the ~1 s is not a lazy first request; it
is work that starts at `listen` and runs regardless.** A CPU profile (`node --cpu-prof`,
[`gke/cpuprofile-window.py`](../../scripts/bench-cold-start-phases/gke/cpuprofile-window.py))
shows the process CPU-busy without a gap from start until ~1 s after listen, then idle; the
post-listen window is dominated by turbopack's `instantiateModule` over one chunk,
`[root-of-the-server]__0r2c7eh._.js` (1.7 MB, ~180 ms self time plus its module bodies, GC and
loader work). That chunk is **`instrumentation-node`**: it contains `registerNode` and the
`@vercel/otel`, `@cerbos/grpc` protobufs (228 `cerbos` and 364 `protobuf` references), `minio`
and `prom-client` code. Next.js runs `register()` once per server start and the server waits for
it before handling requests
([Next.js: instrumentation](https://nextjs.org/docs/app/guides/instrumentation)). The scaffolded
`src/instrumentation.ts` does `await import('./instrumentation-node')` whenever
`NEXT_RUNTIME === 'nodejs'`, and that module's **static** imports pull the whole client stack —
before `registerNode()` gets to its first line, which returns because tracing is off by default.
With the stub, the remaining post-listen work (Node profile) is Next's own server initialisation:
`next-server`, the app-page/app-route runtimes and the turbopack SSR runtime, ~0.3–0.5 s.

### Experiments (Run B, n = 10 per arm, one variable each; Holm across all 48 p-values)

| arm vs its baseline | phase it moved | total (median ms) | Δ total | p | Holm p | 95% CI |
|---|---|---|---|---|---|---|
| **Bun, instrumentation import skipped when tracing is off** | 5+6: 1819 → 957 | 3156 → **2242** | **−914** | 1.1e-5 | **0.0005** | [−1059, −767] |
| **Node, same** | 5+6: 2003 → 1219 | 3822 → **3000** | **−822** | 4.3e-5 | **0.0014** | [−1056, −495] |
| **Bun, CPU limit 4 (request unchanged)** | 4: −76; 5+6: 1819 → 1220 | 3156 → **2482** | **−675** | 1.1e-5 | **0.0005** | [−850, −553] |
| **Bun, no emptyDir (`readOnlyRootFilesystem: false`)** | 3: 791 → 492 | 3156 → **2795** | **−361** | 2.2e-5 | **0.0007** | [−541, −239] |
| Bun, warm-before-ready (#1761 prototype) | 5: −120 (n.s.) | 3156 → 3053 | −103 | 0.052 | 1 | [−341, +9] |
| Node, warm-before-ready | none | 3822 → 3825 | +3 | 0.31 | 1 | [−177, +343] |

Full per-phase tables: [Appendix A](#appendix-a--per-phase-tables).

**Reading it.**

- **Instrumentation gating is the biggest knext-owned lever on both runtimes (−0.8 to −0.9 s).**
  It moves only phase 5 — boot and sandbox are untouched (p ≥ 0.39) — exactly as the trace
  predicts. The app's first health answer drops from ~1.45–1.55 s after listen to ~0.64 s. It is
  an *app template* fix (the file lives in every scaffolded app), behaviourally identical when
  tracing is off; when tracing is on, the import still happens (and the cost is then the price of
  tracing). It also narrows nothing between runtimes: after it, Bun is still 0.76 s faster than
  Node (2242 vs 3000).
- **Warm-before-ready does nothing measurable.** The prototype's own log line confirms the
  warm-up fired (first 200 at ~1.6 s after process start) — but the readiness probe was already
  waiting behind the same `register()`; there is no lazy work left for it to front-run. **#1761's
  premise ("the first request pays a lazy load") is wrong on this app**; the instrumentation
  finding replaces it.
- **On GKE `e2` nodes the 1-CPU limit does throttle the wake** (−675 ms with a 4-CPU limit) —
  unlike OKE, where the same change was worth 37 ms. The post-listen chunk evaluation is mostly
  single-threaded, so this is CFS throttling of the *whole container* (GC/JIT helper threads,
  the supervisor and the child) against a 100 ms-period quota on shared-core-class vCPUs, not a
  need for 4 cores. A permanently higher limit costs tenancy headroom; **a startup-only boost
  gets the same effect**: GKE's CPU startup boost / the open-source
  [Kube Startup CPU Boost](https://github.com/google/kube-startup-cpu-boost) controller raise
  requests/limits until the pod is Ready and revert them in place (in-place pod resize; k8s
  ≥ 1.33) ([GKE: accelerate startup with CPU startup boost](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/boost-application-startup)).
  `bc-bun-cpu4` is the upper bound of what a boost can buy; the controller itself was not
  installed in this sitting.
- **No emptyDir: −0.36 s on GKE** (phase 3 −299 ms), smaller than OKE's −0.47 s phase-3 effect
  but now measured at the total level. Same trade as on OKE: it gives up the read-only root
  filesystem, so it is a per-app opt-in, not a default.

### Machine family (Run C: `e2-standard-4` vs `c3-standard-4`, n = 10 per arm)

A one-node `c3-standard-4` pool (`c3-pool`, same GKE version and image type, 50 GB
`pd-balanced`) was added for this block. `bc-bun-twin` / `bc-node-twin` (spec-identical to the
baselines) were woken only on it, the baselines only on `default-pool`, alternating within every
round by cordoning the other pool for the duration of one wake (`drive.py`'s `arm@pool`).
10 rounds, 10:04–10:28 UTC, 40 wakes, 0 excluded, 0 image pulls.

| phase (median ms) | Bun e2 | Bun c3 | Δ Bun | Node e2 | Node c3 | Δ Node |
|---|---|---|---|---|---|---|
| 1 activation | 200 | 200 | +1 | 208 | 203 | −5 |
| 2 scheduling | 48 | 51 | +3 | 54 | 52 | −2 |
| 3 sandbox + containers | 799 | 566 | **−233** | 893 | 619 | **−274** |
| 4 runtime boot | 248 | 130 | **−118** | 631 | 274 | **−357** |
| 5+6 listening → first byte | 1897 | 851 | **−1046** | 2087 | 852 | **−1235** |
| **total** | **3161** | **1879** | **−1281** (Holm p = 0.0002, CI [−1502, −1193]) | **3922** | **1973** | **−1949** (Holm p = 0.0002, CI [−2047, −1773]) |

**The machine family is the largest single lever measured — and on `c3`, Node ≈ Bun**: 1973 vs
1879 ms (−94 ms, p = 0.023, Holm 0.21); Bun still binds ~0.2 s sooner (bound → listening 693 vs
890 ms, Holm 0.0002), but the post-listen leg is identical (851 vs 852 ms). On `e2` the same pair
differs by 762 ms (Holm 0.025). Every CPU-bound phase shrinks (3, 4, 5); the control-plane
phases (1, 2) do not move. A micro-trace on the `c3` node (same image, same 1-CPU limit, no
Knative) puts the app's own startup at ~1.7–1.9× faster than on `e2` (Node listen 284–303 vs
530–573 ms, first health 612–628 vs 1075–1099 ms; Bun listen 103–116 vs 191–234 ms), so this is
the CPU, not just a quieter node — though the `c3` node also carried none of the cluster's
control-plane pods, which the default-pool nodes do (a confound this sitting does not separate).
Price: `c3-standard-4` ≈ $0.21/hr vs `e2-standard-4` ≈ $0.134/hr on demand (≈ +55%).

**Runtime parity follows the CPU.** Bun's advantage is the CPU-bound work it does faster *at
boot*; on a slow, 1-CPU-throttled `e2` vCPU that work and the post-listen chunk evaluation are
both stretched, which widens the gap to ~0.7 s; on `c3` the post-listen evaluation runs at the
same speed on both runtimes (the micro-trace's first health answer is 612–628 ms Node vs
653–692 ms Bun) and the gap shrinks to Bun's ~0.1–0.2 s boot advantage.

### Activation (~205 ms) and forward (~190 ms): why higher than OKE, and what moves them

- **Activation** splits (morning Part 1 watch events, Bun) into request → Deployment scaled
  **60 ms** (activator → autoscaler → `scale` subresource) and Deployment scaled → Pod object
  **138 ms** (Node: 69 + 170) — the second half is the ReplicaSet controller in GKE's managed
  `kube-controller-manager` plus apiserver round trips, which OKE did in ~60 ms. Nothing in
  Knative or knext is on that half; there is no per-revision knob that shortens a single
  scale-from-zero wake (`initial-scale` applies to a new revision; with zero pods the activator
  is always in the path, whatever `target-burst-capacity` says —
  [Knative: target burst capacity](https://knative.dev/docs/serving/load-balancing/target-burst-capacity/)).
  Not tested further: no lever to test.
- **Forward + render.** For Bun, health 200 → pod `Ready` +122 ms → endpoints ready +46 ms →
  first byte +162 ms; the last leg is the **first render of `/`** (first `/` = 148–192 ms in the
  micro-trace), not the network. For Node, the activator usually routes the request before the
  `Ready` condition lands, so the render shows up inside phase 5 instead — which is why phase 6
  alone looks "slower on Bun" (+205 ms) while 5+6 is not. The lever for this leg is the
  self-contained executable (route chunks as bytecode), not the forward path.
- **Readiness probe settings.** Health 200 → `Ready` is 122 ms (Bun) / 340 ms (Node) median, and
  the operator already renders Knative's aggressive probing (no `periodSeconds`). The kubelet's
  `Readiness probe failed … :8012 … context deadline exceeded` event fires on every wake because
  the app is still inside `register()`; after instrumentation gating there is ≤ ~0.1–0.3 s left
  for probe tuning to win. Not tested; not worth a CRD field.

### Not tested, with the reason

- **GKE image streaming** needs images in Artifact Registry (same region) and helps only when
  the image is *not* already on the node
  ([GKE: image streaming](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/image-streaming)).
  Every wake here is pre-pulled, so phase 3 (~0.79 s) contains no pull for it to remove. It is
  the right recipe for the *first* wake on a fresh node (images of 80–126 MB); measuring that
  needs an image-cache flush per wake, which needs node access this sitting did not use.
- **containerd settings**: not exposed on GKE Standard node pools beyond what node system
  config allows; phase 3's movable part is the volume (measured above).

## How to minimise (ranked)

Measured savings are per wake, this app, GKE, pre-pulled images, each against its own baseline
— **they do not simply add** (each one shrinks the same CPU-bound post-listen work; combinations
were not measured). Ranked by jev `score` "saving per unit of effort, from the measured evidence
only" (0–4) with `noul` P(weakens a security default or scale-to-zero); input:
one evidence paragraph per lever. jev is a gut check, not the decider.

| # | lever | measured saving | ships as | trade-off | size | jev value (conf.) | jev P(weakens) |
|---|---|---|---|---|---|---|---|
| 1 | Faster machine family (`c3` instead of `e2`) | **−1.28 s Bun / −1.95 s Node** | docs recipe for GKE users (node-pool choice) | ≈ +55% node price | S | 3.97 (0.98) | 0.09 |
| 2 | Skip the `instrumentation-node` import when tracing is off (scaffold template) | **−0.91 s Bun / −0.82 s Node** | app template in `@getknext/core` (v1.1) + docs recipe for existing apps | none while tracing is off; tracing-on apps keep paying it | S | 3.00 (0.97) | 0.03 |
| 3 | Self-contained Bun executable (all server chunks as bytecode) | **−0.96 s** vs stock Bun | runtime v1.1 default candidate (opt-in today), compat-gated | compat coverage of that shape; 126 MB binary | M | 2.95 (0.95) | 0.22 |
| 4 | Startup CPU boost (bounded by the 4-CPU-limit arm) | **≤ −0.68 s** (Bun, `e2`) | docs recipe for GKE users | a controller (or GKE's boost); node burst headroom | S | 2.92 (0.93) | 0.17 |
| 5 | Keep bytecode on, guard it against regression | Bun −0.54 s, Node −0.27 s | already shipped; add a cold-start guard | — | S | 2.79 (0.75) | 0.16 |
| 6 | No-volume pod (`readOnlyRootFilesystem: false`) | −0.36 s | docs recipe (per-app opt-in); a write-free runtime later | loses read-only root | S docs / M–L write-free | 2.00 (1.00) | **0.93** |
| 7 | Bake the Node supervisor's 116 modules into the compile cache | not measured (parallel to the child; ≤ tens of ms) | runtime v1.1 | none | S | 0.50 (0.58) | 0.11 |
| 8 | Warm-before-ready (#1761) | **none** (Bun −0.10 s n.s.; Node +0.00 s) | **re-scope #1761 to lever 2** | — | M | 0.43 (0.64) | 0.38 |
| — | Readiness-probe tuning; activation knobs | ≤ 0.1–0.3 s left after lever 2 / no knob exists | nothing | — | — | not scored | — |

Bun as the runtime (vs Node) is −0.67 to −0.76 s on `e2` but only −0.09 s on `c3`; it is already
the default cell, so it is not listed as a lever.

## Limitations

- **One cluster, one sitting, one light app.** Absolute numbers are GKE `e2` + this app; the
  instrumentation saving is specific to apps that keep the scaffolded instrumentation (all knext
  scaffolds since #342), and grows with whatever else an app imports there.
- **The instrumentation arm is a stub, not the template patch.** It is behaviourally identical
  only while tracing is off (the default); the patched template still has to be written, built
  and compat-gated.
- **`bc-bun-cpu4` is a bound, not a boost.** A real boost controller adds its own resize latency.
- **Phase boundaries 3|4 and 5|6 are runtime-dependent** (see Instrument); read the combined rows.
- **Placement was recorded, not controlled** in Runs A and B; every arm landed on all three
  default-pool nodes (`…c8bn` least often: two idle 250m trace pods sat on it).
- **Holm across large families is conservative**: the Node compile-cache effect (raw p = 0.003,
  CI excluding zero) misses Holm 0.05 in a 60-test family.

## Cost and what is left running

| resource | rate (us-central1 on-demand list, approximate) | state at end |
|---|---|---|
| `knext-coldstart` default pool, 3 × `e2-standard-4` + disks + zonal mgmt | ≈ $0.44–0.54/hr | **left running** (founder: keep the cluster) |
| `c3-pool`, 1 × `c3-standard-4` + 50 GB pd-balanced | ≈ $0.21/hr while up | **scaled to 0 nodes** (pool kept, $0/hr) |
| Cloud Build (2 builds, `E2_HIGHCPU_8`, ~5 + ~3 min) | ≈ $0.016/build-min | ≈ $0.13 once |
| Artifact Registry: 6 variant images (~0.6 GB) | ≈ $0.10/GB-month | ≈ $0.06/month |

Every new `NextApp` is scaled to zero (`minScale: 0`); the `prepull-variants` DaemonSet runs
sleeping containers (requests 1m CPU each) on the default pool.

## Raw data and reproduction

[`data/cold-start-gke-runtime-and-minimisation-2026-10-01/`](data/cold-start-gke-runtime-and-minimisation-2026-10-01/):
`run-a-bytecode.jsonl` (66 wakes), `run-b-minimise.jsonl` (80), `run-c-machine-family.jsonl`
(40), `first-request-microtrace.jsonl`, and the two compile-cache evidence logs.

```bash
cd scripts/bench-cold-start-phases/gke
(cd variants && gcloud builds submit --region us-central1 --config cloudbuild.yaml .)  # edit its target list per build
kubectl --context knext-coldstart apply --validate=strict -f nextapps-runtime-min.yaml
kubectl --context knext-coldstart apply -f prepull-variants.yaml
bash verify-arms.sh bc-bun-turbopack bc-bun-nobc …        # one variable per arm, before any wake
python3 drive.py 11 bc-bun-turbopack,bc-bun-nobc,bc-bun-script,bc-bun-sc,bc-node-turbopack,bc-node-nocc run-a-bytecode.jsonl
python3 drive.py 10 bc-bun-turbopack,bc-bun-noinstr,bc-bun-warm,bc-bun-rwfs,bc-bun-cpu4,bc-node-turbopack,bc-node-noinstr,bc-node-warm run-b-minimise.jsonl
python3 drive.py 10 bc-bun-turbopack@default-pool,bc-bun-twin@c3-pool,bc-node-turbopack@default-pool,bc-node-twin@c3-pool run-c-machine-family.jsonl
python3 compare.py run-a-bytecode.jsonl bc-node-turbopack:bc-bun-turbopack,bc-bun-turbopack:bc-bun-nobc,… --phases=1,2,3,4,34,5,6,56,5z,T
```

## Appendix A — per-phase tables

Run A (bytecode family) is in full in Part 1. Each block below is one compare.py invocation, so its Holm family is that block.

### Run B — minimisation (Holm family: 48)

#### bc-bun-noinstr vs bc-bun-turbopack (n=10 vs 10)

| phase | bc-bun-turbopack median · IQR | bc-bun-noinstr median · IQR | diff (B−A) | p | p Holm | 95% CI |
|---|---|---|---|---|---|---|
| 3 sandbox + containers | 791 · 21 | 786 · 45 | -5 | 0.25 | 1 | [-56, +9] |
| 4 runtime boot | 240 · 9 | 238 · 25 | -2 | 0.97 | 1 | [-17, +17] |
| 3+4 bound -> listening | 1026 · 23 | 1020 · 60 | -7 | 0.39 | 1 | [-58, +25] |
| 5 listening -> ready | 1609 · 94 | 725 · 97 | -884 | 1.1e-05 | 0.00052 | [-981, -777] |
| 6 forward + render | 235 · 57 | 212 · 110 | -23 | 0.73 | 1 | [-106, +93] |
| 5+6 listening -> first byte | 1819 · 260 | 957 · 138 | -862 | 1.1e-05 | 0.00052 | [-1028, -722] |
| 5z app: listening -> first /api/health 200 | 1453 · 184 | 645 · 135 | -808 | 1.1e-05 | 0.00052 | [-918, -637] |
| total request -> first byte | 3156 · 204 | 2242 · 114 | -914 | 1.1e-05 | 0.00052 | [-1059, -767] |

#### bc-bun-warm vs bc-bun-turbopack (n=10 vs 10)

| phase | bc-bun-turbopack median · IQR | bc-bun-warm median · IQR | diff (B−A) | p | p Holm | 95% CI |
|---|---|---|---|---|---|---|
| 3 sandbox + containers | 791 · 21 | 785 · 36 | -6 | 0.25 | 1 | [-36, +9] |
| 4 runtime boot | 240 · 9 | 245 · 47 | +5 | 0.48 | 1 | [-18, +30] |
| 3+4 bound -> listening | 1026 · 23 | 1026 · 61 | -0 | 0.91 | 1 | [-33, +40] |
| 5 listening -> ready | 1609 · 94 | 1488 · 203 | -120 | 0.052 | 1 | [-236, +0] |
| 6 forward + render | 235 · 57 | 235 · 43 | -1 | 1 | 1 | [-52, +129] |
| 5+6 listening -> first byte | 1819 · 260 | 1751 · 206 | -68 | 0.25 | 1 | [-282, +102] |
| 5z app: listening -> first /api/health 200 | 1453 · 184 | 1347 · 139 | -106 | 0.075 | 1 | [-216, +57] |
| total request -> first byte | 3156 · 204 | 3053 · 195 | -103 | 0.052 | 1 | [-341, +9] |

#### bc-bun-rwfs vs bc-bun-turbopack (n=10 vs 10)

| phase | bc-bun-turbopack median · IQR | bc-bun-rwfs median · IQR | diff (B−A) | p | p Holm | 95% CI |
|---|---|---|---|---|---|---|
| 3 sandbox + containers | 791 · 21 | 492 · 19 | -299 | 1.1e-05 | 0.00052 | [-331, -284] |
| 4 runtime boot | 240 · 9 | 240 · 29 | +0 | 0.97 | 1 | [-17, +19] |
| 3+4 bound -> listening | 1026 · 23 | 735 · 39 | -292 | 1.1e-05 | 0.00052 | [-338, -273] |
| 5 listening -> ready | 1609 · 94 | 1588 · 155 | -20 | 0.22 | 1 | [-188, +41] |
| 6 forward + render | 235 · 57 | 236 · 28 | +0 | 0.91 | 1 | [-48, +128] |
| 5+6 listening -> first byte | 1819 · 260 | 1824 · 232 | +5 | 0.63 | 1 | [-211, +142] |
| 5z app: listening -> first /api/health 200 | 1453 · 184 | 1406 · 140 | -48 | 0.35 | 1 | [-177, +91] |
| total request -> first byte | 3156 · 204 | 2795 · 159 | -361 | 2.2e-05 | 0.00071 | [-541, -239] |

#### bc-bun-cpu4 vs bc-bun-turbopack (n=10 vs 10)

| phase | bc-bun-turbopack median · IQR | bc-bun-cpu4 median · IQR | diff (B−A) | p | p Holm | 95% CI |
|---|---|---|---|---|---|---|
| 3 sandbox + containers | 791 · 21 | 786 · 38 | -5 | 0.35 | 1 | [-42, +13] |
| 4 runtime boot | 240 · 9 | 164 · 10 | -76 | 1.1e-05 | 0.00052 | [-80, -62] |
| 3+4 bound -> listening | 1026 · 23 | 957 · 48 | -70 | 1.1e-05 | 0.00052 | [-112, -51] |
| 5 listening -> ready | 1609 · 94 | 1137 · 154 | -472 | 1.1e-05 | 0.00052 | [-598, -397] |
| 6 forward + render | 235 · 57 | 102 · 61 | -134 | 0.026 | 0.77 | [-183, -4] |
| 5+6 listening -> first byte | 1819 · 260 | 1220 · 141 | -599 | 1.1e-05 | 0.00052 | [-758, -422] |
| 5z app: listening -> first /api/health 200 | 1453 · 184 | 1037 · 77 | -416 | 1.1e-05 | 0.00052 | [-527, -310] |
| total request -> first byte | 3156 · 204 | 2482 · 160 | -675 | 1.1e-05 | 0.00052 | [-850, -553] |

#### bc-node-noinstr vs bc-node-turbopack (n=10 vs 10)

| phase | bc-node-turbopack median · IQR | bc-node-noinstr median · IQR | diff (B−A) | p | p Holm | 95% CI |
|---|---|---|---|---|---|---|
| 3 sandbox + containers | 897 · 46 | 893 · 61 | -4 | 0.91 | 1 | [-46, +32] |
| 4 runtime boot | 598 · 56 | 606 · 86 | +8 | 0.85 | 1 | [-60, +56] |
| 3+4 bound -> listening | 1502 · 72 | 1484 · 89 | -18 | 0.97 | 1 | [-66, +69] |
| 5 listening -> ready | 1974 · 260 | 1122 · 209 | -851 | 1.1e-05 | 0.00052 | [-996, -651] |
| 6 forward + render | 35 · 59 | 85 · 86 | +51 | 0.026 | 0.77 | [-11, +104] |
| 5+6 listening -> first byte | 2003 · 205 | 1219 · 232 | -784 | 1.1e-05 | 0.00052 | [-970, -621] |
| 5z app: listening -> first /api/health 200 | 1546 · 231 | 641 · 141 | -905 | 1.1e-05 | 0.00052 | [-1058, -757] |
| total request -> first byte | 3822 · 276 | 3000 · 361 | -822 | 4.3e-05 | 0.0014 | [-1056, -495] |

#### bc-node-warm vs bc-node-turbopack (n=10 vs 10)

| phase | bc-node-turbopack median · IQR | bc-node-warm median · IQR | diff (B−A) | p | p Holm | 95% CI |
|---|---|---|---|---|---|---|
| 3 sandbox + containers | 897 · 46 | 894 · 31 | -3 | 0.68 | 1 | [-38, +22] |
| 4 runtime boot | 598 · 56 | 672 · 57 | +75 | 0.0021 | 0.065 | [+17, +117] |
| 3+4 bound -> listening | 1502 · 72 | 1544 · 60 | +42 | 0.043 | 1 | [+2, +113] |
| 5 listening -> ready | 1974 · 260 | 1988 · 276 | +14 | 0.85 | 1 | [-172, +203] |
| 6 forward + render | 35 · 59 | 51 · 67 | +17 | 0.79 | 1 | [-55, +60] |
| 5+6 listening -> first byte | 2003 · 205 | 1995 · 189 | -9 | 0.85 | 1 | [-153, +173] |
| 5z app: listening -> first /api/health 200 | 1546 · 231 | 1531 · 378 | -15 | 0.74 | 1 | [-282, +177] |
| total request -> first byte | 3822 · 276 | 3825 · 309 | +3 | 0.31 | 1 | [-177, +343] |

### Run C — machine family (Holm family: 20)

#### bc-bun-twin@c3-pool vs bc-bun-turbopack@default-pool (n=10 vs 10)

| phase | bc-bun-turbopack@default-pool median · IQR | bc-bun-twin@c3-pool median · IQR | diff (B−A) | p | p Holm | 95% CI |
|---|---|---|---|---|---|---|
| 1 activation | 200 · 24 | 200 · 29 | +1 | 0.74 | 1 | [-18, +31] |
| 2 scheduling | 48 · 4 | 51 · 10 | +3 | 0.059 | 0.29 | [-0, +31] |
| 3 sandbox + containers | 799 · 20 | 566 · 16 | -233 | 1.1e-05 | 0.00022 | [-255, -215] |
| 4 runtime boot | 248 · 37 | 130 · 9 | -118 | 1.1e-05 | 0.00022 | [-150, -105] |
| 3+4 bound -> listening | 1049 · 50 | 693 · 21 | -356 | 1.1e-05 | 0.00022 | [-403, -322] |
| 5 listening -> ready | 1601 · 127 | 826 · 95 | -775 | 1.1e-05 | 0.00022 | [-932, -678] |
| 6 forward + render | 261 · 83 | 39 · 44 | -222 | 0.0025 | 0.015 | [-273, -177] |
| 5+6 listening -> first byte | 1897 · 117 | 851 · 120 | -1046 | 1.1e-05 | 0.00022 | [-1166, -896] |
| 5z app: listening -> first /api/health 200 | 1454 · 106 | 784 · 178 | -671 | 1.1e-05 | 0.00022 | [-809, -515] |
| total request -> first byte | 3161 · 128 | 1879 · 102 | -1281 | 1.1e-05 | 0.00022 | [-1502, -1193] |

#### bc-node-twin@c3-pool vs bc-node-turbopack@default-pool (n=10 vs 10)

| phase | bc-node-turbopack@default-pool median · IQR | bc-node-twin@c3-pool median · IQR | diff (B−A) | p | p Holm | 95% CI |
|---|---|---|---|---|---|---|
| 1 activation | 208 · 54 | 203 · 114 | -5 | 0.8 | 1 | [-51, +91] |
| 2 scheduling | 54 · 28 | 52 · 14 | -2 | 0.58 | 1 | [-28, +11] |
| 3 sandbox + containers | 893 · 26 | 619 · 32 | -274 | 1.1e-05 | 0.00022 | [-291, -239] |
| 4 runtime boot | 631 · 48 | 274 · 14 | -357 | 1.1e-05 | 0.00022 | [-395, -332] |
| 3+4 bound -> listening | 1531 · 45 | 890 · 36 | -641 | 1.1e-05 | 0.00022 | [-670, -591] |
| 5 listening -> ready | 2066 · 208 | 756 · 58 | -1310 | 1.1e-05 | 0.00022 | [-1453, -1211] |
| 6 forward + render | 25 · 62 | 61 · 89 | +36 | 0.15 | 0.6 | [-36, +91] |
| 5+6 listening -> first byte | 2087 · 202 | 852 · 155 | -1235 | 1.1e-05 | 0.00022 | [-1398, -1137] |
| 5z app: listening -> first /api/health 200 | 1655 · 92 | 665 · 70 | -989 | 1.1e-05 | 0.00022 | [-1038, -895] |
| total request -> first byte | 3922 · 126 | 1973 · 147 | -1949 | 1.1e-05 | 0.00022 | [-2047, -1773] |

### Run C — Bun vs Node on each machine family (Holm family: 20)

#### bc-bun-twin@c3-pool vs bc-node-twin@c3-pool (n=10 vs 10)

| phase | bc-node-twin@c3-pool median · IQR | bc-bun-twin@c3-pool median · IQR | diff (B−A) | p | p Holm | 95% CI |
|---|---|---|---|---|---|---|
| 1 activation | 203 · 114 | 200 · 29 | -3 | 0.97 | 1 | [-97, +31] |
| 2 scheduling | 52 · 14 | 51 · 10 | -1 | 0.65 | 1 | [-9, +26] |
| 3 sandbox + containers | 619 · 32 | 566 · 16 | -53 | 2.2e-05 | 0.00035 | [-81, -37] |
| 4 runtime boot | 274 · 14 | 130 · 9 | -144 | 1.1e-05 | 0.00022 | [-151, -133] |
| 3+4 bound -> listening | 890 · 36 | 693 · 21 | -196 | 1.1e-05 | 0.00022 | [-228, -180] |
| 5 listening -> ready | 756 · 58 | 826 · 95 | +70 | 0.0052 | 0.052 | [+6, +168] |
| 6 forward + render | 61 · 89 | 39 · 44 | -22 | 0.45 | 1 | [-62, +44] |
| 5+6 listening -> first byte | 852 · 155 | 851 · 120 | -0 | 0.28 | 1 | [-34, +181] |
| 5z app: listening -> first /api/health 200 | 665 · 70 | 784 · 178 | +118 | 0.0029 | 0.032 | [+40, +267] |
| total request -> first byte | 1973 · 147 | 1879 · 102 | -94 | 0.023 | 0.21 | [-264, -7] |

#### bc-bun-turbopack@default-pool vs bc-node-turbopack@default-pool (n=10 vs 10)

| phase | bc-node-turbopack@default-pool median · IQR | bc-bun-turbopack@default-pool median · IQR | diff (B−A) | p | p Holm | 95% CI |
|---|---|---|---|---|---|---|
| 1 activation | 208 · 54 | 200 · 24 | -8 | 0.63 | 1 | [-52, +14] |
| 2 scheduling | 54 · 28 | 48 · 4 | -6 | 0.28 | 1 | [-30, +3] |
| 3 sandbox + containers | 893 · 26 | 799 · 20 | -94 | 0.0011 | 0.016 | [-111, -68] |
| 4 runtime boot | 631 · 48 | 248 · 37 | -383 | 1.1e-05 | 0.00022 | [-420, -341] |
| 3+4 bound -> listening | 1531 · 45 | 1049 · 50 | -482 | 1.1e-05 | 0.00022 | [-522, -422] |
| 5 listening -> ready | 2066 · 208 | 1601 · 127 | -466 | 0.0011 | 0.016 | [-599, -305] |
| 6 forward + render | 25 · 62 | 261 · 83 | +236 | 0.0019 | 0.025 | [+187, +293] |
| 5+6 listening -> first byte | 2087 · 202 | 1897 · 117 | -190 | 0.029 | 0.21 | [-328, -56] |
| 5z app: listening -> first /api/health 200 | 1655 · 92 | 1454 · 106 | -200 | 0.023 | 0.21 | [-267, -46] |
| total request -> first byte | 3922 · 126 | 3161 · 128 | -762 | 0.0021 | 0.025 | [-873, -530] |

