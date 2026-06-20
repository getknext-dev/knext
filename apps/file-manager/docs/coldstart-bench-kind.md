# Cold-start benchmark — Bun vs Node+NODE_COMPILE_CACHE (local kind + Knative)

Measures end-to-end **scale-from-zero** cold start of the file-manager app on a clean local
Kubernetes (kind, cluster `knext`) with Knative Serving scale-to-zero, comparing two runtimes of
the **same** `next build` standalone output:

- **Node** runner (`Dockerfile`) with `NODE_COMPILE_CACHE` on a persistent PVC (cache survives
  scale-to-zero).
- **Bun** runner (`Dockerfile.bun`) running the same `server.js` under Bun (JSC, no persistent
  bytecode file).

## Method

- Both built from identical builder stage; only the runner differs. Loaded into kind as
  `dev.local/file-manager:{node,bun}-bench` (`imagePullPolicy: Never`, no registry pull in the path).
- Knative ksvc: `min-scale=0`, `scale-to-zero-pod-retention-period=0s`, stable `window=10s`;
  cluster `scale-to-zero-grace-period=10s`.
- Node pre-warmed 5× to populate the PVC bytecode cache (verified ~2.8 MB on the PVC), then
  measured. Bun pre-warmed 5× (no persistent cache to populate).
- Each cold sample: wait until pods scale to **0**, then one timed `GET /` from an in-cluster pod
  through the **kourier-internal** gateway (`Host` header set) → through the Knative **activator** →
  scale-up → first full response. Measured with Python `urllib` (cluster-internal; the public
  ExternalName route resolves to `127.0.0.1` and isn't reachable from a probe pod).

## Results

| Metric | Node + bytecode (PVC) | Bun (standalone) |
|---|---|---|
| Image size | 251 MB | **185 MB** (~26% smaller) |
| Cold start run 1 | 1.240 s | 1.356 s |
| Cold start run 2 | 1.365 s | 1.357 s |
| Cold start run 3 | 1.226 s | 1.304 s |
| **Cold start mean** | **1.28 s** | 1.34 s |
| Warm latency (`GET /`) | ~5 ms | ~5 ms |

## Findings

1. **Cold start is dominated by pod scheduling + container start, not JS warmup.** Both runtimes
   land at ~1.3 s scale-from-zero. The runtime difference is ~60 ms (~5%), within noise of the k8s
   cold-start path. This is consistent with the in-repo microbench (`cache-test-evidence.md`:
   Node server-ready ~207 ms vs Bun ~236 ms) — the JS-engine delta is a small slice of the total.
2. **Node + `NODE_COMPILE_CACHE` is marginally faster cold** here (1.28 s vs 1.34 s), not slower —
   the persistent bytecode cache on the PVC is doing its job.
3. **Bun's real win is image size** (~26% smaller), which helps registry pull / node image
   distribution, not steady-state cold start on a warm node.
4. There is **no "sub-100 ms" cold start** for either runtime on a real scale-to-zero path; the
   sub-100 ms figure in `docs/spikes/0001-bun-bytecode-pipeline.md` was a `bun --compile` binary
   process-spawn on a toy app, not an end-to-end Knative scale-from-zero.

## Caveats

- Single-node kind on a laptop; absolute numbers are environment-specific. The **comparison** is
  apples-to-apples (same build, same cluster, same window/grace, back-to-back).
- n=3 per runtime; the ~60 ms gap is not statistically robust — treat Node and Bun cold start as
  **equivalent** on this path, with image size as the real differentiator.
