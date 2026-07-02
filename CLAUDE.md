# CLAUDE.md — kickoff brief for this MVP

## Goal (current, 2026-07-02)
Ship a **Knative-ecosystem MVP of scale-to-zero PostgreSQL**: one database that is easy to host,
easy to maintain, and reliable enough. Idle DB consumes zero compute; a client connection wakes it
sub-second(ish). Reuse open source (Neon) for everything below the wire; build only the glue.
**SCS multi-tenancy is parked** — single DB first, multi-system later (the `template` wake mode is
the seam where it returns).

## Consumer
The **knext** platform (`~/alpheya/pocs/knext`) — a scale-to-zero Next.js framework on
Knative (Go operator, `NextApp` CRD). knext binds databases only via a `DATABASE_URL` Secret
(`NextApp.spec.secrets.envMap`) and deliberately builds no DB machinery itself. KS-PG ships as
cluster infrastructure **alongside** knext; integration = one Secret pointing at our gateway.
Research notes: `docs/knext-research.md`.

## Architecture (fixed)
Native Postgres compute on Neon's OSS storage stack, all **on Kubernetes** (no docker-compose):
- **Storage plane (reused, StatefulSets):** safekeeper (durable WAL, single-writer authority),
  pageserver (pages + S3/MinIO offload), storage broker, MinIO. Never scaled to zero.
- **Compute plane:** one stateless Neon compute (`neondatabase/compute-node-v17`) as a Deployment,
  `replicas: 0` at rest, scaled 0↔1. Cold start = attach + lazy page fetch; no restore.
- **Routing plane (we build, Go):** `gateway/` — wake-on-connect Postgres proxy. Parses the
  startup packet, declines SSL, scales the compute Deployment via the API server (client-go),
  replays startup, pipes bytes, and scales back to 0 after `GW_IDLE_MS` with no connections.

## Hard rules
1. **Go for everything Kubernetes-native. No JS/TS unless necessary.**
2. **TDD commits**: test/verification commit first (red), implementation commit second (green).
2b. **User docs ship WITH the change.** Any change that alters user-visible behavior,
   config, drills, or measured numbers updates docs/ (getting-started, connecting,
   operations) in the same commit or the same PR-sized batch. Doc drift found in
   review counts as a defect.
3. Single-writer is intrinsic to Neon — no lease/fencing layer. Compute uses `Recreate` strategy.
4. Storage plane never on Knative, never scale-to-zero. Compute scaling is TCP-triggered
   (gateway/KEDA), not Knative Serving — the activator is HTTP-only.
5. Don't rebuild what Neon gives free: WAL durability, replication, branching, PITR.
6. Everything runs on the cluster (`orbstack` context locally). No compose files.

## Repo map
- `gateway/`  — Go wake-on-connect proxy (client-go). Tests in package; `go test ./...`.
- `deploy/`   — all k8s manifests: 00 namespace, 10 gateway, 20 compute (replicas:0),
                30 knext Secret, 40 KEDA (optional), 5X storage plane + init Job.
                `_validate.sh` (manifest contracts), `_verify-storage.sh` (survival test).
- `docs/`     — knext research, recipes.

## Definition of done (MVP)
On a local k8s cluster, with a one-table test DB:
1. Compute at 0 → `psql` through the gateway → compute wakes → rows return. Wake time recorded.
2. Idle window passes → compute back to 0 (verified, no phantom keepalives).
3. Reconnect wakes it again; data intact (storage plane owns durability).
4. knext integration documented: Secret + pool-idle-below-GW_IDLE_MS sizing note.
