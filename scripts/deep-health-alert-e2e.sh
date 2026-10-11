#!/usr/bin/env bash
# Deep-health alert e2e on kind.
#
# Proves, with the manifests knext SHIPS applied unmodified, that an app whose
# database refuses connections makes `KnextDeepHealthDown` go FIRING in a real
# Prometheus:
#
#   shipped PodMonitor  ->  scrape of :9464  ->  knext_deep_health_state
#   forwarded by the runtime contract  ->  shipped PrometheusRule  ->  alert
#
# What is real: the prometheus-operator and Prometheus; packages/kn-next-operator/
# config/prometheus/app-podmonitor.yaml and config/observability/prometheusrule.yaml
# (byte-for-byte); the reference app's instrumentation; the runtime contract's
# :9464 listener; the @getknext/lib pool and deep health check.
# What is not: the cluster is kind, and the app is a small fixture process
# (apps/file-manager/e2e-support/deep-health-alert-fixture.ts) rather than a
# serving-stack deployment, because the claim under test is the observability path, not the
# serving path.
#
# Prerequisites on PATH: docker, kind, kubectl, node, bun, sha256sum, curl.
# The workspace must be installed and the packages built:
#   bun install --frozen-lockfile
#   bun run --filter "@getknext/lib" build && bun run --filter "@getknext/db" build \
#     && bun run --filter "@getknext/core" build
#
# Env: CLUSTER (default s3-o1), KEEP_CLUSTER=1 leaves the cluster for inspection,
# ASSERT_TIMEOUT_SECONDS (default 600).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${ROOT}/scripts/deep-health-alert-e2e"
CLUSTER="${CLUSTER:-s3-o1}"
CTX="kind-${CLUSTER}"
ASSERT_TIMEOUT_SECONDS="${ASSERT_TIMEOUT_SECONDS:-600}"

PROMETHEUS_OPERATOR_VERSION="v0.82.2"
PROMETHEUS_OPERATOR_SHA256="6ca6245f81c4868b90411498549ad91c667d16b9e3f4b1f7898b3e7802b8d2e5"
WORK="$(mktemp -d)"
OUT="${WORK}/prometheus-operator-bundle.yaml"

cleanup() {
  rm -rf "${WORK}"
  if [ "${KEEP_CLUSTER:-0}" != "1" ] && [ "${CREATED_CLUSTER:-0}" = "1" ]; then
    kind delete cluster --name "${CLUSTER}" || true
  fi
}
trap cleanup EXIT

if [ ! -d "${ROOT}/packages/kn-next/dist" ] || [ ! -d "${ROOT}/packages/lib/dist" ]; then
  echo "packages/kn-next/dist or packages/lib/dist is missing — build the workspace packages first" >&2
  exit 2
fi

if kind get clusters | grep -qx "${CLUSTER}"; then
  echo "reusing kind cluster ${CLUSTER}"
else
  # The repo checkout is mounted into the node so the fixture pod runs the
  # working tree under test, with no image build in the loop.
  cat <<YAML | kind create cluster --name "${CLUSTER}" --wait 180s --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraMounts:
      - hostPath: ${ROOT}
        containerPath: /workspace
YAML
  CREATED_CLUSTER=1
fi

# Fetch, checksum-verify, then apply the prometheus-operator release bundle. A
# moved or edited release asset fails the checksum before anything is applied.
curl -fsSL -o "${OUT}" \
  "https://github.com/prometheus-operator/prometheus-operator/releases/download/${PROMETHEUS_OPERATOR_VERSION}/bundle.yaml"
echo "${PROMETHEUS_OPERATOR_SHA256}  ${OUT}" | sha256sum -c -
kubectl --context "${CTX}" apply --server-side -f "${OUT}"
kubectl --context "${CTX}" wait --for=condition=Established --timeout=120s \
  crd/podmonitors.monitoring.coreos.com crd/prometheusrules.monitoring.coreos.com \
  crd/prometheuses.monitoring.coreos.com
kubectl --context "${CTX}" -n default rollout status deployment/prometheus-operator --timeout=180s

kubectl --context "${CTX}" apply -f "${DIR}/prometheus.yaml"

# THE SHIPPED MANIFESTS, unmodified. The PodMonitor is authored for the `system`
# namespace of the operator's deploy overlay; the rule has no namespace.
kubectl --context "${CTX}" apply -f "${ROOT}/packages/kn-next-operator/config/prometheus/app-podmonitor.yaml"
kubectl --context "${CTX}" -n system apply -f "${ROOT}/packages/kn-next-operator/config/observability/prometheusrule.yaml"

kubectl --context "${CTX}" apply -f "${DIR}/fixture-app.yaml"
kubectl --context "${CTX}" -n deep-health-e2e rollout status deployment/e2e-app --timeout=300s
kubectl --context "${CTX}" -n monitoring wait --for=condition=Ready pod/prometheus-e2e-0 --timeout=300s

node "${DIR}/assert-alert.mjs" "${CTX}" "${ASSERT_TIMEOUT_SECONDS}"
