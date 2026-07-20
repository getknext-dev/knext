# ADR-0035: The V8 compile cache is baked into the image at build time

- Status: Accepted
- Date: 2026-07-20
- Deciders: knext architect
- Related: ADR-0034 (bytecode caching decoupled from the data-cache provider and default-OFF —
  this ADR resolves the delivery mechanism ADR-0034 deliberately left open), ADR-0026 (shallow
  dependency-free health route), ADR-0010 (operator-managed Knative PVC feature flags), issues
  #437 (this change), #432 (RWO PVC vs. `maxScale`), #436 (PVC support disabled on a stock
  Knative install), #439 (`apps/docs` has the same bug), `docs/benchmarks/scale-to-zero-oke.md`
  runs 5 and 6

## Context

ADR-0034 decoupled bytecode caching from the data-cache provider but explicitly declined to pick
a **delivery mechanism**: "**#436 and #432 must be resolved by a follow-up ADR.** Nothing here
should be read as endorsing the PVC shape." This is that ADR.

**The segment being optimised is measured.** Cold start on the OKE reference cluster is a
**3.81s median** (run 5, 8 samples). The phase breakdown: scheduling ~0s (the node pool has
headroom), image pull ~0s (already layer-cached on the node), and **~2s in `Started → Ready`** —
uncached Node boot, i.e. V8 parsing and compiling the standalone server's JavaScript on every
cold start.

**What shipped was a placebo.** `apps/file-manager/Dockerfile` created an **empty** compile-cache
directory that nothing ever populated, and the CMD pointed `NODE_COMPILE_CACHE` at it. Every cold
pod therefore compiled from scratch and discarded the cache it wrote when the pod was reaped on
scale-to-zero. The in-file comment promising "faster subsequent cold starts" was false as
shipped.

**The saving is now measured, not hypothesised.** Run 6 compares an empty cache dir (COLD)
against a pre-populated one (WARM) across 5 alternating pairs: **COLD median 3162ms vs WARM
median 2769ms — 393 ms, 12.4% faster boot**, with **complete distribution separation** (the
slowest warm sample, 2809ms, is below the fastest cold sample, 3112ms; zero overlap across all 10
samples). Distribution separation is the reporting bar here for a specific reason: earlier
burst-knob comparisons recorded in `docs/benchmarks/scale-to-zero-oke.md` lacked it and **flipped
sign twice** between runs. A median difference without separation is not a result in this
repository.

**Two facts rule out the pre-existing PVC design.**

- **#436:** Knative ships `kubernetes.podspec-persistent-volume-claim` and
  `kubernetes.podspec-persistent-volume-write` **disabled** by default, so the admission webhook
  rejects any ksvc that mounts the cache PVC on a stock install.
  `kubernetes.podspec-volumes-emptydir` *is* enabled.
- **#432:** the PVC is `ReadWriteOnce` while the default `maxScale` is 10, so a volume-backed
  cache strands burst pods `Pending` on a second node — on the exact scale-out path knext exists
  to serve.

## Decision

**Deliver the V8 compile cache by baking it into the application image at build time, not via a
persistent volume.** The Docker build runs the application server once, lets Node populate
`NODE_COMPILE_CACHE`, and ships the resulting cache directory as an image layer. Every pod —
including the very first one — starts with a fully populated cache and needs no volume, no mount,
and no cluster feature flag.

## Options considered

| Option | Pro | Con | Verdict |
|---|---|---|---|
| **Persistent volume (PVC)** — the pre-existing design | Cache is shared across pods and survives image rebuilds | Unusable on a stock Knative install (#436); RWO vs. `maxScale=10` strands burst pods (#432); 512Mi of storage per app; the cache can outlive the code that produced it; benefit only materialises *after* some earlier pod has warmed it | **Rejected** |
| **Per-pod `emptyDir`** | Works on stock Knative (`podspec-volumes-emptydir` is enabled by default); no RWO/`maxScale` conflict | An `emptyDir` is destroyed with its pod, so it delivers **zero** cross-cold-start benefit — which is precisely the benefit being sought. It was, however, exactly the right **measurement instrument** for run 6: an empty vs. pre-populated `emptyDir` isolates the compile-cache variable with nothing else changing | **Rejected as a delivery mechanism; retained as the measurement instrument** |
| **Baked into the image at build time** (chosen) | No volume, no mount, no cluster feature flags; the benefit applies from the **first** pod; the cache is versioned with the image so it **cannot go stale** relative to the code; no per-app storage | Image size grows (~4.2MB here); build time grows (~11s); the build now boots the application server, which is new build-time surface area | **Chosen** |

## Consequences

**It works on default Knative.** No `config-features` change is required, so **#432 dissolves**
(there is no RWO volume to strand a burst pod) and **#436 no longer blocks the capability** (the
disabled PVC flags are simply not on the path).

**The build now executes the application server.** This is the real cost of the choice and is
worth stating plainly. It is made safe by gating the warm-up on the **shallow, dependency-free
health route (ADR-0026)**, so readiness needs no database and no network: the CI log for the bake
shows `ECONNREFUSED` against Postgres on 5432 while the server still reaches ready. Failure is
loud rather than silent — if the warm-up does not succeed, the **build fails** instead of shipping
an image with an empty cache.

**Guard design matters more than the warm-up itself.** A simple "is the cache directory non-empty"
check is **insufficient**: a *truncated* flush would pass it and silently degrade the optimisation
back toward the placebo it replaced, with nothing in CI to say so. `warm-compile-cache.sh`
therefore:

1. waits for the **`server.js` grandchild** — the process whose modules are actually being cached,
   not the wrapper that spawns it;
2. treats a **stop timeout as FATAL**, because a process that had to be `SIGKILL`ed never ran its
   flush;
3. asserts a **plausibility floor** (200 files / 1MB — roughly 5.5× and 4.2× below observed)
   rather than `>= 1`.

**Determinism evidence, stated as evidence and not more.** Three independent bakes produced
**1106 cache entries** each, at 4,246,088 / 4,246,032 / 4,245,984 bytes (in-cluster, CI pre-fix,
CI post-fix) — identical entry counts and byte totals within ~100. That is **evidence that the
bake is stable**; it is **not** an assertion of bit-for-bit reproducibility, which remains
unverified.

**The legacy operator PVC path is retained as an override, but is no longer the recommended
path.** The operator's `enableBytecodeCache` PVC injection and the CLI's legacy `redis ⇒ on`
inference (ADR-0034, decision 3) still work for anyone depending on them today. The user-facing
documentation already describes the volume-backed path as superseded; **deprecation of the
operator PVC path is planned**, so that code and docs agree rather than drifting.

**What is still open.** (a) An **end-to-end OKE before/after against the 3.81s baseline** has not
run — it needs the image published and deployed, which is why #437 stays open. Run 6 measures the
boot segment in isolation, not the end-to-end cold start. (b) The **image-size delta is
unmeasured** beyond the ~4.2MB cache directory itself. (c) **Bit-reproducibility is unverified**,
per above.

## Action items

1. **Run the end-to-end before/after on OKE** against the 3.81s run-5 baseline, record it in
   `docs/benchmarks/scale-to-zero-oke.md`, then close #437.
2. **Fix `apps/docs/Dockerfile` (#439)**, which has the identical empty-compile-cache bug. When
   wiring it, **promote `warm-compile-cache.sh` out of `apps/file-manager/scripts/` to a shared
   location** so the second consumer inherits the guards instead of copy-pasting them.
3. **Re-scope or retire ADR-0034 action items 1, 3 and 4** (verify the operator-managed path on
   default flags; surface a status condition for an unmountable cache; document the cluster
   prerequisite). All three assume the PVC mechanism, which this ADR supersedes as the
   recommended path.
4. **Decide and announce the deprecation timeline** for the operator PVC path and the CLI's
   legacy `redis ⇒ on` inference (ADR-0034 action item 6), as a deliberate deprecation rather
   than a silent cleanup.
