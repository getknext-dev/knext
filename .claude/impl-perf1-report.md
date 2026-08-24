# Perf iteration #441/#592 — decomposing the knext wrapper overhead

Branch `perf/wrapper-overhead-decomp`, worktree `/Users/banna/alpheya/pocs/knext-wt/perf1`.
Benchmark entry added as **Run 27** in `docs/benchmarks/scale-to-zero-oke.md`.

---

## 0. Read the brief's premise against the current tree first

The brief describes the target as "842 ms / +43 % over booting `server.js` directly — entirely
knext's own code, 2.1× what the baked compile cache saves". **Two parts of that are stale, and the
brief's Phase-1 instruction is written against the stale version**, so this is flagged rather than
worked around (`workflow.md`, escalation trigger: *a discovered fact that invalidates the plan*).

- **"Entirely knext's own code" is refuted in the issue itself.** #441's own comments record Run 9:
  *"The parent costs ~52 ms, not ~842 ms … the hypothesis filed in #441 is refuted by a factor of
  ~16."* The mechanism is not the parent's cost but **CPU contention** — the supervisor's startup
  work competing with the child's ~2 s boot on oversubscribed `0`-CPU-request nodes.
- **The prime suspect named in the issue body is already fixed.** `prom-client` +
  `@opentelemetry/api` are behind `createLazyMetricsEndpoint`, `@getknext/lib/clients` is behind a
  dynamic import in `db-drain`, and the shipped supervisor bundle's static imports are now **node
  builtins only**. Measured below: the eager graph is ~21 ms, not ~790 ms.
- **#441 is also triaged post-1.0**, behind a target-independent ~11 s cold-start mode (Run 24)
  that is an order of magnitude larger than the 842 ms.

What was **genuinely missing**, and is what this iteration delivers, is the thing #592 actually
asks for: **an interval breakdown**. Every prior attribution was an *ablation* — remove a feature,
re-measure the aggregate. An ablation can falsify a named suspect; it cannot produce a table. So
Phase 1 was executed as written (instrument, measure, report the phase table); Phase 2's "name the
dominant term" is answered against the *current* code rather than the 2026-07 measurement.

---

## 1. What was implemented

| file | what |
|---|---|
| `packages/kn-next/src/adapters/boot-trace.ts` | opt-in phase tracer, `KNEXT_BOOT_TRACE=1` |
| `packages/kn-next/src/adapters/node-server.ts` | 5 marks wired at the phase boundaries |
| `packages/kn-next/src/__tests__/boot-trace.test.ts` | tracer unit tests (17) |
| `packages/kn-next/src/__tests__/boot-trace-wiring.test.ts` | source guards (4) |
| `packages/kn-next/bench/boot-phase-trace.mjs` | reproducible phase harness |
| `docs/benchmarks/scale-to-zero-oke.md` | Run 27 |

**Design points that are load-bearing, not decoration:**

- **Anchored at process start, not module load.** `process.hrtime.bigint()` is monotonic but its
  zero is arbitrary, so on its own it cannot see the *start* of the first phase. The origin is
  derived once as `now() − process.uptime()`, after which every mark is a pure hrtime delta. That
  is what makes "node bootstrap + the entire entry module graph" a **measured** quantity instead of
  an inference from outside the process.
- **Free when off.** The disabled tracer reads no clock, allocates nothing, writes nothing. On a
  supervisor whose whole #441 story is *work that competes with the child's boot*, instrumentation
  that costs anything in production would be self-defeating.
- **Fail-open.** A throwing writer is swallowed; a diagnostic never takes the supervisor down.
- **`boot-trace.ts` imports nothing** — it sits on the pre-spawn path in every deployment, trace on
  or off, so a dependency here is one every cold start pays for. That is guarded.

**Runtime contract untouched:** no change to the spawn, the SIGTERM drain, `registerDbPoolDrain`,
the early `:9091` bind, or the compile-cache env. `adapter-migration`, `cli-node-runtime` (55),
`deferred-*`, `lazy-metrics-endpoint`, `shutdown` and `node-server-log-after-spawn` are green.

**One regression found and fixed mid-flight** (worth recording, because it is the exact failure
class `workflow.md` warns about): wiring the `metrics-listening` mark reformatted
`metricsEndpoint.ensureListening("startup")` into a wrapped member chain, which **silently disarmed
a sibling source guard** in `deferred-default-metrics.test.ts` that asserts that string precedes the
spawn. The call is now forced back onto one line with a comment saying why.

---

## 2. Phase table — the deliverable

`node packages/kn-next/bench/boot-phase-trace.mjs`, **n=12**, real **file-manager standalone build**
(`next build`, `output:'standalone'`) as the child, shipped `@getknext/core` bundle from a
`pnpm --prod deploy`. Local Apple-silicon machine.

| phase | interval (median) | range | cumulative |
|---|---|---|---|
| process start → **entry-eval** | **40.3 ms** | 28.8–61.9 | 40.3 ms |
| entry-eval → **spawn-issued** (eager wiring) | **3.4 ms** | 2.2–19.9 | 44.6 ms |
| spawn-issued → **child-listening** (Next's own boot) | **262.4 ms** | 191.2–357.4 | 313.9 ms |
| child-listening → **supervisor-ready** (deferred init) | **27.2 ms** | 19.2–38.5 | 334.8 ms |

Reference arms, same run: `node -e ""` wall **43.0 ms** · node bootstrap measured *in-process*
**17.4 ms** · bootstrap + ESM-loader init for a dynamic import of an empty module **19.0 ms** ·
the same child booted with **no supervisor at all** **246.0 ms** · wrapper overhead
**67.9 ms**.

Second arm, **fast fixture** child (n=12, removes Next's boot so only the wrapper remains):
entry-eval **37.0 ms**, eager wiring **3.9 ms**, child-listening **79.6 ms**, deferred init
**32.1 ms**; DIRECT **68.0 ms**; overhead **48.0 ms**. Every wrapper-side number agrees with the
real-child arm.

### Attribution of the wrapper's 67.9 ms

| term | median | knext's? |
|---|---|---|
| second Node process bootstrap + ESM loader | 19.0 ms | no — the floor of spawning at all |
| **knext's own entry module graph** | **21.4 ms** (entry-eval − esm-import floor) | **yes** |
| eager pre-spawn wiring (drain hook, signal handlers, path resolution, `existsSync`, `listen`) | 3.4 ms | yes |
| child boots slower under the supervisor | ~16.4 ms (262.4 − 246.0) | yes — the contention term |
| deferred supervisor init | 27.2 ms | yes, but **after** child-ready — off the critical path |

Sum of the first four = 60.2 ms against a measured 67.9 ms — the residual is run-to-run spread, and
nothing large is unaccounted for.

---

## 3. The dominant term

**On this machine the wrapper's largest single term is knext's own entry module graph (21.4 ms).
Across machines the term that matters is contention, because it is the only one that scales.**

Two measurements say so:

1. **With a fast-booting child there is no contention at all** — 79.6 ms under the supervisor vs
   68.0 ms direct, spreads overlapping. With a real ~250 ms Next boot the child stretches ~16 ms.
   Run 9 measured ~842 ms with a ~2 s boot on an oversubscribed `0`-CPU-request node. Same term,
   three magnitudes, scaling with the child's boot length × the node's CPU pressure.
2. **Every knext-owned constant is bounded by tens of milliseconds and has no headroom left.** The
   shipped supervisor bundle is 20 KB and its static imports are node builtins only. A direct
   cold-vs-warm `NODE_COMPILE_CACHE` probe (n=10) moved `entry-eval` by **2.0 ms** (40.0 → 38.0), so
   it is **not compile-bound** and the image-baked cache (ADR-0035) already collects what there is —
   **there is no missing-bake gap**, a suspect worth closing explicitly since `warm-compile-cache.sh`
   boots the real supervisor entry and therefore already covers this bundle.

**So: shaving the pre-spawn constant is not the lever.** Deleting *all* of knext's eager work would
buy ~25 ms locally, and the 19 ms process floor under it cannot be removed while a second process
exists at all.

### The proposed lever, and its expected size

**Remove the second process: run the supervisor's responsibilities in-process with Next instead of
spawning `server.js` as a child** (option 3 in #441's own "fix direction", still unexplored).
It is the only change that attacks the term that scales, and it collects the constants for free:

| what it removes | local | on OKE (Run 9 conditions) |
|---|---|---|
| the contention term | ~16 ms | **up to the full ~842 ms** |
| second-process bootstrap + ESM loader | ~19 ms | larger (slower nodes) |
| knext's entry graph on the critical path | ~21 ms | larger |

**Not implemented, and deliberately so** — the brief permits only a contained, provable win, and
this is neither. It touches the SIGTERM drain guarantee (`security.md`: drain in-flight requests and
run `after()` on SIGTERM), which today is *structurally* enforced by owning the child as a separate
process — that is exactly what the CI shipped-bundle drain gate proves. It also touches the
`:9091` sidecar contract. It needs a design gate, not an implementer.

**Before that work is ranked, the honest sequencing objection stands** (and #441's own triage makes
it): Run 24's target-independent **~11 s mode** is an order of magnitude larger than the 842 ms, and
until it is bounded, an 842 ms improvement is not observable against the noise. The instrument added
here is what would let an OKE run *attribute* rather than aggregate — which is the cheap next step,
not the architecture change.

### The small wins that were looked for and are NOT there

- Lazy-require a heavy import — **already done**; the eager graph is builtins-only.
- A redundant fs walk — the only pre-spawn fs work is `existsSync` on the preload (and a second one
  under Bun); the whole eager block is 3.4 ms.
- A synchronous JSON parse of something large — none on the pre-spawn path.
- A missing compile-cache bake for the supervisor bundle — **checked and absent**: 2.0 ms delta.

---

## 4. Verification

- **TDD**: tracer tests written failing (`Cannot find module '../adapters/boot-trace'`) before the
  implementation; source guards likewise.
- **Mutation-proved**, harness branching on **exit code**, anchors asserted to occur exactly once,
  `git checkout --` restore after each, working tree verified clean at the end:

  | mutation | verdict |
  |---|---|
  | M1 `entry-eval` moved off the first-statement position | RED ✔ |
  | M2 `spawn-issued` moved before the `spawn()` call | RED ✔ |
  | M3 `child-listening` mark deleted | RED ✔ |
  | M4 `boot-trace.ts` grows a dependency | RED ✔ |
  | M5 disabled tracer writes to the real stderr | RED ✔ |
  | M6 disabled tracer reads the real clock | RED ✔ |

  **M5 and M6 initially STAYED GREEN.** The first version of the disabled-tracer test asserted only
  that the *injected* `now`/`write` went untouched — but an implementation that ignored its options
  and reached for the real `process.hrtime` / `process.stderr` passes that. The test now spies on
  the globals a leaking implementation would actually reach. That is a guard that was decoration
  until a mutation said so.
- **Typecheck** (`pnpm run typecheck`) clean; **biome** clean on every changed file.
- **Contract tests green**: `adapter-migration`, `cli-node-runtime` (55 tests),
  `deferred-default-metrics`, `deferred-supervisor-init*`, `lazy-metrics-endpoint`, `shutdown`,
  `node-server-log-after-spawn`.

---

## 5. What this does not do

- **It does not close #441.** The 842 ms was measured on OKE, pre-deferral, under conditions this
  machine cannot create (no `0`-CPU-request oversubscription, no ~2 s child boot). Non-reproduction
  here is expected and is **not** evidence of closure — the same caveat Run 20 states about itself.
- **It does not re-measure the wrapper on the deployed path.** The instrument is what makes such a
  run attributable; the run itself is cluster-gated and is the recommended next step.
- **It changes no runtime behaviour.** With `KNEXT_BOOT_TRACE` unset — every production deployment —
  the tracer reads no clock and writes nothing.
