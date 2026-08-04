#!/bin/bash
# Run a shell command in the HOST namespace of one node, as a TTL'd Job.
#
#   nodesh.sh <node> '<shell command>'
#
# Why a Job and not `kubectl debug node/...`: the Job carries
# ttlSecondsAfterFinished, so it reaps itself and the harness never needs a
# `kubectl delete` (deletes are human-gated in this repo).
#
# The command is base64'd into the pod spec so quoting/pipes survive YAML.
#
# This is the ONLY part of the harness that touches a node directly. It exists
# because the no-prewarm arm has to make the app image genuinely absent from the
# node image cache — the whole point of the measurement — and nothing in the
# Kubernetes API can evict a cached image. It only ever removes the image the
# harness itself published (a dedicated repository), never a pre-existing one.
set -euo pipefail

NODE="$1"
shift
CMD="$*"
CTX_ARGS=()
[ -n "${KUBE_CONTEXT:-}" ] && CTX_ARGS=(--context "$KUBE_CONTEXT")
NS="${NAMESPACE:-knext-prewarm}"
B64=$(printf '%s' "$CMD" | base64 | tr -d '\n')
NAME="nodesh-$(echo "$NODE" | tr '.' '-')-$RANDOM$RANDOM"
TMP="$(mktemp -t nodesh)"

cat > "$TMP" <<YAML
apiVersion: batch/v1
kind: Job
metadata:
  name: $NAME
  namespace: $NS
  labels:
    knext.dev/benchmark: image-prewarm
spec:
  ttlSecondsAfterFinished: 60
  backoffLimit: 0
  template:
    metadata:
      labels:
        knext.dev/benchmark: image-prewarm
    spec:
      nodeName: $NODE
      hostPID: true
      hostNetwork: true
      restartPolicy: Never
      tolerations: [{operator: Exists}]
      containers:
      - name: sh
        image: ${NODESH_IMAGE:-alpine:3.20}
        command: ["nsenter","-t","1","-m","-u","-i","-n","-p","--","sh","-c","echo $B64 | base64 -d | sh"]
        securityContext: {privileged: true}
        resources: {requests: {cpu: 5m, memory: 16Mi}}
YAML

kubectl apply -f "$TMP" "${CTX_ARGS[@]}" --validate=strict >/dev/null
rm -f "$TMP"
kubectl wait --for=condition=complete "job/$NAME" -n "$NS" "${CTX_ARGS[@]}" --timeout=240s >/dev/null 2>&1 || true
kubectl logs "job/$NAME" -n "$NS" "${CTX_ARGS[@]}" 2>&1
