# Bytecode cache reuse across scale-to-zero — verification runbook (A2-2 / #38)

This runbook locks the core invariant from issue #38: **a second cold start reads the
V8 bytecode cache off the PVC and does NOT recompile.** It explains what each verification
layer actually proves, so nobody mistakes the per-PR gate for the real scale-to-zero test.

## The three layers (and what each one proves)

| Layer | Where it runs | Proves | File |
| --- | --- | --- | --- |
| 1. Deterministic vitest gate | **per-PR CI** (existing vitest job) | The *mechanism*: a 2nd process on the same `NODE_COMPILE_CACHE` dir reuses bytecode (zero new/rewritten cache files) and the metrics route reports `kn_next_bytecode_cache_warm_start == 1`. | `apps/file-manager/bytecode-cache-reuse.test.ts` |
| 2. kind + Knative e2e | **nightly / `workflow_dispatch`** (NOT PR CI) | The *real invariant*: cache survives an actual scale-to-zero cycle on a PVC. Depends on #59 (PVC wiring). | `packages/kn-next-operator/test/e2e/scale_to_zero_cache_test.go` (`//go:build e2e_scale`) |
| 3. Manual procedure | **on demand**, real cluster | End-to-end human verification + optional cold-start timing. | this document |

Plainly: **per-PR CI proves the mechanism (Layer 1).** The real scale-to-zero invariant is
verified nightly / on dispatch (Layer 2) and by the manual procedure below (Layer 3). A true
scale-to-zero cold-start timing test cannot run in standard PR CI — there is no persistent
kind/Knative cluster, RWO-PVC scheduling across the scale cycle, and the timing sits within noise.

## Layer 1 — reproduce the per-PR gate locally

```bash
# From repo root. Build the standalone output first (the test skips without it).
cd apps/file-manager && npx next build --webpack && cd -
npx vitest run apps/file-manager/bytecode-cache-reuse.test.ts
```

Expected: the reuse spec passes — cold run populates the cache, the warm run adds/rewrites
**zero** compile-cache files, and the app `/api/metrics` route emits
`kn_next_bytecode_cache_warm_start{app="..."} 1`. Without a build present the spec skips cleanly.

## Layer 2 — nightly / dispatch e2e

```bash
# Requires a kind cluster with Knative Serving (scale-to-zero) already up.
# The nightly workflow (.github/workflows/operator-e2e-nightly.yml) provisions both.
cd packages/kn-next-operator
SCALE_TEST_IMAGE=<digest-pinned file-manager image> make test-e2e-scale
```

> Dependency: the load-bearing assertions (`warm_start == 1`, stable PVC file count after a
> cold start) only hold once **#59** wires `cache.enableBytecodeCache: true` into a PVC mounted
> at `NODE_COMPILE_CACHE`. Until then the spec deploys and runs but is expected to fail — which
> is why Layer 2 is nightly/dispatch and gates nothing.

## Layer 3 — manual reactivation procedure (real cluster)

Prerequisites: a NextApp deployed with `cache.enableBytecodeCache: true`,
`observability.enabled: true`, `scaling.minScale: 0`, `scaling.maxScale: 1`, and (post-#59) a PVC
bound at `NODE_COMPILE_CACHE`.

1. **Warm up.** Hit the app a few times, then scrape the app's own metrics route (port 3000,
   NOT the `:9091` sidecar — the sidecar has no bytecode metric):

   ```bash
   kubectl run scrape --rm -i --restart=Never --image=curlimages/curl:8.11.1 -- \
     curl -sS http://<app>.<ns>.svc.cluster.local/api/metrics | grep kn_next_bytecode_cache
   ```

   Record `kn_next_bytecode_cache_files_total` — call it `N`.

2. **Scale to zero.** Wait until there are no Running pods:

   ```bash
   kubectl get pods -n <ns> -l serving.knative.dev/service=<app> -w
   ```

3. **Reactivate from cold.** Send a single request, then re-scrape `/api/metrics`.

4. **Assert reuse.** On the reactivated pod:
   - `kn_next_bytecode_cache_warm_start{app="<app>"} == 1` — it started **warm**.
   - `kn_next_bytecode_cache_files_total == N` — the file count is **stable** (no recompile bloat).

   If `warm_start == 0` or the file count grew, the cache did **not** survive scale-to-zero —
   investigate the PVC mount / retention (regression).

5. **(Optional) cold-start timing.** Measure scale-from-zero latency with vs without the warm
   cache; see the methodology in [`coldstart-bench-kind.md`](./coldstart-bench-kind.md). Treat
   timing as informational — the binding invariant is the no-recompile assertion above, not a
   millisecond threshold.

## Cross-references

- Cold-start benchmark methodology: [`coldstart-bench-kind.md`](./coldstart-bench-kind.md)
- Per-PR mechanism gate: `apps/file-manager/bytecode-cache-reuse.test.ts`
- Nightly e2e + workflow: `packages/kn-next-operator/test/e2e/scale_to_zero_cache_test.go`,
  `.github/workflows/operator-e2e-nightly.yml`
