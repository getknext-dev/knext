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

# EVERY value interpolated into the pod spec below is validated here. That is
# stated as a rule rather than as a list because the list is how this went
# wrong: the image was hardened in 64 lines while `$NAMESPACE`, the third
# interpolated value in the SAME privileged hostPID spec, went in untouched —
# `NAMESPACE=$'default\n  labels:\n    evil: yes'` injected arbitrary YAML into
# an applied Job. tests/image-prewarm-harness.test.ts SCANS the heredoc for
# `$VAR` and fails on any without a proof, so a new one cannot be forgotten.
#
# Character sets are ENUMERATED, never written as the range `[!a-z0-9]`: `case`
# glob ranges use the locale's COLLATION order, in which `a-z` spans `aAbBcC…`
# and therefore silently admits uppercase. The digest check below learned this
# the hard way (it accepted `sha256:AAAA…`); the same lesson applies here.

# The node name lands in `nodeName:` and in a Job name, both interpolated into
# YAML — and the command itself runs as root under `nsenter -t 1` on that node.
# Defence in depth: lib.mjs validates the same shape before calling this.
case "$NODE" in
  *[!0123456789abcdefghijklmnopqrstuvwxyz.-]* | "" | [!0123456789abcdefghijklmnopqrstuvwxyz]*)
    echo "nodesh.sh: refusing node name '$NODE' (expected a DNS-1123 name)" >&2
    exit 2
    ;;
esac

# `NODESH_IMAGE` lands in the SAME privileged, hostPID pod spec three lines
# below the node name that is validated above, so it gets the same treatment:
# it is a YAML-injection point into a spec that nsenters the host as root, and
# an unvalidated override is also an escape hatch around the digest pin — a pin
# anyone can replace with a tag is advisory. `lib.mjs` validates `PW_IMAGE` for
# exactly this reason ("it reaches a root shell"); this is that rule applied to
# the harness's own image. Shape enforced: [registry[:port]/]path:tag@sha256:<64 hex>.
NODESH_IMAGE="${NODESH_IMAGE:-alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc}"
reject_image() {
  echo "nodesh.sh: refusing NODESH_IMAGE '$NODESH_IMAGE' ($1)" >&2
  echo "nodesh.sh: expected [registry[:port]/]path:tag@sha256:<64 hex> — it is interpolated into a" >&2
  echo "nodesh.sh: privileged hostPID pod spec, so anything else is rejected rather than escaped." >&2
  exit 2
}
# `:-` above substitutes the pinned default for UNSET *and EMPTY*, so there is no
# empty case to reject here — an empty override falls back to the pin, which is
# the safe direction. Everything else is checked.
# ENUMERATED, per the rule stated above — this pair shipped as the range form
# `[!a-zA-Z0-9._/:@-]`, i.e. the file broke its own invariant 30 lines below the
# sentence stating it. It was not exploitable (both forms rejected newline, tab,
# CR, space, `;`, `"`, `{`, `,`, `+`, `é` and `$` under glibc `C`, en_US.UTF-8
# and macOS), but "not exploitable under the locales we happened to test" is the
# guarantee the enumerated form makes unnecessary. tests/image-prewarm-harness.test.ts
# SCANS every `[!…]` class in this file for a range, so the rule is now a gate.
case "$NODESH_IMAGE" in
  *[!0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ._/:@-]* | *' '*) reject_image "illegal character" ;;
  [!0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ]*) reject_image "must start with an alphanumeric" ;;
  *@sha256:*) ;;
  *) reject_image "not digest-pinned" ;;
esac
NODESH_DIGEST="${NODESH_IMAGE##*@sha256:}"
# The hex set is ENUMERATED, not written as the range `[!0-9a-f]`: `case` glob
# ranges use the locale's COLLATION order, in which `a-f` spans `AbBcC…` — so
# the range form accepted `sha256:AAAA…`, a digest no registry serves, and the
# check reported nothing. Measured, not theorised: that case is in the suite.
case "$NODESH_DIGEST" in
  *[!0123456789abcdef]*) reject_image "digest is not lowercase hex" ;;
esac
[ "${#NODESH_DIGEST}" -eq 64 ] || reject_image "digest is not 64 hex characters"
# Exactly one `@`: `a@sha256:<64>@sha256:<64>` would otherwise pass on its tail.
NODESH_NAME="${NODESH_IMAGE%@sha256:*}"
case "$NODESH_NAME" in
  *@*) reject_image "more than one '@'" ;;
esac
# The tag must be in the LAST path segment — `reg.example.com:5000/app` has a
# colon and no tag, and a digest with no tag states no intent, so nothing can
# resolve it (scripts/verify-image-pins.mjs reports exactly that as `no-tag`).
case "${NODESH_NAME##*/}" in
  *:?*) ;;
  *) reject_image "no tag — a tag is what makes the pin auditable" ;;
esac

CTX_ARGS=()
[ -n "${KUBE_CONTEXT:-}" ] && CTX_ARGS=(--context "$KUBE_CONTEXT")
# bash < 4.4 (macOS ships 3.2 as /bin/bash) treats "${arr[@]}" on an EMPTY array
# as an unbound variable under `set -u`, so every invocation without
# KUBE_CONTEXT died on its first kubectl call with "CTX_ARGS[@]: unbound
# variable". The `${a[@]+…}` form expands to nothing when the array is empty and
# is portable to both; it is used at every kubectl call below.

# `$NAMESPACE` lands in `namespace: $NS`, in the same spec and with the same
# consequences as the two values already validated above. A DNS-1123 LABEL is
# the whole grammar Kubernetes allows for a namespace, so anything else is
# rejected rather than escaped.
NS="${NAMESPACE:-knext-prewarm}"
reject_ns() {
  echo "nodesh.sh: refusing namespace '$NS' ($1)" >&2
  echo "nodesh.sh: expected a DNS-1123 label — it is interpolated into a privileged hostPID pod" >&2
  echo "nodesh.sh: spec that nsenters the host as root, so anything else is rejected." >&2
  exit 2
}
case "$NS" in
  *[!0123456789abcdefghijklmnopqrstuvwxyz-]*) reject_ns "illegal character" ;;
  "") reject_ns "empty" ;;
  -* | *-) reject_ns "must start and end with an alphanumeric" ;;
esac
[ "${#NS}" -le 63 ] || reject_ns "longer than the 63-character DNS-1123 label limit"

B64=$(printf '%s' "$CMD" | base64 | tr -d '\n')
NAME="nodesh-$(echo "$NODE" | tr '.' '-')-$RANDOM$RANDOM"
# `mktemp -t nodesh` is BSD syntax. GNU coreutils — every Linux CI runner, and
# every Linux host this harness is driven from — requires at least three
# trailing `X` and otherwise fails with "too few X's in template". Under
# `set -e` that killed nodesh.sh BEFORE its `kubectl apply`, so the no-prewarm
# arm's image eviction never ran at all while every macOS run stayed green.
# The explicit template is accepted by both.
TMP="$(mktemp "${TMPDIR:-/tmp}/nodesh.XXXXXX")"

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
        # behind a tag is mutable and load-bearing — which is why the tag is kept
        # alongside the digest and resolved against it by
        # scripts/verify-image-pins.mjs, and why the value is VALIDATED above
        # before it reaches this spec.
        # Bump with: crane digest alpine:<tag>
        image: $NODESH_IMAGE
        command: ["nsenter","-t","1","-m","-u","-i","-n","-p","--","sh","-c","echo $B64 | base64 -d | sh"]
        securityContext: {privileged: true}
        resources: {requests: {cpu: 5m, memory: 16Mi}}
YAML

kubectl apply -f "$TMP" ${CTX_ARGS[@]+"${CTX_ARGS[@]}"} --validate=strict >/dev/null
rm -f "$TMP"
kubectl wait --for=condition=complete "job/$NAME" -n "$NS" ${CTX_ARGS[@]+"${CTX_ARGS[@]}"} --timeout=240s >/dev/null 2>&1 || true
kubectl logs "job/$NAME" -n "$NS" ${CTX_ARGS[@]+"${CTX_ARGS[@]}"} 2>&1
