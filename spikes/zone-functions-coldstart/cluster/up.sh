#!/usr/bin/env bash
# Z2 spike: bring up a throwaway kind cluster with cert-manager, Knative Serving
# 1.16 + Kourier and the knext operator built from this tree. Mirrors the
# standalone-deploy-kind-e2e.yml setup. Local kind ONLY.
#
# The kubeconfig is written to a private file ($Z2_KUBECONFIG) so no command in
# this spike can reach a remote cluster through the user's default context.
set -euo pipefail

CLUSTER="${Z2_CLUSTER:-knext-z2-coldstart}"
export KUBECONFIG="${Z2_KUBECONFIG:?set Z2_KUBECONFIG to a private kubeconfig path}"
REG="${Z2_REGISTRY_CONTAINER:-kind-registry-39}"   # an existing registry:2 on the kind network, host port 5001
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

if ! kind get clusters | grep -qx "$CLUSTER"; then
  cat <<'YAML' | kind create cluster --name "$CLUSTER" --kubeconfig "$KUBECONFIG" --wait 180s --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
containerdConfigPatches:
- |-
  [plugins."io.containerd.grpc.v1.cri".registry]
    config_path = "/etc/containerd/certs.d"
YAML
fi

ctx="$(kubectl config current-context)"
[ "$ctx" = "kind-${CLUSTER}" ] || { echo "refusing: context is $ctx" >&2; exit 1; }

node="${CLUSTER}-control-plane"
docker network connect kind "$REG" 2>/dev/null || true
docker exec "$node" mkdir -p /etc/containerd/certs.d/localhost:5001
printf '[host."http://%s:5000"]\n  capabilities = ["pull", "resolve"]\n' "$REG" \
  | docker exec -i "$node" cp /dev/stdin /etc/containerd/certs.d/localhost:5001/hosts.toml

"$REPO_ROOT/scripts/kind-manifests/apply-cert-manager.sh"
kubectl wait --for=condition=Available --timeout=300s \
  -n cert-manager deployment/cert-manager deployment/cert-manager-webhook deployment/cert-manager-cainjector

"$REPO_ROOT/scripts/kind-manifests/apply-knative-kourier.sh" knative-v1.16.0
kubectl patch configmap/config-network -n knative-serving --type merge \
  --patch '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'
kubectl wait --for=condition=Available --timeout=300s \
  -n knative-serving deployment/controller deployment/webhook deployment/autoscaler deployment/net-kourier-controller

# Faster scale-to-zero so a cold sample does not cost a minute of waiting.
# This changes only how soon a pod is removed, not how a cold start proceeds.
kubectl patch configmap/config-autoscaler -n knative-serving --type merge \
  --patch '{"data":{"stable-window":"10s","scale-to-zero-grace-period":"10s","scale-to-zero-pod-retention-period":"0s"}}'

cd "$REPO_ROOT/packages/kn-next-operator"
IMG=example.com/kn-next-operator:z2
make docker-build IMG="$IMG"
kind load docker-image "$IMG" --name "$CLUSTER"
make install
make deploy IMG="$IMG"
kubectl rollout status deployment/kn-next-operator-controller-manager -n kn-next-operator-system --timeout=300s
kubectl wait --for=condition=Ready --timeout=180s -n kn-next-operator-system certificate/kn-next-operator-serving-cert
"$REPO_ROOT/scripts/kind-manifests/wait-for-webhook-ready.sh"
# Namespace + the in-cluster client pod every timed request is issued from.
kubectl create namespace z2 --dry-run=client -o yaml | kubectl apply -f -
kubectl run z2-drv -n z2 --image=curlimages/curl:8.16.0 --restart=Always --command -- sleep infinity 2>/dev/null || true
kubectl wait -n z2 --for=condition=Ready pod/z2-drv --timeout=180s
echo "cluster $CLUSTER ready"
