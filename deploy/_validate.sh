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
for f in 51-storage-broker.yaml 52-safekeeper.yaml 53-pageserver.yaml 55-storage-init.yaml; do
  for st in $(grep -o 'neondatabase/neon:[a-z0-9.]*' "$f" | cut -d: -f2 | sort -u); do
    [ "$st" = "$CT" ] || fail "version-pair drift: $f uses neon:$st but compute is :$CT"
  done
done
[ -n "$CT" ] || fail "could not extract compute tag from 20-compute.yaml"
ok "compute↔storage version pair consistent (:$CT everywhere)"

# 13. contract: every long-running pod declares ephemeral-storage requests
#     (incident 2026-07-03: pods without them were kubelet's preferred
#     eviction targets during DiskPressure - the storage plane died first).
for f in 10-gateway.yaml 20-compute.yaml 25-compute-warm.yaml 50-minio.yaml 51-storage-broker.yaml 52-safekeeper.yaml 53-pageserver.yaml 60-prometheus.yaml 61-alertmanager.yaml 62-backup.yaml; do
  # must be under requests: (eviction ordering ranks on requests, not limits)
  grep -E 'requests: \{[^}]*ephemeral-storage' "$f" >/dev/null || fail "$f lacks ephemeral-storage under requests:"
done
ok "all long-running pods declare ephemeral-storage REQUESTS (incl. backup-store)"
