# Bake-off — full run (phase-4B decision gate, 2026-07-02)

Run id **`20260702T192637`**. Harness: `bakeoff/_run-battery.sh` (supersedes the
scaffold's env-var `COLD_CMD` path; fixes the Neon `readyReplicas` cold-forcing bug
and quiesces `scale-zero-pg` during Neon sampling). **n=20 per cell.**

Decision + full analysis: **`docs/adr-0002-database-foundation.md`**.

## Latency (ms; connect + `SELECT count(*) FROM t` through each gateway)

| Foundation | Dimension | n | min | p50 | p95 | p99 | max |
|---|---|--:|--:|--:|--:|--:|--:|
| Neon | cold wake | 20 | 3504 | 3717 | 4956 | 5067 | 5095 |
| CNPG | cold wake | 20 | 12261 | 14413 | 14848 | 14917 | 14934 |
| Neon | warm | 20 | 116 | 121 | 131 | 133 | 134 |
| CNPG | warm | 20 | 112 | 115 | 122 | 144 | 150 |
| Neon | reconnect-after-drain | 20 | 3565 | 3692 | 4878 | 4908 | 4915 |
| CNPG | reconnect-after-drain | 20 | 12808 | 14446 | 15223 | 16309 | 16580 |

Raw: `bakeoff/results/{neon,cnpg}-{cold,warm,reconnect}-20260702T192637.csv`.

- Neon cold wake **~3.9× faster** (p95 5.0 s vs 14.8 s) — its one measured differentiator.
- Warm is a tie (~120 ms both): steady-state latency is the shared gateway, not the substrate.
- Reconnect mirrors cold on both foundations.

## Failure drills (data survival)

| Foundation | Drill | Result | Recovery |
|---|---|---|---|
| CNPG | hibernate → un-hibernate | PASS (3 rows, no restore) | ~3.3 s |
| CNPG | hard pod-kill (`--grace-period=0 --force`) → operator reschedules on same PVC | PASS — new pod (uid changed) served 3 rows on PVC `pg-1` | **~16 s** (`_drill-cnpg-podkill.sh`) |
| Neon | compute pod-kill → re-attach to tenant/timeline | PASS (`deploy/_verify-storage.sh`) | re-attach, no restore |

## Ops mass (counted, live cluster)

- **Neon:** 6 data-path workloads (compute + safekeeper×3 + pageserver + broker + MinIO)
  + 2 bootstrap Jobs + 3 compute ConfigMaps + **compute↔storage version-pair `8464`/`8464`**
  + ≥3 data-path images + 6 PVCs. Backup story not yet built; single-pageserver read SPOF.
- **CNPG:** 1 operator + 1 Cluster (1 pod) + 2 images + 1 PVC. Backup CRDs installed.

## Recommendation (Proposed)

**CNPG-hibernation as the default foundation.** Neon's cold-wake edge sits at the
architect's ~3× decision boundary (2.96×) while *all* Neon differentiators (branching /
PITR / read replicas) are unused and the consumer (knext) defaults to CNPG and declines to
commit to them. Keep Neon as a documented escalation lane. Full rationale + kill criteria in
ADR-0002. State restored after the run (compute=0, CNPG hibernated, PVCs bound).
