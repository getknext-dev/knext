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
#   F2. a co-resident pod's DIRECT dial to the warm function pod (user port and
#       queue-proxy ports) is REFUSED, from the zone's namespace and from another
#       namespace. The policy cannot express "only the owning zone" (calls
#       arrive through shared Knative peers), so the per-zone control is the
#       identity token, not this policy;
#   F3. mutation: with the function's policy DELETED, F2's direct dial
#       succeeds — the refusal is the policy's doing.
# A mutation that drops the activator peer turns F1 red; that is proved by
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

log "F2. a co-resident pod's DIRECT dial to the warm function pod must be REFUSED"
FN_POD_IP=$(kubectl -n "$FN_NS" get pods -l "serving.knative.dev/service=$FN" -o jsonpath='{.items[0].status.podIP}')
[ -n "$FN_POD_IP" ] || fail "no warm function pod after the call"
fdial() { # $1=namespace $2=pod $3=port -> open|refused
  if kubectl -n "$1" exec "$2" -- curl -s -o /dev/null -m 8 "http://$FN_POD_IP:$3/" 2>/dev/null; then
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
  for port in 8080 8012 8013; do
    R=$(fdial "$cns" "$cpod" "$port")
    echo "   $caller -> function pod :$port: $R"
    [ "$R" = refused ] || fail "$caller dialled the function pod's :$port directly — the Knative path is bypassable"
  done
done

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

log "FUNCTION LEG PASSED: a cold call through the activator succeeds on Calico, direct dials are refused, and the refusal is the policy's"
fi

log "DRILL PASSED (legs: $LEGS)"
