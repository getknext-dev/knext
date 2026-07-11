#!/bin/sh
# Live-spec-vs-manifest drift check (issue #13: "grep-green, prod-red").
# Two guards, both against the LIVE cluster:
#   A. every running pod declares the ephemeral-storage request the manifests
#      promise — catches applied-but-not-rolled / never-applied field drift.
#   B. PRESENCE + READINESS (issues #27/#51): every Deployment/StatefulSet/CronJob
#      declared in a deploy/NN-*.yaml manifest EXISTS on the cluster (closes the
#      merged≠deployed class — the grep-green/prod-red recurrence) AND is HEALTHY,
#      not merely present. Existence-only was blind to a deployed-yet-0-ready /
#      CrashLoopBackOff workload (e.g. a crash-looping kube-state-metrics would pass
#      "exists" while blinding 5+ platform alerts — #48/#51). So we also assert
#      readyReplicas==spec.replicas for Deployments/StatefulSets (this correctly
#      accepts the scale-to-zero compute: 0 ready == 0 desired) and that CronJobs are
#      NOT suspended.
set -eu
cd "$(dirname "$0")"
NS=scale-zero-pg

# ---- args / env (issues #157, #162) --------------------------------------
# --context <ctx> / DRIFT_CONTEXT : run against an EXPLICIT kube-context (CI).
#                                   Default: kubectl's current-context (interactive) —
#                                   but §0 below ASSERTS its identity either way.
# EXPECTED_CLUSTER <ctx-name>     : if set, current-context MUST equal it (CI hard-pin).
# --deep / DRIFT_DEEP=1           : also run §G, the per-app DURABLE-SCRAM sample
#                                   (needs a compute WAKE — opt-in, off by default).
DRIFT_CONTEXT="${DRIFT_CONTEXT:-}"
EXPECTED_CLUSTER="${EXPECTED_CLUSTER:-}"
DEEP="${DRIFT_DEEP:-0}"
while [ $# -gt 0 ]; do
  case "$1" in
    --context) DRIFT_CONTEXT="${2:?--context needs a value}"; shift 2;;
    --context=*) DRIFT_CONTEXT="${1#*=}"; shift;;
    --deep) DEEP=1; shift;;
    -h|--help) echo "usage: _verify-drift.sh [--context <kube-context>] [--deep]"; exit 0;;
    *) echo "FAIL: unknown arg: $1" >&2; exit 1;;
  esac
done
CTX=""
[ -n "$DRIFT_CONTEXT" ] && CTX="--context $DRIFT_CONTEXT"
K="kubectl $CTX --request-timeout=15s -n $NS"
KC="kubectl $CTX --request-timeout=15s"   # cluster-scoped (nodes, crds, current-context)
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

# 0. TARGET-CLUSTER IDENTITY GUARD (issue #157). The whole drift gate is only meaningful
# against the OKE plane. This tool historically ran against kubectl's CURRENT-context with
# NO identity assertion — and on operator machines a kubectl wrapper self-RESETS the
# current-context to local orbstack. Net effect: the gate could run fully GREEN against the
# WRONG cluster (orbstack/kind) while the real OKE plane drifted — a META merged≠deployed:
# the gate itself silently checking the wrong target (the #157 false-green). So BEFORE any
# check, prove we point at OKE and FAIL LOUD otherwise. An explicit --context /
# EXPECTED_CLUSTER pins the target for CI; interactively we assert whatever current-context
# resolves to.
# Read the EFFECTIVE (explicit-or-ambient) context — the SAME source the fingerprint
# check below honors. `kubectl config current-context` IGNORES --context (it always
# reports the raw AMBIENT context), so on a machine whose ambient self-reset to orbstack,
# CI passing --context <oke> must NOT hit the orbstack fast-reject and false-RED — that
# would defeat the very #157 explicit-context remedy this error message advertises
# (PR #180 code-review, BLOCKING). When --context/DRIFT_CONTEXT is set it IS the target;
# otherwise fall back to the ambient current-context (interactive).
CURCTX="${DRIFT_CONTEXT:-$($KC config current-context 2>/dev/null || echo '<none>')}"
# fast, obvious reject: a well-known LOCAL/dev context is never the OKE plane.
case "$CURCTX" in
  orbstack|docker-desktop|minikube|kind-*|k3d-*|colima*|rancher-desktop)
    fail "WRONG CLUSTER: kube-context '$CURCTX' is a LOCAL/dev cluster, not the OKE plane. The drift gate must target OKE (e.g. context-ckmva7v7zvq). Run 'kubectl config use-context context-ckmva7v7zvq' or pass --context — refusing to FALSE-GREEN against '$CURCTX' (issue #157).";;
esac
# CI hard-pin: if EXPECTED_CLUSTER is set, current-context MUST equal it.
if [ -n "$EXPECTED_CLUSTER" ] && [ "$CURCTX" != "$EXPECTED_CLUSTER" ]; then
  fail "WRONG CLUSTER: kube-context '$CURCTX' != EXPECTED_CLUSTER '$EXPECTED_CLUSTER' (issue #157)."
fi
# positive OKE fingerprint (the real guard — survives a renamed / self-reset context): an
# OKE cluster carries the OCI node-management CRD and the known OKE nodes; a silently
# retargeted orbstack/kind matches NEITHER. Retry a few times so a flaky API TLS timeout
# fails LOUD-but-retried, never silently skips the identity assertion.
OKE_CRD=nodeoperationrules.oci.oraclecloud.com
OKE_NODES="10.0.1.253 10.0.1.78"
fp_ok() {
  $KC get crd "$OKE_CRD" >/dev/null 2>&1 && { echo "OCI CRD $OKE_CRD"; return 0; }
  for n in $OKE_NODES; do
    $KC get node "$n" >/dev/null 2>&1 && { echo "OKE node $n"; return 0; }
  done
  return 1
}
FP=""; i=0
while [ $i -lt 3 ]; do FP="$(fp_ok)" && break; i=$((i+1)); sleep 2; done
[ -n "$FP" ] || fail "WRONG/UNVERIFIED CLUSTER: kube-context '$CURCTX' exposes NO OKE fingerprint (missing OCI CRD $OKE_CRD AND known OKE nodes $OKE_NODES). The kubectl wrapper self-resets to orbstack — refusing to run the drift gate against an unverified target and FALSE-GREEN (issue #157). Set the OKE current-context, pass --context, or set EXPECTED_CLUSTER for CI."
ok "target cluster identity: OKE fingerprint present ($FP), context '$CURCTX' (issue #157)"

# A. field drift: running pods must carry the ephemeral-storage request.
BAD=$($K get pods --field-selector=status.phase=Running -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.containers[0].resources.requests.ephemeral-storage}{"\n"}{end}' | awk '$2=="" {print $1}' | grep -v '^pgclient\|^metric-\|^verify-\|^wmetric-\|^alertq-\|^alert-drill-' || true)
[ -z "$BAD" ] || fail "pods running WITHOUT ephemeral-storage request: $BAD"
ok "live pods match the manifest ephemeral-storage contract"

# B. presence: parse every numbered manifest for its workload kinds+names, then
# assert each exists live. python3 splits multi-doc YAML and reads metadata.name
# for the three long-running workload kinds (Jobs are one-shot; Secrets/CMs/SVCs
# are covered by check A's pods or are not "load-bearing machinery").
DECLARED=$(python3 - <<'PY'
import glob, re, sys
want = {"Deployment", "StatefulSet", "CronJob"}
out = []
for path in sorted(glob.glob("[0-9][0-9]-*.yaml")):
    with open(path) as fh:
        text = fh.read()
    for doc in re.split(r'(?m)^---\s*$', text):
        kind = None
        for line in doc.splitlines():
            m = re.match(r'^kind:\s*(\S+)', line)
            if m:
                kind = m.group(1)
                break
        if kind not in want:
            continue
        # first metadata.name at 2-space indent (the object's own name).
        name = None
        in_meta = False
        for line in doc.splitlines():
            if re.match(r'^metadata:\s*$', line):
                in_meta = True
                continue
            if in_meta:
                m = re.match(r'^  name:\s*(\S+)', line)
                if m:
                    name = m.group(1)
                    break
                if re.match(r'^\S', line):  # left metadata block
                    in_meta = False
        if name:
            out.append(f"{kind} {name} {path}")
print("\n".join(out))
PY
)
[ -n "$DECLARED" ] || fail "presence parser found no Deployment/StatefulSet/CronJob in deploy/ — parser broken?"

MISSING=""
echo "$DECLARED" | while IFS=' ' read -r kind name src; do
  [ -n "$kind" ] || continue
  if ! $K get "$kind" "$name" >/dev/null 2>&1; then
    echo "  MISSING: $kind/$name (declared in deploy/$src)"
    continue
  fi
  # readiness (issue #51): exists is not healthy.
  case "$kind" in
    Deployment|StatefulSet)
      spec=$($K get "$kind" "$name" -o jsonpath='{.spec.replicas}' 2>/dev/null); spec=${spec:-0}
      ready=$($K get "$kind" "$name" -o jsonpath='{.status.readyReplicas}' 2>/dev/null); ready=${ready:-0}
      if [ "$ready" != "$spec" ]; then
        echo "  NOTREADY: $kind/$name readyReplicas=$ready want=$spec (declared in deploy/$src)"
      fi
      ;;
    CronJob)
      susp=$($K get cronjob "$name" -o jsonpath='{.spec.suspend}' 2>/dev/null)
      if [ "$susp" = "true" ]; then
        echo "  SUSPENDED: CronJob/$name (declared in deploy/$src)"
      fi
      ;;
  esac
done > /tmp/drift-missing-$$.txt
MISSING=$(cat /tmp/drift-missing-$$.txt)
rm -f /tmp/drift-missing-$$.txt
if [ -n "$MISSING" ]; then
  echo "$MISSING" >&2
  fail "declared workloads are absent, not-ready, or suspended (merged≠deployed / deployed≠healthy) — see above"
fi
COUNT=$(echo "$DECLARED" | grep -c . || true)
ok "all $COUNT declared Deployments/StatefulSets/CronJobs exist live AND are ready/not-suspended (presence+readiness, issues #27/#51)"

# C. DIGEST provenance (issue #56): presence+readiness prove a pod is UP, not that
# it runs the code we merged. A mutable tag (v0.5.0) can point at a rebuilt binary
# that was never rolled, or a rolled pod can still run a superseded layer behind a
# matching tag. So assert every OUR-OCIR (ks-pg/*) container is running a digest the
# manifests pin (tag@sha256:...) — matched against EITHER the pulled reference in
# .status.image OR the imageID (issue #153: OCI-index images report imageID as the
# child CONFIG digest, which never equals the pinned index/manifest digest, so an
# imageID-only check false-fired on the appdb-operator even though it ran exactly the
# pinned image). This closes the merged≠deployed hiding spot the tag-based check was
# blind to, without false-firing on index-pushed images.
WANT_DIGESTS=$(grep -rhoE 'me-abudhabi-1\.ocir\.io/[^[:space:]"#]+@sha256:[0-9a-f]{64}' [0-9][0-9]-*.yaml | grep -oE 'sha256:[0-9a-f]{64}' | sort -u)
[ -n "$WANT_DIGESTS" ] || fail "no digest-pinned OCIR images in deploy/ — manifests must pin tag@sha256 (issue #56; see _validate.sh contract 22)"
$K get pods -o jsonpath='{range .items[*]}{range .status.containerStatuses[*]}{.image}{" "}{.imageID}{"\n"}{end}{end}' \
  | grep 'ocir\.io/.*/ks-pg/' > /tmp/drift-imgs-$$.txt 2>/dev/null || true
while read -r img imgid; do
  [ -n "$img" ] || continue
  # imageID is the digest the kubelet recorded for the RUNNING content. For a normal
  # single-manifest image that equals the manifest digest the manifests pin. BUT an image
  # pushed as an OCI *index* (docker buildx default attestations/provenance) makes imageID
  # the SELECTED CHILD's CONFIG digest — which never equals the index/manifest digest — so
  # imageID-alone false-fires on a pod that is running EXACTLY the pinned reference (the
  # appdb-operator case, #153: manifest pins @sha256:8a7a1..., imageID is the child config
  # @sha256:24f22...). The reference the kubelet actually resolved and pulled is carried
  # digest-and-all in .status.image (`img` here) for a digest-pinned spec — and contract 22
  # guarantees every ks-pg manifest IS digest-pinned. So accept a container whose EITHER
  # .status.image digest OR imageID digest is a manifest-pinned digest. A genuinely drifted
  # pod (bare tag / unpinned content) matches NEITHER and still trips DIGESTDRIFT.
  dimg=$(printf '%s' "$img"   | grep -oE 'sha256:[0-9a-f]{64}' | head -1)
  did=$(printf '%s' "$imgid" | grep -oE 'sha256:[0-9a-f]{64}' | head -1)
  if [ -z "$dimg" ] && [ -z "$did" ]; then
    echo "  NODIGEST: running $img exposes no resolvable digest (.status.image=none imageID=none)"
  elif { [ -n "$dimg" ] && printf '%s\n' "$WANT_DIGESTS" | grep -q "$dimg"; } \
    || { [ -n "$did" ]  && printf '%s\n' "$WANT_DIGESTS" | grep -q "$did"; }; then
    : # running content matches a manifest-pinned digest (via the pulled reference OR the imageID)
  else
    echo "  DIGESTDRIFT: running $img (image-digest ${dimg:-none} / imageID ${did:-none}) matches NO manifest-pinned digest"
  fi
done < /tmp/drift-imgs-$$.txt > /tmp/drift-digest-$$.txt
rm -f /tmp/drift-imgs-$$.txt
DIGDRIFT=$(cat /tmp/drift-digest-$$.txt); rm -f /tmp/drift-digest-$$.txt
if [ -n "$DIGDRIFT" ]; then
  echo "$DIGDRIFT" >&2
  fail "live OCIR image digest(s) diverge from the manifests (merged≠deployed behind a matching tag) — see above (issue #56)"
fi
ok "every running OCIR (ks-pg) container matches a manifest-pinned digest (provenance, issue #56)"

# D. ZONE AXIS LIVE-PRESENCE (issue #151). The generic presence check (B) already
# asserts the zone-operator DEPLOYMENT exists+ready (it is one of the parsed
# Deployments), but the CRD it reconciles is a CustomResourceDefinition — NOT in B's
# {Deployment,StatefulSet,CronJob} set — so a live cluster missing the `zones` CRD (a
# user cannot create a Zone) would pass B silently. This is exactly the convergent
# v1.3.0 finding: the flagship shipped drill-only (_verify-zones.sh applied 86/87 then
# tore them down on exit). Assert BOTH halves explicitly so 'merged ≠ deployed / drill-
# only-again' cannot recur: (1) the zones CRD is installed and serves v1alpha1;
# (2) the zone-operator Deployment is present AND ready 1/1 (a sustained deploy, not a
# throwaway drill). Named-explicit, so the failure message points straight at #151.
ZCRD=zones.zones.scale-zero-pg.dev
if ! $K get crd "$ZCRD" >/dev/null 2>&1; then
  fail "the Zone CRD ($ZCRD) is NOT installed on the live cluster — a user cannot create a Zone; the flagship (ADR-0007 v2-2) is drill-only. Apply deploy/86-zone-crd.yaml as part of the STANDARD deploy (issue #151)."
fi
ok "Zone CRD ($ZCRD) is installed on the live cluster (not drill-only, issue #151)"
ZREADY=$($K get deploy zone-operator -o jsonpath='{.status.readyReplicas}' 2>/dev/null); ZREADY=${ZREADY:-0}
ZSPEC=$($K get deploy zone-operator -o jsonpath='{.spec.replicas}' 2>/dev/null); ZSPEC=${ZSPEC:-0}
if ! $K get deploy zone-operator >/dev/null 2>&1; then
  fail "the zone-operator Deployment is NOT present on the live cluster — Zone CRs would never reconcile. Apply deploy/87-zone-operator.yaml as part of the STANDARD deploy (issue #151)."
fi
[ "$ZREADY" = "$ZSPEC" ] && [ "$ZSPEC" -ge 1 ] 2>/dev/null \
  || fail "the zone-operator Deployment is present but not ready (readyReplicas=$ZREADY want=$ZSPEC) — the reconciler is not a sustained healthy deploy (issue #151)."
ok "zone-operator Deployment is live and ready $ZREADY/$ZSPEC (sustained, not a throwaway drill, issue #151)"

# E. RULES-LOADED (issue #155). Sections A–D prove workloads/images are deployed, but a
# Prometheus ALERT RULE is a merged≠deployed case they are blind to: a rule can be merged
# into deploy/60, applied to the prometheus-config ConfigMap, and even present on the pod's
# mounted rules.yml, yet NOT LOADED by the running Prometheus — ConfigMap volume updates do
# NOT trigger a reload, so without a pod roll or a POST /-/reload the rule stays DARK (the
# 2026-07-06 zone-alerts miss: JanitorConfigDisarmed/ZoneDegradedOrFailed applied but
# unloaded). deploy/60 now carries a config-hash pod annotation so an apply auto-rolls the
# pod (_validate contract 27), and this gate independently proves the END STATE: every alert
# rule SHIPPED in the manifest is LOADED in the live Prometheus (/api/v1/rules). A
# shipped-but-unloaded rule is RED — the exact "applied yet dark" hole.
SHIPPED_ALERTS=$(grep -oE '^[[:space:]]*- alert:[[:space:]]+[A-Za-z0-9_]+' 60-prometheus.yaml | awk '{print $NF}' | sort -u)
[ -n "$SHIPPED_ALERTS" ] || fail "no alert rules parsed from 60-prometheus.yaml — parser broken? (issue #155)"
LOADED=$($K exec deploy/prometheus -- wget -qO- 'http://localhost:9090/api/v1/rules' 2>/dev/null \
  | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(0)
print("\n".join(sorted({r["name"] for g in d["data"]["groups"] for r in g["rules"] if r.get("type")=="alerting"})))')
[ -n "$LOADED" ] || fail "could not read loaded alert rules from the running Prometheus (/api/v1/rules empty or unreachable) — is deploy/prometheus up? (issue #155)"
UNLOADED=""
for a in $SHIPPED_ALERTS; do
  printf '%s\n' "$LOADED" | grep -qx "$a" || UNLOADED="$UNLOADED $a"
done
if [ -n "$UNLOADED" ]; then
  echo "  RULEUNLOADED:$UNLOADED" >&2
  fail "alert rule(s) shipped in deploy/60 are NOT loaded in the running Prometheus (merged≠loaded — a ConfigMap rule change was applied but the pod never reloaded/rolled). Re-apply deploy/60-prometheus.yaml (the config-hash annotation now rolls the pod) or POST /-/reload — see above (issue #155)"
fi
NRULES=$(printf '%s\n' "$SHIPPED_ALERTS" | grep -c .)
ok "all $NRULES alert rules shipped in deploy/60 are LOADED in the running Prometheus (merged==loaded, issue #155)"

# F. COMPUTE-FILES SCRAM CONTENT (issue #160). The md5→SCRAM migration (#117) lives in
# the SHARED compute-files ConfigMap: config.json's password_encryption AND the compute
# entrypoint's pg_hba `md5`→`scram-sha-256` catch-all rewrite + the APP_ROLE_VERIFIER
# spec-role injection. That ConfigMap only takes effect on the NEXT per-app compute boot,
# so an "applied the new image/operator but never re-applied deploy/54" (or never-applied)
# cluster is a merged≠deployed hole A–E are blind to: no workload/image-digest change, yet
# a cold-waking per-app compute would enforce the OLD `md5` pg_hba and silently lose SCRAM
# on the wire (or, worse, mid-rollout, meet a scram pg_hba with an unmigrated md5 verifier
# — the #160 cold-wake-outage hazard). Assert the LIVE compute-files carries the SCRAM
# migration verbatim so "the entrypoint was never rolled to SCRAM" is RED.
# NOTE (convergent fix, issue #162 lane): the pg_hba `md5`→`scram-sha-256` catch-all
# rewrite (`harden_pg_hba`) was FACTORED OUT of entrypoint.sh into the SOURCED lib-harden.sh
# by the #164/#167 RO/warm-parity refactor — AFTER §F shipped (#160). §F still only read
# config.json+entrypoint.sh, so it FALSE-FIRED `pg_hba-catch-all-not-scram` on a live cluster
# that is actually correct (the rewrite simply moved keys). Read lib-harden.sh too so §F
# tracks where the rewrite LIVES, restoring the guarantee without weakening it.
CF=$($K get configmap compute-files -o jsonpath='{.data.config\.json}{"\n===ENTRYPOINT===\n"}{.data.entrypoint\.sh}{"\n===LIBHARDEN===\n"}{.data.lib-harden\.sh}' 2>/dev/null || true)
[ -n "$CF" ] || fail "compute-files ConfigMap absent or unreadable on the live cluster (issue #160)"
CFERR=""
printf '%s' "$CF" | grep -A2 '"password_encryption"' | grep -q 'scram-sha-256' \
  || CFERR="$CFERR password_encryption!=scram-sha-256"
printf '%s' "$CF" | grep -qE 'host.+all.+all.+all.+scram-sha-256' \
  || CFERR="$CFERR pg_hba-catch-all-not-scram"
printf '%s' "$CF" | grep -q 'APP_ROLE_VERIFIER' \
  || CFERR="$CFERR no-APP_ROLE_VERIFIER-injection"
if [ -n "$CFERR" ]; then
  echo "  COMPUTEFILESDRIFT:$CFERR" >&2
  fail "live compute-files ConfigMap is NOT the SCRAM (#117) manifest — drift:$CFERR. Re-apply deploy/54-compute-files.yaml (the scram entrypoint only takes effect on the NEXT per-app compute boot; existing md5-era apps must be SCRAM-verifier-durable FIRST) — see issue #160."
fi
ok "live compute-files carries the SCRAM migration (password_encryption + pg_hba scram rewrite + APP_ROLE_VERIFIER injection) — merged==deployed (issue #160)"

# G. PER-APP DURABLE SCRAM VERIFIER SAMPLE (issue #162; OPT-IN via --deep / DRIFT_DEEP=1).
# §F proves the SHARED compute-files ConfigMap is the SCRAM manifest, but it CANNOT prove a
# given md5-era app's DURABLE catalog verifier (pg_authid.rolpassword) is actually SCRAM: a
# SCRAM verifier cannot be re-derived from a manifest without the app's plaintext, so it can
# only be READ off a LIVE compute. That leaves a hole §F is blind to — a HALF-MIGRATED app
# (SCRAM pg_hba live via §F/#160, but its own durable verifier still md5) which cold-wake
# REJECTS on the wire (the #160 atomic-rollout hazard: scram pg_hba vs md5 verifier = self-
# inflicted outage). This check wakes a BOUNDED SAMPLE of per-app computes and asserts each
# app role's pg_authid.rolpassword begins 'SCRAM-SHA-256' (not md5), catching a half-migrated
# app BEFORE a visitor's cold wake does. It needs a compute WAKE, so it is OPT-IN and bounded
# (default 2 apps; DRIFT_SAMPLE overrides). The reserved template (compute-tmpl / app_tmpl —
# not a tenant) is excluded, and every woken compute is RESTORED to its prior replica count.
if [ "$DEEP" = "1" ]; then
  SAMPLE_N="${DRIFT_SAMPLE:-2}"
  # per-app computes carry tier=apps,plane=compute and are named compute-<app>; drop the
  # reserved template (compute-tmpl / app_tmpl).
  APPS=$($K get deploy -l tier=apps,plane=compute -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null \
        | sed -n 's/^compute-//p' | grep -v '^tmpl$' | sort | head -n "$SAMPLE_N")
  if [ -z "$APPS" ]; then
    ok "no per-app computes on the cluster to sample — §G vacuously passes (issue #162)"
  else
    # read_pref <app> <role>: print the durable verifier prefix; exit 0 on a clean read,
    # non-zero on a TRANSIENT read error (psql/exec failed). Retries a few times because a
    # compute can report Ready before compute_ctl finishes accepting loopback psql. This
    # separation is why a transient/connection failure is NOT mislabelled as an md5 verifier.
    read_pref() {
      _out=""; _rc=1; _i=0
      while [ $_i -lt 3 ]; do
        if _out=$($K exec "deploy/compute-$1" -c compute -- \
              psql -h localhost -p 55433 -U cloud_admin -d postgres -tAw \
              -c "select left(rolpassword,13) from pg_authid where rolname='$2'" 2>/dev/null); then
          _rc=0; break
        fi
        _i=$((_i+1)); sleep 3
      done
      printf '%s' "$_out" | tr -d '[:space:]'
      return $_rc
    }
    SCRAMERR=""    # CONFIRMED durable drift (md5 / missing verifier row)
    TRANSERR=""    # transient read/connect error — NOT a confirmed md5 (re-run)
    RESTOREERR=""  # a woken sample compute we FAILED to scale back (leaked, burns budget)
    for app in $APPS; do
      role=$($K get configmap "compute-config-$app" -o jsonpath='{.data.APP_ROLE}' 2>/dev/null)
      role="${role:-app_$app}"
      # remember prior replicas so an at-rest (0) app is returned to 0 afterward.
      pr=$($K get deploy "compute-$app" -o jsonpath='{.spec.replicas}' 2>/dev/null); pr=${pr:-0}
      woke=0
      if [ "$pr" = "0" ]; then
        $K scale deploy "compute-$app" --replicas=1 >/dev/null 2>&1 || true
        woke=1
      fi
      if ! $K rollout status deploy "compute-$app" --timeout=150s >/dev/null 2>&1; then
        # could not wake the sampled compute — a transient/infra condition, not a verifier
        # verdict (we never read the catalog). Restore, and surface it as transient.
        TRANSERR="$TRANSERR $app(wake-failed)"
        if [ "$woke" = "1" ]; then
          $K scale deploy "compute-$app" --replicas="$pr" >/dev/null 2>&1 || RESTOREERR="$RESTOREERR compute-$app(->$pr)"
        fi
        continue
      fi
      # read the DURABLE verifier prefix over the pod-LOCAL LOOPBACK as cloud_admin
      # (loopback-trust; TCP cloud_admin is rejected since #112). pg_authid needs superuser;
      # 'SCRAM-SHA-256' is 13 chars, an md5 verifier begins 'md5'.
      if pref=$(read_pref "$app" "$role"); then
        case "$pref" in
          SCRAM-SHA-256) ok "app '$app' role '$role' durable verifier is SCRAM-SHA-256 (issue #162)";;
          "")            SCRAMERR="$SCRAMERR $app($role:no-verifier-row)";;
          md5*)          SCRAMERR="$SCRAMERR $app($role:$pref)";;
          *)             SCRAMERR="$SCRAMERR $app($role:unexpected[$pref])";;
        esac
      else
        # exec/psql itself failed after retries — a connection/transient error, NOT proof
        # the verifier is md5. Bucket separately so it never reads as a false PERAPPSCRAMDRIFT.
        TRANSERR="$TRANSERR $app($role:verifier-read-error)"
      fi
      # restore prior replica count (an at-rest app returns to 0); a FAILED restore is a
      # leaked awake compute — surface it loud, do NOT swallow it.
      if [ "$woke" = "1" ]; then
        $K scale deploy "compute-$app" --replicas="$pr" >/dev/null 2>&1 || RESTOREERR="$RESTOREERR compute-$app(->$pr)"
      fi
    done
    if [ -n "$SCRAMERR$TRANSERR$RESTOREERR" ]; then
      [ -n "$SCRAMERR" ]   && echo "  PERAPPSCRAMDRIFT:$SCRAMERR" >&2 || true
      [ -n "$TRANSERR" ]   && echo "  VERIFIER-READ-TRANSIENT (NOT a confirmed md5 — re-run):$TRANSERR" >&2 || true
      [ -n "$RESTOREERR" ] && echo "  RESTOREFAILED (leaked AWAKE compute — scale it to 0):$RESTOREERR" >&2 || true
      if [ -n "$SCRAMERR" ]; then
        fail "per-app DURABLE SCRAM verifier drift (a half-migrated app cold-wake-REJECTS vs the scram pg_hba, #160):$SCRAMERR. Mint a SCRAM verifier + re-render each flagged app BEFORE the scram pg_hba is enforced — see operations.md 'Migrating an existing app to SCRAM' (issue #162). (Also review any TRANSIENT / RESTORE lines above.)"
      elif [ -n "$RESTOREERR" ]; then
        fail "§G left a sampled compute AWAKE — failed to restore replicas:$RESTOREERR. A leaked compute burns budget (#116); scale it to 0. No SCRAM drift was detected (issue #162)."
      else
        fail "§G could NOT read the durable verifier — TRANSIENT/connection error, NOT a confirmed md5:$TRANSERR. The compute may still be booting or the API flaked; re-run '_verify-drift.sh --deep' (issue #162)."
      fi
    fi
    ok "sampled per-app durable SCRAM verifiers (≤$SAMPLE_N apps): all begin SCRAM-SHA-256 (no half-migrated app, issue #162)"
  fi
else
  ok "per-app durable SCRAM verifier sample SKIPPED — needs a compute wake; run '_verify-drift.sh --deep' (or DRIFT_DEEP=1) to enable (issue #162)"
fi

if [ "$DEEP" = "1" ]; then DSUM=" AND sampled per-app durable SCRAM verifiers are SCRAM-SHA-256 (issue #162)"; else DSUM=""; fi
echo "drift verification: TARGET CLUSTER identity asserted (OKE, not orbstack/kind — issue #157) AND live pods match the manifest contract AND every declared workload is deployed and healthy AND runs the pinned image digest AND the zone axis (CRD + operator) is live-present AND every shipped Prometheus alert rule is loaded AND the compute-files SCRAM migration is live${DSUM} (issues #151/#155/#157/#160/#162)"
