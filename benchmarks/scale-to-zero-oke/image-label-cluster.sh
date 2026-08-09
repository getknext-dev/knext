#!/usr/bin/env bash
#
# image-label-cluster.sh <image-ref> <label-key>
#
# An IMAGE_LABEL_RESOLVER for run.sh that reads an image label FROM INSIDE THE
# CLUSTER, for the case where the registry is reachable from the cluster but not
# from the host running the benchmark.
#
# WHY THIS EXISTS. run.sh enforces ADR-0036 condition A1 ("same application on
# both arms") by comparing an image label across the two arms, and it aborts the
# whole A/B when it cannot read one — correctly, because an unreadable label must
# never be mistaken for an agreeing one. Measured 2026-08-09: OCIR is unreachable
# from this workstation. Not unauthenticated — UNREACHABLE: `crane config` hangs
# to a 45 s external timeout with zero bytes, and `docker manifest inspect` hangs
# on the same ref, which rules out crane and credentials as the cause.
#
# The cluster does not have that problem: it pulls those exact images. So the
# lookup runs there, as a short-lived Job, using the SAME pull secret the
# workload uses — which is also what makes the answer trustworthy. A label read
# with different credentials than the deployment used is a label read from a
# possibly different image.
#
# Contract (what run.sh expects): print the label value on stdout, exit 0. Print
# nothing and exit 0 if the label is absent. Exit non-zero on any failure to
# look it up. "Absent" and "could not look it up" are different facts and run.sh
# reports them differently; do not collapse them here.
#
#   env: BENCH_CONTEXT     kube context            (default: current context)
#        BENCH_NAMESPACE   namespace with the pull secret (default: default)
#        BENCH_PULL_SECRET dockerconfigjson secret (default: ocir-secret)
#        BENCH_CRANE_IMAGE resolver image          (default: pinned below)
#        BENCH_JOB_TIMEOUT seconds to wait         (default: 90)
set -uo pipefail

REF="${1:-}"; KEY="${2:-}"
[ -n "$REF" ] && [ -n "$KEY" ] || { echo "usage: $0 <image-ref> <label-key>" >&2; exit 2; }

CTX="${BENCH_CONTEXT:-}"
NS="${BENCH_NAMESPACE:-default}"
SECRET="${BENCH_PULL_SECRET:-ocir-secret}"
# Digest-pinned per security.md ("pin images by digest; reject :latest").
CRANE_IMAGE="${BENCH_CRANE_IMAGE:-gcr.io/go-containerregistry/crane:v0.21.7@sha256:3a62904867999848c5b16bb9b1eb8b2a7bbaa6061203a90037c91bf33b6b567e}"
TIMEOUT="${BENCH_JOB_TIMEOUT:-90}"

kc() { if [ -n "$CTX" ]; then kubectl --context "$CTX" "$@"; else kubectl "$@"; fi; }

JOB="knext-imglabel-$(date +%s)-$RANDOM"

# NO `kubectl delete` HERE, DELIBERATELY. `block-dangerous-bash.sh` gates deletes
# on a human because the operator is the single source of truth (ADR-0001), and a
# script that shells out to one from inside would route around that guard rather
# than honour it — the guard inspects the command a human ran, not what it spawns.
# `ttlSecondsAfterFinished` below has the Job reaped by the cluster instead, which
# is the same outcome without the bypass, and survives this script being killed.

# `crane config` writes the image config JSON to stdout. The label is extracted
# HOST-SIDE with jq so the in-cluster image stays a plain distroless crane with
# no shell — nothing to inject a key name into.
manifest=$(cat <<YAML
apiVersion: batch/v1
kind: Job
metadata:
  name: ${JOB}
  namespace: ${NS}
  labels: { app.kubernetes.io/managed-by: knext-bench }
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 120
  template:
    metadata:
      labels: { app.kubernetes.io/managed-by: knext-bench }
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      containers:
        - name: crane
          image: ${CRANE_IMAGE}
          args: ["config", "${REF}"]
          env:
            - name: DOCKER_CONFIG
              value: /docker-cfg
          volumeMounts:
            - name: pull-secret
              mountPath: /docker-cfg
              readOnly: true
          resources:
            requests: { cpu: 50m, memory: 64Mi }
      volumes:
        - name: pull-secret
          secret:
            secretName: ${SECRET}
            items:
              - key: .dockerconfigjson
                path: config.json
YAML
)

printf '%s' "$manifest" | kc apply -f - >/dev/null 2>&1 || {
  echo "cluster-side resolver: could not create Job ${JOB} in ${NS}" >&2; exit 1; }

if ! kc wait --for=condition=complete "job/${JOB}" -n "$NS" --timeout="${TIMEOUT}s" >/dev/null 2>&1; then
  # Distinguish "the Job failed" from "it is still running" — a timeout on a
  # slow registry and a hard failure need different responses.
  state=$(kc get job "$JOB" -n "$NS" -o jsonpath='{.status.conditions[*].type}' 2>/dev/null)
  logs=$(kc logs "job/${JOB}" -n "$NS" --tail=5 2>&1 | tr '\n' ' ')
  echo "cluster-side resolver: Job ${JOB} did not complete within ${TIMEOUT}s (conditions='${state:-none}'): ${logs:-<no logs>}" >&2
  exit 1
fi

cfg=$(kc logs "job/${JOB}" -n "$NS" 2>/dev/null)
[ -n "$cfg" ] || { echo "cluster-side resolver: Job ${JOB} completed but produced no output" >&2; exit 1; }

# A malformed config is a lookup FAILURE, not an absent label.
printf '%s' "$cfg" | jq -e . >/dev/null 2>&1 || {
  echo "cluster-side resolver: output is not JSON (first 120 chars): $(printf '%s' "$cfg" | head -c 120)" >&2; exit 1; }

printf '%s' "$cfg" | jq -r --arg k "$KEY" '.config.Labels[$k] // ""'
