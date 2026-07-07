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
K="kubectl --request-timeout=15s -n $NS"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

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

echo "drift verification: live pods match the manifest contract AND every declared workload is deployed and healthy AND runs the pinned image digest AND the zone axis (CRD + operator) is live-present AND every shipped Prometheus alert rule is loaded (issues #151/#155)"
