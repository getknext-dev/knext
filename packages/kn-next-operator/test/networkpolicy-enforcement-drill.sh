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

# Reproduces the operator's policy shape (buildDesiredNetworkPolicy): rule [0]
# serving+metrics from the system namespaces, rule [1] metrics-only from the
# same namespace. The user port appears in NEITHER — that is the whole point.
log "applying the operator-shaped NetworkPolicy"
kubectl -n "$NS" apply -f - <<YAML
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: drill-app-allow-ingress
spec:
  podSelector:
    matchLabels:
      serving.knative.dev/service: drill-app
  policyTypes: [Ingress]
  ingress:
    - ports:
        - port: 8012
        - port: 8013
        - port: 9090
        - port: $METRICS_PORT
      from:
        - namespaceSelector:
            matchExpressions:
              - key: kubernetes.io/metadata.name
                operator: In
                values: [knative-serving, kourier-system]
    - ports:
        - port: 9090
        - port: $METRICS_PORT
      from:
        - podSelector: {}
YAML
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

log "3. MUTATION: delete the policy — the user port must become reachable again"
kubectl -n "$NS" delete networkpolicy drill-app-allow-ingress
sleep 5
R=$(dial "$APP_PORT" 8)
echo "   user port without the policy: $R"
[ "$R" = open ] || fail "the user port is still refused with NO policy — the drill proves nothing (something else is blocking)"

log "DRILL PASSED: refusal is enforced, caused by the policy, and metrics survive"
