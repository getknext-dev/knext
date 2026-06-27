#!/usr/bin/env bash
# set-ingress-class.sh — override the Knative Serving ingress-class in a knext bundle.
#
# Why (#45 / #46): the operator install bundle ships a `config-network` ConfigMap that
# pins the ingress-class to Kourier (kourier.ingress.networking.knative.dev), the
# default networking layer. Clusters whose Knative install uses **net-istio** or
# **Contour** need a different class. Rather than hand-edit the rendered manifest, run
# this after `make build-installer` (it mirrors the release-time digest substitution):
#
#   make build-installer
#   ./hack/set-ingress-class.sh dist/install.yaml istio.ingress.networking.knative.dev   # Istio
#   ./hack/set-ingress-class.sh dist/install.yaml contour.ingress.networking.knative.dev # Contour
#   kubectl apply --server-side -f dist/install.yaml
#
# With no class argument it (re)asserts the Kourier default — a safe no-op for the
# out-of-box bundle. The file is rewritten in place.
#
# Common ingress-class values (full controller-qualified form is REQUIRED — short
# forms do not match and leave routes unprogrammed):
#   Kourier : kourier.ingress.networking.knative.dev   (default)
#   Istio   : istio.ingress.networking.knative.dev
#   Contour : contour.ingress.networking.knative.dev
set -euo pipefail

DEFAULT_CLASS="kourier.ingress.networking.knative.dev"

file="${1:-}"
class="${2:-${INGRESS_CLASS:-$DEFAULT_CLASS}}"

if [[ -z "$file" ]]; then
  echo "usage: $0 <bundle.yaml> [ingress-class]" >&2
  echo "       (ingress-class defaults to \$INGRESS_CLASS or $DEFAULT_CLASS)" >&2
  exit 2
fi
if [[ ! -f "$file" ]]; then
  echo "error: file not found: $file" >&2
  exit 1
fi

# Rewrite only the `ingress-class:` data key (any current full-form value). We match
# the indented key as it appears under a ConfigMap's `data:` block.
if ! grep -Eq '^[[:space:]]+ingress-class:[[:space:]]' "$file"; then
  echo "error: no 'ingress-class:' key found in $file (was the bundle rendered with the config-network ConfigMap?)" >&2
  exit 1
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
# Preserve the original indentation; replace everything after the colon.
sed -E "s|^([[:space:]]+ingress-class:[[:space:]]*).*$|\1${class}|" "$file" > "$tmp"
mv "$tmp" "$file"
trap - EXIT

echo "set ingress-class = ${class} in ${file}"
