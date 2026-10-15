#!/usr/bin/env bash
# kind e2e for the Go zone-function template.
#
# Deploys the template image as a cluster-local Knative Service with an h2c
# port and no JWKS mounted, then proves, through Knative's cluster-local
# gateway, by the function's cluster-local host name:
#   - the health check is served without a token;
#   - every other RPC is refused (Unauthenticated), with or without a token,
#     over Connect, Connect GET and gRPC, and a raw gRPC refusal keeps
#     grpc-status 16 through Kourier and the queue-proxy;
#   - the public gateway has no route to the function;
# once against a warm pod and once from zero replicas (through the activator).
#
# Usage (from anywhere):
#   templates/go/e2e/kind-e2e.sh
# Env:
#   KIND_CLUSTER        kind cluster name (default knext-go-template-e2e);
#                       created when missing, kept afterwards.
#   KNATIVE_VERSION     default knative-v1.16.0 (the version the shared
#                       install script pins).
#   SKIP_KNATIVE=1      the cluster already has Knative + Kourier configured.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$(cd "${HERE}/.." && pwd)"
REPO_ROOT="$(cd "${TEMPLATE}/../.." && pwd)"
CLUSTER="${KIND_CLUSTER:-knext-go-template-e2e}"
KNATIVE_VERSION="${KNATIVE_VERSION:-knative-v1.16.0}"
IMAGE="kind.local/knext-function-go:e2e"
NAME="example-fn"
NS="default"
HOST="${NAME}.${NS}.svc.cluster.local"

log() { printf '\n== %s\n' "$*"; }

if ! kind get clusters | grep -qx "${CLUSTER}"; then
  log "creating kind cluster ${CLUSTER}"
  kind create cluster --name "${CLUSTER}" --wait 120s
fi
kubectl config use-context "kind-${CLUSTER}" >/dev/null

if [ "${SKIP_KNATIVE:-0}" != "1" ]; then
  log "installing Knative Serving + Kourier (${KNATIVE_VERSION})"
  "${REPO_ROOT}/scripts/kind-manifests/apply-knative-kourier.sh" "${KNATIVE_VERSION}"
  kubectl patch configmap/config-network -n knative-serving --type merge \
    --patch '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'
  kubectl patch configmap/config-autoscaler -n knative-serving --type merge \
    --patch '{"data":{"scale-to-zero-grace-period":"10s","scale-to-zero-pod-retention-period":"0s","stable-window":"6s"}}'
  kubectl wait --for=condition=Available --timeout=300s -n knative-serving \
    deployment/controller deployment/webhook deployment/autoscaler deployment/activator deployment/net-kourier-controller
  kubectl wait --for=condition=Available --timeout=300s -n kourier-system deployment/3scale-kourier-gateway
fi

log "building ${IMAGE}"
docker build -t "${IMAGE}" "${TEMPLATE}"
kind load docker-image "${IMAGE}" --name "${CLUSTER}"

log "deploying ${NAME} (cluster-local, h2c, no JWKS)"
kubectl delete ksvc "${NAME}" -n "${NS}" --ignore-not-found --wait=true
kubectl apply -n "${NS}" -f "${HERE}/ksvc.yaml"
kubectl wait --for=condition=Ready --timeout=180s -n "${NS}" "ksvc/${NAME}"

URL="$(kubectl get ksvc "${NAME}" -n "${NS}" -o jsonpath='{.status.url}')"
echo "status.url = ${URL}"
case "${URL}" in
  "http://${HOST}") ;;
  *) echo "FAIL: status.url is ${URL}; want http://${HOST} (cluster-local)" >&2; exit 1 ;;
esac
VISIBILITY="$(kubectl get ksvc "${NAME}" -n "${NS}" -o jsonpath='{.metadata.labels.networking\.knative\.dev/visibility}')"
[ "${VISIBILITY}" = "cluster-local" ] || { echo "FAIL: visibility label is '${VISIBILITY}'" >&2; exit 1; }

# The function's own log must say it is failing closed.
POD="$(kubectl get pods -n "${NS}" -l "serving.knative.dev/service=${NAME}" -o jsonpath='{.items[0].metadata.name}')"
kubectl logs -n "${NS}" "${POD}" -c user-container | tee /dev/stderr | grep -q 'no JWKS is mounted' \
  || { echo "FAIL: the function did not log that it is failing closed" >&2; exit 1; }

PF_LOG="$(mktemp)"
kubectl port-forward -n kourier-system svc/kourier-internal 18080:80 >"${PF_LOG}" 2>&1 &
PF_INTERNAL=$!
kubectl port-forward -n kourier-system svc/kourier 18081:80 >>"${PF_LOG}" 2>&1 &
PF_PUBLIC=$!
trap 'kill ${PF_INTERNAL} ${PF_PUBLIC} 2>/dev/null || true; rm -f "${PF_LOG}"' EXIT
sleep 3

export KNEXT_E2E_INTERNAL_URL="http://127.0.0.1:18080"
export KNEXT_E2E_PUBLIC_URL="http://127.0.0.1:18081"
export KNEXT_E2E_HOST="${HOST}"
export KNEXT_E2E_PUBLIC_HOST="${NAME}.${NS}.example.com"

log "pass 1: warm pod"
(cd "${TEMPLATE}" && go test -tags e2e -count=1 -v ./e2e/)

log "waiting for ${NAME} to scale to zero"
for _ in $(seq 1 60); do
  if [ -z "$(kubectl get pods -n "${NS}" -l "serving.knative.dev/service=${NAME}" -o name)" ]; then
    break
  fi
  sleep 3
done
if [ -n "$(kubectl get pods -n "${NS}" -l "serving.knative.dev/service=${NAME}" -o name)" ]; then
  echo "FAIL: ${NAME} did not scale to zero" >&2
  exit 1
fi
echo "${NAME} is at zero replicas"

log "pass 2: from zero, through the activator (a refused call is the one that wakes it)"
(cd "${TEMPLATE}" && go test -tags e2e -count=1 -v -run '^TestRawGRPCStatusSurvivesTheGateway$' ./e2e/)
(cd "${TEMPLATE}" && go test -tags e2e -count=1 -v ./e2e/)

log "PASS: health served, every other RPC refused, no public route (warm and cold)"
