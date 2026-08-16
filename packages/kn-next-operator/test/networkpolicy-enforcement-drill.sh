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
#   2b-2d. cross-namespace scraping (#735) in BOTH directions: an UNLABELLED
#      namespace is refused, the same namespace LABELLED is admitted on the
#      metrics port, and it is STILL refused on the user port. Asserting only
#      the admit half would pass on a policy that admits everyone;
#   3. mutation: with the policy DELETED, (1) succeeds — proving the refusal
#      is the policy's doing and not something else in the cluster.
#
# Usage:  bash test/networkpolicy-enforcement-drill.sh
# Requires: docker, kind, kubectl. Runs ~4 minutes.
set -euo pipefail

CLUSTER="${CLUSTER:-knext-np-enforcement}"
NS=np-drill
APP_PORT=3000
METRICS_PORT=9091

log() { printf '\n=== %s\n' "$*"; }
cleanup() { kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true; }
fail() { echo "DRILL FAILED: $*" >&2; exit 1; }

command -v docker >/dev/null || fail "docker is required"
command -v kind >/dev/null || fail "kind is required"
command -v kubectl >/dev/null || fail "kubectl is required"
docker info >/dev/null 2>&1 || fail "docker daemon is not running"

trap cleanup EXIT

log "kind cluster with the default CNI DISABLED (kindnet cannot enforce NetworkPolicy)"
cat <<'YAML' | kind create cluster --name "$CLUSTER" --config=- --wait 180s
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  disableDefaultCNI: true
  podSubnet: "192.168.0.0/16"
YAML

log "installing Calico (a policy-capable CNI — this is what makes the drill meaningful)"
kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.28.2/manifests/calico.yaml
kubectl -n kube-system rollout status daemonset/calico-node --timeout=300s
kubectl wait --for=condition=Ready nodes --all --timeout=180s

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
R=$(xdial "$METRICS_PORT")
echo "   metrics port from an unlabelled namespace: $R"
[ "$R" = refused ] || fail "an UNLABELLED namespace can already scrape — the label grants nothing, so the next assertion would prove nothing"

log "2c. cross-namespace scrape: LABELLED namespace must be ADMITTED on metrics"
kubectl label namespace np-drill-mon knext.dev/metrics-scrape=true --overwrite >/dev/null
sleep 5
R=$(xdial "$METRICS_PORT")
echo "   metrics port from a labelled namespace: $R"
[ "$R" = open ] || fail "the labelled namespace still cannot scrape — the #735 rule is not effective"

log "2d. the labelled namespace must STILL be refused on the app's user port"
R=$(xdial "$APP_PORT")
echo "   user port from a labelled namespace: $R"
[ "$R" = refused ] || fail "a monitoring namespace reached the USER port — it scrapes, it must not serve"

log "3. MUTATION: delete the policy — the user port must become reachable again"
kubectl -n "$NS" delete networkpolicy drill-app-allow-ingress
sleep 5
R=$(dial "$APP_PORT" 8)
echo "   user port without the policy: $R"
[ "$R" = open ] || fail "the user port is still refused with NO policy — the drill proves nothing (something else is blocking)"

log "DRILL PASSED: refusal is enforced, caused by the policy, and metrics survive"
