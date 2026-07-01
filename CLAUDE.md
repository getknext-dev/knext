# CLAUDE.md — kickoff brief for building this MVP

## Goal
Ship an MVP of a **scale-to-zero Postgres platform** for a Self-Contained Systems (SCS)
architecture that is **proven to work at scale**. Each system gets its own database; idle systems
consume zero compute; a connection wakes the system's compute sub-second. "Works at scale" is
defined by the four risks in *Definition of done*, not by feature count.

## Architecture (fixed — do not relitigate)
Native PostgreSQL compute on a **self-hosted Neon storage stack** (Apache-2.0), orchestrated by
**Knative/KEDA**. Three planes:
- **Storage plane = reused from Neon** (safekeepers = durable WAL + single-writer authority;
  pageserver = pages + object-storage offload; storage broker + storage controller). Runs as
  StatefulSets. We operate it; we do NOT build or fork it.
- **Compute plane = native Postgres (Neon compute)**, one **primary per system**, scaled 0<->1 by
  KEDA. Stateless: cold start connects to storage and lazy-fetches pages (~300-500ms); no restore.
- **Routing plane = we build**: the gateway (wake-on-connect, route by system_id, pipe) and the
  provisioner (system_id -> Neon tenant/timeline + registry).

## Invariants (guardrails — violating these is a bug)
1. **Single-writer is intrinsic to Neon.** One primary compute per timeline. Do NOT build a lease,
   epoch, or fencing layer — the safekeeper/storage-controller layer already guarantees it.
2. **Never put storage (safekeepers/pageservers) on Knative or scale them to zero.** Stateful only.
3. **Postgres is TCP.** Knative Serving's activator is HTTP-first, so compute scaling uses **KEDA**.
   Knative Serving is for the HTTP-facing SCS apps, not the DB compute.
4. **Don't rebuild what Neon gives free:** WAL durability, replication, snapshots, branching, PITR.
5. **system_id is a DNS-1035 label** and is carried as the Postgres `database` name on connect.

## Repo map
- `gateway/`     — Node, dependency-free. TCP proxy: parse startup -> wake compute -> replay -> pipe.
                   `_smoke.js` (proto) and `_e2e.js` (full path) both pass today.
- `provisioner/` — Node, dependency-free. `POST /systems` -> tenant/timeline + registry. `storage.js`
                   has a `neon` stub to implement in Phase 1. `_smoke.js` passes.
- `deploy/`      — k8s manifests (namespace, Neon CRDs, gateway+RBAC, provisioner, compute+KEDA template).
- `local/`       — docker-compose Neon storage plane for dev + how to run gateway/provisioner locally.

## What works vs what's stubbed
- WORKS: gateway startup parse / SSL decline / static+template wake / byte-pipe; provisioner API in
  `mock` mode; both smoke tests + gateway e2e.
- STUBBED (implement next): `provisioner/src/storage.js` `neon` mode (real storage-controller calls);
  gateway `kubectl` wake wiring end-to-end; the provisioner rendering `30-compute-template.yaml` per system.

## Phased tasks (see TASKS.md for the checklist)
0. Stand up the storage plane (local compose, then cluster); prove native PG survives a compute kill.
1. Provisioner `neon` mode: create real tenant/timeline; move registry to control-plane Postgres.
2. Gateway wake path on-cluster (KEDA activate or `kubectl` mode); wake-on-connect verified.
3. Scale-to-zero loop: idle -> 0, connect -> sub-second wake; per-system.
Then: **scale validation** (Definition of done).

## Definition of done (the MVP "works at scale" bar)
Retire these four, with load-test evidence:
1. **Concurrent cold starts stay sub-second** under many simultaneous wakes (no gateway/KEDA/
   controller bottleneck).
2. **Tenant density**: measured systems-per-storage-set before degradation.
3. **Gateway is horizontally scalable / not a SPOF** on the connection path.
4. **Idle detection is real**: systems actually reach zero; no phantom keepalive traffic.

## Conventions
- Node services are stdlib-only (no deps) for the MVP — keep them runnable offline; add deps only
  with clear justification. Keep `_smoke.js`/`_e2e.js` green. Config via env only.
