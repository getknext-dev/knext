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
#   scripts/prereqs/install.sh --context <name>   # install into that cluster
#   scripts/prereqs/install.sh --yes              # install into the CURRENT context (CI)
#   scripts/prereqs/install.sh                    # interactive: shows the context, asks to confirm
#   ... --verify   only assert everything is Ready
#   scripts/prereqs/install.sh --print            # print the pinned versions and exit
#
# Wrong-cluster protection: a non-interactive run needs --context or --yes; the
# target context is always printed first. --context is applied to every kubectl
# call (including the helpers') via a PATH shim, never by switching your
# current context.
#
# Needs: kubectl, curl, jq, and sha256sum or shasum (macOS).
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

MODE=install
CTX=""
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --print)
      echo "knative=${KNATIVE_VERSION} cert-manager=${CERT_MANAGER_VERSION}"
      exit 0
      ;;
    --verify) MODE=verify ;;
    --yes) YES=1 ;;
    --context)
      CTX="${2:?--context needs a name}"
      shift
      ;;
    --context=*) CTX="${1#--context=}" ;;
    *)
      echo "usage: install.sh [--context <name>] [--yes] [--verify|--print]" >&2
      exit 2
      ;;
  esac
  shift
done

# Gate first, before touching anything: no silent installs into whatever the
# current context happens to be.
if [ -z "$CTX" ] && [ "$YES" != 1 ] && ! [ -t 0 ]; then
  echo "prereqs: refusing to run non-interactively without --context <name> or --yes (target would be the current kubectl context)" >&2
  exit 2
fi

for tool in kubectl curl jq; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "prereqs: required tool '$tool' not found on PATH" >&2
    exit 3
  }
done

SHIMS="$(mktemp -d)"
trap 'rm -r "$SHIMS"' EXIT
REAL_KUBECTL="$(command -v kubectl)"

# macOS (and some minimal images) have no sha256sum; shasum -a 256 verifies the
# same "<hash>  <file>" lines, so the checksums stay enforced either way.
if [ "${PREREQS_FORCE_SHA_FALLBACK:-}" = 1 ] || ! command -v sha256sum >/dev/null 2>&1; then
  if ! command -v shasum >/dev/null 2>&1; then
    echo "prereqs: neither sha256sum nor shasum found; one is required to verify the pinned manifest checksums" >&2
    exit 3
  fi
  REAL_SHASUM="$(command -v shasum)"
  printf '#!/bin/sh\nexec "%s" -a 256 "$@"\n' "$REAL_SHASUM" >"$SHIMS/sha256sum"
  chmod +x "$SHIMS/sha256sum"
fi

if [ -n "$CTX" ]; then
  printf '#!/bin/sh\nexec "%s" --context "%s" "$@"\n' "$REAL_KUBECTL" "$CTX" >"$SHIMS/kubectl"
  chmod +x "$SHIMS/kubectl"
fi
PATH="$SHIMS:$PATH"
export PATH

TARGET="$CTX"
[ -n "$TARGET" ] || TARGET="$(kubectl config current-context 2>/dev/null || true)"
echo "prereqs: target kubectl context: ${TARGET:-<none>}" >&2
[ -n "$TARGET" ] || {
  echo "prereqs: no kubectl context selected" >&2
  exit 2
}

if [ -z "$CTX" ] && [ "$YES" != 1 ]; then
  printf 'Install into context "%s"? [y/N] ' "$TARGET" >&2
  read -r answer
  case "$answer" in
    y | Y | yes) ;;
    *)
      echo "prereqs: aborted" >&2
      exit 2
      ;;
  esac
fi

if [ "$MODE" = verify ]; then
  verify
  exit 0
fi

"${HELPERS}/apply-cert-manager.sh"
"${HELPERS}/apply-knative-kourier.sh" "${KNATIVE_VERSION}"
kubectl patch configmap/config-network \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'

verify
