#!/usr/bin/env bash
# ADR-0044 Option E — the ENFORCEMENT drill, not an object assertion.
#
# WHY THIS EXISTS, SEPARATELY FROM THE ENVTEST GUARD. `networkpolicy_test.go`
# asserts the policy OBJECT's fields — that we wrote the right ports. It runs
# under envtest, which is an apiserver + etcd with NO CNI, NO pods and NO
# dataplane, so it can never prove that anything is actually REFUSED. ADR-0044
# anticipated exactly this substitution ("a refusal test there would read green
# on an unenforced object"), so the enforcement claim gets its own drill.
#
# It also cannot run just anywhere: flannel — which OKE GA and OrbStack both
# run — ships NO NetworkPolicy controller at all, so on those clusters the
# policy is declarative-only and a refusal test would fail while the object is
# perfectly correct. This drill therefore stands up kind with its default CNI
# DISABLED and installs Calico, a policy-capable CNI.
#
# What it proves, end to end:
#   1. a same-namespace pod dialling the app pod's USER port is REFUSED
#      (the ADR-0044 bypass, closed);
#   2. a same-namespace pod dialling the app pod's METRICS port SUCCEEDS
#      (scraping survives — the architect gate's named residual);
#   2e. REVOCATION: unlabelling denies again on a NEW connection (established
#      flows can survive in conntrack — stated, not glossed);
#   2b-2d. cross-namespace scraping (#735) in BOTH directions: an UNLABELLED
#      namespace is refused, the same namespace LABELLED is admitted on the
#      metrics port, and it is STILL refused on the user port. Asserting only
#      the admit half would pass on a policy that admits everyone;
#   3. mutation: with the policy DELETED, (1) succeeds — proving the refusal
#      is the policy's doing and not something else in the cluster.
#
# THE FUNCTION LEG (zone functions, BackendService) adds Knative Serving +
# Kourier to the same Calico cluster and proves the zone-function policy:
#   F1. a zone pod's COLD call (the function at zero replicas) through the
#       function's cluster-local URL SUCCEEDS, and arrives over h2c. At zero the
#       activator (knative-serving) is the peer, so a policy that admitted only
#       the zone's pods would blackhole this call on Calico while every flannel
#       cluster stayed green;
#   F1b. a WARM call through the same URL SUCCEEDS with the ACTIVATOR OUT OF THE
#       PATH. A warm function is not automatically gateway-served: with the
#       default target-burst-capacity the SKS stays in `Proxy` and the activator
#       keeps buffering, so a "warm" call is still admitted by the activator peer
#       and proves nothing about the gateway. The leg therefore sets
#       target-burst-capacity=0 on the drill's own function (drill-only, never
#       shipped), requires the ServerlessService to report mode `Serve` with a pod
#       up, and FAILS if it never does. Only then is the call admitted by the
#       GATEWAY peer alone — without this leg a policy that dropped the gateway
#       peer would blackhole every warm cross-zone call while F1 stayed green;
#       it also pins ONE replica for the warm legs (min-scale=1, drill-only). A
#       warm pod is not the same as `Serve`: the autoscaler wants a replica only
#       while traffic is recent, so `Serve` collapses back to `Proxy` seconds
#       after the cold call while pod retention keeps the pod up. Judging the
#       call inside that window makes the leg a stopwatch, and it cannot be
#       re-entered by waiting — waiting generates no traffic. The pin also keeps
#       the pod alive for the direct-dial legs, which dial its IP;
#   F2. a co-resident pod's DIRECT dial to the warm function pod (user port and
#       queue-proxy ports) is REFUSED, from the zone's namespace and from another
#       namespace. The policy cannot express "only the owning zone" (calls
#       arrive through shared Knative peers), so the per-zone control is the
#       identity token, not this policy;
#   F2b. a pod in knative-serving that is NOT the activator and NOT the
#       autoscaler — a stand-in labelled `app=controller`, standing for the
#       controller, webhook and net-kourier-controller pods — is REFUSED on every
#       serving port. Namespace membership alone must not admit a pod, which is
#       the whole point of the narrowing;
#   F3. mutation: with the function's policy DELETED, F2's direct dial
#       succeeds — the refusal is the policy's doing.
# Mutations that drop the activator peer (F1), drop the gateway peer (F1b) or
# widen every peer back to its whole namespace (F2, F2b) are proved by
# scripts/mutation-prove-2052-backendservice.mjs, which re-runs this leg on a
# kept cluster (REUSE_CLUSTER=1 LEGS=function) and judges by exit code.
#
# Usage:  bash test/networkpolicy-enforcement-drill.sh
#   LEGS="app function" (default) | app | function
#   REUSE_CLUSTER=1  use the existing $CLUSTER (already on Calico) and keep it
#   KEEP_CLUSTER=1   create $CLUSTER as usual but keep it at exit
# Requires: docker, kind, kubectl, go. Runs ~10 minutes with the function leg.
set -euo pipefail

CLUSTER="${CLUSTER:-knext-np-enforcement}"
NS=np-drill
APP_PORT=3000
# 9464 since #951 / ADR-0044 Amendment 5 — the app metrics port moved off
# queue-proxy's 9091. The grep below asserts the OPERATOR's rendered policy
# admits this port, so a drill pinned to the old number would fail step 0
# rather than silently prove the wrong policy.
METRICS_PORT=9464
LEGS="${LEGS:-app function}"
REUSE_CLUSTER="${REUSE_CLUSTER:-0}"
# KEEP_CLUSTER=1 creates the cluster but does not delete it at exit, so the
# mutation prover can re-run a leg on it with REUSE_CLUSTER=1.
KEEP_CLUSTER="${KEEP_CLUSTER:-$REUSE_CLUSTER}"
# The drill talks to its cluster through its OWN kubeconfig file and never
# touches the user's current context, so running it beside other kind clusters
# (or a real one) cannot redirect anyone else's kubectl.
KUBECONFIG_FILE="${TMPDIR:-/tmp}/kubeconfig-$CLUSTER"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPERATOR_DIR="$(cd "$HERE/.." && pwd)"
KIND_MANIFESTS="$(cd "$HERE/../../../scripts/kind-manifests" && pwd)"

log() { printf '\n=== %s\n' "$*"; }
cleanup() {
  [ "$KEEP_CLUSTER" = 1 ] && return 0
  kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
}
fail() { echo "DRILL FAILED: $*" >&2; exit 1; }
has_leg() { case " $LEGS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

command -v docker >/dev/null || fail "docker is required"
command -v kind >/dev/null || fail "kind is required"
command -v kubectl >/dev/null || fail "kubectl is required"
docker info >/dev/null 2>&1 || fail "docker daemon is not running"

trap cleanup EXIT

if [ "$REUSE_CLUSTER" = 1 ]; then
  log "reusing kind cluster $CLUSTER (REUSE_CLUSTER=1: no create, no delete)"
  kind get kubeconfig --name "$CLUSTER" > "$KUBECONFIG_FILE"
  export KUBECONFIG="$KUBECONFIG_FILE"
  kubectl -n kube-system rollout status daemonset/calico-node --timeout=60s \
    || fail "REUSE_CLUSTER=1 but $CLUSTER runs no Calico; the drill would prove nothing"
else
log "kind cluster with the default CNI DISABLED (kindnet cannot enforce NetworkPolicy)"
cat <<'YAML' | kind create cluster --name "$CLUSTER" --kubeconfig "$KUBECONFIG_FILE" --config=- --wait 180s
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  disableDefaultCNI: true
  podSubnet: "192.168.0.0/16"
YAML
export KUBECONFIG="$KUBECONFIG_FILE"

log "installing Calico (a policy-capable CNI — this is what makes the drill meaningful)"
# Checksum-pinned AND image-digest-pinned (#1413 review, rounds 1410-1 and
# 1410-2): a moved/edited release asset fails the checksum; Calico's three
# images (docker.io/calico/{cni,node,kube-controllers}:v3.28.2) are
# tag-only releases, same discipline as
# scripts/kind-manifests/apply-cert-manager.sh / apply-knative-kourier.sh.
CALICO_VERSION="v3.28.2"
CALICO_SHA256="be59408bf990e96276f631d2f9285c2a0f9802194c0ad1cecdb6d9c52623a1c8"
CALICO_OUT="${TMPDIR:-/tmp}/calico-${CALICO_VERSION}.yaml"
curl -fsSL -o "$CALICO_OUT" \
  "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/calico.yaml"
echo "${CALICO_SHA256}  ${CALICO_OUT}" | sha256sum -c -
"$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../scripts/kind-manifests" && pwd)/pin-known-images.sh" "$CALICO_OUT" --expect 3
kubectl apply -f "$CALICO_OUT"
kubectl -n kube-system rollout status daemonset/calico-node --timeout=300s
kubectl wait --for=condition=Ready nodes --all --timeout=180s
fi

if has_leg app; then

log "app pod (serves both the user port and a metrics port) + a co-resident caller"
kubectl create namespace "$NS"
kubectl -n "$NS" run app --image=python:3.12-alpine --labels="serving.knative.dev/service=drill-app" \
  --command -- sh -c "python3 -m http.server $APP_PORT & python3 -m http.server $METRICS_PORT & wait"
kubectl -n "$NS" run caller --image=curlimages/curl --command -- sleep 3600
kubectl -n "$NS" wait --for=condition=Ready pod/app pod/caller --timeout=180s
APP_IP=$(kubectl -n "$NS" get pod app -o jsonpath='{.status.podIP}')
[ -n "$APP_IP" ] || fail "no app pod IP"

# THE POLICY COMES FROM THE OPERATOR, NOT FROM THIS FILE.
#
# An earlier cut of this drill inlined the YAML, and spec review caught that a
# hand-copy drifts silently: the drill would keep passing against a policy the
# operator no longer produces. `cmd/policygen` renders
# `controller.DesiredNetworkPolicy` — the exact object the reconciler applies —
# so any change to the real rules changes what is proved here.
log "rendering the operator's own policy via cmd/policygen"
POLICY=$(cd "$(dirname "$0")/.." && go run ./cmd/policygen -app drill-app -namespace "$NS")
echo "$POLICY"
# Fail closed if the rendered policy does not actually exclude the user port —
# otherwise steps 1-3 could "pass" against a policy that never closed anything.
echo "$POLICY" | grep -q "port: $APP_PORT" && fail "the operator's policy ADMITS the user port; this drill cannot prove a refusal"
echo "$POLICY" | grep -q "port: $METRICS_PORT" || fail "the operator's policy does not admit the metrics port; step 2 would be vacuous"
echo "$POLICY" | grep -q "knext.dev/metrics-scrape" || fail "the operator's policy carries no cross-namespace scrape rule; steps 2b-2d would be vacuous"
echo "$POLICY" | kubectl apply -f -
sleep 5

dial() { # $1=port $2=timeout -> prints "open" or "refused"
  if kubectl -n "$NS" exec caller -- curl -s -o /dev/null -m "$2" "http://$APP_IP:$1/" 2>/dev/null; then
    echo open
  else
    echo refused
  fi
}

log "1. same-namespace pod -> app USER port (must be REFUSED — the ADR-0044 bypass)"
R=$(dial "$APP_PORT" 8)
echo "   user port: $R"
[ "$R" = refused ] || fail "the user port is REACHABLE from a co-resident pod — the bypass is OPEN"

log "2. same-namespace pod -> app METRICS port (must be OPEN — scraping must survive)"
R=$(dial "$METRICS_PORT" 8)
echo "   metrics port: $R"
[ "$R" = open ] || fail "metrics scraping is BROKEN by the policy"

# CROSS-NAMESPACE scraping (#735). The issue's acceptance criteria demanded this
# case explicitly, because the existing assertions proved only the SAME-namespace
# half — they would have stayed green forever while the operator's own shipped
# PodMonitor scrape was refused. Both halves are checked: an UNLABELLED namespace
# is denied, and the same namespace LABELLED is admitted. Testing only the second
# would pass just as well on a policy that admits everyone.
log "2b. cross-namespace scrape: UNLABELLED namespace must be REFUSED"
kubectl create namespace np-drill-mon >/dev/null
kubectl -n np-drill-mon run scraper --image=curlimages/curl --command -- sleep 3600 >/dev/null
kubectl -n np-drill-mon wait --for=condition=Ready pod/scraper --timeout=120s >/dev/null

xdial() { # $1=port -> open|refused, dialled from the OTHER namespace
  if kubectl -n np-drill-mon exec scraper -- curl -s -o /dev/null -m 8 "http://$APP_IP:$1/" 2>/dev/null; then
    echo open
  else
    echo refused
  fi
}
# Prove the scraper can reach SOMETHING first, so a "refused" below means the
# policy denied it rather than the pod being unable to dial at all — code review
# named this as a way 2b could pass spuriously.
#
# HTTPS + -k, not http: the kubernetes service listens on 443 ONLY, so an http
# dial fails on essentially every cluster. The first version of this check did
# exactly that and, being advisory-only, printed its note and moved on — a
# vacuity check that was itself vacuous. It is a hard FAIL now: if the scraper
# cannot dial anything, 2b's "refused" proves nothing and the drill should say so
# rather than bank a meaningless pass.
kubectl -n np-drill-mon exec scraper -- curl -sk -o /dev/null -m 8 "https://kubernetes.default.svc/" 2>/dev/null \
  || fail "the scraper pod cannot reach the apiserver either, so a 'refused' in 2b would not be attributable to the policy"
R=$(xdial "$METRICS_PORT")
echo "   metrics port from an unlabelled namespace: $R"
[ "$R" = refused ] || fail "an UNLABELLED namespace can already scrape — the label grants nothing, so the next assertion would prove nothing"

log "2c. cross-namespace scrape: LABELLED namespace must be ADMITTED on metrics"
kubectl label namespace np-drill-mon knext.dev/metrics-scrape=true --overwrite >/dev/null
# RETRY rather than a fixed sleep. Calico programs a namespace-label change
# asynchronously, so a fixed wait makes this a FALSE-FAIL flake: the drill would
# report "the rule is not effective" for a rule that simply had not propagated.
# Only the ADMIT direction is retried — the refuse direction (2b/2d) must hold
# immediately and forever, so retrying there would mask a real leak.
R=refused
for _ in 1 2 3 4 5 6 7 8 9 10; do
  R=$(xdial "$METRICS_PORT")
  [ "$R" = open ] && break
  sleep 3
done
echo "   metrics port from a labelled namespace: $R"
[ "$R" = open ] || fail "the labelled namespace still cannot scrape after ~30s — the #735 rule is not effective"

log "2d. the labelled namespace must STILL be refused on the app's user port"
R=$(xdial "$APP_PORT")
echo "   user port from a labelled namespace: $R"
[ "$R" = refused ] || fail "a monitoring namespace reached the USER port — it scrapes, it must not serve"

log "2e. REVOCATION: unlabelling the namespace must deny the scrape again"
# The system-designer gate named revocation as the untested failure mode: every
# assertion so far proves the GRANT works, none proved it can be TAKEN BACK. A
# grant that cannot be revoked is a different security property from the one
# documented.
#
# CONNTRACK CAVEAT, stated because it bounds what this proves: Calico (like most
# CNIs) evaluates policy on connection ESTABLISHMENT and keeps established flows
# in conntrack. A long-lived keep-alive scrape can therefore survive removal of
# the label until the connection is torn down. This step dials fresh each time —
# `kubectl exec curl` opens a NEW connection — so it proves revocation for NEW
# connections, which is the guarantee we document, not for in-flight ones.
#
# WHY THIS ONE RETRIES A *DENY*, WHEN 2b/2d DELIBERATELY DO NOT. Retrying a deny
# normally masks a leak: "refused eventually" is not the property, and a policy
# that admits for three seconds has already lost. The exception here is narrow
# and deliberate — DE-programming is asynchronous exactly as programming is, so
# the alternative is a fixed sleep, which is the flake this drill already
# removed once. A policy that never revokes still FAILS: the loop is bounded at
# ~30s and then fails. Recorded so this does not read as precedent for softening
# 2b or 2d, which must hold immediately and forever.
kubectl label namespace np-drill-mon knext.dev/metrics-scrape- >/dev/null 2>&1 || true
R=open
for _ in 1 2 3 4 5 6 7 8 9 10; do
  R=$(xdial "$METRICS_PORT")
  [ "$R" = refused ] && break
  sleep 3
done
echo "   metrics port after unlabelling: $R"
[ "$R" = refused ] || fail "the scrape survived REVOCATION on a fresh connection — the grant cannot be taken back, which is not the documented property"

log "3. MUTATION: delete the policy — the user port must become reachable again"
kubectl -n "$NS" delete networkpolicy drill-app-allow-ingress
sleep 5
R=$(dial "$APP_PORT" 8)
echo "   user port without the policy: $R"
[ "$R" = open ] || fail "the user port is still refused with NO policy — the drill proves nothing (something else is blocking)"

log "APP LEG PASSED: refusal is enforced, caused by the policy, and metrics survive"
fi

if has_leg function; then
# A fresh pair of namespaces per run, so a re-run on a kept cluster (the
# mutation prover) starts clean without tearing anything down.
RUN_ID="$(date +%s)"
FN_NS="np-fn-$RUN_ID"
FN_OTHER_NS="np-fn-other-$RUN_ID"
FN=pricing
ZONE=orders
FN_IMAGE=dev.local/knext-h2c-echo:drill

log "F0. Knative Serving + Kourier (the function's data path) on the Calico cluster"
if ! kubectl get namespace knative-serving >/dev/null 2>&1; then
  # Fetched, checksum-verified and digest-pinned by the shared helper.
  "$KIND_MANIFESTS/apply-knative-kourier.sh" knative-v1.16.0
  kubectl patch configmap/config-network -n knative-serving --type merge \
    -p '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'
fi
kubectl -n knative-serving rollout status deployment --timeout=300s
kubectl -n kourier-system rollout status deployment --timeout=300s
# Scale to zero quickly, so the cold call below is reached in about a minute.
kubectl patch configmap/config-autoscaler -n knative-serving --type merge \
  -p '{"data":{"stable-window":"6s","scale-to-zero-grace-period":"6s"}}'

log "F0. the stand-in function image (HTTP/1.1 + h2c), loaded into kind"
NODE_ARCH=$(docker exec "$CLUSTER-control-plane" uname -m)
case "$NODE_ARCH" in
  x86_64) GOARCH_NODE=amd64 ;;
  aarch64 | arm64) GOARCH_NODE=arm64 ;;
  *) fail "unknown node architecture $NODE_ARCH" ;;
esac
FN_BUILD_DIR=$(mktemp -d)
(cd "$OPERATOR_DIR" && CGO_ENABLED=0 GOOS=linux GOARCH="$GOARCH_NODE" go build -o "$FN_BUILD_DIR/h2cecho" ./test/h2cecho)
printf 'FROM scratch\nCOPY h2cecho /h2cecho\nUSER 65532:65532\nENTRYPOINT ["/h2cecho"]\n' > "$FN_BUILD_DIR/Dockerfile"
docker build -q -t "$FN_IMAGE" "$FN_BUILD_DIR" >/dev/null
rm -rf "$FN_BUILD_DIR"
kind load docker-image "$FN_IMAGE" --name "$CLUSTER"

log "F0. the function as the OPERATOR renders it (cmd/policygen -function), in $FN_NS"
kubectl create namespace "$FN_NS"
kubectl create namespace "$FN_OTHER_NS"
FN_OBJS=$(cd "$OPERATOR_DIR" && go run ./cmd/policygen -function "$FN" -zone "$ZONE" -image "$FN_IMAGE" -namespace "$FN_NS")
echo "$FN_OBJS"
# Fail closed if the rendered objects are not what the leg claims to test.
echo "$FN_OBJS" | grep -q "networking.knative.dev/visibility: cluster-local" || fail "the function is not cluster-local"
echo "$FN_OBJS" | grep -q "name: h2c" || fail "the function's port is not named h2c"
echo "$FN_OBJS" | grep -q "port: 8080" && fail "the function policy ADMITS the user port; F2 cannot prove a refusal"
echo "$FN_OBJS" | kubectl apply -f -
kubectl -n "$FN_NS" wait "ksvc/$FN" --for=condition=Ready --timeout=300s

# DRILL-ONLY autoscaler tuning, and the reason F1b can prove anything at all.
#
# A warm Knative function is NOT automatically served by the gateway. With the
# default target-burst-capacity (200) the autoscaler keeps counting requests
# against the activator's buffer, so the ServerlessService stays in `Proxy` mode
# and a warm call through the function URL still travels gateway -> ACTIVATOR ->
# queue-proxy. Such a call is admitted by the ACTIVATOR peer and says nothing
# about the gateway peer, so dropping the gateway peer would leave the leg green.
#
# target-burst-capacity=0 makes the SKS switch to `Serve` — route straight to the
# pods — as soon as one pod is up, so the activator leaves the path and the warm
# call is admitted by the GATEWAY peer alone. F1b asserts the mode before it
# calls and fails rather than passes while the mode is still `Proxy`.
#
# This is a setting on the drill's own fixture, not on what the operator ships.
kubectl -n "$FN_NS" patch ksvc "$FN" --type=json \
  -p '[{"op":"add","path":"/spec/template/metadata/annotations/autoscaling.knative.dev~1target-burst-capacity","value":"0"}]'
# JSON Patch on one annotation path, never --type=merge: a merge patch on a ksvc
# once dropped env/resources/probes silently. Prove the container survived.
[ "$(kubectl -n "$FN_NS" get ksvc "$FN" -o jsonpath='{.spec.template.spec.containers[0].image}')" = "$FN_IMAGE" ] \
  || fail "the ksvc lost its container image after the target-burst-capacity patch"
kubectl -n "$FN_NS" wait "ksvc/$FN" --for=condition=Ready --timeout=300s >/dev/null

kubectl -n "$FN_NS" run zone-caller --image=curlimages/curl --labels="serving.knative.dev/service=$ZONE" \
  --command -- sleep 3600 >/dev/null
kubectl -n "$FN_OTHER_NS" run other-zone --image=curlimages/curl --command -- sleep 3600 >/dev/null
kubectl -n "$FN_NS" wait --for=condition=Ready pod/zone-caller --timeout=180s >/dev/null
kubectl -n "$FN_OTHER_NS" wait --for=condition=Ready pod/other-zone --timeout=180s >/dev/null

fn_pods() { kubectl -n "$FN_NS" get pods -l "serving.knative.dev/service=$FN" --no-headers 2>/dev/null | grep -c . || true; }

log "F1. wait for the function to scale to ZERO"
for _ in $(seq 1 60); do
  [ "$(fn_pods)" = 0 ] && break
  sleep 5
done
[ "$(fn_pods)" = 0 ] || fail "the function never scaled to zero; F1 would not be a cold call"

log "F1. the zone's COLD call through the function URL must SUCCEED over h2c (activator path)"
FN_URL="http://$FN.$FN_NS.svc.cluster.local"
BODY=$(kubectl -n "$FN_NS" exec zone-caller -- curl -sS -m 90 "$FN_URL/" 2>&1) \
  || fail "the cold call to $FN_URL FAILED — the policy blackholes scale-from-zero: $BODY"
echo "   cold call: $BODY"
case "$BODY" in
  *"knext-function-ok proto=HTTP/2.0"*) ;;
  *) fail "the cold call answered, but not from the function over h2c: $BODY" ;;
esac

log "F1b. a WARM call through the function URL must SUCCEED (gateway peer, activator out of path)"
# The leg is only meaningful with the ACTIVATOR OUT OF THE PATH, which is what
# the target-burst-capacity patch above buys: at zero replicas the SKS is
# `Proxy` and the activator buffers; once a pod is up it flips to `Serve` and the
# gateway routes straight to the pod. So BOTH halves are asserted before the
# call — a pod Ready AND sks mode == Serve — and the whole thing is retried
# while the pinned revision's pod comes up and the autoscaler moves the SKS to
# `Serve`.
# If Serve is never reached with a pod up, the leg FAILS: a warm call through the
# activator proves nothing about the gateway peer.
F1B_OK=0
# Pin one replica for the remaining function legs (drill-only, like the burst
# capacity above). `Serve` is NOT a function of "a pod exists": the autoscaler
# sets it only while it wants a replica (`want > 0`), and `want` drops to zero
# one stable-window after the last request. Pod retention then keeps the pod
# Running for its full 30s with the SKS back in `Proxy` — measured on a failing
# run, `Serve` survived 2-3 seconds after the cold call and never returned. A
# wait-only retry can never recover from missing it: waiting generates no
# traffic, so it cannot restore `want > 0`. Pinning the replica makes `want`>=1
# persistently, which makes `Serve` a steady state instead of a stopwatch —
# and it keeps the pod alive for F2/F3, which dial its IP: with the autoscaler
# reclaiming it 40s after the cold call those legs measured a dead address, so
# F2 could read "refused" for the wrong reason and F3 could never open.
kubectl -n "$FN_NS" patch ksvc "$FN" --type=json \
  -p '[{"op":"add","path":"/spec/template/metadata/annotations/autoscaling.knative.dev~1min-scale","value":"1"}]'
[ "$(kubectl -n "$FN_NS" get ksvc "$FN" -o jsonpath='{.spec.template.spec.containers[0].image}')" = "$FN_IMAGE" ] \
  || fail "the ksvc lost its container image after the min-scale patch"
kubectl -n "$FN_NS" wait "ksvc/$FN" --for=condition=Ready --timeout=300s >/dev/null

for _ in $(seq 1 10); do
  # The SKS is named after its revision, and only the LATEST READY revision's
  # mode is the path a new request takes — earlier revisions stay `Proxy`.
  FN_REV=$(kubectl -n "$FN_NS" get ksvc "$FN" -o jsonpath='{.status.latestReadyRevisionName}' 2>/dev/null || true)
  [ -n "$FN_REV" ] || { sleep 2; continue; }
  # Scope to the revision as well as the service: a draining pod of the previous
  # revision still answers the service label, and the assertion below must not
  # be made against an address that is about to disappear.
  FN_POD=$(kubectl -n "$FN_NS" get pods \
    -l "serving.knative.dev/service=$FN,serving.knative.dev/revision=$FN_REV" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  [ -n "$FN_POD" ] || { sleep 2; continue; }
  # A pod that exists but is not Ready is not "warm": the `Serve` transition
  # (and therefore a gateway-only warm call) presupposes a ready backend, so the
  # precondition is readiness, not bare pod existence.
  if ! kubectl -n "$FN_NS" wait --for=condition=Ready "pod/$FN_POD" --timeout=60s >/dev/null 2>&1; then
    log "   F1b: function pod $FN_POD exists but is not Ready; waiting"
    sleep 2
    continue
  fi
  SKS_MODE=$(kubectl -n "$FN_NS" get sks "$FN_REV" -o jsonpath='{.spec.mode}' 2>/dev/null || true)
  if [ "$SKS_MODE" != "Serve" ]; then
    log "   F1b: function is warm but sks mode=${SKS_MODE:-<none>} — the activator is still in the path, so a call here would not prove the gateway; waiting"
    sleep 2
    continue
  fi
  before="$FN_POD"
  BODY_WARM=$(kubectl -n "$FN_NS" exec zone-caller -- curl -sS -m 30 "$FN_URL/" 2>&1) || BODY_WARM=""
  after=$(kubectl -n "$FN_NS" get pods \
    -l "serving.knative.dev/service=$FN,serving.knative.dev/revision=$FN_REV" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  if [ -n "$BODY_WARM" ] && [ "$before" = "$after" ]; then
    echo "   warm call: $BODY_WARM (revision $FN_REV, sks mode=Serve, warm pod $before unchanged across the call)"
    case "$BODY_WARM" in
      *"knext-function-ok proto=HTTP/2.0"*) F1B_OK=1; break ;;
      *) fail "the warm call answered, but not from the function over h2c: $BODY_WARM" ;;
    esac
  fi
  echo "   F1b retry: pod=$before -> $after, answer=${BODY_WARM:-<none>}"
  sleep 3
done
[ "$F1B_OK" = 1 ] || fail "no warm call could be proved with the activator out of the path: either sks mode never reached Serve while a pod was up (so the gateway peer is unproven), or the pod did not hold across the call, or the warm call was blackholed"

log "F2. a co-resident pod's DIRECT dial to the warm function pod must be REFUSED"
# The SAME revision F1b proved warm: with the replica pinned it stays up for the
# whole leg, so these refusals are attributable to the policy rather than to an
# address the autoscaler already took away (and F3 needs it still alive to
# prove the refusal was the policy's).
FN_POD_IP=$(kubectl -n "$FN_NS" get pods \
  -l "serving.knative.dev/service=$FN,serving.knative.dev/revision=$FN_REV" \
  -o jsonpath='{.items[0].status.podIP}')
[ -n "$FN_POD_IP" ] || fail "no warm function pod after the call"
fdial() { # $1=namespace $2=pod $3=port -> open|refused
  # The SCHEME matters. 8112 is queue-proxy's TLS port and 8013 is h2c, so a
  # plain http:// probe fails its handshake on an ADMITTED port too and would
  # read "refused" — a refusal must come from the policy, never from curl.
  local scheme=http extra=""
  case "$3" in
    8112) scheme=https extra="-k" ;;
    8013) extra="--http2-prior-knowledge" ;;
  esac
  if kubectl -n "$1" exec "$2" -- curl -s -o /dev/null -m 8 $extra "$scheme://$FN_POD_IP:$3/" 2>/dev/null; then
    echo open
  else
    echo refused
  fi
}
# Vacuity guard: each caller CAN dial something, so a refusal is the policy's.
for caller in "$FN_NS/zone-caller" "$FN_OTHER_NS/other-zone"; do
  cns="${caller%%/*}"
  cpod="${caller##*/}"
  kubectl -n "$cns" exec "$cpod" -- curl -sk -o /dev/null -m 8 "https://kubernetes.default.svc/" 2>/dev/null \
    || fail "$caller cannot reach the apiserver either, so a refusal would not be attributable to the policy"
  for port in 8080 8012 8013 8112; do
    R=$(fdial "$cns" "$cpod" "$port")
    echo "   $caller -> function pod :$port: $R"
    [ "$R" = refused ] || fail "$caller dialled the function pod's :$port directly — the Knative path is bypassable"
  done
done

log "F2b. a non-activator knative-serving pod's DIRECT dial must be REFUSED"
# The narrowed peer select knative-serving AND a pod label. Namespace membership
# alone must not admit a pod, so the rest of the control plane (controller,
# webhook, net-kourier-controller) has to be refused on every serving port. The
# stand-in carries `app=controller`; the real pods are distroless and carry
# knative's own labels, and neither can be exec'd into.
kubectl apply -f - >/dev/null <<'YAML'
apiVersion: v1
kind: Pod
metadata:
  name: np-drill-controller
  namespace: knative-serving
  labels:
    app: controller
spec:
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: probe
      image: curlimages/curl
      command: ["sleep", "3600"]
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
YAML
kubectl -n knative-serving wait --for=condition=Ready pod/np-drill-controller --timeout=180s >/dev/null
# Vacuity guard: a refusal only counts if this pod can reach something.
kubectl -n knative-serving exec np-drill-controller -- curl -sk -o /dev/null -m 8 "https://kubernetes.default.svc/" 2>/dev/null \
  || fail "the knative-serving stand-in cannot reach the apiserver, so a refusal would not be attributable to the policy"
for port in 8080 8012 8013 8112; do
  R=$(fdial knative-serving np-drill-controller "$port")
  echo "   knative-serving/app=controller -> function pod :$port: $R"
  [ "$R" = refused ] || fail "a NON-activator knative-serving pod dialled the function pod's :$port — namespace membership admits it"
done
kubectl -n knative-serving delete pod np-drill-controller --wait=false >/dev/null

log "F3. MUTATION: delete the function's policy — the direct dial must succeed"
kubectl -n "$FN_NS" delete networkpolicy "$FN-function-ingress"
R=refused
for _ in 1 2 3 4 5 6 7 8 9 10; do
  R=$(fdial "$FN_NS" zone-caller 8080)
  [ "$R" = open ] && break
  sleep 3
done
echo "   user port without the policy: $R"
[ "$R" = open ] || fail "the direct dial is still refused with NO policy — F2 proved nothing"

log "FUNCTION LEG PASSED: cold (activator) and warm (gateway) calls succeed on Calico, direct dials from zone pods and from a non-activator knative-serving pod are refused, and the refusal is the policy's"
fi

log "DRILL PASSED (legs: $LEGS)"
