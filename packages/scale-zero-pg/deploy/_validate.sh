#!/bin/sh
# Validation for deploy/ manifests: server-side dry-run against the current
# kube context, plus contract checks the YAML must satisfy. Run from repo root
# or deploy/. Exits non-zero on any failure.
#
# NO `set -e` here, deliberately (knext #797): under set -e any failing command
# aborted the run mid-list, and every contract after the crash point passed BY
# ABSENCE — the checker-that-cannot-see-red class this script has hit twice
# (#126 immutable-reject, #797 88-loadsoak parse). Instead fail() RECORDS the
# failure and returns, the script always reaches the summary at the bottom,
# reports every failed contract in one run, and exits 1 if any failed. The EXIT
# trap below is the tripwire: if a future edit reintroduces a mid-run abort
# (set -e, a stray `exit`, a re-exiting fail()), the trap turns that silent
# early death into a loud non-zero failure instead of a vacuous pass.
set -u
cd "$(dirname "$0")" || { echo "FAIL: cannot cd into deploy/" >&2; exit 1; }

FAILURES=0
FAIL_LIST=""
OK_MARK=0
fail() {
  FAILURES=$((FAILURES + 1))
  FAIL_LIST="${FAIL_LIST}
  FAIL: $*"
  echo "FAIL: $*" >&2
}
# ok() closes a contract block: it prints `ok` ONLY if no failure was recorded
# since the previous block boundary — otherwise a failed contract would still
# print its trailing ok-line and read as passing.
ok() {
  if [ "$FAILURES" -gt "$OK_MARK" ]; then
    echo "not ok - $* (FAILED — see the FAIL lines above)"
  else
    echo "ok - $*"
  fi
  OK_MARK=$FAILURES
}
# blockdone closes a block that ends on a failure WITHOUT an ok-line (the
# section-1 per-file continue paths), so the next block's ok() is not blamed
# for this block's failures.
blockdone() { OK_MARK=$FAILURES; }

COMPLETED=0
trap 'if [ "$COMPLETED" -ne 1 ]; then
  echo "FAIL: _validate.sh exited BEFORE evaluating all contracts (early death — the #797 class); $FAILURES failure(s) had been recorded up to this point" >&2
  exit 70
fi' EXIT

# Canonical sha256 of the prometheus-config ConfigMap DATA (prometheus.yml + rules.yml)
# in 60-prometheus.yaml — the SINGLE SOURCE OF TRUTH for the auto-reload config-hash
# annotation (issue #155). The pod-template annotation ks-pg.dev/prometheus-config-sha256
# must equal this value; contract 27 enforces it, and `./_validate.sh prom-config-hash`
# prints it so a human can regenerate the annotation after editing the rules. Offline
# (no cluster / no pyyaml): extracts the two block-scalar keys with an indent-aware parser
# and hashes their dedented content in sorted-key order.
prom_config_hash() {
  python3 - "$1" <<'PY'
import hashlib, re, sys
text = open(sys.argv[1]).read()
cm = None
for d in re.split(r'(?m)^---\s*$', text):
    if re.search(r'(?m)^kind:\s*ConfigMap\s*$', d) and 'name: prometheus-config' in d:
        cm = d; break
if cm is None:
    sys.stderr.write("prom-config-hash: no prometheus-config ConfigMap in 60-prometheus.yaml\n"); sys.exit(3)
lines = cm.splitlines(); data = {}; i = 0
while i < len(lines):
    m = re.match(r'^  ([^\s:]+):\s*\|\s*$', lines[i])  # 2-space key whose value is a literal block
    if m:
        key = m.group(1); i += 1; block = []
        while i < len(lines) and (lines[i].strip() == '' or lines[i].startswith('    ')):
            block.append(lines[i][4:] if lines[i].startswith('    ') else '')
            i += 1
        data[key] = "\n".join(block); continue
    i += 1
if not data:
    sys.stderr.write("prom-config-hash: no data block-scalars found\n"); sys.exit(3)
canon = "".join("%s\n%s\n" % (k, data[k]) for k in sorted(data))
sys.stdout.write(hashlib.sha256(canon.encode()).hexdigest())
PY
}

# Subcommand: print the prometheus config-hash and exit (offline; regenerates the
# annotation after a rules edit — `./_validate.sh prom-config-hash`).
if [ "${1:-}" = "prom-config-hash" ]; then
  prom_config_hash 60-prometheus.yaml; rc=$?; echo
  COMPLETED=1
  exit "$rc"
fi

HAVE_KUBECTL=1
command -v kubectl >/dev/null \
  || { HAVE_KUBECTL=0; fail "kubectl not found — section 1 (server dry-run of every manifest) and the 2c HPA dry-run NOT evaluated"; blockdone; }

# 1. every manifest must dry-run apply cleanly (server-side validation).
# The namespace is applied for real first: namespaced dry-runs need it to
# exist, and this cluster is the demo target anyway.
if [ "$HAVE_KUBECTL" = 1 ]; then
kubectl apply -f 00-namespace.yaml >/dev/null || fail "namespace apply failed"
ok "00-namespace.yaml applied"
for f in [0-9][0-9]-*.yaml; do
  [ -e "$f" ] || { fail "no numbered manifests found in deploy/"; blockdone; continue; }
  [ "$f" = 00-namespace.yaml ] && continue
  # Doc-only manifests carry ONLY comments (no k8s objects) — e.g. 30-knext-secret.yaml,
  # whose base DATABASE_URL Secret is now owned by gen-secrets.sh (issue #168). A
  # server dry-run of a comment-only file errors "no objects passed to apply"; that is
  # not a defect, so skip cleanly when the file declares no apiVersion.
  grep -q '^apiVersion:' "$f" || { ok "$f is doc-only (no k8s objects; owned by gen-secrets.sh)"; continue; }
  # cert-manager manifests (11-mtls-certs.yaml, F5 phase 1): the cert-manager.io/v1
  # CRDs (Issuer/Certificate) may not be installed on every cluster the validator
  # runs against — a knext+scale-zero-pg cluster has them (the operator webhook
  # depends on cert-manager), but a bare cluster does not, and a server dry-run
  # then errors "no matches for kind ... in version cert-manager.io/v1". That is
  # NOT a manifest defect, so when the CRD is absent, fall back to an OFFLINE YAML
  # parse (structure is still validated) instead of failing. When the CRD IS
  # present, the normal server dry-run below runs and schema-validates for real.
  if grep -q 'cert-manager\.io/' "$f" \
     && { [ "$HAVE_KUBECTL" != 1 ] || ! kubectl get crd certificates.cert-manager.io >/dev/null 2>&1; }; then
    # Offline YAML sanity, degrading with the tooling present (the repo avoids a
    # pyyaml hard-dep — see prom_config_hash's stdlib parser). Structural
    # correctness of the objects themselves is asserted by contract 33 below.
    if python3 -c 'import yaml' 2>/dev/null; then
      if python3 -c 'import sys,yaml; list(yaml.safe_load_all(open(sys.argv[1])))' "$f" >/dev/null 2>&1; then
        ok "$f is valid YAML (pyyaml parse; cert-manager CRDs unavailable — server dry-run skipped; F5 phase 1)"
      else
        fail "$f is not valid YAML (pyyaml parse; cert-manager CRDs unavailable so no server dry-run)"; blockdone
      fi
    elif command -v yamllint >/dev/null 2>&1; then
      if yamllint -d relaxed "$f" >/dev/null 2>&1; then
        ok "$f is valid YAML (yamllint; cert-manager CRDs unavailable — server dry-run skipped; F5 phase 1)"
      else
        fail "$f fails yamllint (cert-manager CRDs unavailable so no server dry-run)"; blockdone
      fi
    else
      ok "$f: cert-manager CRDs unavailable + no YAML parser present — server dry-run skipped; structural checks in contract 33 cover it (F5 phase 1)"
    fi
    continue
  fi
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
      || { fail "$f does not validate (client dry-run after immutable server-side reject): $err"; blockdone; continue; }
    ok "$f validates (client dry-run; server rejects an immutable field on the live object — #126)"
    continue
  fi
  # DRILL TEMPLATES (e.g. 88-loadsoak-k6.yaml): the file ships with ${VAR} placeholders
  # that the drill substitutes (envsubst) before applying, so the RAW file can never
  # satisfy the apiserver — "${K6_MEM_REQUEST}" is not a valid quantity. Before this
  # branch existed the loop simply ABORTED here, which is why every contract below
  # (including the rooted-host one) had never executed in a real run. Render the
  # placeholders to a syntactically-valid stand-in and validate THAT, so the template's
  # structure and schema are genuinely checked rather than skipped.
  #
  # Known limit, stated rather than implied: a defect that exists only in the RAW form
  # and disappears once substituted — an unquoted ${...} opening a brace inside a {flow
  # map}, which is exactly what made this file unparseable — is NOT caught by a rendered
  # check. That is why those placeholders are now quoted at the source.
  if grep -q '\${[A-Z0-9_]*}' "$f"; then
    rendered="$(mktemp)"
    # Stand-in "1Mi" is deliberate: it satisfies the apiserver's quantity regex
    # (cpu/memory) AND, unquoted, still parses as a STRING rather than a number, so
    # fields like container.image do not fail to unmarshal.
    sed 's/\${[A-Z0-9_]*}/1Mi/g' "$f" > "$rendered"
    if rerr="$(kubectl apply --dry-run=server -f "$rendered" 2>&1 >/dev/null)"; then
      rm -f "$rendered"
      ok "$f validates (server dry-run of the placeholder-rendered template; the drill envsubsts before applying)"
      continue
    fi
    rm -f "$rendered"
    fail "$f does not validate even with its \${VAR} placeholders rendered: $rerr"
    blockdone
    continue
  fi
  fail "$f does not validate: $err"
  blockdone
done
fi # HAVE_KUBECTL

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
if [ "$HAVE_KUBECTL" = 1 ]; then
  kubectl apply --dry-run=server -f "$HPA" >/dev/null || fail "$HPA does not validate"
fi
grep -q 'name: compute-ro' "$HPA" || fail "$HPA must target the compute-ro deployment"
grep -q 'minReplicas: 1' "$HPA" || fail "$HPA posture B must set minReplicas: 1"
ok "read-scaling HPA ships under optional/ (opt-in, valid, targets compute-ro)"

# 3. contract: gateway RBAC may scale deployments (scale subresource)
grep -q 'deployments/scale' 10-gateway.yaml || fail "gateway RBAC lacks deployments/scale"
ok "gateway RBAC includes deployments/scale"

# 4. contract: gateway runs in kubectl mode against the compute deployment
grep -q 'GW_COMPUTE_MODE' 10-gateway.yaml || fail "gateway env GW_COMPUTE_MODE missing"
ok "gateway wake mode configured"

# 4b. contract (F6): both gateway fronts authenticate the peer idle-scrape with
#     the shared fleet bearer token, sourced from the pggw-peer-token Secret via
#     secretKeyRef (never a literal). Fail-closed: absent the Secret the gateway
#     refuses to boot, so shipping this env is what makes the default config safe.
for f in 10-gateway.yaml 81-apps-gateway.yaml; do
  grep -q 'GW_PEER_TOKEN' "$f" || fail "$f: gateway must source GW_PEER_TOKEN (F6 peer-scrape auth)"
  grep -q 'name: pggw-peer-token' "$f" || fail "$f: GW_PEER_TOKEN must come from the pggw-peer-token Secret via secretKeyRef, not a literal"
done
ok "both gateways source GW_PEER_TOKEN from the pggw-peer-token Secret (F6, fail-closed)"

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
# #116/ADR-0008: the per-app WAKE budget must be configured on the apps-gateway AND
# alerted on. The budget caps the unauthenticated wake side-channel; a missing env or
# alert re-opens the cost/DoS vector silently.
grep -q 'GW_WAKE_BUDGET' 81-apps-gateway.yaml || fail "81-apps-gateway.yaml must set GW_WAKE_BUDGET — the #116 per-app wake budget (ADR-0008)"
grep -q 'alert: WakeBudgetExceeded' 60-prometheus.yaml || fail "60-prometheus.yaml missing WakeBudgetExceeded alert (#116) — the wake side-channel would be unmonitored"
grep -q 'pggw_wake_budget_exceeded_total{gateway="pggw-apps"}' 60-prometheus.yaml || fail "60 WakeBudgetExceeded must scope to gateway=\"pggw-apps\" (the single-DB gateway runs no budget)"
ok "60-prometheus.yaml scrapes the gateway family (pggw + pggw-apps) + ships the review alerts + multi-tenant/read-pool wake alerts (#80) + the #116 wake-budget alert"

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

# (#797: the premature "all checks passed" that sat HERE — before 20 more contracts —
# is gone; the single honest summary lives at the very bottom of the script.)

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

# 14b. contract (#1098 review, FIX 3): the APPS-TENANT ID LOCK-STEP is ASSERTED, not
#      commented. The same fixed id appears in 58 (PSW_APPS_TENANT_ID — the watcher's
#      promotion scope), 83 (APPDB_TENANT_ID — where every per-app AppDatabase is
#      created as a timeline), 57 (APPS_TENANT_ID — the standby's warm-Secondary
#      registration) and provision-app.sh (APPS_TENANT — the break-glass path). Four
#      files, one id, previously joined only by "kept in lock-step" COMMENTS: deleting
#      PSW_APPS_TENANT_ID from 58 silently reverts promotion scope to base-only and
#      every test stayed green. Repo convention is to SCAN, not to ask nicely.
_psw_apps="$(sed -n 's/.*PSW_APPS_TENANT_ID, value: "\([^"]*\)".*/\1/p' 58-pswatcher.yaml | head -1)"
_appdb_tenant="$(sed -n 's/.*APPDB_TENANT_ID, value: "\([^"]*\)".*/\1/p' 83-appdb-operator.yaml | head -1)"
_sb_apps="$(sed -n 's/.*APPS_TENANT_ID, value: "\([^"]*\)".*/\1/p' 57-pageserver-standby.yaml | head -1)"
_prov_apps="$(sed -n 's/^APPS_TENANT="\${APPS_TENANT:-\([^}]*\)}"/\1/p' provision-app.sh | head -1)"
# The operator (83) is the source of truth: it decides where per-app timelines LIVE.
if [ -z "$_appdb_tenant" ]; then
  fail "83-appdb-operator.yaml has no APPDB_TENANT_ID — the apps-tenant lock-step check cannot anchor (#1098)"
else
  # 58 MUST carry the key whenever 83 does: without it the watcher's promotion scope
  # silently shrinks to the base tenant and a failover strands every per-app timeline.
  [ -n "$_psw_apps" ] \
    || fail "58-pswatcher.yaml is MISSING PSW_APPS_TENANT_ID while 83 sets APPDB_TENANT_ID=$_appdb_tenant — failover would promote ONLY the base tenant and strand every per-app database on the demoted pageserver (#1098)"
  for _pair in "58:PSW_APPS_TENANT_ID:$_psw_apps" "57:APPS_TENANT_ID:$_sb_apps" "provision-app.sh:APPS_TENANT:$_prov_apps"; do
    _f="${_pair%%:*}"; _rest="${_pair#*:}"; _k="${_rest%%:*}"; _v="${_rest#*:}"
    [ -n "$_v" ] || continue # absence of 58's key is reported above; 57/provision are optional surfaces
    [ "$_v" = "$_appdb_tenant" ] \
      || fail "apps-tenant LOCK-STEP BROKEN: $_f $_k=$_v but 83 APPDB_TENANT_ID=$_appdb_tenant — the watcher/standby/provisioner would act on a tenant the operator never writes to (#1098)"
  done
  [ -n "$_sb_apps" ] \
    || fail "57-pageserver-standby.yaml is MISSING APPS_TENANT_ID — the standby is never warmed for the apps tenant, so failover aborts on its 404 (#1098)"
  ok "apps-tenant lock-step asserted: 58 PSW_APPS_TENANT_ID == 83 APPDB_TENANT_ID == 57 APPS_TENANT_ID == provision-app.sh APPS_TENANT ($_appdb_tenant)"
fi

# 14c. contract (#1098 review, FIX 1b): the watcher's generation view must resolve
#      against the CURRENTLY-ROUTED pageserver (the client Service whose selector the
#      failover flips), never a fixed primary URL. The primary is the node that is
#      DOWN in the failover this watcher exists for, and post-failover it is the
#      DEMOTED node holding the OLD (lower) generation — seeding from it under-writes
#      the ledger, which is the silent floor class #1095 closed.
grep -q 'PSW_ROUTED_BASE_URL' 58-pswatcher.yaml \
  || fail "58-pswatcher.yaml must set PSW_ROUTED_BASE_URL (the routed-pageserver generation view: ledger seed/heal + the failover second vantage) (#1098)"
if grep -q 'PSW_PRIMARY_BASE_URL' 58-pswatcher.yaml; then
  fail "58-pswatcher.yaml resolves the generation view against the PRIMARY (PSW_PRIMARY_BASE_URL) — that node is down during a failover and demoted after one, so the view under-writes the ledger. Use PSW_ROUTED_BASE_URL (#1098)."
fi
_routed_base="$(sed -n 's/.*PSW_ROUTED_BASE_URL, value: "\([^"]*\)".*/\1/p' 58-pswatcher.yaml | head -1)"
_client_svc="$(sed -n 's/.*PSW_CLIENT_SERVICE, value: "\([^"]*\)".*/\1/p' 58-pswatcher.yaml | head -1)"
case "$_routed_base" in
  *"//$_client_svc:"*) : ;;
  *) fail "58 PSW_ROUTED_BASE_URL=$_routed_base does not point at the flipped client Service ($_client_svc) — the second vantage must follow routing, not a fixed node (#1098)" ;;
esac

# 14d. contract (#1098 review, FIX 5): the standby warm-Secondary helper must return
#      the REGISTRATION status. It used to end in `curl … || true`, so it always
#      returned 0 and the `|| echo` diagnostic was UNREACHABLE — a failed apps-tenant
#      registration was silent at deploy time, and the failover then aborts on its 404.
if grep -A6 'warm_secondary() {' 57-pageserver-standby.yaml | grep -qE 'secondary/download.*\|\| true$' \
   && ! grep -A12 'warm_secondary() {' 57-pageserver-standby.yaml | grep -q 'return 1'; then
  fail "57 warm_secondary() ends in an always-true download kick, so its failure branch is UNREACHABLE — a failed warm-Secondary registration is silent at deploy time (#1098). Return the registration's status."
fi

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

# 16b. contract: SLOT-AWARE janitor + bounded WAL retention (issue #139, ADR-0007 §4a).
#      The zone axis introduces logical-replication slots that pin publisher WAL; the
#      janitor must NEVER prune an ACTIVE slot's WAL (break live replication), and an
#      inactive/leaked slot must be bounded by max_slot_wal_keep_size (degrade-to-re-sync,
#      never plane-fill) and surfaced by a slot-aware monitor.
grep -q '"max_slot_wal_keep_size"' compute-files/config.json || fail "config.json must set a BOUNDED max_slot_wal_keep_size (issue #139) — default -1 pins WAL unbounded for an inactive slot"
# the DEPLOYED ConfigMap (54, inlined) must carry the same knob — that is what boots
grep -q '"max_slot_wal_keep_size"' 54-compute-files.yaml || fail "54-compute-files.yaml (the applied ConfigMap) must also carry max_slot_wal_keep_size — config.json is inlined here (issue #139)"
grep -A2 '"max_slot_wal_keep_size"' compute-files/config.json | grep -q '"value": "-1"' && fail "config.json max_slot_wal_keep_size must not be -1 (unbounded) (issue #139)"
grep -q 'name: resolve-slot-floors' 62-backup.yaml || fail "62 wal-janitor must have a resolve-slot-floors initContainer (slot-aware prune floor, issue #139)"
grep -q '/state/slotfloors' 62-backup.yaml || fail "62 wal-janitor must floor pruning at ACTIVE slots' restart_lsn via /state/slotfloors (issue #139)"
grep -q '/state/protect' 62-backup.yaml || fail "62 wal-janitor must fail-safe-SKIP (PROTECT) a timeline whose awake compute's Postgres it cannot read (issue #139)"
grep -q 'pg_replication_slots' 62-backup.yaml || fail "62 wal-janitor slot-floor pass must read pg_replication_slots (issue #139)"
grep -q 'SLOT-FLOOR' 62-backup.yaml || fail "62 prune step must apply the active-slot floor (SLOT-FLOOR, issue #139)"
grep -q 'serviceAccountName: wal-janitor' 62-backup.yaml || fail "62 wal-janitor must run under a scoped ServiceAccount to exec computes (issue #139)"
ok "wal-janitor is SLOT-AWARE — bounded retention + active-slot floor, never breaks live replication (issue #139)"

# 16c. contract: the slot-aware MONITOR (deploy/63) — two CronJobs that read
#      pg_replication_slots on awake writers and fail their Job on a growing / leaked
#      slot, sourcing the ReplicationSlotWALGrowth / ReplicationSlotInactive alerts.
[ -f 63-repl-slot-monitor.yaml ] || fail "deploy/63-repl-slot-monitor.yaml missing (slot-aware early-warning monitor, issue #139)"
grep -q 'name: repl-slot-wal-monitor' 63-repl-slot-monitor.yaml || fail "63 missing repl-slot-wal-monitor CronJob (ReplicationSlotWALGrowth source, #139)"
grep -q 'name: repl-slot-inactive-monitor' 63-repl-slot-monitor.yaml || fail "63 missing repl-slot-inactive-monitor CronJob (ReplicationSlotInactive source, #139)"
grep -q 'pg_replication_slots' 63-repl-slot-monitor.yaml || fail "63 slot monitor must read pg_replication_slots (#139)"
grep -q 'MAX_SLOT_WAL_KEEP_MB' 63-repl-slot-monitor.yaml || fail "63 growth monitor must compare retained WAL to the max_slot_wal_keep_size bound (#139)"
ok "63 ships the slot-aware early-warning monitor (growth + inactive/leaked), owner_name-joined like apps-wal-monitor (#139)"

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
# #1098 review (FIX 4): every pswatcher counter must have an alert, else a promotion
# that silently covered LESS than the routed scope, or a permanently blind ledger-heal
# vantage, is invisible. Pin the metric name too — a rename would make the rule dead.
grep -q 'alert: PswatcherTenantSkipped' 60-prometheus.yaml || fail "60 missing PswatcherTenantSkipped alert (#1098) — a routed tenant skipped on failover would be unmonitored"
grep -q 'pswatcher_tenant_absent_total' 60-prometheus.yaml || fail "60 PswatcherTenantSkipped must fire on pswatcher_tenant_absent_total (#1098)"
grep -q 'alert: PswatcherLedgerHealBlind' 60-prometheus.yaml || fail "60 missing PswatcherLedgerHealBlind alert (#1098) — an unreadable generation view makes the ledger heal path dead code"
grep -q 'pswatcher_ledger_heal_errors_total' 60-prometheus.yaml || fail "60 PswatcherLedgerHealBlind must fire on pswatcher_ledger_heal_errors_total (#1098)"
# cross-file pin: the alert expressions above are only live if the watcher EXPORTS them.
grep -q 'pswatcher_tenant_absent_total' ../gateway/internal/pswatcher/metrics.go || fail "pswatcher no longer exports pswatcher_tenant_absent_total — PswatcherTenantSkipped would never fire (#1098)"
grep -q 'pswatcher_ledger_heal_errors_total' ../gateway/internal/pswatcher/metrics.go || fail "pswatcher no longer exports pswatcher_ledger_heal_errors_total — PswatcherLedgerHealBlind would never fire (#1098)"
# #1099 review (FIX 4): the failover-TRIGGER family (discrimination + maintenance
# freeze) gets the SAME alert<->metric pin as the #1098 family above. Without it the
# stuck-freeze alert — ADR-0011's own mitigation for a freeze that silently disables
# HA — could go dormant on a metric rename with CI green. Each row pins BOTH halves:
# the alert exists in 60-prometheus.yaml AND the watcher still exports the metric.
for _a in PswatcherFailoverFrozen PswatcherFailoverSuppressedByFreeze PswatcherDependencyDegraded PswatcherFreezeUnreadable; do
  # Anchored at end-of-line: a bare substring grep would accept a RENAMED alert
  # (PswatcherFreezeUnreadableX matches "alert: PswatcherFreezeUnreadable"), which is how
  # this guard would have gone quietly decorative.
  grep -qE "alert: $_a\$" 60-prometheus.yaml || fail "60 missing $_a alert (#1099) — the failover-trigger/maintenance-freeze family must be monitored"
done
for _m in pswatcher_failover_frozen pswatcher_failover_freeze_suppressed_total pswatcher_failover_freeze_expiry_seconds pswatcher_dependency_degraded_total pswatcher_freeze_read_errors_total; do
  grep -q "$_m" 60-prometheus.yaml || fail "60 no alert/rule binds $_m (#1099) — an unbound metric is an unmonitored failover-trigger signal"
  grep -q "$_m" ../gateway/internal/pswatcher/metrics.go || fail "pswatcher no longer exports $_m — the #1099 alert bound to it would never fire"
done
# A SUSTAINED degradation-hold is a read outage, not health: it must PAGE, not warn.
grep -A3 'alert: PswatcherDependencyDegraded' 60-prometheus.yaml | grep -q 'for: 5m' || fail "60 PswatcherDependencyDegraded must only fire when SUSTAINED (for: 5m) so a multi-minute HOLD cannot masquerade as health (#1099 review)"
grep -A4 'alert: PswatcherDependencyDegraded' 60-prometheus.yaml | grep -q 'severity: critical' || fail "60 a SUSTAINED dependency-degraded hold must PAGE (severity: critical) — reads are down and no failover will fire (#1099 review)"
# LOCKSTEP: the manifest's freeze bound must equal the binary's default, or the ADR's
# documented 2h clamp is a claim about code nobody is running (repo precedent:
# metrics-port-lockstep). 7200000ms == 2h == DefaultMaxFreezeDuration.
_psw_max_ms="$(grep -o 'PSW_MAX_FREEZE_MS, value: "[0-9][0-9]*"' 58-pswatcher.yaml | grep -o '[0-9][0-9]*' | head -1)"
[ -n "$_psw_max_ms" ] || fail "58 must set PSW_MAX_FREEZE_MS (the hard bound on a maintenance freeze, #1099)"
_psw_default_h="$(grep -o 'DefaultMaxFreezeDuration = [0-9]* \* time.Hour' ../gateway/internal/pswatcher/watcher.go | grep -o '[0-9]*' | head -1)"
[ -n "$_psw_default_h" ] || fail "pswatcher DefaultMaxFreezeDuration is no longer an N*time.Hour literal — the PSW_MAX_FREEZE_MS lockstep check cannot read it (#1099 review)"
[ "$_psw_max_ms" = "$((_psw_default_h * 3600000))" ] || fail "58 PSW_MAX_FREEZE_MS=${_psw_max_ms}ms != DefaultMaxFreezeDuration=${_psw_default_h}h — the documented freeze bound and the shipped bound have drifted (#1099 review)"
# #1099 review (FIX 2): a node death freezes containerStatuses at Running (no kubelet),
# which the discrimination would read as "degraded -> hold". pswatcher classifies
# NodeLost/NodeStatusUnknown as a DEATH so recovery still fires — but an INFINITE
# `unreachable`/`not-ready` toleration on the storage plane would keep the dead pod
# object around forever, and any future regression there becomes a PERMANENT HA
# outage. Keep the storage plane un-tolerant of an unreachable node.
for _f in 53-pageserver.yaml 57-pageserver-standby.yaml; do
  grep -q 'node.kubernetes.io/unreachable' "$_f" && fail "$_f must NOT tolerate node.kubernetes.io/unreachable — a dead node's pod would linger and a failover-hold regression becomes a PERMANENT HA outage (#1099 review)"
  grep -q 'node.kubernetes.io/not-ready' "$_f" && fail "$_f must NOT tolerate node.kubernetes.io/not-ready — see #1099 review (permanent-hold trap)"
done
grep -q 'NodeLost' ../gateway/internal/pswatcher/k8s.go || fail "pswatcher no longer classifies a NodeLost pod as a DEATH — a true node death would read as 'dependency degraded' and HOLD, regressing MTTR ~5x (#1099 review)"
ok "60 pins the #1099 failover-trigger alert<->metric family, the freeze bound is in lockstep with the binary, and the storage plane stays un-tolerant of an unreachable node"
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
# the phantom-keepalive honesty rule must survive (state-based, not counter drift).
# Anchor re-pinned for #797: #777/#791 deliberately evolved the rule to subtract the
# DECLARED warm holds (min_over_time((sum(pggw_active_connections) - (sum(appdb_warm_hold_active)
# or vector(0)))[30m:1m])) — the rule was fine, THIS check had gone stale and was failing
# invisibly behind the script's old die-on-first-failure behavior. The invariant kept here is
# state-based-ness (min_over_time over the connection level) + the subtraction being present;
# contract 32 below separately asserts the subtraction's `or vector(0)` fallback semantics.
grep -q 'min_over_time((sum(pggw_active_connections) -' 60-prometheus.yaml || fail "60 phantom-keepalive honesty rule was lost (want state-based min_over_time over sum(pggw_active_connections) minus the declared warm holds)"
# issue #139: zoned-replication slot alerts — dormant Failed-Job rules joined on the
# repl-slot-monitor CronJobs (deploy/63) by exact owner_name, same pattern as apps-wal-monitor.
grep -q 'alert: ReplicationSlotWALGrowth' 60-prometheus.yaml || fail "60 missing ReplicationSlotWALGrowth alert (#139) — a slot nearing the WAL bound would be unmonitored"
grep -q 'alert: ReplicationSlotInactive' 60-prometheus.yaml || fail "60 missing ReplicationSlotInactive alert (#139) — a leaked slot from a dead subscriber would be unmonitored"
grep -q 'owner_name="repl-slot-wal-monitor"' 60-prometheus.yaml || fail "60 ReplicationSlotWALGrowth must match the repl-slot-wal-monitor CronJob by exact owner_name (#139)"
grep -q 'owner_name="repl-slot-inactive-monitor"' 60-prometheus.yaml || fail "60 ReplicationSlotInactive must match the repl-slot-inactive-monitor CronJob by exact owner_name (#139)"
# ADR-0007 v2-2 (SRE F2): ZONE STATUS alerts — a Failed/Degraded Zone or a broken
# subscription must PAGE (severity critical), sourced from the zone-status-monitor
# CronJobs (deploy/64) joined by exact owner_name, same Failed-Job pattern.
grep -q 'alert: ZoneDegradedOrFailed' 60-prometheus.yaml || fail "60 missing ZoneDegradedOrFailed alert (ADR-0007) — a Failed/Degraded Zone would be unmonitored"
grep -q 'alert: ZoneSubscriptionBroken' 60-prometheus.yaml || fail "60 missing ZoneSubscriptionBroken alert (ADR-0007) — a broken cross-zone subscription would be unmonitored"
grep -q 'owner_name="zone-phase-monitor"' 60-prometheus.yaml || fail "60 ZoneDegradedOrFailed must match the zone-phase-monitor CronJob by exact owner_name (ADR-0007)"
grep -q 'owner_name="zone-subscription-monitor"' 60-prometheus.yaml || fail "60 ZoneSubscriptionBroken must match the zone-subscription-monitor CronJob by exact owner_name (ADR-0007)"
grep -Eq 'alert: Zone(DegradedOrFailed|SubscriptionBroken)' 60-prometheus.yaml && grep -q 'severity: critical, plane: zones' 60-prometheus.yaml || fail "60 zone-status alerts must PAGE (severity: critical, plane: zones)"
[ -f 64-zone-status-monitor.yaml ] || fail "deploy/64-zone-status-monitor.yaml missing (zone-status paging monitor, ADR-0007 SRE F2)"
grep -q 'name: zone-phase-monitor' 64-zone-status-monitor.yaml || fail "64 missing zone-phase-monitor CronJob (ZoneDegradedOrFailed source)"
grep -q 'name: zone-subscription-monitor' 64-zone-status-monitor.yaml || fail "64 missing zone-subscription-monitor CronJob (ZoneSubscriptionBroken source)"
grep -q 'kubectl get zones' 64-zone-status-monitor.yaml || fail "64 zone-status monitor must read the Zone CRs"
ok "60 ships the platform alert rules (backup+janitor+staleness+pswatcher+standby+wake+slot+zone) and keeps the phantom honesty rule"

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
# Every gateway host the PLATFORM mints into an app-consumed Secret must be ROOTED
# (trailing dot). Measured on the live plane (a running pod's /etc/resolv.conf, knext
# cold-start ledger): `options ndots:5` with a FIVE-entry search path — the standard
# three plus two OCI VCN domains. Any name below 5 dots is tried against all five
# suffixes before the name as given: 5 wasted attempts = 10 wasted queries with
# A+AAAA, and the two VCN misses leave the cluster for OCI's resolver. That covers
# BOTH the short "pggw-apps.<ns>.svc" (2 dots) and the merely-qualified
# "…svc.cluster.local" (4 dots) — only the rooted form skips the walk.
#
# SCAN, don't enumerate: the operator manifest is only ONE writer of app-db-<app>.
# provision-app.sh writes the same Secret from `create` AND from `rotate-cred` (the
# latter would silently REVERT a rooted DSN on every rotation), so the scan below
# covers the script's DSNs too.
#
# REACHABILITY — this contract had NEVER executed in a real run before #797's fix.
# Two separate reasons, both stated rather than implied:
#   1. This file is not wired into the monorepo's root .github/workflows; the
#      packages/scale-zero-pg/.github copy is subtree residue GitHub does not run
#      (knext #797 tracks the wiring).
#   2. (RESOLVED by #797) The script was `set -eu` with an exiting fail(), so the first
#      failing check — latterly the stale phantom-keepalive anchor in contract 19 —
#      killed the run before this point. fail() now aggregates and the script always
#      evaluates every contract, so an early failure can no longer disable this one.
# Until (1) lands, the LIVE enforcement is the root test infra, which does run in CI:
# tests/rooted-minted-hosts.test.ts (minted values) and
# tests/rooted-cluster-hosts-repo-wide.test.ts (every reference, repo-wide).
grep -q 'APPDB_GATEWAY_HOST, value: "' 83-appdb-operator.yaml || fail "83-appdb-operator.yaml no longer sets APPDB_GATEWAY_HOST — the rooted-host contract below would silently pass"
grep 'APPDB_GATEWAY_HOST, value: "' 83-appdb-operator.yaml | grep -qv 'value: "[^"]*\."' &&
  fail "83-appdb-operator.yaml APPDB_GATEWAY_HOST is NOT rooted (no trailing dot) — minted DATABASE_URLs would walk the ndots:5 search path on every fresh pod (a custom DNS zone edits the value but KEEPS the trailing dot)" || true
# provision-app.sh: both Secret writers (create at mint_credential, rotate-cred) plus
# the DSN it prints. Since #798 the host is resolved ONCE, honouring the operator's
# APPDB_GATEWAY_HOST override with the operator's precedence, so there are two
# contracts here, not one: the DEFAULT must be rooted, AND no writer may inline a host
# (a hardcoded host in rotate-cred is what silently reverted an operator-minted,
# correctly-overridden DSN to an unresolvable one on a routine rotation).
#
# Presence check first, so deleting the resolution cannot vacuously pass. The
# host-position scan stays bare-inclusive — NOT anchored on `pggw-apps\.`. An anchor
# that requires a dot cannot even see the worst form: the bare single-label
# `@pggw-apps:55432` is furthest below ndots:5, so it walks all five search suffixes,
# and `_verify-scale-ceiling.sh:141` already contains exactly that.
grep -q 'APPDB_GATEWAY_HOST:-pggw-apps\.' provision-app.sh ||
  fail "provision-app.sh no longer resolves the apps-gateway host from APPDB_GATEWAY_HOST (\$GW_HOST) — the contracts below would silently pass, and a custom-zone cluster's DSN would be clobbered on every create/rotate (#798)"
grep 'APPDB_GATEWAY_HOST:-' provision-app.sh | grep -qv 'APPDB_GATEWAY_HOST:-.*\.}"' &&
  fail "provision-app.sh's APPDB_GATEWAY_HOST DEFAULT is NOT rooted (no trailing dot before the closing brace) — minted DATABASE_URLs would walk the ndots:5 search path on every fresh pod" || true
grep -n '@pggw' provision-app.sh &&
  fail "provision-app.sh INLINES a gateway host in a DSN (see the lines above) instead of using \$GW_HOST: that writer ignores APPDB_GATEWAY_HOST, so on a custom-zone cluster 'create'/'rotate-cred' overwrites a working Secret with an unresolvable host (#798)" || true
[ "$(grep -c '@\$GW_HOST' provision-app.sh)" -ge 2 ] ||
  fail "provision-app.sh must mint through \$GW_HOST from BOTH Secret writers (create's mint_credential AND rotate-cred) — found fewer than 2 sites, so one writer was fixed and the other left behind (#798, the half-fix class)"
# gen-secrets.sh: the base DATABASE_URL[_RO] Secret is the other minting writer. Same
# two contracts. Its host is the BASE gateway (pggw, cloud_admin) and therefore its own
# knob — the apps-gateway refuses cloud_admin, so it must NOT read APPDB_GATEWAY_HOST.
grep -q 'DBHOST:-pggw\.' gen-secrets.sh ||
  fail "gen-secrets.sh no longer resolves the base gateway host from \$DBHOST — re-running it on a custom-zone cluster would reconcile a working base DATABASE_URL to an unresolvable one (#798)"
grep 'DBHOST:-' gen-secrets.sh | grep -qv 'DBHOST:-.*\.}"' &&
  fail "gen-secrets.sh's DBHOST DEFAULT is NOT rooted (no trailing dot before the closing brace)" || true
ok "AppDatabase CRD + operator wired (82/83), operator built into the image, does not claim deployments/scale (issue #96); every platform-minted gateway host (operator manifest, provision-app.sh create/rotate, gen-secrets.sh base DSN) is ROOTED by default and honours its env override"

# 25. contract (issue #151, ADR-0007 v2-2): the Zone CRD + zone-operator ship together
#     and are STANDARD deploy artifacts, not drill-only. Same "merged ≠ deployed" class
#     the loop has caught 3× (#27/#125/#126): the flagship was proven only in
#     _verify-zones.sh, which applied 86/87 then TORE THEM DOWN on exit — so the live
#     cluster never carried the CRD or the operator. These grep-contracts guard the
#     MANIFESTS; _verify-drift.sh (section D) asserts the LIVE presence + readiness so a
#     regression to drill-only-again cannot pass silently.
grep -q 'kind: CustomResourceDefinition' 86-zone-crd.yaml || fail "86-zone-crd.yaml missing the CustomResourceDefinition"
grep -q 'zones.zones.scale-zero-pg.dev' 86-zone-crd.yaml || fail "86-zone-crd.yaml wrong CRD name (want zones.zones.scale-zero-pg.dev)"
grep -q 'group: zones.scale-zero-pg.dev' 86-zone-crd.yaml || fail "86-zone-crd.yaml wrong API group"
grep -q 'kind: Deployment' 87-zone-operator.yaml || fail "87-zone-operator.yaml missing the zone-operator Deployment"
grep -q 'name: zone-operator' 87-zone-operator.yaml || fail "87-zone-operator.yaml missing the zone-operator name"
grep -q '/zone-operator' 87-zone-operator.yaml || fail "87-zone-operator.yaml must override the entrypoint to /zone-operator"
grep -q 'zones/finalizers' 87-zone-operator.yaml || fail "87-zone-operator.yaml RBAC lacks zones/finalizers (cross-zone deprovision hygiene, ADR-0007 §4d)"
grep -q 'zone-operator' ../gateway/Dockerfile || fail "Dockerfile does not build the zone-operator binary into the image"
# STANDARD-DEPLOY guard: 86/87 must be picked up by the documented deploy glob
# (deploy/[0-9][0-9]-*.yaml). They already match by number; assert docs present them as
# standard (not an opt-in aside) so a future reader does not treat the flagship as optional.
grep -q '86-zone-crd.yaml' ../docs/getting-started.md || fail "getting-started.md must document 86-zone-crd as a standard deploy artifact (#151)"
grep -q '87-zone-operator.yaml' ../docs/getting-started.md || fail "getting-started.md must document 87-zone-operator as a standard deploy artifact (#151)"
ok "Zone CRD + operator wired (86/87), operator built into the image, standard-deploy documented (issue #151)"

# 26. contract (issue #142): the janitor-disarm tripwire. A missing janitor-critical
#     ConfigMap (storage-objstore/compute-config, or the repl-slot monitors' script CM)
#     puts the next scheduled pod in CreateContainerConfigError — the container never
#     starts, so no Failed Job → WalJanitorJobFailed/ReplicationSlot*/SafekeeperWALGrowth
#     stay SILENT and the only backstop was WalJanitorStale at 26h (the WAL then
#     accumulates toward DiskPressure — the 2026-07-06 incident). JanitorConfigDisarmed
#     reads the POD's waiting-reason directly (KSM `pods` collector, deploy/59) so it
#     PAGES within one cycle. Must cover BOTH the wal-janitor AND the zone repl-slot
#     monitors (same shared-config/exec coupling class).
grep -q 'alert: JanitorConfigDisarmed' 60-prometheus.yaml || fail "60 missing JanitorConfigDisarmed alert (#142) — a missing janitor-critical ConfigMap would silently disarm the janitor for up to 26h"
grep -q 'kube_pod_container_status_waiting_reason' 60-prometheus.yaml || fail "60 JanitorConfigDisarmed must read kube_pod_container_status_waiting_reason off the POD (Failed-Job joins are blind to a never-starting container) (#142)"
grep -q 'CreateContainerConfigError' 60-prometheus.yaml || fail "60 JanitorConfigDisarmed must match CreateContainerConfigError (config-missing = janitor disarmed) (#142)"
grep -q 'repl-slot-wal-monitor|repl-slot-inactive-monitor' 60-prometheus.yaml || fail "60 JanitorConfigDisarmed must ALSO cover the zone repl-slot monitors (same config/exec coupling class) (#142)"
# the KSM `pods` collector is the metric SOURCE — assert it stays enabled (else the rule is inert).
grep -q 'resources=cronjobs,jobs,deployments,statefulsets,pods' 59-kube-state-metrics.yaml || fail "59 KSM must keep the `pods` collector — JanitorConfigDisarmed reads kube_pod_container_status_waiting_reason from it (#142)"
ok "janitor-disarm tripwire wired: JanitorConfigDisarmed pages on CreateContainerConfigError for janitor+repl-slot monitors (issue #142)"

# 27. contract (issue #155): the prometheus Deployment POD TEMPLATE carries a config-hash
#     annotation equal to the sha256 of the prometheus-config ConfigMap data. A rule/scrape
#     edit changes the hash → the pod template changes → `kubectl apply` rolls the (Recreate)
#     Deployment → the new pod LOADS the fresh rules at boot (AUTO-RELOAD). WITHOUT it, a
#     merged+applied ConfigMap change is DARK in the running Prometheus until a manual POST
#     /-/reload — the 2026-07-06 zone-alerts miss (rules can be applied yet never loaded).
#     Making a stale annotation a HARD failure guarantees the roll is never forgotten.
#     Regenerate the value with: ./_validate.sh prom-config-hash
WANT_PROM_HASH=$(prom_config_hash 60-prometheus.yaml) \
  || { WANT_PROM_HASH=""; fail "prom_config_hash could not extract the prometheus-config ConfigMap data from 60-prometheus.yaml (#155)"; }
GOT_PROM_HASH=$(grep -oE 'ks-pg\.dev/prometheus-config-sha256:[[:space:]]*"?[0-9a-f]{64}' 60-prometheus.yaml | grep -oE '[0-9a-f]{64}' | head -1)
[ -n "$GOT_PROM_HASH" ] || fail "60-prometheus.yaml pod template lacks the ks-pg.dev/prometheus-config-sha256 auto-reload annotation (#155) — add it under spec.template.metadata.annotations; value = ./_validate.sh prom-config-hash"
[ "$WANT_PROM_HASH" = "$GOT_PROM_HASH" ] || fail "60-prometheus.yaml config-hash annotation ($GOT_PROM_HASH) != the ConfigMap data hash ($WANT_PROM_HASH) — the rules/config changed but the pod template was not re-hashed, so \`kubectl apply\` would NOT roll prometheus and the new rules would stay DARK. Regenerate: ./_validate.sh prom-config-hash (#155)"
# placement: the annotation MUST sit on spec.template.metadata (rolls the pod). A top-level
# metadata annotation does not change the pod template and would never trigger a roll.
awk '/^  template:/{t=NR} /prometheus-config-sha256:/{a=NR} END{exit !(t>0 && a>t)}' 60-prometheus.yaml \
  || fail "60 config-hash annotation must live under spec.template.metadata.annotations (a top-level annotation does NOT roll the pod, so rules would stay DARK) (#155)"
ok "prometheus pod template carries a config-hash annotation matching the ConfigMap data — a rules edit auto-rolls the pod (#155)"

# 28. contract (issues #155 + #153): the LIVE drift gate (_verify-drift.sh) must
#     (a) assert every SHIPPED alert rule is LOADED in the running Prometheus (query
#     /api/v1/rules) — a rule can be merged+applied to the ConfigMap yet DARK until a
#     reload, which sections A–D were blind to; and (b) in the digest-provenance check
#     accept the manifest digest carried by a pod's .status.image, not the imageID alone —
#     an image pushed as an OCI INDEX (docker buildx attestations) reports imageID as the
#     selected child's CONFIG digest, which never equals the index/manifest digest the
#     manifest pins, so imageID-alone false-fires on a pod running EXACTLY the pinned
#     reference (the appdb-operator case). Guard both so a refactor cannot silently drop them.
grep -q 'api/v1/rules' _verify-drift.sh || fail "_verify-drift.sh must assert shipped rules are LOADED in the running Prometheus via /api/v1/rules — a merged-but-not-reloaded rule is DARK (#155)"
grep -q 'RULEUNLOADED' _verify-drift.sh || fail "_verify-drift.sh loaded-rules assertion missing (expected the shipped-vs-loaded diff that flags RULEUNLOADED) (#155)"
grep -q 'status.image' _verify-drift.sh || fail "_verify-drift.sh section C must also accept the manifest digest from .status.image — OCI-index images report imageID as the child CONFIG digest (the appdb-operator false positive, #153)"
ok "drift gate asserts shipped rules LOADED + tolerates OCI-index imageID via the .status.image digest (#155/#153)"

# 29. contract (issue #117): SCRAM-SHA-256 password auth (was md5). The app role gets a
#     PRECOMPUTED SCRAM verifier injected into the compute spec (compute_ctl stores a
#     recognised SCRAM-SHA-256$... verifier verbatim), so the role is SCRAM FROM BOOT —
#     no cold-wake md5 window, and ZERO tenant plaintext on the compute (the verifier is
#     non-reversible). Legs:
#     (a) password_encryption=scram-sha-256 (source spec + inlined 54) — belt for the
#         zone repl role's plaintext ALTER path;
#     (b) the per-app writer entrypoint (APP_ROLE) injects APP_ROLE_VERIFIER into the
#         spec's encrypted_password, and rewrites the pg_hba network catch-all
#         md5 -> scram-sha-256 (reject md5-only clients) while KEEPING the #112
#         cloud_admin loopback-only reject;
#     (c) the per-app Secret carries APP_ROLE_VERIFIER (a SCRAM verifier), delivered as
#         an env var (a verifier is safe to env; there is no plaintext to protect) — and
#         there is NO plaintext file mount and NO md5 key.
grep -q '"name": "password_encryption"' compute-files/config.json || fail "config.json must set password_encryption (issue #117)"
grep -A2 '"name": "password_encryption"' compute-files/config.json | grep -q '"value": "scram-sha-256"' || fail "config.json password_encryption must be scram-sha-256, not md5 (issue #117)"
grep -A2 '"name": "password_encryption"' 54-compute-files.yaml | grep -q '"value": "scram-sha-256"' || fail "54-compute-files.yaml (inlined spec) password_encryption must be scram-sha-256 (issue #117)"
# entrypoint (source + inlined) injects the SCRAM VERIFIER into the spec + enforces SCRAM in pg_hba.
grep -q 'APP_ROLE_VERIFIER' compute-files/entrypoint.sh || fail "entrypoint.sh must inject APP_ROLE_VERIFIER (a SCRAM verifier) into the compute spec (issue #117)"
grep -q 'APP_ROLE_VERIFIER' 54-compute-files.yaml || fail "54-compute-files.yaml (inlined entrypoint) must inject APP_ROLE_VERIFIER (issue #117)"
grep -q 'APP_ROLE_MD5' compute-files/entrypoint.sh && fail "entrypoint.sh must not reference APP_ROLE_MD5 — renamed to APP_ROLE_VERIFIER (issue #117)" || true
# the pg_hba harden (scram catch-all + #112 cloud_admin reject) lives in the SHARED
# lib-harden.sh (issue #164) — assert it there, the single source of truth.
grep -q 'scram-sha-256' compute-files/lib-harden.sh || fail "lib-harden.sh must rewrite the pg_hba network catch-all to scram-sha-256 (issue #117)"
# the #112 cloud_admin loopback reject MUST survive the SCRAM change (no cross-tenant regression).
grep -q 'cloud_admin.*reject' compute-files/lib-harden.sh || fail "lib-harden.sh must keep the cloud_admin loopback-only reject (issue #112 preserved under #117)"
# the per-app compute injects the verifier from the Secret; NO plaintext file mount.
grep -q 'APP_ROLE_VERIFIER' compute-app.template.yaml || fail "compute-app.template.yaml must inject APP_ROLE_VERIFIER from the per-app Secret (issue #117)"
grep -q 'app-role-secret' compute-app.template.yaml && fail "compute-app.template.yaml must NOT mount a plaintext file — the verifier-in-spec approach needs no plaintext on the compute (issue #117)" || true
# provision-app + the appdb operator must COMPUTE a SCRAM verifier (not an md5 hash).
grep -q 'app_scram_verifier\|APP_ROLE_VERIFIER' provision-app.sh || fail "provision-app.sh must mint APP_ROLE_VERIFIER via a SCRAM verifier (issue #117)"
ok "SCRAM-SHA-256 auth wired: app role gets a precomputed SCRAM verifier in-spec (SCRAM from boot, no plaintext on compute, no cold-wake window), scram-sha-256 pg_hba, cloud_admin reject preserved (issue #117)"

# 30. contract (issue #164): the pg_hba harden (cloud_admin loopback-only reject #112 +
#     md5 -> scram-sha-256 catch-all rewrite #117) is a SINGLE SHARED snippet
#     (lib-harden.sh) sourced by ALL THREE compute entrypoints (primary/RO/warm) so it
#     can never drift. Each entrypoint calls harden_pg_hba gated on APP_ROLE (a per-app
#     compute), identical to the primary — the base single-DB tiers (no APP_ROLE) keep
#     cloud_admin over TCP so DATABASE_URL / DATABASE_URL_RO are unchanged.
[ -f compute-files/lib-harden.sh ] || fail "compute-files/lib-harden.sh missing — the shared pg_hba harden (issue #164)"
grep -q 'harden_pg_hba()' compute-files/lib-harden.sh || fail "lib-harden.sh must define harden_pg_hba() (issue #164)"
grep -q 'lib-harden.sh' 54-compute-files.yaml || fail "54-compute-files.yaml must embed lib-harden.sh in the compute-files ConfigMap (issue #164)"
for e in entrypoint.sh entrypoint-ro.sh entrypoint-warm.sh; do
  grep -q '\. /compute-files/lib-harden.sh' "compute-files/$e" || fail "compute-files/$e must source the shared /compute-files/lib-harden.sh (issue #164)"
  # the harden must NOT be redefined inline in any entrypoint (single source of truth).
  grep -q 'harden_pg_hba()' "compute-files/$e" && fail "compute-files/$e must NOT redefine harden_pg_hba() — source lib-harden.sh instead (issue #164)" || true
done
# RO + warm must actually CALL the harden, gated on APP_ROLE (parity with the primary).
for e in entrypoint-ro.sh entrypoint-warm.sh; do
  grep -Eq 'APP_ROLE.*\]' "compute-files/$e" || fail "compute-files/$e must gate the harden on APP_ROLE (issue #164)"
  grep -q 'harden_pg_hba &' "compute-files/$e" || fail "compute-files/$e must call harden_pg_hba (backgrounded) when APP_ROLE is set (issue #164)"
done
# the primary still gates identically (byte-identical behavior preserved under the refactor).
grep -q 'harden_pg_hba &' compute-files/entrypoint.sh || fail "entrypoint.sh must still call harden_pg_hba when APP_ROLE is set (issue #164 refactor must not change primary behavior)"
ok "pg_hba harden factored into shared lib-harden.sh; sourced + APP_ROLE-gated by primary/RO/warm entrypoints; embedded in 54 ConfigMap (issue #164)"

# 31. contract (issue #168): the BASE single-DB tiers must NOT ship the PUBLIC
#     DEFAULT cloud_admin:cloud_admin as their only TCP defense. The base tiers
#     (compute / compute-ro / compute-warm) run cloud_admin as the documented
#     DATABASE_URL[_RO] credential over TCP (no APP_ROLE → the pg_hba harden is
#     deliberately skipped), so — unlike a per-app compute — they cannot rely on
#     the loopback-only reject. Instead they carry a STRONG cloud_admin md5 minted
#     by gen-secrets.sh (Secret pg-base-admin) and injected as a REQUIRED env, so
#     a base compute can never boot on the public default (fail-closed). The
#     matching strong PLAINTEXT lives in the base DATABASE_URL[_RO] Secret, also
#     gen-secrets-owned. See docs/operations.md "Base-tier cloud_admin".
#
# (a) deploy/30 must be DOC-ONLY: it must NOT ship the literal public default.
grep -Eq 'cloud_admin:cloud_admin@' 30-knext-secret.yaml && fail "30-knext-secret.yaml must NOT ship the public default cloud_admin:cloud_admin (issue #168 — gen-secrets.sh owns the strong base DATABASE_URL Secret)" || true
# (b) each base compute manifest must inject CLOUD_ADMIN_MD5 from pg-base-admin,
#     REQUIRED (no optional:true) so the pod fails closed without the strong Secret.
for m in 20-compute.yaml 25-compute-warm.yaml 26-compute-ro.yaml; do
  grep -q 'CLOUD_ADMIN_MD5' "$m" || fail "$m must inject CLOUD_ADMIN_MD5 from the pg-base-admin Secret (issue #168)"
  grep -q 'pg-base-admin' "$m" || fail "$m must reference the pg-base-admin Secret for the strong base cloud_admin md5 (issue #168)"
  # the pg-base-admin CLOUD_ADMIN_MD5 secretKeyRef must be fail-closed (no
  # optional:true — base tiers never boot on the default). Scoped to the
  # pg-base-admin ref (±3 lines — YAML key order is author-controlled, so optional: may sit above OR below the name; covers flow AND block style), NOT the whole
  # file: the same manifests also carry the compute-jwt-trust JWK env refs,
  # which are DELIBERATELY optional:true and fail-SAFE (absent, the entrypoint
  # locks the control API with a random throwaway anchor). The old whole-file
  # grep went stale the day those landed and had been failing invisibly behind
  # the pre-#797 die-on-first-failure behavior.
  grep -B3 -A3 'pg-base-admin' "$m" | grep -Eq 'optional:[[:space:]]*true' \
    && fail "$m marks the pg-base-admin CLOUD_ADMIN_MD5 secretKeyRef optional:true — base compute must fail closed (issue #168)" || true
done
# (c) gen-secrets.sh must mint pg-base-admin (strong plaintext + its md5) AND own
#     the base DATABASE_URL[_RO] Secret derived from it.
grep -q 'pg-base-admin' gen-secrets.sh || fail "gen-secrets.sh must mint the pg-base-admin Secret (issue #168)"
grep -q 'CLOUD_ADMIN_MD5' gen-secrets.sh || fail "gen-secrets.sh must compute CLOUD_ADMIN_MD5=md5(password||cloud_admin) for pg-base-admin (issue #168)"
grep -q 'myapp-database' gen-secrets.sh || fail "gen-secrets.sh must own the base DATABASE_URL Secret myapp-database, derived from pg-base-admin (issue #168)"
ok "base tiers carry a STRONG cloud_admin md5 (pg-base-admin, fail-closed) — the public default is never shipped (issue #168)"

# 32. contract (knext #388, ADR-0030 addendum): the scheduled DB warm lockstep.
#     An AppDatabase may declare spec.warmSchedule; while a window is active the
#     appdb operator holds ONE authenticated gateway connection per app so the
#     compute never idles. Invariants the manifests must keep:
grep -q 'warmSchedule' 82-appdb-crd.yaml || fail "82-appdb-crd.yaml missing spec.warmSchedule (knext #388 DB warm lockstep)"
# (a) the lockstep is a HOLD, never a scale: the operator must still NOT claim
#     deployments/scale (contract 24 above is the guard; restated here as the
#     #388 design constraint — a replica-pinning writer would fight the
#     gateway's idle scale-to-zero, the ADR-0030 two-writer defect).
grep -q 'deployments/scale' 83-appdb-operator.yaml && fail "appdb-operator must warm via a held CONNECTION, never via deployments/scale (knext #388)" || true
# (b) the operator exposes the deliberate holds on :9092/metrics and Prometheus
#     scrapes them, so the phantom-keepalive alert can subtract them.
grep -q 'job_name: appdb-operator' 60-prometheus.yaml || fail "60-prometheus.yaml must scrape the appdb-operator :9092 /metrics (appdb_warm_hold_active, knext #388)"
grep -q 'appdb_warm_hold_active' 60-prometheus.yaml || fail "60-prometheus.yaml ComputePhantomKeepalive must subtract appdb_warm_hold_active — a declared warm hold is not a phantom (knext #388)"
grep -q 'or vector(0)' 60-prometheus.yaml || fail "60-prometheus.yaml phantom-keepalive subtraction must use 'or vector(0)' so the alert is not silenced when nothing is held (knext #388)"
ok "AppDatabase warmSchedule CRD field shipped; warm = held connection (no deployments/scale); holds scraped + subtracted from phantom-keepalive (knext #388)"

# 33. contract (F5 phase 1, ADR-0003): the gateway→compute mTLS cert
#     infrastructure must ship as a cert-manager CA bootstrap + two role leaf
#     certs. INTENT — absent cert infra must FAIL the deploy, never fall through
#     to a later phase that then runs plaintext. This contract asserts the infra
#     the later phases mount:
#       * the manifest exists and wires the self-signed→CA→CA-Issuer bootstrap,
#       * a compute-server leaf (serverAuth) whose SANs cover the compute Service
#         DNS the gateway will verify as ServerName,
#       * a gateway-client leaf (clientAuth) — the identity phase-4
#         clientcert=verify-ca enforces,
#       * both leaves issue from the ONE CA Issuer (shared trust root).
#     Phase 1 is manifests+docs only: NO Go code consumes these yet.
CM=11-mtls-certs.yaml
[ -f "$CM" ] || fail "deploy/$CM missing — the F5 phase-1 gateway↔compute mTLS cert infrastructure (ADR-0003)"
grep -q 'kind: Issuer' "$CM"      || fail "$CM missing a cert-manager Issuer (self-signed bootstrap + CA issuer)"
grep -q 'selfSigned: {}' "$CM"    || fail "$CM missing the self-signed bootstrap Issuer"
grep -q 'isCA: true' "$CM"        || fail "$CM missing the CA Certificate (isCA: true)"
grep -q 'name: pggw-mtls-ca-issuer' "$CM" || fail "$CM missing the CA Issuer (issues every leaf from the shared CA)"
# the two role leaves + their Secrets (what phases 2/3/4 mount)
grep -q 'secretName: pggw-compute-server-tls' "$CM" || fail "$CM missing the compute-server leaf Secret pggw-compute-server-tls (serverAuth)"
grep -q 'secretName: pggw-gateway-client-tls' "$CM" || fail "$CM missing the gateway-client leaf Secret pggw-gateway-client-tls (clientAuth)"
grep -q 'server auth' "$CM" || fail "$CM compute-server leaf must declare usages: [server auth]"
grep -q 'client auth' "$CM" || fail "$CM gateway-client leaf must declare usages: [client auth]"
# the compute-server SANs must cover every backend DNS the gateway dials as
# ServerName: the single-DB write path, the RO pool, and the per-system wildcard.
grep -q 'compute.scale-zero-pg.svc' "$CM"    || fail "$CM compute-server leaf missing the compute.scale-zero-pg.svc SAN (GW_TARGET write path)"
grep -q 'compute-ro.scale-zero-pg.svc' "$CM" || fail "$CM compute-server leaf missing the compute-ro.scale-zero-pg.svc SAN (GW_RO_TARGET)"
grep -q '\*.scale-zero-pg.svc' "$CM"         || fail "$CM compute-server leaf missing the *.scale-zero-pg.svc wildcard SAN (per-system compute-{system} from GW_TARGET_TEMPLATE)"
# both leaves must chain to the ONE CA issuer (shared trust root: gateway RootCAs
# + compute ssl_ca_file are the same CA).
[ "$(grep -c 'name: pggw-mtls-ca-issuer' "$CM")" -ge 3 ] || fail "$CM both leaves + the CA cert must reference issuerRef name pggw-mtls-ca-issuer / the CA (shared root)"
# finite duration + renewBefore so cert-manager auto-rotates across the fleet
# (the reliability point vs the manual, never-rotating gen-tls.sh path).
grep -q 'renewBefore:' "$CM" || fail "$CM leaves must set renewBefore so cert-manager auto-rotates (the F5 reliability win over gen-tls.sh)"
# Live fail-closed gate, keyed on the CA Issuer being APPLIED. Rationale: this is a
# manifest-contract validator that also runs pre-apply (fresh cluster / CI), and in
# PHASE 1 nothing consumes these certs yet, so an un-applied cluster is NOT a defect —
# reding on "Secret not issued" before anyone applied 11-mtls-certs.yaml would just
# break the validator. But the DANGEROUS state IS caught: once the CA Issuer is
# applied (a cert-consuming deploy is imminent), a MISSING leaf Secret means
# cert-manager half-provisioned the infra, and a later phase that mounts it would run
# without TLS — that fails closed here. So: Issuer absent -> not-yet-applied (note);
# Issuer present -> both leaf Secrets MUST be issued.
if [ "$HAVE_KUBECTL" = 1 ] && kubectl get crd certificates.cert-manager.io >/dev/null 2>&1; then
  if kubectl -n scale-zero-pg get issuer pggw-mtls-ca-issuer >/dev/null 2>&1; then
    for s in pggw-compute-server-tls pggw-gateway-client-tls; do
      kubectl -n scale-zero-pg get secret "$s" >/dev/null 2>&1 \
        || fail "F5 fail-closed: CA Issuer is applied but leaf Secret $s is NOT issued — cert-manager half-provisioned the mTLS infra; a phase that mounts it would run without TLS. Fix issuance before advancing."
    done
    echo "  (F5: CA Issuer applied; both leaf Secrets issued on this cluster)"
  else
    echo "  (F5: cert-manager present but deploy/$CM not yet applied — phase-1 infra is optional to apply now; MUST be applied + issued before phase 2 mounts the certs)"
  fi
fi
ok "F5 phase-1 mTLS cert infrastructure ships (cert-manager CA + shared server/client leaves, shared trust root, auto-rotating; fail-closed on missing infra) — ADR-0003"

# ---------------------------------------------------------------------------
# 34. contract (F5 phase 2, ADR-0003): the compute OFFERS TLS — ssl=on + the
#     server cert/key/CA wired through the compute_ctl GUC channel, the two
#     phase-1 Secrets mounted at the paths the GUCs name, and the server key
#     staged to a private 0600 path so Postgres does not refuse to start
#     ("private key file has group or world access"). A path mismatch between a
#     GUC and its mount = silent no-TLS or a crash-loop, so the paths are asserted
#     to MATCH. pg_hba is not touched by THIS contract — the enforcement half
#     (hostssl + clientcert=verify-ca) is contract 36 below; this one covers the
#     OFFER half (serve TLS, be able to verify a client cert via ssl_ca_file), which
#     stays independently safe: a compute with no cert mounts boots plaintext rather
#     than crash-looping.
SRVMNT=/etc/pggw-compute-server-tls
CAMNT=/etc/pggw-mtls-ca
KEYDST=/tmp/pggw-server-tls.key
for cfg in compute-files/config.json 54-compute-files.yaml; do
  grep -q '"name": "ssl", "value": "on"' "$cfg" || fail "$cfg must set ssl=on in spec.cluster.settings (F5 phase 2 — compute serves TLS; restart-only GUC applied by compute_ctl at boot)"
  grep -q "\"name\": \"ssl_cert_file\", \"value\": \"$SRVMNT/tls.crt\"" "$cfg" || fail "$cfg ssl_cert_file GUC must equal the pggw-compute-server-tls mount ($SRVMNT/tls.crt) — a path mismatch = silent no-TLS/crash"
  grep -q "\"name\": \"ssl_key_file\", \"value\": \"$KEYDST\"" "$cfg" || fail "$cfg ssl_key_file GUC must point at the staged 0600 key ($KEYDST) — see lib-harden.sh stage_tls_key"
  grep -q "\"name\": \"ssl_ca_file\", \"value\": \"$CAMNT/ca.crt\"" "$cfg" || fail "$cfg ssl_ca_file GUC must equal the pggw-mtls-ca mount ($CAMNT/ca.crt)"
done
# config.json must remain valid JSON with the ssl GUCs present.
if command -v python3 >/dev/null 2>&1; then
  python3 -c 'import json; json.load(open("compute-files/config.json"))' 2>/dev/null || fail "compute-files/config.json is not valid JSON after adding the ssl GUCs (F5 phase 2)"
fi
# the server key is staged to a private 0600 path owned by the running postgres
# user (no securityContext change) — Postgres refuses a group/world-readable key.
grep -q 'stage_tls_key()' compute-files/lib-harden.sh || fail "lib-harden.sh must define stage_tls_key() (F5 phase 2 key-perms: copy the mounted key to a 0600 postgres-owned path before compute_ctl starts Postgres)"
grep -q 'stage_tls_key' 54-compute-files.yaml || fail "54-compute-files.yaml (inlined lib-harden) must embed stage_tls_key (F5 phase 2)"
grep -q 'chmod 600' compute-files/lib-harden.sh || fail "lib-harden.sh stage_tls_key must chmod 600 the staged key (Postgres rejects a group/world-readable ssl_key_file)"
grep -q "$SRVMNT/tls.key" compute-files/lib-harden.sh || fail "lib-harden.sh stage_tls_key must copy FROM the mounted server key ($SRVMNT/tls.key)"
grep -q "$KEYDST" compute-files/lib-harden.sh || fail "lib-harden.sh stage_tls_key must stage the key TO $KEYDST (matching the ssl_key_file GUC)"
# CRASH-LOOP GUARD: ssl must be enabled only when BOTH the server key AND the CA file are
# present. The CA ($CAMNT/ca.crt) is a SEPARATE optional Secret; ssl=on with a missing
# ssl_ca_file FATALs in be_tls_init. Assert stage_tls_key gates on the CA source too.
grep -q "SERVER_CA_SRC=$CAMNT/ca.crt" compute-files/lib-harden.sh || fail "lib-harden.sh stage_tls_key must gate ssl-enable on the CA file ($CAMNT/ca.crt via SERVER_CA_SRC) — ssl=on with a missing ssl_ca_file crash-loops (be_tls_init FATAL)"
grep -q '\[ -r "\$SERVER_CA_SRC" \]' compute-files/lib-harden.sh || fail "lib-harden.sh stage_tls_key must test the CA file readable (\[ -r \"\$SERVER_CA_SRC\" \]) before enabling ssl — otherwise a present cert + absent CA crash-loops"
# The plaintext-fallback strip must be JSON-aware/order-independent (awk self-repairing
# the dangling comma), NOT a position-dependent `grep -v` that breaks if the ssl GUCs are
# reordered off the head of the array.
grep -q 'grep -v .*"name": "ssl' compute-files/lib-harden.sh && fail "lib-harden.sh stage_tls_key must NOT strip the ssl GUCs with a position-dependent 'grep -v' — a reorder leaves a dangling comma / invalid JSON. Use the order-independent awk removal." || true
for e in entrypoint.sh entrypoint-ro.sh entrypoint-warm.sh; do
  grep -q 'stage_tls_key' "compute-files/$e" || fail "compute-files/$e must call stage_tls_key before exec compute_ctl (F5 phase 2)"
done
# INLINE-54 BYTE CONSISTENCY (not just token presence): the ConfigMap 54 ships is the copy
# that actually runs on the compute; a body drift (wrong perm/path/gate) in the inline copy
# would pass a mere grep. Extract the inline lib-harden.sh + config.json blocks, strip the
# 4-space YAML block indent, and assert BYTE-identical to the compute-files/ sources — so
# the CA gate + chmod 600 + staged path + JSON-safe strip are provably the same in both.
_il_lh=$(awk 'f && /^kind:/ {exit} f {sub(/^    /,""); print} /^  lib-harden\.sh: \|/ {f=1}' 54-compute-files.yaml)
if [ "$_il_lh" != "$(cat compute-files/lib-harden.sh)" ]; then
  fail "54-compute-files.yaml inline lib-harden.sh has DRIFTED from compute-files/lib-harden.sh — regenerate the ConfigMap (see the header comment). The inline copy is what runs; a body drift ships the wrong TLS gate."
fi
_il_cfg=$(awk 'f && /^  entrypoint-ro\.sh: \|/ {exit} f {sub(/^    /,""); print} /^  config\.json: \|/ {f=1}' 54-compute-files.yaml)
if [ "$_il_cfg" != "$(cat compute-files/config.json)" ]; then
  fail "54-compute-files.yaml inline config.json has DRIFTED from compute-files/config.json — regenerate the ConfigMap; the inline spec (incl. the 4 ssl GUCs) is what compute_ctl renders."
fi
# RUNTIME MUTATION-PROOF of the crash-loop fix + the JSON-safe strip. Source stage_tls_key,
# point its file gates at temp paths, and exercise the two failure classes the review found:
#   (A) server key PRESENT but CA ABSENT  -> must STRIP the ssl GUCs (plaintext), never leave
#       a dangling ssl_ca_file (that is the crash-loop). Reverting Fix 1 leaves ssl in -> RED.
#   (B) ssl GUCs at the TAIL of the array -> the strip must still yield VALID JSON. Reverting
#       Fix 2 to `grep -v` leaves a dangling comma -> invalid JSON -> RED.
if command -v python3 >/dev/null 2>&1; then
  _tdir=$(mktemp -d)
  ( # subshell: variable overrides do not leak into the rest of _validate.sh
    . ./compute-files/lib-harden.sh
    SERVER_KEY_DST="$_tdir/staged.key"
    # (A) key present + CA absent
    SERVER_KEY_SRC="$_tdir/tls.key"; printf 'KEY' > "$SERVER_KEY_SRC"
    SERVER_CA_SRC="$_tdir/ca.crt"   # deliberately not created (absent)
    cp compute-files/config.json "$_tdir/a.json"
    stage_tls_key "$_tdir/a.json" >/dev/null
    if grep -q '"name": "ssl' "$_tdir/a.json"; then
      echo "FAIL: stage_tls_key left ssl GUCs when the CA is absent (crash-loop: ssl=on + missing ssl_ca_file) — Fix 1 regression" >&2; exit 3
    fi
    python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$_tdir/a.json" 2>/dev/null || { echo "FAIL: CA-absent strip produced invalid JSON" >&2; exit 3; }
    # (B) ssl GUCs moved to the TAIL of settings (single-line form, as the real spec ships
    # them), both key+CA absent -> the strip must still yield VALID JSON. A `grep -v` here
    # would leave the previous element's trailing comma dangling before `]`.
    cat > "$_tdir/tail.json" <<'JSON'
{
    "spec": {
        "cluster": {
            "settings": [
                { "name": "fsync", "value": "off", "vartype": "bool" },
                { "name": "port", "value": "55433", "vartype": "integer" },
                { "name": "ssl", "value": "on", "vartype": "bool" },
                { "name": "ssl_cert_file", "value": "/etc/pggw-compute-server-tls/tls.crt", "vartype": "string" },
                { "name": "ssl_key_file", "value": "/tmp/pggw-server-tls.key", "vartype": "string" },
                { "name": "ssl_ca_file", "value": "/etc/pggw-mtls-ca/ca.crt", "vartype": "string" }
            ]
        }
    }
}
JSON
    SERVER_KEY_SRC="$_tdir/nokey"   # absent
    stage_tls_key "$_tdir/tail.json" >/dev/null
    grep -q '"name": "ssl' "$_tdir/tail.json" && { echo "FAIL: ssl GUCs not removed from tail layout" >&2; exit 3; }
    python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$_tdir/tail.json" 2>/dev/null || { echo "FAIL: tail-layout strip produced INVALID JSON — order-dependent strip (Fix 2 regression)" >&2; exit 3; }
  ) || fail "stage_tls_key runtime mutation-proof failed (see FAIL line above) — F5 phase 2 crash-loop / JSON-safe strip"
  rm -rf "$_tdir"
fi
# ca_projection_is_public_only: the pggw-mtls-ca VOLUME must project the CA's
# public cert and NOTHING else. Asserting only that `key: ca.crt` appears leaves
# the contract satisfiable by a volume that ALSO projects tls.key — the CA's
# private key, i.e. the ability to mint a trusted identity for any pod that reads
# the mount. So extract the volume block and assert BOTH halves:
#   (a) an `items:` list exists at all — a secret volume with no items projects
#       EVERY key in the Secret, tls.key included;
#   (b) it lists ca.crt and lists NO other key.
# $1 = manifest, $2 = audience (for the message).
ca_projection_is_public_only() {
  _m=$1; _who=$2
  _blk=$(awk '/^[[:space:]]*- name: pggw-mtls-ca([[:space:]]|#|$)/{f=1;print;next} f&&/^[[:space:]]*- name: /{f=0} f{print}' "$_m")
  echo "$_blk" | grep -q 'items:' || fail "$_m: the pggw-mtls-ca volume has no items: list — a secret volume without items projects EVERY key, so the CA PRIVATE KEY would be mounted into $_who pods"
  echo "$_blk" | grep -q 'key: ca.crt' || fail "$_m must project ca.crt from pggw-mtls-ca (the CA that verifies the peer cert)"
  _extra=$(echo "$_blk" | grep -o 'key: [A-Za-z0-9._-]*' | grep -v 'key: ca.crt' || true)
  [ -z "$_extra" ] || fail "$_m: the pggw-mtls-ca volume projects more than ca.crt ($_extra) — the CA PRIVATE KEY must never reach $_who pods"
}

# every compute manifest that runs Postgres mounts both phase-1 Secrets at the
# GUC paths; the CA Secret projects ONLY ca.crt (the CA private key must NOT be
# distributed to compute pods).
for m in 20-compute.yaml 25-compute-warm.yaml 26-compute-ro.yaml compute-app.template.yaml; do
  grep -q 'secretName: pggw-compute-server-tls' "$m" || fail "$m must mount the pggw-compute-server-tls Secret (server cert/key) — F5 phase 2"
  grep -q 'secretName: pggw-mtls-ca' "$m" || fail "$m must mount the pggw-mtls-ca Secret (CA) — F5 phase 2"
  grep -q "mountPath: $SRVMNT" "$m" || fail "$m must mount the server cert at $SRVMNT (matches ssl_cert_file/ssl_key_file GUC dir)"
  grep -q "mountPath: $CAMNT" "$m" || fail "$m must mount the CA at $CAMNT (matches ssl_ca_file GUC dir)"
  ca_projection_is_public_only "$m" compute
done
ok "F5 phase-2 compute serves TLS (ssl=on + cert/key/CA via GUCs matching the mounts; key staged 0600) — ADR-0003"

# ---------------------------------------------------------------------------
# 35. contract (F5 phase 3, ADR-0003): the gateway is the TLS CLIENT on the
#     backend leg. BOTH gateway manifests must carry GW_COMPUTE_TLS=true (the
#     shipped fail-closed default — a compute answering 'N' is REFUSED, never
#     downgraded), name the CA + client keypair, and MOUNT the phase-1 Secrets
#     at exactly the directories those env vars name. A path mismatch between an
#     env var and its mount = every backend dial fails closed (an outage), so the
#     paths are asserted to MATCH, the same way the phase-2 GUC↔mount parity is.
#     The CA Secret projects ca.crt ONLY — the CA private key must never reach a
#     gateway pod.
GWCA=/etc/pggw-mtls-ca
GWCLI=/etc/pggw-client-tls
for m in 10-gateway.yaml 81-apps-gateway.yaml; do
  grep -A1 'name: GW_COMPUTE_TLS' "$m" | grep -q 'value: "true"' || fail "$m must set GW_COMPUTE_TLS=\"true\" (F5 phase 3 — the gateway REQUIRES TLS to the compute; shipping anything else is a silent plaintext data path)"
  grep -A1 'name: GW_COMPUTE_CA_FILE' "$m" | grep -q "value: \"$GWCA/ca.crt\"" || fail "$m GW_COMPUTE_CA_FILE must equal the pggw-mtls-ca mount ($GWCA/ca.crt)"
  grep -A1 'name: GW_COMPUTE_CLIENT_CERT_FILE' "$m" | grep -q "value: \"$GWCLI/tls.crt\"" || fail "$m GW_COMPUTE_CLIENT_CERT_FILE must equal the client-leaf mount ($GWCLI/tls.crt)"
  grep -A1 'name: GW_COMPUTE_CLIENT_KEY_FILE' "$m" | grep -q "value: \"$GWCLI/tls.key\"" || fail "$m GW_COMPUTE_CLIENT_KEY_FILE must equal the client-leaf mount ($GWCLI/tls.key)"
  grep -q 'secretName: pggw-gateway-client-tls' "$m" || fail "$m must mount the pggw-gateway-client-tls Secret (the gateway clientAuth leaf) — F5 phase 3"
  grep -q 'secretName: pggw-mtls-ca' "$m" || fail "$m must mount the pggw-mtls-ca Secret (CA that verifies the compute server cert) — F5 phase 3"
  grep -q "mountPath: $GWCLI" "$m" || fail "$m must mount the client leaf at $GWCLI (matches GW_COMPUTE_CLIENT_CERT_FILE/KEY_FILE)"
  grep -q "mountPath: $GWCA" "$m" || fail "$m must mount the CA at $GWCA (matches GW_COMPUTE_CA_FILE)"
  ca_projection_is_public_only "$m" gateway
done
ok "F5 phase-3 gateway requires TLS on the backend leg (GW_COMPUTE_TLS=true + CA/client-leaf env matching the mounts, ca.crt-only projection) — ADR-0003"

# ---------------------------------------------------------------------------
# 36. contract (F5 phase 4, ADR-0003): the compute ENFORCES client-cert mTLS in
#     pg_hba. The phase-2 GUCs only make the compute OFFER TLS and make it ABLE to
#     verify a client cert (ssl_ca_file); ENFORCEMENT is the harden's rewrite of the
#     pg_hba NETWORK catch-all to `hostssl … scram-sha-256 clientcert=verify-ca`
#     — TLS required AND a CA-verified client certificate, with the auth-option AFTER
#     the method field (pg_hba puts options after the method; before it is a parse
#     error). Three things must NOT move with it:
#       (a) the cloud_admin reject stays BROAD `host`, so cloud_admin is refused over
#           ANY transport — narrowing it to hostssl lets a PLAINTEXT cloud_admin
#           attempt fall past the rule that names it;
#       (b) the rewrite keys on `$4=="all"` (the network catch-all), so the initdb
#           loopback lines (127.0.0.1/32, ::1/128 -> trust, listed FIRST, first-match
#           wins) are untouched and the pod's own cloud_admin@localhost:55433 admin
#           ops keep working;
#       (c) the enforcement is GATED on the compute actually serving TLS (`SHOW ssl`).
#           Postgres rejects a hostssl line when ssl is off, and ONE bad line makes the
#           whole pg_hba fail to parse — on SIGHUP the file is discarded and the old
#           config kept, so an ungated rewrite would silently throw away the #112
#           cloud_admin reject and the #117 SCRAM catch-all on any cert-less compute
#           (the phase-2 plaintext fallback). That branch must keep existing.
#       (d) the option is `clientcert=verify-ca`, NEVER `verify-full`. verify-full
#           additionally requires the client certificate's COMMON NAME to equal the
#           connecting username (absent a map=/pg_ident.conf, which this deployment does
#           not have). The gateway holds ONE shared client leaf whose CN is a service
#           name and connects as app_<app>, so verify-full would refuse EVERY
#           gateway→compute connection the moment the harden reloads pg_hba on a wake —
#           a wake-triggered per-app outage. verify-ca is the intended split: the
#           certificate proves CA-issued identity, SCRAM authenticates the user.
for f in compute-files/lib-harden.sh 54-compute-files.yaml; do
  grep -vE '^[[:space:]]*#' "$f" | grep -q 'verify-full' \
    && fail "$f: an EXECUTABLE line uses clientcert=verify-full — it ties the certificate CN to the connecting username, and the gateway's shared leaf CN is a service name while it connects as app_<app>, so every connection would be refused on a common-name mismatch. Use verify-ca — see (d) above" || true
  grep -qF "_catchall='hostssl\\tall\\tall\\tall\\tscram-sha-256\\tclientcert=verify-ca'" "$f" \
    || fail "$f: the pg_hba network catch-all must become 'hostssl all all all scram-sha-256 clientcert=verify-ca' (F5 phase 4 — TLS + a CA-verified client cert REQUIRED on the gateway→compute hop)"
  grep -qF "_catchall='host\\tall\\tall\\tall\\tscram-sha-256'" "$f" \
    || fail "$f: the not-serving-TLS fallback catch-all ('host all all all scram-sha-256') is gone — a cert-less compute would get a hostssl line, whose parse error discards the ENTIRE pg_hba reload, taking the #112 cloud_admin reject and #117 SCRAM enforcement with it"
  grep -qF 'SHOW ssl' "$f" \
    || fail "$f: the phase-4 enforcement must be gated on what the compute is ACTUALLY serving (SHOW ssl over loopback) — see (c) above"
  grep -qF 'print "host\tall\tcloud_admin\tall\treject"' "$f" \
    || fail "$f: the cloud_admin reject must stay BROAD 'host' (issue #112) — it has to reject cloud_admin over ANY transport, so it is never narrowed to hostssl"
  grep -qF 'print "hostssl\tall\tcloud_admin' "$f" \
    && fail "$f: the cloud_admin reject was narrowed to hostssl — a PLAINTEXT cloud_admin attempt would then fall past the rule that names it" || true
  grep -qF '$4=="all"' "$f" \
    || fail "$f: the pg_hba rewrite must key on \$4==\"all\" (the NETWORK catch-all) — without it the loopback lines (127.0.0.1/32, ::1/128) would be rewritten and the pod's own cloud_admin admin ops would break"
done
# RUNTIME proof of the transform, not just its source text: test_harden_pghba.sh
# EXTRACTS the awk + both catch-alls out of lib-harden.sh AND out of the inline 54
# copy, runs a representative initdb pg_hba through both modes, and asserts the
# enforced catch-all, the broad cloud_admin reject and its ordering, byte-unchanged
# loopback lines, no surviving plaintext catch-all, idempotency, and the cert-less
# fallback. Editing the awk or either catch-all in either file changes this result.
if command -v bash >/dev/null 2>&1; then
  bash ./test_harden_pghba.sh >/dev/null 2>&1 \
    || { bash ./test_harden_pghba.sh >&2; fail "test_harden_pghba.sh FAILED — the shipped pg_hba harden does not produce the enforced mTLS rules (output above)"; }
else
  echo "  (no bash on PATH — skipped the test_harden_pghba.sh runtime transform proof; the source contracts above still ran)"
fi
ok "F5 phase-4 compute ENFORCES mTLS in pg_hba (hostssl catch-all + clientcert=verify-ca + scram-sha-256, gated on SHOW ssl; cloud_admin reject stays broad host; loopback trust untouched) — ADR-0003"

# ---------------------------------------------------------------------------
# 37. contract (F5 phase 4 drill honesty, ADR-0003): _verify-tls.sh may not claim
#     "mTLS enforced" for a run that never dialled through the gateway. Its section-4
#     leg (b) — a query through pggw-apps — is the ONLY positive gateway-path
#     assertion; legs (a) (a no-client-cert dial is refused) and (c) (the loopback
#     admin path still works) pass unchanged even when the enforced rule rejects the
#     GATEWAY too, which is exactly what a CN-tying clientcert option does. So:
#       (a) when section 4 runs, leg (b) is MANDATORY — a missing app-db-<app> Secret
#           or missing pggw-apps must FAIL the drill, never print a per-leg "skipped"
#           note and carry on;
#       (b) the closing summary must report what ACTUALLY ran (the $MTLS_CLAIM the
#           section sets), never an unconditional hardcoded enforcement claim.
_vt=_verify-tls.sh
grep -q 'MTLS_CLAIM=' "$_vt" \
  || fail "$_vt must record what section 4 actually proved in \$MTLS_CLAIM and print THAT — an unconditional 'mTLS enforced' closing line reports success for a run whose gateway leg never executed"
grep -q 'wake-over-TLS passed, \$MTLS_CLAIM' "$_vt" \
  || fail "$_vt: the closing summary must interpolate \$MTLS_CLAIM instead of hardcoding the enforcement claim (a skipped section-4 would otherwise still print 'mTLS enforced')"
grep -qiE 'skipped the gateway-identity leg' "$_vt" \
  && fail "$_vt: the gateway-identity leg (b) is being SKIPPED with a note — it is the only positive gateway-path assertion in the drill and must FAIL when its prerequisites (app-db-<app> Secret, pggw-apps) are missing" || true
awk '/TLS_MTLS_APP:-/ {s=1} s && /the gateway-identity leg CANNOT run/ {n++} END{exit !(n>=2)}' "$_vt" \
  || fail "$_vt: section 4 must FAIL (not skip) on a missing app-db-<app> Secret AND on a missing pggw-apps deployment — both are prerequisites of the mandatory gateway-identity leg"
ok "F5 phase-4 drill honesty: _verify-tls.sh leg (b) is mandatory when section 4 runs, and the closing line reports what actually ran (\$MTLS_CLAIM) — ADR-0003"

# ---------------------------------------------------------------------------
# 38. contract (T1 read-before-attach, #1095): NO tenant-attach path may POST a
#     HARDCODED generation to /v1/tenant/<T>/location_config, and every attach path
#     must consult the DURABLE `pageserver-generation` ledger as the authority —
#     attach = max(ledger, pageserver-view, 1), never below the ledger.
#     Both bootstrap attach sites — the storage-init init container
#     (55-storage-init.yaml) and provision-app.sh:ensure_tenant — used to send
#     {"mode":"AttachedSingle","generation":1,...}. After a pswatcher failover the
#     tenant's generation advances (->2, ->3...), so a literal 1 is REJECTED
#     ("Generation 00000001 is less than existing N") and the path wedges
#     (storage-init CrashLoops). Reading the pageserver ALONE is not enough: a
#     fresh-PVC pageserver 404s the tenant while the object-store index is at the
#     ledger generation N, and it ACCEPTS an attach at 1 (the reject only fires when
#     it already knows a higher gen) — silently hiding the gen-N index (data loss).
#     The durable ledger (seeded/advanced by pswatcher, survives a fresh PVC) is the
#     floor. This guard fails if the literal creeps back OR if either site loses its
#     ledger read OR its pageserver read — a revert of any half reds it.
for _f in 55-storage-init.yaml provision-app.sh; do
  # Strip comment lines first (a provenance comment legitimately quotes the live
  # pageserver JSON `…,"generation":1,…`; the guard targets the ATTACH PAYLOAD, never a
  # comment), then normalise shell backslash-escaping (the literal reappears as
  # "generation":1 in the YAML single-quoted form and \"generation\":1 in the
  # provision-app.sh double-quoted -d payload) so ONE pattern catches both.
  if grep -v '^[[:space:]]*#' "$_f" | sed 's/\\//g' | grep -qE '"generation" *: *1[,}]'; then
    fail "$_f attaches at a HARDCODED generation:1 — after a pswatcher failover the pageserver has advanced past 1 and REJECTS it (#1095 wedge). Attach at max(ledger, pageserver-view, 1)."
  fi
  # Every attach site must consult the durable ledger (the authority).
  grep -q 'pageserver-generation' "$_f" \
    || fail "$_f must consult the durable pageserver-generation ledger before attaching — reading the pageserver alone loses data on a fresh-PVC pageserver (#1095)"
done
grep -q 'resolve_attach_generation' provision-app.sh \
  || fail "provision-app.sh:ensure_tenant must resolve max(ledger, pageserver-view, 1) (resolve_attach_generation) before the location_config PUT (#1095)"
grep -q 'ledger_generation' provision-app.sh \
  || fail "provision-app.sh must read the durable ledger (ledger_generation) — never attach below it (#1095)"
grep -qF 'curl -sf "${PS}/v1/tenant/${TENANT_ID}"' 55-storage-init.yaml \
  || fail "55-storage-init.yaml must GET /v1/tenant/<T> for the pageserver's current view (#1095)"
grep -qF '/ledger/generation' 55-storage-init.yaml \
  || fail "55-storage-init.yaml must read the mounted durable ledger (/ledger/generation) — the authority that survives a fresh-PVC pageserver (#1095)"
# Guard gap (#1095 review): pin the volumeMount that projects the ledger into the pod.
# Deleting ONLY the mount (keeping the volume, so the pageserver-generation grep above
# still hits) would leave /ledger empty and the attach flooring at 1 — mutation-proved.
grep -qF 'mountPath: /ledger' 55-storage-init.yaml \
  || fail "55-storage-init.yaml must MOUNT the pageserver-generation ledger at /ledger — without the volumeMount the init reads an empty /ledger and attaches at 1 (#1095)"
grep -qF 'generation\":${GEN}' 55-storage-init.yaml \
  || fail "55-storage-init.yaml must attach at the resolved generation \${GEN}, not a literal (#1095)"
# Fail-closed pins (#1095 review): neither attach site may silently floor to 1 on an
# unreadable ledger — provision-app REFUSES (die) and storage-init REFUSES (exit 1).
grep -q 'refusing to attach' provision-app.sh \
  || fail "provision-app.sh:ensure_tenant must FAIL CLOSED (die) when the ledger is unreadable — never silently floor to 1 (#1095)"
grep -q 'REFUSING to attach' 55-storage-init.yaml \
  || fail "55-storage-init.yaml must FAIL CLOSED (exit 1) when the ledger is missing/non-numeric — never silently floor to 1 (#1095)"
# Response/CM-shape pins: the field/key name the logic depends on. If the pageserver
# JSON field or the ledger CM key is renamed, every attach silently degrades to the
# floor and the wedge returns green — so pin BOTH names, cross-file.
grep -q 'genKeyDefault = "generation"' ../gateway/internal/pswatcher/k8s.go \
  || fail "pswatcher ledger key drifted from \"generation\" — the attach paths read data.generation / /ledger/generation; a rename silently degrades every attach (#1095)"
grep -qE 'name: pageserver-generation' 57-pageserver-standby.yaml \
  || fail "57-pageserver-standby.yaml must ship the pageserver-generation ledger ConfigMap (#1095)"
# APPLY-SAFETY (#1095 review): the ledger CM must NOT declare a numeric `generation`
# value. A declared key is reconciled back to its manifest value on every kubectl apply
# (proven on kind: live 5 -> apply -> 1) and a reset "1" is byte-identical to a genesis
# "1", so the fail-closed readers cannot tell it apart and silently attach low. The key
# is seeded CREATE-IF-ABSENT by deploy/seed-ledger.sh instead. So: 57 must ship data:{}
# (empty), and there must be NO declared generation value on the ledger CM.
if grep -A5 'name: pageserver-generation' 57-pageserver-standby.yaml | grep -qE 'generation: *"?[0-9]'; then
  fail "57-pageserver-standby.yaml DECLARES a numeric pageserver-generation value — kubectl apply would RESET a pswatcher-advanced ledger back to it (silent floor-to-1, #1095). Ship data: {} and seed create-if-absent via deploy/seed-ledger.sh."
fi
# The create-if-absent seed must exist, never overwrite a live value, and be WIRED into
# the deploy path (else a fresh plane's ledger key is never seeded and storage-init
# fail-closes forever).
test -f seed-ledger.sh \
  || fail "deploy/seed-ledger.sh (create-if-absent ledger seed) is missing — the undeclared generation key would never be seeded (#1095)"
grep -q 'ledger_seed_action' seed-ledger.sh \
  || fail "seed-ledger.sh must decide create-if-absent via ledger_seed_action (seed|keep|refuse) — never blindly overwrite the ledger (#1095)"
grep -qF 'bash deploy/seed-ledger.sh' ../Makefile \
  || fail "the Makefile deploy target must run deploy/seed-ledger.sh after apply — otherwise a fresh plane's ledger is never seeded and storage-init fail-closes (#1095)"
# It MUST be invoked with `bash`, not `sh`: seed-ledger.sh uses `set -o pipefail`
# (bash-only), so under dash (/bin/sh on Debian/Ubuntu) `sh deploy/seed-ledger.sh`
# aborts with "Illegal option -o pipefail" — the seed silently never runs. The word
# boundary [^a-z] before `sh` avoids matching the `sh` inside `bash`.
if grep -qE '(^|[^a-z])sh +deploy/seed-ledger\.sh' ../Makefile; then
  fail "the Makefile invokes deploy/seed-ledger.sh with bare 'sh' — it uses bash-only 'set -o pipefail' and aborts under dash, so the ledger is never seeded (#1095). Use 'bash deploy/seed-ledger.sh'."
fi
ok "T1 read-before-attach: no literal generation:1; both attach sites read the durable ledger + pageserver view (max, never below the ledger), FAIL CLOSED on an unreadable ledger; ledger mounted at /ledger; field/key names pinned; ledger key UNDECLARED (apply-safe) + create-if-absent seed wired (#1095)"

# Runtime proof of the create-if-absent seed (never overwrites/lowers a live value).
if command -v bash >/dev/null 2>&1; then
  if bash ./test_seed-ledger.sh >/dev/null 2>&1; then
    ok "T1 seed-ledger create-if-absent proof: seeds only when absent, keeps a live value, refuses non-numeric (#1095)"
  else
    bash ./test_seed-ledger.sh >&2
    fail "test_seed-ledger.sh FAILED — the create-if-absent seed does not preserve a live ledger value (output above)"
  fi
fi

# Runtime proof of the read-before-attach logic (mirrors the harden_pghba pattern):
# SOURCE provision-app.sh + EXTRACT the storage-init inline lines and exercise both
# against fixture ledger/pageserver values, so a broken transform is caught here, not
# only on-cluster. The ok() is INSIDE the ran-branch — on a bash-less host the else
# prints a skip note and NO green proof (a proof that never ran must not read as ok).
if command -v bash >/dev/null 2>&1; then
  if bash ./test_ensure-tenant-gen.sh >/dev/null 2>&1; then
    ok "T1 read-before-attach runtime proof: attaches at max(ledger, pageserver-view, 1) — honours a ledger of 3 over a fresh-PVC pageserver (never 1), for both the provision-app and storage-init copies (#1095)"
  else
    bash ./test_ensure-tenant-gen.sh >&2
    fail "test_ensure-tenant-gen.sh FAILED — the shipped read-before-attach logic does not honour the durable ledger (output above)"
  fi
else
  echo "  (no bash on PATH — skipped the test_ensure-tenant-gen.sh runtime proof; the source contracts above still ran)"
fi

# ---------------------------------------------------------------------------
# Summary (#797): every contract above has been EVALUATED — nothing exits early.
# One aggregated report, one CI-faithful exit code: 0 only if every contract
# passed, 1 if any failed (the EXIT trap catches anything that dies before here).
COMPLETED=1
if [ "$FAILURES" -gt 0 ]; then
  echo "" >&2
  echo "deploy validation: $FAILURES FAILURE(S):$FAIL_LIST" >&2
  exit 1
fi
echo "deploy validation: all checks passed"
