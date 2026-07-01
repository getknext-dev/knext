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
