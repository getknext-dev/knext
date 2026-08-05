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
# Kubernetes API can evict a cached image.
#
# SCOPE OF WHAT IT REMOVES, stated as the code actually enforces it: the caller
# (`lib.mjs`) selects image ids by an EXACT match on the repository column
# (`awk '$1 == repo'`). It used to be `crictl images | grep ${REPO}`, an
# unanchored substring match — with `REPO=…/pw` that also matched `…/pw-app` and
# `…/pwx`, and the eviction loop then removed by image ID, dropping every
# reference to content the harness does not own, on a cluster that carries other
# work's images. Exact-match is the guarantee; the sentence is downstream of it.
set -euo pipefail

NODE="$1"
shift
CMD="$*"

# The node name lands in `nodeName:` and in a Job name, both interpolated into
# YAML — and the command itself runs as root under `nsenter -t 1` on that node.
# Defence in depth: lib.mjs validates the same shape before calling this.
case "$NODE" in
  *[!a-z0-9.-]* | "" | [!a-z0-9]*)
    echo "nodesh.sh: refusing node name '$NODE' (expected a DNS-1123 name)" >&2
    exit 2
    ;;
esac
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
        # Digest-pinned like every other image this repo runs (security.md), and
        # this one especially: it is a PRIVILEGED, hostPID pod that nsenters the
        # host. The whole finding this harness produced is that the artifact
        # behind a tag is mutable and load-bearing.
        # Bump with: crane digest alpine:<tag>
        image: ${NODESH_IMAGE:-alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc}
        command: ["nsenter","-t","1","-m","-u","-i","-n","-p","--","sh","-c","echo $B64 | base64 -d | sh"]
        securityContext: {privileged: true}
        resources: {requests: {cpu: 5m, memory: 16Mi}}
YAML

kubectl apply -f "$TMP" "${CTX_ARGS[@]}" --validate=strict >/dev/null
rm -f "$TMP"
kubectl wait --for=condition=complete "job/$NAME" -n "$NS" "${CTX_ARGS[@]}" --timeout=240s >/dev/null 2>&1 || true
kubectl logs "job/$NAME" -n "$NS" "${CTX_ARGS[@]}" 2>&1
