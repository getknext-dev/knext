# TASKS — dependency-ordered MVP checklist

## Phase 0 — storage plane + native Postgres (foundation)
- [ ] Bring up `local/docker-compose.yml`; confirm MinIO bucket + pageserver/safekeeper healthy.
- [ ] Run a Neon compute against it; connect with psql; create a table, insert, select.
- [ ] Kill the compute; reconnect; confirm data intact and cold start is sub-second (no restore).
- [ ] Repeat on a cluster: install neon-operator (pilot), apply `10-neon-cluster.yaml`.

## Phase 1 — SCS provisioning
- [ ] Implement `provisioner/src/storage.js` `neon` mode against the storage-controller API.
- [ ] Move `registry.js` to the shared control-plane Postgres (schema: systems table).
- [ ] `POST /systems` creates tenant+timeline and (Phase 3) renders the compute template.
- [ ] Idempotency + validation covered by tests (extend `_smoke.js`).

## Phase 2 — gateway wake-on-connect (on cluster)
- [ ] Choose wake mechanism: KEDA "activate" trigger vs `GW_COMPUTE_MODE=kubectl` (RBAC included).
- [ ] Verify: connecting to a slept system wakes its primary and the query succeeds.
- [ ] Gateway emits per-system wake latency + active-connection metrics (already scaffolded).

## Phase 3 — scale-to-zero loop
- [ ] KEDA ScaledObject per system (`30-compute-template.yaml`): idle -> 0 after cooldown.
- [ ] Confirm a clean 0 -> 1 -> 0 cycle per system under real client traffic.
- [ ] Alert on "never scales to zero" (phantom keepalive detection).

## Scale validation (Definition of done)
- [ ] Provision N systems (pick N with target load); most idle, a subset hot.
- [ ] Load test: fire many simultaneous cold-start connections; assert p99 wake < 1s.
- [ ] Measure tenant density per storage set; record the ceiling.
- [ ] Scale the gateway to 2+ replicas; confirm no SPOF and flat latency.
