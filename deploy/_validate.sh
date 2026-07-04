#!/bin/sh
# Validation for deploy/ manifests: server-side dry-run against the current
# kube context, plus contract checks the YAML must satisfy. Run from repo root
# or deploy/. Exits non-zero on any failure.
set -eu
cd "$(dirname "$0")"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

command -v kubectl >/dev/null || fail "kubectl not found"

# 1. every manifest must dry-run apply cleanly (server-side validation).
# The namespace is applied for real first: namespaced dry-runs need it to
# exist, and this cluster is the demo target anyway.
kubectl apply -f 00-namespace.yaml >/dev/null || fail "namespace apply failed"
ok "00-namespace.yaml applied"
for f in [0-9][0-9]-*.yaml; do
  [ -e "$f" ] || fail "no numbered manifests found in deploy/"
  [ "$f" = 00-namespace.yaml ] && continue
  # Capture stderr (stdout discarded). On success this is empty and we move on.
  if err="$(kubectl apply --dry-run=server -f "$f" 2>&1 >/dev/null)"; then
    ok "$f validates (server dry-run)"
    continue
  fi
  # #126: server dry-run REJECTS a re-apply that touches an immutable field on an
  # ALREADY-APPLIED object — e.g. the completed storage-init Job (immutable
  # spec.template/selector). That is not a manifest defect, but the old `|| fail`
  # ABORTED the whole loop there, so the later manifests (notably 82/83, the
  # AppDatabase CRD + operator) were NEVER validated — the guard that should have
  # caught the #125 placeholder digest. Fall back to CLIENT dry-run (schema
  # validation) for the immutable case so validation continues and still checks
  # the YAML is well-formed.
  if printf '%s' "$err" | grep -qi 'immutable'; then
    kubectl apply --dry-run=client -f "$f" >/dev/null 2>&1 \
      || fail "$f does not validate (client dry-run after immutable server-side reject): $err"
    ok "$f validates (client dry-run; server rejects an immutable field on the live object — #126)"
    continue
  fi
  fail "$f does not validate: $err"
done

# 2. contract: compute deployment must start at zero replicas
grep -q 'replicas: 0' 20-compute.yaml || fail "20-compute.yaml must set replicas: 0"
ok "compute starts at zero"

# 2b. contract: the read-only pool (issue #66) starts at zero and the gateway
#     serves a second RO DSN lane pointed at it.
grep -q 'replicas: 0' 26-compute-ro.yaml || fail "26-compute-ro.yaml must set replicas: 0"
grep -q 'name: compute-ro' 26-compute-ro.yaml || fail "26-compute-ro.yaml missing the compute-ro Service"
grep -q 'GW_RO_PORT' 10-gateway.yaml || fail "10-gateway.yaml missing GW_RO_PORT (RO pool lane)"
grep -q 'GW_RO_DEPLOYMENT' 10-gateway.yaml || fail "10-gateway.yaml missing GW_RO_DEPLOYMENT"
ok "read-only pool starts at zero + gateway RO lane wired (GW_RO_PORT -> compute-ro)"

# 2c. contract: the read-scaling HPA (issue #99 GA) is a real, valid manifest but
#     lives under deploy/optional/ so the default `kubectl apply -f deploy/`
#     (non-recursive) never floors compute-ro at 1 — scale-to-zero stays default.
HPA=optional/27-compute-ro-hpa.yaml
[ -f "$HPA" ] || fail "$HPA missing (read-scaling HPA must ship as a real .yaml, not .optional)"
[ -e 27-compute-ro-hpa.yaml.optional ] && fail "stale 27-compute-ro-hpa.yaml.optional present — GA'd file moved to $HPA"
[ -e 27-compute-ro-hpa.yaml ] && fail "27-compute-ro-hpa.yaml must live under optional/ (else -f deploy/ auto-applies it)"
kubectl apply --dry-run=server -f "$HPA" >/dev/null || fail "$HPA does not validate"
grep -q 'name: compute-ro' "$HPA" || fail "$HPA must target the compute-ro deployment"
grep -q 'minReplicas: 1' "$HPA" || fail "$HPA posture B must set minReplicas: 1"
ok "read-scaling HPA ships under optional/ (opt-in, valid, targets compute-ro)"

# 3. contract: gateway RBAC may scale deployments (scale subresource)
grep -q 'deployments/scale' 10-gateway.yaml || fail "gateway RBAC lacks deployments/scale"
ok "gateway RBAC includes deployments/scale"

# 4. contract: gateway runs in kubectl mode against the compute deployment
grep -q 'GW_COMPUTE_MODE' 10-gateway.yaml || fail "gateway env GW_COMPUTE_MODE missing"
ok "gateway wake mode configured"

# 5. contract: knext consumes the DB only via a DATABASE_URL secret
grep -q 'DATABASE_URL' 30-knext-secret.yaml || fail "knext secret lacks DATABASE_URL"
ok "knext DATABASE_URL secret present"

# 6. contract: every storage pod must declare a liveness probe (a hung — not
#    crashed — pageserver/safekeeper must be restarted, not silently stalled).
for f in 50-minio.yaml 51-storage-broker.yaml 52-safekeeper.yaml 53-pageserver.yaml; do
  grep -q 'livenessProbe:' "$f" || fail "$f lacks a livenessProbe"
done
ok "storage pods declare liveness probes"

# 7. contract: every storage pod must set resource requests AND limits (no
#    BestEffort QoS on the durability tier — one hog must not evict the plane).
for f in 50-minio.yaml 51-storage-broker.yaml 52-safekeeper.yaml 53-pageserver.yaml; do
  grep -q 'requests:' "$f" || fail "$f lacks resource requests"
  grep -q 'limits:' "$f"   || fail "$f lacks resource limits"
done
ok "storage pods set resource requests + limits"

# 8. contract: storage + compute cap ReplicaSet/controller history (no churn).
for f in 20-compute.yaml 26-compute-ro.yaml 50-minio.yaml 51-storage-broker.yaml 52-safekeeper.yaml 53-pageserver.yaml; do
  grep -q 'revisionHistoryLimit:' "$f" || fail "$f lacks revisionHistoryLimit"
done
ok "compute + storage cap controller revision history"

# 9. contract: storage pods harden the securityContext (drop caps / no priv-esc /
#    seccomp; neon images run as uid 1000 so runAsNonRoot is safe there).
for f in 50-minio.yaml 51-storage-broker.yaml 52-safekeeper.yaml 53-pageserver.yaml; do
  grep -q 'securityContext:' "$f" || fail "$f lacks a securityContext"
done
ok "storage pods set a hardened securityContext"

# 10. contract: PodDisruptionBudgets guard the safekeeper quorum + pageserver.
grep -q 'kind: PodDisruptionBudget' 56-pdb.yaml || fail "56-pdb.yaml missing PDBs"
grep -q 'minAvailable: 2' 56-pdb.yaml || fail "safekeeper PDB must keep minAvailable: 2 (quorum)"
ok "56-pdb.yaml guards safekeeper quorum + pageserver"

# 11. contract: a minimal in-cluster Prometheus scrapes the gateway FAMILY and
#     ships the review's three alerts (wake failures, wake latency, phantom keepalive).
grep -q 'prom/prometheus' 60-prometheus.yaml || fail "60-prometheus.yaml lacks a pinned prometheus image"
grep -q 'pggw_wake_failures_total' 60-prometheus.yaml || fail "60-prometheus.yaml missing wake-failure alert"
grep -q 'pggw_wake_latency_ms_last' 60-prometheus.yaml || fail "60-prometheus.yaml missing wake-latency alert"
grep -q 'PhantomKeepalive' 60-prometheus.yaml || fail "60-prometheus.yaml missing phantom-keepalive alert"
# #80: the scrape keep MUST cover the apps-gateway (pggw-apps), not exact `pggw` only —
# otherwise the entire branch-per-app plane + per-app computes emit metrics no rule sees.
grep -q 'regex: pggw(-apps)?' 60-prometheus.yaml || fail "60-prometheus.yaml scrape keep must be 'pggw(-apps)?' to cover the apps-gateway (#80)"
grep -q 'target_label: gateway' 60-prometheus.yaml || fail "60-prometheus.yaml must carry a per-plane 'gateway' label (#80)"
# #80: multi-tenant / read-pool compute wake alerts must exist.
for a in ComputeWakeStuckApps ComputeRoPoolStuck ComputeStuckNotReady; do
  grep -q "alert: $a" 60-prometheus.yaml || fail "60-prometheus.yaml missing $a alert (#80)"
done
# ComputeWakeStuck (single-DB) must be scoped to gateway=pggw so apps traffic can't trip it.
grep -q 'pggw_active_connections{gateway="pggw"}' 60-prometheus.yaml || fail "60 ComputeWakeStuck must scope its connection sum to gateway=\"pggw\" (#80)"
ok "60-prometheus.yaml scrapes the gateway family (pggw + pggw-apps) + ships the review alerts + multi-tenant/read-pool wake alerts (#80)"

# 12. contract: storage S3/root credentials come from a Secret, never plaintext
#     YAML. No `value: password`/`value: minio` literals; secretKeyRef present.
for f in 50-minio.yaml 52-safekeeper.yaml 53-pageserver.yaml; do
  grep -q 'secretKeyRef' "$f" || fail "$f must source S3 creds via secretKeyRef"
  grep -qE 'value:[[:space:]]*(password|minio)[[:space:]]*(#.*)?$' "$f" \
    && fail "$f still carries a plaintext S3 credential value"
done
grep -q 'storage-s3-creds' 50-minio.yaml || fail "50-minio.yaml must reference the storage-s3-creds Secret"
ok "storage S3 creds sourced from Secret (no plaintext in 50/52/53)"

# 13. contract: credential-provisioning + PV-hardening scripts exist.
[ -f gen-secrets.sh ] || fail "gen-secrets.sh missing"
grep -q 'storage-s3-creds' gen-secrets.sh || fail "gen-secrets.sh must manage the storage-s3-creds Secret"
[ -f harden-pvs.sh ] || fail "harden-pvs.sh missing"
grep -q 'Retain' harden-pvs.sh || fail "harden-pvs.sh must set Retain reclaim policy"
ok "gen-secrets.sh + harden-pvs.sh present"

echo "deploy validation: all checks passed"

# 12. contract: compute and storage are a VERSION PAIR (ADR-0002 kill-criterion
#     #3; the pageserver wire protocol has no cross-version guarantee). A tag
#     drift anywhere fails the build.
CT=$(grep -o 'neondatabase/compute-node-v[0-9]*:[a-z0-9.]*' 20-compute.yaml | head -1 | cut -d: -f2)
for f in 51-storage-broker.yaml 52-safekeeper.yaml 53-pageserver.yaml 55-storage-init.yaml 57-pageserver-standby.yaml 26-compute-ro.yaml; do
  for st in $(grep -o 'neondatabase/neon:[a-z0-9.]*' "$f" | cut -d: -f2 | sort -u); do
    [ "$st" = "$CT" ] || fail "version-pair drift: $f uses neon:$st but compute is :$CT"
  done
  for ct in $(grep -o 'neondatabase/compute-node-v[0-9]*:[a-z0-9.]*' "$f" | cut -d: -f2 | sort -u); do
    [ "$ct" = "$CT" ] || fail "version-pair drift: $f uses compute-node:$ct but writer is :$CT"
  done
done
[ -n "$CT" ] || fail "could not extract compute tag from 20-compute.yaml"
ok "compute↔storage version pair consistent (:$CT everywhere)"

# 13. contract: every long-running pod declares ephemeral-storage requests
#     (incident 2026-07-03: pods without them were kubelet's preferred
#     eviction targets during DiskPressure - the storage plane died first).
for f in 10-gateway.yaml 20-compute.yaml 25-compute-warm.yaml 26-compute-ro.yaml 50-minio.yaml 51-storage-broker.yaml 52-safekeeper.yaml 53-pageserver.yaml 57-pageserver-standby.yaml 58-pswatcher.yaml 59-kube-state-metrics.yaml 60-prometheus.yaml 61-alertmanager.yaml 62-backup.yaml; do
  # must be under requests: (eviction ordering ranks on requests, not limits)
  grep -E 'requests: \{[^}]*ephemeral-storage' "$f" >/dev/null || fail "$f lacks ephemeral-storage under requests:"
done
ok "all long-running pods declare ephemeral-storage REQUESTS (incl. backup mirror)"

# 13b. contract: the RO read-pool ephemeral-storage is SIZED for load (issue #121).
#      At the old 1Gi limit the kubelet evicted compute-ro pods under sustained read
#      load (LFC + pg_wal + temp spill all live on the pod's ephemeral fs), so the
#      read-scaling axis flapped. The limit must be raised WELL above 1Gi and the
#      request set realistically so a loaded pod is not the first eviction target.
grep -qE 'ephemeral-storage: 1Gi' 26-compute-ro.yaml && fail "26-compute-ro still caps ephemeral-storage at 1Gi — the RO pool evicts under load (issue #121); raise the limit + set a realistic request"
grep -qE 'limits: \{[^}]*ephemeral-storage: (4|8|16)Gi' 26-compute-ro.yaml || fail "26-compute-ro must raise the ephemeral-storage LIMIT (>=4Gi) so a loaded read replica is not evicted (issue #121)"
grep -qE 'requests: \{[^}]*ephemeral-storage: (2|4|8)Gi' 26-compute-ro.yaml || fail "26-compute-ro must set a REALISTIC ephemeral-storage REQUEST (>=2Gi) so loaded RO pods aren't the first eviction target (issue #121)"
ok "RO read-pool ephemeral-storage sized for sustained load (request>=2Gi, limit>=4Gi) — no flap (issue #121)"

# 14. contract: automated pageserver failover (issue #3) — a standing warm
#     Secondary standby + a watcher that promotes it. The SPOF is only bounded
#     if BOTH ship: the standby holds warm layers, the watcher drives the flip.
grep -q 'kind: StatefulSet' 57-pageserver-standby.yaml || fail "57 missing the standby StatefulSet"
grep -q '"mode":"Secondary"' 57-pageserver-standby.yaml || fail "57 standby-init must register a warm Secondary"
grep -q 'name: pageserver-primary' 57-pageserver-standby.yaml || fail "57 missing stable pageserver-primary liveness Service"
grep -q 'name: pageserver-generation' 57-pageserver-standby.yaml || fail "57 missing the generation ledger ConfigMap"
grep -q '/pswatcher' 58-pswatcher.yaml || fail "58 must run the /pswatcher binary (not /gateway)"
grep -q 'PSW_STANDBY_SELECTOR_APP' 58-pswatcher.yaml || fail "58 watcher missing the standby selector-flip target"
# the watcher's RBAC must be able to flip the Service and bounce the compute.
grep -q 'services' 58-pswatcher.yaml || fail "58 watcher RBAC lacks services (selector flip)"
ok "automated failover ships: warm-Secondary standby (57) + auto-failover watcher (58)"

# 15. contract: the backup target is OFF-CLUSTER OCI Object Storage (issue #4),
#     NOT the retired in-cluster backup-store PVC. The mirror must authenticate
#     dst from the backup-s3-target Secret and must not reintroduce backup-store.
grep -q 'backup-s3-target' 62-backup.yaml || fail "62 backup mirror must read the backup-s3-target Secret (off-cluster dst)"
grep -q 'api S3v4' 62-backup.yaml || fail "62 backup mirror must use S3v4 for the OCI S3-compat endpoint"
grep -q 'kind: PersistentVolumeClaim' 62-backup.yaml && fail "62 must NOT declare a PVC — backup-store is retired (off-cluster OCI OS)"
# reintroduction guard: the backup-store WORKLOAD (Service endpoint / resource
# name), not the migration note that tells operators to delete it.
grep -qE 'backup-store:9000|name: backup-store' 62-backup.yaml && fail "62 still runs the backup-store workload — it is retired (issue #4)"
ok "backup target is off-cluster OCI Object Storage (backup-store retired)"

# 15b. contract: the backup SOURCE store is CONFIGURABLE (issue #120), NOT pinned to
#      minio:9000. GA #105 made the pageserver/safekeeper offload backend swappable
#      (S3/OCI/Ceph, MinIO optional); the backup Job + wal-janitor MUST follow the
#      SAME storage-objstore ConfigMap for their `src` alias. Before #120 both
#      hardcoded `mc alias set src http://minio:9000`, so a non-MinIO deployment had
#      NO backup (mirror can't reach a `minio` service) AND leaked safekeeper WAL
#      unbounded (janitor pruned a store that wasn't there) — the #105 portability
#      claim only half-delivered.
grep -qE 'mc alias set src[[:space:]]+http://minio:9000' 62-backup.yaml && fail "62 backup/wal-janitor still hardcode 'src http://minio:9000' — parameterize the LIVE store via storage-objstore (issue #120); a non-MinIO backend has no backup + leaks WAL"
# both the mirror AND the wal-janitor prune container must envFrom storage-objstore
# (2 references) and build the src alias from OBJSTORE_ENDPOINT.
[ "$(grep -c 'configMapRef: { name: storage-objstore }' 62-backup.yaml)" -ge 2 ] || fail "62 backup mirror AND wal-janitor must BOTH source the live object store from the storage-objstore ConfigMap (issue #120) — expected >=2 envFrom refs"
grep -q 'mc alias set src "$OBJSTORE_ENDPOINT"' 62-backup.yaml || fail "62 must build the backup/janitor 'src' alias from OBJSTORE_ENDPOINT (storage-objstore), not a hardcoded endpoint (issue #120)"
grep -q 'src/$OBJSTORE_BUCKET' 62-backup.yaml || fail "62 must resolve the live-store bucket path from OBJSTORE_BUCKET, not a hardcoded 'neon' bucket (issue #120)"
ok "backup + wal-janitor SOURCE the live object store from storage-objstore — portable to any S3 backend (issue #120)"

# 16. contract: a WAL janitor bounds safekeeper WAL accumulation (issue #19), and
#     the backup path self-heals a torn pageserver index (issue #21).
#     SAFETY: the janitor must prune only WAL strictly BELOW a horizon measured
#     from remote_consistent_lsn (provably ingested + uploaded), keep a
#     KEEP_SEGMENTS margin above what the writable restore re-seeds, and must
#     NEVER delete the live durability tail (.partial segments / segments at or
#     above the horizon). The backup must verify index_part.json is intact so a
#     torn index can no longer ship.
grep -q 'name: wal-janitor' 62-backup.yaml || fail "62 missing the wal-janitor CronJob (issue #19)"
# issues #90/#87: the apps-tenant orphaned-WAL fail-safe must be MONITORED, not just
# WARNed on. The apps-wal-monitor CronJob measures orphan WAL dirs (safekeeper-present,
# pageserver-404) + safekeeper /data utilization and fails its Job to surface the alert.
grep -q 'name: apps-wal-monitor' 62-backup.yaml || fail "62 missing the apps-wal-monitor CronJob (issues #90/#87) — orphan WAL residue + SK PV growth must be monitored"
grep -q 'df -P /data' 62-backup.yaml || fail "62 apps-wal-monitor must check safekeeper PV utilization (df /data) for ENOSPC early-warning (#90)"
grep -q 'KEEP_SEGMENTS' 62-backup.yaml || fail "62 wal-janitor must expose a KEEP_SEGMENTS safety horizon"
grep -q 'remote_consistent_lsn' 62-backup.yaml || fail "62 wal-janitor must derive its prune threshold from remote_consistent_lsn"
grep -q 'partial' 62-backup.yaml || fail "62 wal-janitor must exclude .partial WAL (the live durability tail)"
grep -q 'index_part.json' 62-backup.yaml || fail "62 backup must verify pageserver index integrity post-mirror (issue #21)"
# issue #42: the prune threshold's TLI must be DERIVED from the segment names, not
# hardcoded to 1 (a promotion bumps the TLI and a TLI=1 threshold silently stops
# pruning). Assert the hardcode is gone, the derivation is present, and the janitor
# fails LOUD (not exit-0-having-pruned-nothing) if the bucket listing errors.
grep -qE "printf '%08X%08X%08X' 1 " 62-backup.yaml && fail "62 wal-janitor still hardcodes TLI=1 in the prune threshold (issue #42) — derive it from the segment set"
grep -q 'threshold_suffix' 62-backup.yaml || fail "62 wal-janitor must emit a TLI-independent LOGID+SEG threshold_suffix (issue #42)"
grep -q 'cut -c1-8' 62-backup.yaml || fail "62 wal-janitor must derive the timeline id(s) from the 24-hex segment names (issue #42)"
grep -q 'mc ls failed' 62-backup.yaml || fail "62 wal-janitor must fail-LOUD (exit nonzero) when the bucket listing errors, not exit 0 pruning nothing (issue #42)"
# issue #59: PER-TIMELINE horizon — each timeline judged against ITS OWN
# remote_consistent_lsn; an unresolvable sibling is fail-safe-skipped (not pruned).
grep -q '/state/horizons' 62-backup.yaml || fail "62 wal-janitor must resolve a PER-TIMELINE horizon (each timeline vs its own rcl), not a shared suffix (#59)"
grep -q 'UNRESOLVED' 62-backup.yaml || fail "62 wal-janitor must fail-safe-SKIP (never over-prune) a timeline whose own rcl it cannot resolve (#59)"
ok "wal-janitor bounds safekeeper WAL (issue #19), derives TLI per-timeline + fails loud (issue #42), per-timeline horizon fail-safe (issue #59), backup self-heals torn index (issue #21)"

# 17. contract: kube-state-metrics (59) is the CronJob/Deployment/STS metric
#     PRODUCER the janitor/backup/failover alerts key off (issues #29/#41/#23).
#     Minimal: single-namespace scope + only the five collectors we alert on.
grep -q 'kube-state-metrics/kube-state-metrics' 59-kube-state-metrics.yaml || fail "59 lacks a pinned kube-state-metrics image"
grep -q 'namespaces=scale-zero-pg' 59-kube-state-metrics.yaml || fail "59 KSM must be namespace-scoped (--namespaces=scale-zero-pg)"
grep -q 'resources=cronjobs,jobs,deployments,statefulsets,pods' 59-kube-state-metrics.yaml || fail "59 KSM must limit collectors to the five we alert on"
grep -q 'kind: Role' 59-kube-state-metrics.yaml || fail "59 KSM must use a namespaced Role (least privilege, not ClusterRole)"
grep -q 'kind: ClusterRole' 59-kube-state-metrics.yaml && fail "59 KSM must NOT use a ClusterRole (namespace-scoped)"
ok "59 ships a minimal, namespace-scoped kube-state-metrics producer"

# 18. contract: Prometheus (60) scrapes BOTH new producers — KSM and pswatcher —
#     otherwise the platform alerts have no data (issues #23/#29).
grep -q 'job_name: kube-state-metrics' 60-prometheus.yaml || fail "60 must scrape kube-state-metrics"
grep -q 'job_name: pswatcher' 60-prometheus.yaml || fail "60 must scrape pswatcher (:9091 metrics)"

# 19. contract: the platform alert rules exist — a failing backup AND a failing
#     wal-janitor (matched by EXACT owner_name, not a loose backup.* regex),
#     backup staleness, pswatcher down / promotion, standby-not-ready, and a
#     stuck wake path. This is the "silent load-bearing machinery" close (#29/#41).
grep -q 'owner_name="backup"' 60-prometheus.yaml || fail "60 backup alert must match the CronJob by exact owner_name"
grep -q 'owner_name="wal-janitor"' 60-prometheus.yaml || fail "60 must alert on wal-janitor failure by exact owner_name (not backup.*)"
grep -q 'alert: WalJanitorJobFailed' 60-prometheus.yaml || fail "60 missing WalJanitorJobFailed alert (#41)"
grep -q 'alert: BackupJobFailed' 60-prometheus.yaml || fail "60 missing BackupJobFailed alert"
grep -q 'alert: BackupStale' 60-prometheus.yaml || fail "60 missing BackupStale (>26h) alert"
grep -q 'kube_cronjob_status_last_successful_time' 60-prometheus.yaml || fail "60 BackupStale must use the last-successful-time metric"
grep -q 'alert: PswatcherDown' 60-prometheus.yaml || fail "60 missing PswatcherDown alert (#23)"
grep -q 'alert: PswatcherPromotionFired' 60-prometheus.yaml || fail "60 missing promotion-fired alert (#23)"
grep -q 'alert: PageserverStandbyNotReady' 60-prometheus.yaml || fail "60 missing standby-not-ready alert"
grep -q 'alert: ComputeWakeStuck' 60-prometheus.yaml || fail "60 missing wake-path-stuck alert"
# issue #39: demo end-to-end canary alert — dormant Failed-Job rule joined on the
# demo-canary CronJob owner_name, same pattern as backup/wal-janitor.
grep -q 'alert: DemoCanaryFailed' 60-prometheus.yaml || fail "60 missing DemoCanaryFailed alert (#39)"
grep -q 'owner_name="demo-canary"' 60-prometheus.yaml || fail "60 DemoCanaryFailed must match the canary CronJob by exact owner_name (#39)"
# issues #90/#87: apps-tenant orphaned-WAL residue + safekeeper PV growth — the SIGNAL
# on the fail-safe the janitor only WARNs on. Distinct from WalJanitorJobFailed, joined
# on the apps-wal-monitor CronJob via the SAME owner_name pattern.
grep -q 'alert: SafekeeperWALGrowth' 60-prometheus.yaml || fail "60 missing SafekeeperWALGrowth alert (#90) — orphaned apps WAL + SK PV growth would be unmonitored"
grep -q 'owner_name="apps-wal-monitor"' 60-prometheus.yaml || fail "60 SafekeeperWALGrowth must match the apps-wal-monitor CronJob by exact owner_name (#90)"
# issue #49: wal-janitor STALENESS (silent-stop with zero Failed Jobs), symmetric to BackupStale.
grep -q 'alert: WalJanitorStale' 60-prometheus.yaml || fail "60 missing WalJanitorStale alert (#49) — a silently-stopped janitor produces no Failed Job"
# issue #51: absent()/suspend companions so a never-succeeded or suspended CronJob pages instead of passing silently.
grep -q 'alert: BackupStaleAbsent' 60-prometheus.yaml || fail "60 missing BackupStaleAbsent (absent/suspend guard, #51)"
grep -q 'alert: WalJanitorStaleAbsent' 60-prometheus.yaml || fail "60 missing WalJanitorStaleAbsent (absent/suspend guard, #49/#51)"
grep -q 'kube_cronjob_spec_suspend' 60-prometheus.yaml || fail "60 absent-guards must also page on a suspended CronJob (kube_cronjob_spec_suspend==1)"
# issue #62: the *StaleAbsent guards must be GATED by CronJob age so a fresh/DR-restored
# plane isn't paged before the first schedule has genuinely been missed (Day-0 noise).
grep -q 'kube_cronjob_created' 60-prometheus.yaml || fail "60 *StaleAbsent must gate on CronJob age (kube_cronjob_created > 26h) to suppress Day-0/post-DR over-fire (#62)"
# issue #60: DEAD-MAN'S-SWITCH — an always-firing Watchdog routed to an EXTERNAL receiver.
grep -q 'alert: Watchdog' 60-prometheus.yaml || fail "60 missing the Watchdog dead-man's-switch alert (#60)"
grep -q 'vector(1)' 60-prometheus.yaml || fail "60 Watchdog must be always-firing (expr: vector(1)) (#60)"
# issue #48: SELF-GUARD on kube-state-metrics — the sole producer of every rule above.
grep -q 'alert: KubeStateMetricsDown' 60-prometheus.yaml || fail "60 missing KubeStateMetricsDown (#48) — a dead KSM silently blinds all platform alerts"
grep -q 'absent(up{job="kube-state-metrics"})' 60-prometheus.yaml || fail "60 KubeStateMetricsDown must also page when KSM was never scraped (absent up series, #48)"
# the phantom-keepalive honesty rule must survive (state-based, not counter drift)
grep -q 'min_over_time(sum(pggw_active_connections)' 60-prometheus.yaml || fail "60 phantom-keepalive honesty rule was lost"
ok "60 ships the platform alert rules (backup+janitor+staleness+pswatcher+standby+wake) and keeps the phantom honesty rule"

# 20. contract: Alertmanager (61) keeps the testable in-cluster sink as default
#     BUT cleanly supports a real Slack-compatible receiver via a Secret FILE
#     (api_url_file — no webhook URL ever inlined into the ConfigMap or git).
grep -q 'receiver: webhook-sink' 61-alertmanager.yaml || fail "61 default route must stay the testable in-cluster sink"
grep -q 'slack_configs' 61-alertmanager.yaml || fail "61 must define a real Slack-compatible receiver"
grep -q 'api_url_file' 61-alertmanager.yaml || fail "61 real receiver must read the webhook URL from a Secret file (not inline)"
grep -q 'alertmanager-receiver' 61-alertmanager.yaml || fail "61 must mount the alertmanager-receiver Secret (optional)"
grep -q 'alertmanager-receiver' gen-secrets.sh || fail "gen-secrets.sh must scaffold the alertmanager-receiver Secret"
# issue #60: DEAD-MAN'S-SWITCH — a dedicated external `watchdog` receiver reading the
# heartbeat URL from the optional Secret (like slack), routed the Watchdog alert only.
grep -q 'name: watchdog' 61-alertmanager.yaml || fail "61 missing the external watchdog receiver (dead-man's-switch, #60)"
grep -q 'watchdog-webhook' 61-alertmanager.yaml || fail "61 watchdog receiver must read the heartbeat URL from the Secret file watchdog-webhook (#60)"
grep -q 'alertname="Watchdog"' 61-alertmanager.yaml || fail "61 must route the Watchdog alert to the watchdog receiver (#60)"
grep -q 'watchdog-webhook' gen-secrets.sh || fail "gen-secrets.sh must scaffold the watchdog-webhook heartbeat URL (#60)"
ok "61 keeps the testable sink default + real Slack receiver + external Watchdog dead-man's-switch (#60), all via Secret files"

# 21. contract: skctl.py's safekeeper.control serializer is COUPLED to the neon
#     on-disk format (magic cafeceef, format v9) reverse-engineered from a
#     specific neon image (issue #22). The version-pair check above guards the
#     compute<->storage tag; this guards the SECOND version-coupled artifact the
#     pair check cannot see. A neon tag bump that does not re-validate
#     safekeeper.control and update skctl's recorded compat tag MUST fail CI —
#     otherwise writable restore silently crafts a structurally-wrong control
#     file, surfacing only in an actual disaster.
SKTAG=$(grep -oE 'SK_COMPAT_NEON_TAG[[:space:]]*=[[:space:]]*"[a-z0-9.]+"' skctl.py | head -1 | sed -E 's/.*"([a-z0-9.]+)".*/\1/')
[ -n "$SKTAG" ] || fail "skctl.py missing SK_COMPAT_NEON_TAG (issue #22 format-coupling gate)"
grep -qE 'SK_CONTROL_VERSION[[:space:]]*=[[:space:]]*9\b' skctl.py || fail "skctl.py SK_CONTROL_VERSION drifted from the reverse-engineered v9"
[ "$SKTAG" = "$CT" ] || fail "skctl format coupling: skctl.py targets neon:$SKTAG but the plane pins neon:$CT — re-validate safekeeper.control (dump one from neon:$CT, run deploy/test_skctl.py against it) and bump SK_COMPAT_NEON_TAG (docs/operations.md 'skctl format coupling')"
ok "skctl.py safekeeper.control (v9) coupled to pinned neon:$CT (issue #22)"

# 22. contract (issue #56): every one of OUR OWN OCIR images (me-abudhabi-1.ocir.io
#     /.../ks-pg/*) must be pinned by DIGEST — `tag@sha256:<64hex>`, not a mutable
#     tag alone. A bare tag lets a rebuilt-but-not-rolled, or rolled-but-stale-tag,
#     binary pass the presence/readiness drift check while running old code — the
#     last place the merged≠deployed class can hide (the manifests even noted
#     "same image, distinct binary"). We keep the human :tag for provenance AND
#     require the @sha256 Kubernetes actually pulls; _verify-drift.sh then asserts
#     the LIVE running imageID digest equals the manifest digest. Release procedure:
#     docs/operations.md "Releasing an OCIR image (digest pinning)".
for ref in $(grep -rhoE 'me-abudhabi-1\.ocir\.io/[^[:space:]"#]+' [0-9][0-9]-*.yaml | sort -u); do
  case "$ref" in
    *:*@sha256:*) : ;; # has BOTH a human :tag and an @sha256 digest — good
    *@sha256:*) fail "OCIR image $ref pins a digest but dropped its human :tag — use tag@sha256:... (issue #56)" ;;
    *) fail "OCIR image not digest-pinned: $ref — pin as tag@sha256:<64hex> (issue #56)" ;;
  esac
done
ok "our OCIR images are digest-pinned with a human tag (tag@sha256:...) (issue #56)"

# 23. contract (issue #105): the object-storage backend is CONFIGURABLE — the
#     pageserver page-offload + safekeeper WAL-offload S3 target
#     (endpoint/bucket/region) is sourced from the `storage-objstore` ConfigMap
#     (env), NOT hardcoded to in-cluster MinIO. Credentials stay in the
#     storage-s3-creds Secret. An external endpoint disables MinIO (its bucket
#     Job moved to endpoint-agnostic storage-init), and MinIO — whose upstream is
#     archived — is pinned by DIGEST as an OPTIONAL local default.
for f in 52-safekeeper.yaml 53-pageserver.yaml 57-pageserver-standby.yaml; do
  grep -q 'configMapRef: { name: storage-objstore }' "$f" \
    || fail "$f must source the object-store endpoint from the storage-objstore ConfigMap (#105)"
  grep -q "endpoint='http://minio:9000'" "$f" \
    && fail "$f still hardcodes the minio S3 endpoint — parameterize via storage-objstore (#105)"
done
grep -q 'storage-objstore' gen-secrets.sh \
  || fail "gen-secrets.sh must manage the storage-objstore ConfigMap (endpoint/bucket/region) (#105)"
# storage-init must ensure the bucket on the CONFIGURED endpoint (not minio-only).
grep -q 'OBJSTORE_ENDPOINT' 55-storage-init.yaml \
  || fail "55-storage-init must ensure the bucket on the CONFIGURED object-store endpoint (#105)"
# MinIO is now OPTIONAL + digest-pinned; its minio-only bucket Job must be gone
# (bucket creation is endpoint-agnostic in storage-init).
grep -qE 'quay.io/minio/minio:[^ ]*@sha256:[0-9a-f]{64}' 50-minio.yaml \
  || fail "50-minio.yaml must digest-pin MinIO (archived upstream, #105)"
grep -q 'name: minio-create-buckets' 50-minio.yaml \
  && fail "50-minio.yaml still carries the minio-only bucket Job — bucket creation moved to storage-init (#105)"
ok "object-storage backend is configurable via storage-objstore; MinIO optional + digest-pinned (#105)"

# 24. contract (issue #96, ADR-0004): the AppDatabase CRD + operator ship together.
#     The CRD defines the v1.0 declarative provisioning interface; the operator (a
#     distinct binary in the SAME multi-binary gateway image, /appdb-operator
#     entrypoint) reconciles it. The operator must NOT claim the deployments/scale
#     subresource — the apps-gateway owns spec.replicas (0<->1 wake); the operator
#     only get/update/patch deployments and preserves the live replica count.
grep -q 'kind: CustomResourceDefinition' 82-appdb-crd.yaml || fail "82-appdb-crd.yaml missing the CustomResourceDefinition"
grep -q 'appdatabases.apps.scale-zero-pg.dev' 82-appdb-crd.yaml || fail "82-appdb-crd.yaml wrong CRD name"
grep -q 'appdatabases/finalizers' 83-appdb-operator.yaml || fail "83-appdb-operator.yaml RBAC lacks appdatabases/finalizers (safe deprovision)"
grep -q '/appdb-operator' 83-appdb-operator.yaml || fail "83-appdb-operator.yaml must override the entrypoint to /appdb-operator"
grep -q 'deployments/scale' 83-appdb-operator.yaml && fail "appdb-operator must NOT hold deployments/scale — the apps-gateway owns spec.replicas"
grep -q 'appdb-operator' ../gateway/Dockerfile || fail "Dockerfile does not build the appdb-operator binary into the image"
ok "AppDatabase CRD + operator wired (82/83), operator built into the image, does not claim deployments/scale (issue #96)"
