#!/usr/bin/env bash
# #1594 round 2: `kubectl wait --for=condition=Ready certificate/...` plus
# `kubectl wait --for=jsonpath=...` on the webhook Service's Endpoints (round
# 1) still leaves a race. Evidence from the round-1 PR's own run
# (36375801475): the operator logged "Serving webhook server {port: 9443}"
# at 04:05:22, BOTH round-1 waits passed, and the bun leg's first NextApp
# apply still failed at 04:05:33 with "the NextApp admission webhook could
# not be reached". A Ready Certificate and a routable Endpoint prove the pod
# is up; they prove nothing about whether cert-manager's cainjector has
# actually PATCHED the caBundle into the ValidatingWebhookConfiguration (a
# separate, asynchronous controller loop watching the Certificate's Secret),
# nor whether the apiserver's own webhook client can complete a TLS
# handshake against that just-issued cert. Close the residual window with
# two more waits that check the ACTUAL failure mode instead of a proxy for
# it:
#
#   1. poll the ValidatingWebhookConfiguration until its caBundle is
#      non-empty (cainjector's half of the race);
#   2. actually EXERCISE the apiserver -> webhook call with a server-side
#      dry-run apply of a minimal, otherwise-valid NextApp, retried until it
#      succeeds -- the same call shape `kn-next deploy`'s own preflight
#      makes (packages/kn-next/src/cli/schema/preflight.ts), proving the
#      whole chain works before the lane's first REAL apply.
#
# No cluster resource is created: `--dry-run=server` validates and discards.
set -euo pipefail

VWC="kn-next-operator-validating-webhook-configuration"
OPERATOR_NS="kn-next-operator-system"
PROBE_NS="default"
CABUNDLE_TIMEOUT_S=120
PROBE_TIMEOUT_S=120
POLL_INTERVAL_S=3

echo "Waiting for cert-manager's cainjector to patch caBundle into ${VWC}..."
cabundle=""
deadline=$(( $(date +%s) + CABUNDLE_TIMEOUT_S ))
while true; do
  cabundle="$(kubectl get validatingwebhookconfiguration "$VWC" \
    -o jsonpath='{.webhooks[0].clientConfig.caBundle}' 2>/dev/null || true)"
  [ -n "$cabundle" ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::caBundle was never injected into ${VWC} within ${CABUNDLE_TIMEOUT_S}s"
    kubectl get validatingwebhookconfiguration "$VWC" -o yaml || true
    exit 1
  fi
  sleep "$POLL_INTERVAL_S"
done
echo "caBundle present (${#cabundle} chars)."

probe_manifest="$(mktemp)"
probe_log="$(mktemp)"
trap 'rm -f "$probe_manifest" "$probe_log"' EXIT
cat > "$probe_manifest" <<'YAML'
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: webhook-readiness-probe
spec:
  # Digest-pinned and otherwise well-formed on purpose: a REJECTION from our
  # own validation logic (a fast in-process check, see
  # internal/webhook/v1alpha1/nextapp_webhook.go) must never be confused with
  # the apiserver failing to REACH the webhook at all -- only the latter is
  # this probe's failure mode.
  image: "registry.example.com/webhook-readiness-probe:v1@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  scaling:
    minScale: 0
    maxScale: 1
  storage:
    provider: "gcs"
    bucket: "webhook-readiness-probe"
  cache:
    provider: "redis"
    url: "redis://redis.default.svc.cluster.local.:6379"
YAML

echo "Probing the apiserver -> webhook call path (server-side dry-run apply)..."
deadline=$(( $(date +%s) + PROBE_TIMEOUT_S ))
while true; do
  if kubectl apply --dry-run=server -f "$probe_manifest" -n "$PROBE_NS" >"$probe_log" 2>&1; then
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::the NextApp admission webhook never became reachable within ${PROBE_TIMEOUT_S}s"
    cat "$probe_log" || true
    kubectl get validatingwebhookconfiguration "$VWC" -o yaml || true
    kubectl -n "$OPERATOR_NS" get endpoints kn-next-operator-webhook-service -o yaml || true
    kubectl -n "$OPERATOR_NS" logs deploy/kn-next-operator-controller-manager --tail=100 || true
    exit 1
  fi
  sleep "$POLL_INTERVAL_S"
done
echo "Webhook reachable -- dry-run apply of the probe NextApp succeeded."
