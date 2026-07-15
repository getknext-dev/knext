# TASKS — dependency-ordered MVP checklist (rescoped 2026-07-02: single DB, all-on-k8s, Go)

## Done
- [x] Gateway prototype (Node) — superseded, kept in git history as the spec.
- [x] deploy/: namespace, gateway+RBAC, compute replicas:0, knext Secret, optional KEDA
      (`deploy/_validate.sh` green against the orbstack cluster).

## Done (MVP shipped 2026-07-02)
- [x] Gateway in Go (client-go): port all 20 test behaviors, delete Node version, Dockerfile.
- [x] Storage plane on k8s: minio + broker + safekeeper + pageserver StatefulSets,
      init Job → tenant/timeline + `compute-config`/`compute-files` ConfigMaps,
      `deploy/_verify-storage.sh` proves one-table data survives a compute pod kill.

## MVP acceptance (user-defined)
- [x] On the local k8s cluster, one-table test DB:
      compute at 0 → connect via gateway → wake → SELECT returns rows (record wake seconds)
      → idle → compute back to 0 → reconnect wakes again.
- [x] Gateway image built + deployed; `kubectl -n scale-zero-pg get deploy compute` shows 0↔1.

## After MVP
- [x] Docs: README quickstart (cluster-only), knext recipe (Secret + pool sizing), wake-latency
      numbers; refresh graphify graph.
- [ ] Harden: 3 safekeepers, secondary pageserver, PVC sizing, TLS in front of gateway.
- [ ] Un-park SCS: `template` wake mode + per-system compute Deployments + provisioning API.
- [ ] Scale validation: concurrent cold starts, tenant density, gateway HA, idle-detection audit.

## Phase 2 — maturity & reliability (done 2026-07-02)
- [x] Cold wake 5.2s -> 2.4s (CoreDNS negative-cache root cause; ClusterIP + publishNotReadyAddresses).
- [x] 3-safekeeper WAL quorum; drill: writes survive one member down, member rejoins.
- [x] Gateway x2, peer-aware idle (no split-brain), no-SPOF drill green (_verify-ha.sh).
- [x] 57P03 starting-up FATALs absorbed by gateway handshake retry (was an intermittent client error).
- [x] ADR-0001: TimescaleDB = Apache-2 add-on only (hypertables); sharding = tenant-per-app + Neon shard-split + pg_partman; Citus rejected.

## Phase 3 — next
- [ ] Warm-standby compute pool for sub-second wake (attach-on-wake).
- [ ] Secondary pageserver + Neon shard-split exercised; failure-domain spreading.
- [ ] TLS in front of the gateway; real secret management (rotate cloud_admin).
- [ ] Un-park SCS: template wake mode + per-system computes + provisioning API.
- [ ] Load tests: concurrent cold starts p99, tenant density, idle-detection audit.
