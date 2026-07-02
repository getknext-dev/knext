# Bake-off — initial scaffold run (2026-07-02)

**Purpose of this iteration:** prove the scaffold and the review's "same gateway,
two foundations" claim. NOT a rigorous latency verdict — that needs the 20+
sample / multi-dimension run described in `../README.md`.

## Same-gateway claim: HELD ✅

The exact production gateway binary (`/gateway`, sha256
`150d802d…e0e56b`) is **byte-for-byte identical** in `scale-zero-pg/gateway:dev`
(distroless, production) and `scale-zero-pg/gateway-exec:dev` (bake-off). The
bake-off image only re-bases it onto alpine to supply `sh`+`kubectl`, which
exec-mode's `execDriver` shells out to. Zero source changes. A cold connect
through the exec-mode gateway woke a hibernated CNPG cluster and served the
seeded 3 rows (`_verify-wake.sh` → PASS).

## Cold-wake numbers (5-sample scaffold, client-observed via `_measure.sh`)

| Foundation | mechanism | min | p50 | p99 | notes |
|---|---|---|---|---|---|
| **CNPG-hibernation** | un-hibernate = pod reschedule + PVC attach + PG start | 13048 | **13255** | 13309 | 5/5 cold, extremely consistent (`cnpg-*.csv`) |
| **Neon** | scale 0→1 + attach + lazy page fetch | 121 (warm) | — | — | harness cold-forcing flaky (see below); `neon-*.csv` |
| **Neon (confirmed-cold)** | " | — | **~5045** | — | one sample with verified `spec.replicas=0` before connect |
| Neon (best-case, prior team measurement) | " | — | ~2400 | — | README verification table |

**Directional finding:** CNPG-hibernation cold wake (~13.3s, very tight variance)
is **~2.5–5× slower** than Neon's lazy-fetch cold wake (~2.4–5s). Neon's
size-independent fast start is a *real* differentiator — this is the first
measured evidence for the review's kill-criterion "if wake isn't Neon's
differentiator, pivot." Here it still is. The counter-weight (ops mass, see
README inventory) is what the full run must price against this ~8–10s gap.

## Honest scaffold caveats (fix before the 20+ run)

1. **Neon cold-forcing is unreliable in the harness.** `.status.readyReplicas`
   is *omitted when zero* in this k8s (1.34); the sample `COLD_CMD` treated the
   empty value as "already cold" and broke early, so 4/5 Neon samples measured a
   *warm* compute (~120ms). Fix: poll `spec.replicas==0 AND readyReplicas(default 0)==0`
   (as the confirmed-cold capture above does) before timing.
2. **Shared namespace.** `scale-zero-pg` is used by other work; another
   connection can reset its idle timer and prevent sleep. The full run should
   quiesce it or record pre-connect replica count per sample.
3. **kubectl-exec offset.** Each sample includes ~100–200ms `kubectl exec`
   overhead (constant across both foundations; dwarfed by seconds-scale wake).

## Failure drill (data survival) — CNPG: PASS ✅

Hibernate (pod deleted, PVC `pg-1` retained) → un-hibernate → `SELECT count(*)
FROM t` = 3. Sleep took ~3.3s; PVC survived; no restore step. Neon's equivalent
(compute kill, no volume) is already proven in `deploy/_verify-storage.sh`.

## Ops-mass snapshot (measured, this cluster)

- **CNPG:** 1 operator Deployment (`cnpg-system`) + 1 Cluster = 1 pod + 1 PVC +
  3 svc (rw/ro/r). 2 pinned images (operator 1.29.2, postgresql 17.2).
- **Neon:** compute + safekeeper×3 + pageserver + broker + MinIO + storage-init
  Job + compute ConfigMaps; ≥3 images with a compute/storage version-compat
  matrix. (Per `deploy/`.)
