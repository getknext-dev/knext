#!/usr/bin/env bash
# One-command, pinned install of the knext cluster prerequisites:
# cert-manager, Knative Serving and the Kourier ingress layer.
#
# Every manifest is sha256-verified and every mutable-tag image digest-pinned by
# the shared helpers in scripts/kind-manifests/ (the same ones CI installs with),
# so what you install here is byte-for-byte what knext's CI tests. The versions
# are pinned in those helpers; this script only composes them, waits for
# readiness, and can re-check the result.
#
# Idempotent: every step is a `kubectl apply` or a merge patch, so re-running on
# a cluster that already has the prerequisites converges and exits 0.
#
# Usage:
#   scripts/prereqs/install.sh            # install + wait until Ready
#   scripts/prereqs/install.sh --verify   # only assert everything is Ready
#   scripts/prereqs/install.sh --print    # print the pinned versions and exit
#
# Needs: kubectl (current context = target cluster), curl, jq, sha256sum.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPERS="${SCRIPT_DIR}/../kind-manifests"

# The bundle's version pins. The checksums live in the helpers and must move
# with these (tests/prereqs-bundle.test.ts enforces lockstep).
KNATIVE_VERSION="knative-v1.16.0"
CERT_MANAGER_VERSION="v1.16.2"
WAIT_TIMEOUT="${PREREQS_WAIT_TIMEOUT:-300s}"

verify() {
  kubectl wait --for=condition=Available --timeout="${WAIT_TIMEOUT}" \
    -n cert-manager deployment/cert-manager deployment/cert-manager-webhook deployment/cert-manager-cainjector
  kubectl wait --for=condition=Available --timeout="${WAIT_TIMEOUT}" \
    -n knative-serving deployment/controller deployment/webhook deployment/autoscaler deployment/activator
  kubectl wait --for=condition=Available --timeout="${WAIT_TIMEOUT}" \
    -n knative-serving deployment/net-kourier-controller
  kubectl wait --for=condition=Available --timeout="${WAIT_TIMEOUT}" \
    -n kourier-system deployment/3scale-kourier-gateway
  ingress="$(kubectl get configmap/config-network -n knative-serving -o jsonpath='{.data.ingress-class}')"
  if [ "$ingress" != "kourier.ingress.networking.knative.dev" ]; then
    echo "prereqs: config-network ingress-class is '${ingress}', expected kourier" >&2
    exit 1
  fi
  echo "prereqs: cert-manager ${CERT_MANAGER_VERSION}, Knative Serving ${KNATIVE_VERSION} and Kourier are Ready"
}

case "${1:-}" in
  --print)
    echo "knative=${KNATIVE_VERSION} cert-manager=${CERT_MANAGER_VERSION}"
    exit 0
    ;;
  --verify)
    verify
    exit 0
    ;;
  "") ;;
  *)
    echo "usage: install.sh [--verify|--print]" >&2
    exit 2
    ;;
esac

"${HELPERS}/apply-cert-manager.sh"
"${HELPERS}/apply-knative-kourier.sh" "${KNATIVE_VERSION}"
kubectl patch configmap/config-network \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'

verify
