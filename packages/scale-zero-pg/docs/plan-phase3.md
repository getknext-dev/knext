# Phase 3 plan — consolidated from three independent reviews

> Inputs: `reviews/system-design-review.md` (5/10 maintainability, 3/10 prod),
> `reviews/devops-review.md` (3/10 operability, 2/10 prod-perf),
> `reviews/architect-review.md` (6/10 fitness, 5/10 evolution).
> Date: 2026-07-02. Status: PROPOSED — awaiting owner approval.

## What all three reviews agree on (do first, no debate)

| Convergent finding | Sys-design | DevOps | Architect |
|---|---|---|---|
| Compute image `:latest` vs pinned storage = compat time-bomb | CRITICAL #1 | HIGH | Contract #1 |
| Secrets/creds/TLS/NetworkPolicy unfit for a shared platform DB | HIGH #4,#5 | CRITICAL | Aging #5 |
| Data on `local-path`/`Delete`, no backups → unrecoverable loss | HIGH #6 | CRITICAL ×2 | Invariant unprotected |
| Compute spec is a test fixture (1MB buffers, 100 conns, `fsync=off` unexplained) | LOW #13 + #11 | CRITICAL | Aging #4 (contract in prose) |
| Idle/sleep decision is fragile where it lives | TOCTOU race #3 | — | Aging #2: wrong layer entirely |
| Storage plane guards missing (PDB/liveness/limits/anti-affinity) | MEDIUM #8 | HIGH | Contract #4 |

**The architect's reframe (accepted as the plan's spine):** don't harden the
foundation before *deciding* the foundation. Self-hosted Neon was inherited from
the architecture doc, never decided against the goal's "easy to host/maintain"
clause — and knext (the sole consumer) defaults to CNPG and calls Neon self-host
"unsupported for production". The same gateway fronts either. So: quick
foundation-agnostic fixes → measured bake-off + ADR → harden the winner.

---

## Phase 3A — Foundation-agnostic fixes (cheap, needed regardless; ~1–2 days)

Everything here survives any bake-off outcome (the gateway and the k8s shape stay).

1. **Pin the compute image** to a digest matched to `neon:8464`; write the
   compute↔storage compatibility note in operations.md. *(All three reviews.)*
   Acceptance: no `:latest` anywhere; verify battery green on the pinned digest.
2. **Real compute spec** (also prerequisite for a *fair* bake-off): size
   `shared_buffers` to the pod limit, set `max_connections` deliberately, rename
   `docker_compose_test`, comment WHY `fsync=off` is safe (safekeeper quorum) at
   the setting. Acceptance: verify green + a before/after `pgbench`-style number.
3. **Secrets hygiene**: generated per-tier creds in real `Secret`s (no plaintext
   in manifests), scrub `minio/password` ×3, stop publishing `:9090` on the LB,
   default-deny NetworkPolicy (compute reachable only from gateway).
   Acceptance: `git grep password deploy/` clean; netpol drill (client pod
   cannot reach `compute:55433` directly).
4. **Interim sleep-race mitigation** (sys-design #3): re-confirm local+peer
   counts immediately before `Sleep()` and abort scale-down if a connection
   arrived; also retry handshake on refused/EOF from a Terminating pod
   (sys-design #14). Structural ownership move happens in 3C. Acceptance: Go
   test reproducing the race window passes.
5. **CI**: GitHub Actions (or equivalent): `go vet` + `go test ./...` + image
   build + `deploy/_validate.sh` against kind. Acceptance: pipeline green on main.
6. **Cheap data-safety insurance**: reclaim `Retain` on stateful PVs, PDBs
   (safekeeper `minAvailable: 2`, pageserver), liveness probes + resource
   requests/limits on the storage plane, `revisionHistoryLimit: 2`.
7. **"Never scales to zero" alert + Prometheus scrape** (architect #4, DevOps
   observability): deploy kube-prometheus-stack (or minimal Prometheus), scrape
   `pggw`, ship 3 alert rules as code (wake failures, phantom keepalive, wake
   p99 drift). Needed to *measure* the bake-off anyway.

## Phase 3B — Decide the foundation (the centerpiece; ~1 sprint)

8. **Bake-off: CNPG + `cnpg-i-scale-to-zero` (hibernation) + the SAME gateway**
   vs the current self-hosted Neon plane. The gateway's `Driver` seam already
   supports this (exec/kubectl modes; hibernation = CNPG annotation toggle).
   Measure on the goal's own axes:
   - wake p99 (cold, warm, reconnect-after-drain), 20+ samples each
   - data-survival + failure drills (the existing verify battery, ported)
   - ops mass: components, PVCs, images to track, upgrade steps
   - what's lost: branching/PITR, lazy page fetch (document, don't hand-wave)
9. **Write ADR-0002 "database foundation"** with the measurements, the decision
   (self-host Neon | CNPG-hibernation | managed Neon), and **adopt the
   architect's kill criteria verbatim** as standing pivot triggers (ops toil
   >1 eng-day/month; wake p99 advantage evaporated; version-treadmill cost;
   knext posture; branching unused).

## Phase 3C — Harden the winner (order within depends on 3B)

10. **Backups + rehearsed restore drill** for the winner's history store
    (real S3 / replicated MinIO; documented RTO; the drill is a script like the
    other verifies). *(DevOps: "the one that ends the project".)*
11. **Move scale-down ownership out of the gateway** (KEDA ScaledObject or a
    ~200-line controller); gateway keeps wake + connection-holding only.
    Kills the split-brain class structurally before multi-tenancy multiplies it.
12. **Remove remaining SPOFs**: secondary pageserver (if Neon wins) /
    multi-node + anti-affinity; connection cap + backpressure in the gateway.
13. **Warm-standby pool for sub-second wake** — after the foundation decision,
    because it deepens foundation-specific coupling (architect #4 ordering).
    Includes the wake-ahead + LFC/pg_prewarm investigation (Knative Functions
    prewarm idea from the owner).
14. **Template-mode multi-tenancy, end-to-end tested** — last, per all three
    reviews: it multiplies every unsolved problem by N.

## Declared out of scope (from the architect, adopted)

Horizontal write scaling within one DB; cross-region active/active; forking or
building a bespoke Neon operator; TSL Timescale features on scale-to-zero
compute.

## Sequencing rationale in one line

Fix what's cheap and universal → measure before marrying the storage plane →
then spend hardening effort only on the foundation that won.
