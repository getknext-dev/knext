#!/usr/bin/env bash
# kind e2e for the Rust zone-function template.
#
# Deploys the template image as a cluster-local Knative Service with an h2c
# port and no JWKS mounted, then proves, through Knative's cluster-local
# gateway, by the function's cluster-local host name:
#   - the health check is served without a token;
#   - every other RPC is refused (unauthenticated), with or without a token,
#     over Connect, Connect GET, gRPC and gRPC-Web, and a raw gRPC refusal
#     keeps grpc-status 16 through Kourier and the queue-proxy;
#   - the public gateway has no route to the function;
# once against a warm pod and once from zero replicas (through the activator).
#
# The script talks to the cluster through a kubeconfig file of its own, so it
# never changes your kubeconfig or its current context, and it deletes
# nothing: a rebuilt image rolls a new revision through an annotation.
#
# Usage (from anywhere):
#   templates/rust/e2e/kind-e2e.sh
# Env:
#   KIND_CLUSTER        kind cluster name (default knext-rust-template-e2e);
#                       created when missing, kept afterwards.
#   KNATIVE_VERSION     default knative-v1.16.0 (the version the shared
#                       install script pins).
#   SKIP_KNATIVE=1      the cluster already has Knative + Kourier configured.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$(cd "${HERE}/.." && pwd)"
REPO_ROOT="$(cd "${TEMPLATE}/../.." && pwd)"
CLUSTER="${KIND_CLUSTER:-knext-rust-template-e2e}"
KNATIVE_VERSION="${KNATIVE_VERSION:-knative-v1.16.0}"
IMAGE="kind.local/knext-function-rust:e2e"
NAME="example-rust-fn"
NS="default"
HOST="${NAME}.${NS}.svc.cluster.local"

KCFG="$(mktemp)"
PF_LOG="$(mktemp)"
PIDS=()
cleanup() {
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "${pid}" 2>/dev/null || true; done
  rm -f "${KCFG}" "${PF_LOG}"
}
trap cleanup EXIT

log() { printf '\n== %s\n' "$*"; }
k() { kubectl --kubeconfig "${KCFG}" "$@"; }

if ! kind get clusters | grep -qx "${CLUSTER}"; then
  log "creating kind cluster ${CLUSTER}"
  kind create cluster --name "${CLUSTER}" --kubeconfig "${KCFG}" --wait 120s
fi
kind get kubeconfig --name "${CLUSTER}" >"${KCFG}"

if [ "${SKIP_KNATIVE:-0}" != "1" ]; then
  log "installing Knative Serving + Kourier (${KNATIVE_VERSION})"
  KUBECONFIG="${KCFG}" "${REPO_ROOT}/scripts/kind-manifests/apply-knative-kourier.sh" "${KNATIVE_VERSION}"
  k patch configmap/config-network -n knative-serving --type merge \
    --patch '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'
  k patch configmap/config-autoscaler -n knative-serving --type merge \
    --patch '{"data":{"scale-to-zero-grace-period":"10s","scale-to-zero-pod-retention-period":"0s","stable-window":"6s"}}'
  k wait --for=condition=Available --timeout=300s -n knative-serving \
    deployment/controller deployment/webhook deployment/autoscaler deployment/activator deployment/net-kourier-controller
  k wait --for=condition=Available --timeout=300s -n kourier-system deployment/3scale-kourier-gateway
fi

log "building ${IMAGE}"
docker build -t "${IMAGE}" "${TEMPLATE}"
kind load docker-image "${IMAGE}" --name "${CLUSTER}"
IMAGE_ID="$(docker image inspect "${IMAGE}" --format '{{.Id}}' | cut -c8-27)"

log "deploying ${NAME} (cluster-local, h2c, no JWKS, image ${IMAGE_ID})"
sed "s/knext.dev\/e2e-image: \"unset\"/knext.dev\/e2e-image: \"${IMAGE_ID}\"/" "${HERE}/ksvc.yaml" \
  | k apply -n "${NS}" -f -
k wait --for=condition=Ready --timeout=180s -n "${NS}" "ksvc/${NAME}"
for _ in $(seq 1 60); do
  CREATED="$(k get ksvc "${NAME}" -n "${NS}" -o jsonpath='{.status.latestCreatedRevisionName}')"
  READY="$(k get ksvc "${NAME}" -n "${NS}" -o jsonpath='{.status.latestReadyRevisionName}')"
  [ -n "${CREATED}" ] && [ "${CREATED}" = "${READY}" ] && break
  sleep 2
done
[ "${CREATED}" = "${READY}" ] || { echo "FAIL: revision ${CREATED} never became ready" >&2; exit 1; }
ANNOTATED="$(k get revision "${READY}" -n "${NS}" -o jsonpath='{.metadata.annotations.knext\.dev/e2e-image}')"
[ "${ANNOTATED}" = "${IMAGE_ID}" ] || { echo "FAIL: ready revision runs image ${ANNOTATED}, not ${IMAGE_ID}" >&2; exit 1; }

URL="$(k get ksvc "${NAME}" -n "${NS}" -o jsonpath='{.status.url}')"
echo "status.url = ${URL}"
case "${URL}" in
  "http://${HOST}") ;;
  *) echo "FAIL: status.url is ${URL}; want http://${HOST} (cluster-local)" >&2; exit 1 ;;
esac
VISIBILITY="$(k get ksvc "${NAME}" -n "${NS}" -o jsonpath='{.metadata.labels.networking\.knative\.dev/visibility}')"
[ "${VISIBILITY}" = "cluster-local" ] || { echo "FAIL: visibility label is '${VISIBILITY}'" >&2; exit 1; }

# The function's own log must say it is failing closed.
POD="$(k get pods -n "${NS}" -l "serving.knative.dev/revision=${READY}" -o jsonpath='{.items[0].metadata.name}')"
k logs -n "${NS}" "${POD}" -c user-container | tee /dev/stderr | grep -q 'no JWKS is mounted' \
  || { echo "FAIL: the function did not log that it is failing closed" >&2; exit 1; }

k port-forward -n kourier-system svc/kourier-internal 18180:80 >"${PF_LOG}" 2>&1 &
PIDS+=($!)
k port-forward -n kourier-system svc/kourier 18181:80 >>"${PF_LOG}" 2>&1 &
PIDS+=($!)
sleep 3

export KNEXT_E2E_INTERNAL_URL="http://127.0.0.1:18180"
export KNEXT_E2E_PUBLIC_URL="http://127.0.0.1:18181"
export KNEXT_E2E_HOST="${HOST}"
export KNEXT_E2E_PUBLIC_HOST="${NAME}.${NS}.example.com"

E2E=(cargo test --locked --features e2e --test e2e -- --test-threads=1 --nocapture)

log "building the e2e client"
(cd "${TEMPLATE}" && cargo test --locked --features e2e --test e2e --no-run)

log "pass 1: warm pod"
(cd "${TEMPLATE}" && "${E2E[@]}")

log "waiting for ${NAME} to scale to zero"
for _ in $(seq 1 60); do
  if [ -z "$(k get pods -n "${NS}" -l "serving.knative.dev/service=${NAME}" -o name)" ]; then
    break
  fi
  sleep 3
done
if [ -n "$(k get pods -n "${NS}" -l "serving.knative.dev/service=${NAME}" -o name)" ]; then
  echo "FAIL: ${NAME} did not scale to zero" >&2
  exit 1
fi
echo "${NAME} is at zero replicas"

log "pass 2: from zero, through the activator (a refused call is the one that wakes it)"
(cd "${TEMPLATE}" && "${E2E[@]}" raw_grpc_status_survives_the_gateway)
(cd "${TEMPLATE}" && "${E2E[@]}")

log "PASS: health served, every other RPC refused, no public route (warm and cold)"
