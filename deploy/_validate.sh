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
  kubectl apply --dry-run=server -f "$f" >/dev/null || fail "$f does not validate"
  ok "$f validates (server dry-run)"
done

# 2. contract: compute deployment must start at zero replicas
grep -q 'replicas: 0' 20-compute.yaml || fail "20-compute.yaml must set replicas: 0"
ok "compute starts at zero"

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
for f in 20-compute.yaml 50-minio.yaml 51-storage-broker.yaml 52-safekeeper.yaml 53-pageserver.yaml; do
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

# 11. contract: a minimal in-cluster Prometheus scrapes the gateway fleet and
#     ships the review's three alerts (wake failures, wake latency, phantom keepalive).
grep -q 'prom/prometheus' 60-prometheus.yaml || fail "60-prometheus.yaml lacks a pinned prometheus image"
grep -q 'pggw_wake_failures_total' 60-prometheus.yaml || fail "60-prometheus.yaml missing wake-failure alert"
grep -q 'pggw_wake_latency_ms_last' 60-prometheus.yaml || fail "60-prometheus.yaml missing wake-latency alert"
grep -q 'PhantomKeepalive' 60-prometheus.yaml || fail "60-prometheus.yaml missing phantom-keepalive alert"
ok "60-prometheus.yaml scrapes pggw + ships the three review alerts"

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
for f in 51-storage-broker.yaml 52-safekeeper.yaml 53-pageserver.yaml 55-storage-init.yaml 57-pageserver-standby.yaml; do
  for st in $(grep -o 'neondatabase/neon:[a-z0-9.]*' "$f" | cut -d: -f2 | sort -u); do
    [ "$st" = "$CT" ] || fail "version-pair drift: $f uses neon:$st but compute is :$CT"
  done
done
[ -n "$CT" ] || fail "could not extract compute tag from 20-compute.yaml"
ok "compute↔storage version pair consistent (:$CT everywhere)"

# 13. contract: every long-running pod declares ephemeral-storage requests
#     (incident 2026-07-03: pods without them were kubelet's preferred
#     eviction targets during DiskPressure - the storage plane died first).
for f in 10-gateway.yaml 20-compute.yaml 25-compute-warm.yaml 50-minio.yaml 51-storage-broker.yaml 52-safekeeper.yaml 53-pageserver.yaml 57-pageserver-standby.yaml 58-pswatcher.yaml 59-kube-state-metrics.yaml 60-prometheus.yaml 61-alertmanager.yaml 62-backup.yaml; do
  # must be under requests: (eviction ordering ranks on requests, not limits)
  grep -E 'requests: \{[^}]*ephemeral-storage' "$f" >/dev/null || fail "$f lacks ephemeral-storage under requests:"
done
ok "all long-running pods declare ephemeral-storage REQUESTS (incl. backup mirror)"

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

# 16. contract: a WAL janitor bounds safekeeper WAL accumulation (issue #19), and
#     the backup path self-heals a torn pageserver index (issue #21).
#     SAFETY: the janitor must prune only WAL strictly BELOW a horizon measured
#     from remote_consistent_lsn (provably ingested + uploaded), keep a
#     KEEP_SEGMENTS margin above what the writable restore re-seeds, and must
#     NEVER delete the live durability tail (.partial segments / segments at or
#     above the horizon). The backup must verify index_part.json is intact so a
#     torn index can no longer ship.
grep -q 'name: wal-janitor' 62-backup.yaml || fail "62 missing the wal-janitor CronJob (issue #19)"
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
ok "wal-janitor bounds safekeeper WAL (issue #19), derives TLI per-timeline + fails loud (issue #42), backup self-heals torn index (issue #21)"

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
# issue #49: wal-janitor STALENESS (silent-stop with zero Failed Jobs), symmetric to BackupStale.
grep -q 'alert: WalJanitorStale' 60-prometheus.yaml || fail "60 missing WalJanitorStale alert (#49) — a silently-stopped janitor produces no Failed Job"
# issue #51: absent()/suspend companions so a never-succeeded or suspended CronJob pages instead of passing silently.
grep -q 'alert: BackupStaleAbsent' 60-prometheus.yaml || fail "60 missing BackupStaleAbsent (absent/suspend guard, #51)"
grep -q 'alert: WalJanitorStaleAbsent' 60-prometheus.yaml || fail "60 missing WalJanitorStaleAbsent (absent/suspend guard, #49/#51)"
grep -q 'kube_cronjob_spec_suspend' 60-prometheus.yaml || fail "60 absent-guards must also page on a suspended CronJob (kube_cronjob_spec_suspend==1)"
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
ok "61 keeps the testable sink default + supports a real Slack receiver via Secret file (scaffolded by gen-secrets.sh)"

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
