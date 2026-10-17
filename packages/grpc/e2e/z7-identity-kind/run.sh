#!/usr/bin/env bash
# Z7 zone identity tokens, end to end on kind.
#
# The operator half of Z7 (the zone's signing key, its JWKS, rotation) is proved
# by unit and envtest tests that have no kubelet, no Knative and no pods. This
# runs it on a real cluster with the pieces that make it matter: the operator
# built from this checkout, a zone (a NextApp) bound to a Go and a Rust function
# (BackendServices) built from the templates, and a zone whose calls are made by
# the generated glue through the real signer. It proves, in order:
#
#   verify  1. the operator creates the zone's signing-key Secret and JWKS
#              ConfigMap, owned by the NextApp; a call from the zone's generated
#              glue succeeds with a real served token (Go: the generated query
#              and Server Action; Rust: the same signer);
#           2. a call with no token, a garbage token, a token from another key, a
#              forged kid, a token for another function, for another RPC, an
#              expired one and one from another issuer are all refused, each
#              next to a control that differs in that one property; the health
#              check is served without a token;
#           5. the function pod mounts no private key, takes the JWKS as a
#              directory volume (no subPath, no env), and the zone mounts the
#              key as a directory volume without the staged key;
#   rotate  3. a rotation by annotation publishes the new key, a WARM function
#              (same pod, no restart) accepts a token signed by it before the
#              switch, signing switches only after the propagation bound, the
#              zone's signer picks up the new key without a restart, tokens of
#              the previous key keep verifying during the overlap, and no call
#              through the zone fails at any point of the rotation;
#           4. retirement after the overlap: the previous key leaves the Secret
#              and the JWKS, and a warm function then refuses its tokens.
#   leaks      no key material in the operator's or the pods' logs, the events,
#              or the objects the operator publishes.
#
# What is NOT proved here, stated rather than implied:
#   - The overlap is a one-hour constant in the operator (no flag). Step 4
#     backdates the Secret's switched-at stamp by two hours and restarts the
#     operator, which re-derives the whole state from the Secret; the elapsed
#     time logic itself is covered by the operator's unit tests.
#   - NetworkPolicy enforcement needs a policy-capable CNI (that drill is
#     packages/kn-next-operator/test/networkpolicy-enforcement-drill.sh).
#   - The zone is a small Node server in front of the real generated glue, not a
#     built Next.js app: `use cache` is not active, the signer and the transport
#     are the real ones.
#   - OKE (a signed operator release candidate) is a separate, later run.
#
# Usage (from anywhere):
#   packages/grpc/e2e/z7-identity-kind/run.sh
# Env:
#   KIND_CLUSTER          kind cluster name (default knext-z7-e2e); created when
#                         missing, NEVER deleted by this script.
#   REGISTRY_NAME/PORT    the local image registry (default knext-z7-registry,
#                         5001): digests are required, so images go through one.
#   Z7_NAMESPACE          namespace for the zone and its functions (default
#                         z7-e2e). It is deleted and recreated each run, and
#                         only if this script created it (label).
#   Z7_PROPAGATION_BOUND  the operator's --zone-signing-key-propagation-bound
#                         (default 90s, the shipped default; the minimum is 60s).
#   Z7_WITH_RUST          1 (default) also builds and binds the Rust function.
#   PHASES                space-separated subset of: up images deploy verify
#                         rotate leaks (default: all, in that order).
#   INTERNAL_PORT         local port of the port-forward to Knative's cluster-local gateway.
set -euo pipefail
# This script handles private keys: it must never trace, and what it creates is
# private to the user.
set +x
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "${HERE}/../.." && pwd)"
REPO="$(cd "${PKG}/../.." && pwd)"
OPERATOR="${REPO}/packages/kn-next-operator"
PROBE="${HERE}/probe.ts"
NEEDLES="${HERE}/key-needles.ts"

CLUSTER="${KIND_CLUSTER:-knext-z7-e2e}"
REG_NAME="${REGISTRY_NAME:-knext-z7-registry}"
REG_PORT="${REGISTRY_PORT:-5001}"
NS="${Z7_NAMESPACE:-z7-e2e}"
BOUND="${Z7_PROPAGATION_BOUND:-90s}"
WITH_RUST="${Z7_WITH_RUST:-1}"
PHASES="${PHASES:-up images deploy verify rotate leaks}"
INTERNAL_PORT="${INTERNAL_PORT:-18080}"
KNATIVE_VERSION="${KNATIVE_VERSION:-knative-v1.16.0}"
REGISTRY_IMAGE='registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373'
OPERATOR_IMG='example.com/kn-next-operator:z7-build'
OPERATOR_NS='kn-next-operator-system'

case "${BOUND}" in
  [0-9]*s) BOUND_SECONDS="${BOUND%s}" ;;
  *) echo "Z7_PROPAGATION_BOUND must be whole seconds like 90s, got '${BOUND}'" >&2; exit 64 ;;
esac
[ "${BOUND_SECONDS}" -ge 60 ] || { echo "the operator refuses a bound below 60s" >&2; exit 64; }

ZONE=storefront
GO_FN=example-go          # the BackendService (and Knative Service) of the Go function
RUST_FN=inventory-rust    # the BackendService of the Rust function
ISSUER="knext:zone:${NS}/${ZONE}"
KEY_SECRET="${ZONE}-knext-signing-key"
JWKS_CM="${ZONE}-knext-jwks"
ZONE_HOST=""   # the zone's own host, read from its status.url once it has one
GO_HOST="${GO_FN}.${NS}.svc.cluster.local"
RUST_HOST="${RUST_FN}.${NS}.svc.cluster.local"
GO_AUD="knext:fn:${NS}/${GO_FN}"
RUST_AUD="knext:fn:${NS}/${RUST_FN}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/knext-z7-e2e.XXXXXX")"
STATE="${TMPDIR:-/tmp}/knext-z7-e2e-state-${CLUSTER}"
mkdir -p "${STATE}"
export KUBECONFIG="${WORK}/kubeconfig"
PIDS=()
WATCH_PID=""
FORWARDS_STARTED=0
PF_PIDS="${WORK}/pf.pids"

log() { printf '\n== %s\n' "$*"; }
ok() { printf 'ok: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
has_phase() { case " ${PHASES} " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
k() { kubectl "$@"; }

diagnostics() {
  # Never a Secret, never a token: object status, pod state and log tails only.
  echo "---- diagnostics (no Secret is read) ----" >&2
  k -n "${NS}" get nextapp,backendservice,ksvc,pods -o wide 2>&1 | tail -40 >&2 || true
  k -n "${NS}" get nextapp "${ZONE}" -o json 2>/dev/null | jq -c '.status.conditions // []' >&2 || true
  k -n "${NS}" get backendservice -o json 2>/dev/null | jq -c '[.items[] | {name: .metadata.name, c: .status.conditions}]' >&2 || true
  k -n "${NS}" logs -l "serving.knative.dev/service=${ZONE}" -c user-container --tail=30 >&2 2>&1 || true
  k -n "${NS}" logs -l "serving.knative.dev/service=${GO_FN}" -c function --tail=30 >&2 2>&1 || true
  k -n "${OPERATOR_NS}" logs deployment/kn-next-operator-controller-manager --tail=60 >&2 2>&1 || true
}

cleanup() {
  local rc=$?
  for pid in "${PIDS[@]:-}"; do
    [ -n "${pid}" ] && kill "${pid}" 2>/dev/null || true
  done
  if [ -f "${PF_PIDS}" ]; then
    while read -r pid; do kill "${pid}" 2>/dev/null || true; done <"${PF_PIDS}"
  fi
  if [ "${rc}" -ne 0 ]; then diagnostics; fi
  rm -rf "${WORK}"
  exit "${rc}"
}
trap cleanup EXIT

# ---------------------------------------------------------------- helpers

# wait_until <timeout-seconds> <interval-seconds> <description> <condition>
# The condition is a shell string, evaluated afresh on every attempt (a
# `$(...)` in it is re-run each time, which an argument list would not do).
wait_until() {
  local timeout=$1 interval=$2 desc=$3 cond=$4
  local end=$((SECONDS + timeout))
  until eval "${cond}" >/dev/null 2>&1; do
    [ "${SECONDS}" -lt "${end}" ] || fail "timed out after ${timeout}s waiting for: ${desc}"
    sleep "${interval}"
  done
}

epoch_of() { node -p 'Date.parse(process.argv[1]) / 1000' "$1"; }
now_s() { node -p 'Date.now() / 1000'; }

use_cluster() {
  kind get kubeconfig --name "${CLUSTER}" >"${KUBECONFIG}"
  local ctx
  ctx="$(kubectl config current-context)"
  [ "${ctx}" = "kind-${CLUSTER}" ] || fail "kubeconfig context is '${ctx}', want kind-${CLUSTER}"
}

secret_get() { # <field>: one data field of the zone's key Secret, decoded (kids only!)
  k -n "${NS}" get secret "${KEY_SECRET}" -o json | jq -r --arg f "$1" '.data[$f] // empty | @base64d'
}
secret_annotation() { k -n "${NS}" get secret "${KEY_SECRET}" -o json | jq -r --arg a "$1" '.metadata.annotations[$a] // empty'; }
jwks_kids() { k -n "${NS}" get configmap "${JWKS_CM}" -o json | jq -r '.data["jwks.json"] | fromjson | [.keys[].kid] | sort | join(",")'; }
zone_condition() { # <type>: "<status>/<reason>" of a condition on the NextApp
  k -n "${NS}" get nextapp "${ZONE}" -o json | jq -r --arg t "$1" '.status.conditions[]? | select(.type == $t) | "\(.status)/\(.reason)"'
}

# export_key <dir> <slot>: the Secret's <slot>.key/.kid as <dir>/current.key/.kid,
# the layout the signer reads. Written straight to files; nothing is printed.
export_key() {
  local dir=$1 slot=$2 json
  mkdir -p "${dir}"
  chmod 700 "${dir}"
  json="$(k -n "${NS}" get secret "${KEY_SECRET}" -o json)"
  jq -r --arg s "${slot}.key" '.data[$s] // empty | @base64d' <<<"${json}" >"${dir}/current.key"
  jq -r --arg s "${slot}.kid" '.data[$s] // empty | @base64d' <<<"${json}" >"${dir}/current.kid"
  chmod 600 "${dir}/current.key" "${dir}/current.kid"
  [ -s "${dir}/current.key" ] && [ -s "${dir}/current.kid" ] || fail "the Secret holds no ${slot} key"
}

# collect_operator_logs <file>: the logs of EVERY operator pod, previous
# containers included, appended to <file>. The operator runs several replicas and
# only the leader reconciles, so `kubectl logs deployment/...` (one pod, whichever
# it picks) would scan the wrong one and call it clean.
collect_operator_logs() {
  local pod
  for pod in $(k -n "${OPERATOR_NS}" get pods -l control-plane=controller-manager -o name); do
    k -n "${OPERATOR_NS}" logs "${pod}" --all-containers --tail=-1 >>"$1" 2>&1 || true
    k -n "${OPERATOR_NS}" logs "${pod}" --all-containers --previous --tail=-1 >>"$1" 2>&1 || true
  done
}

pair_kids() { printf '%s\n%s\n' "$1" "$2" | LC_ALL=C sort | paste -sd, -; }

# probe <args...>: one call to a function, one JSON line. Exit status 2 means the
# gateway could not be reached (a dropped port-forward): the forward is
# re-established and the call retried. A function that ANSWERS is never retried,
# so a refusal stays a refusal.
probe() {
  local attempt rc=0
  for attempt in 1 2 3; do
    rc=0
    bun "${PROBE}" --base "http://127.0.0.1:${INTERNAL_PORT}" "$@" || rc=$?
    [ "${rc}" = 2 ] || return "${rc}"
    ensure_forward
  done
  return "${rc}"
}

# probe_status <args...>: just the HTTP status of one probe call ("" if none).
probe_status() { probe "$@" 2>/dev/null | jq -r .status 2>/dev/null || true; }

# expect <description> <status> <code> <probe args...>
expect() {
  local desc=$1 want_status=$2 want_code=$3 out status code
  shift 3
  out="$(probe "$@")" || fail "${desc}: the function did not answer"
  status="$(jq -r .status <<<"${out}")"
  code="$(jq -r '.code // ""' <<<"${out}")"
  if [ "${status}" != "${want_status}" ] || [ "${code}" != "${want_code}" ]; then
    fail "${desc}: got status=${status} code=${code}; want status=${want_status} code=${want_code}"
  fi
  ok "${desc} (status=${status}${code:+ code=${code}})"
}

zone_call() { # <path?query>: sets ZC_STATUS / ZC_BODY from the zone, through the cluster-local gateway
  local out attempt
  for attempt in 1 2 3; do
    out="$(curl -s -m 30 -H "Host: ${ZONE_HOST}" -w '\n%{http_code}' "http://127.0.0.1:${INTERNAL_PORT}$1" 2>/dev/null)" || out=$'\n000'
    # 000 is curl's "no response": only a dropped port-forward gives it. The zone
    # answering with an error is a status, and is not retried.
    [ "${out##*$'\n'}" = 000 ] || break
    ensure_forward
  done
  ZC_STATUS="${out##*$'\n'}"
  ZC_BODY="${out%$'\n'*}"
}
zone_status() { # <path?query>: just the status of one request to the zone
  zone_call "$1"
  echo "${ZC_STATUS}"
}
expect_zone() { # <description> <path?query> <status> <jq filter that must hold>
  zone_call "$2"
  [ "${ZC_STATUS}" = "$3" ] || fail "$1: status ${ZC_STATUS}, want $3 (body: ${ZC_BODY})"
  jq -e "$4" <<<"${ZC_BODY}" >/dev/null || fail "$1: body does not satisfy $4 (body: ${ZC_BODY})"
  ok "$1"
}
zone_kid() { zone_call /kid; jq -r '.kid // ""' <<<"${ZC_BODY}"; }

pod_idents() { # <service>: "<uid> <restarts>" per live pod, sorted
  k -n "${NS}" get pods -l "serving.knative.dev/service=$1" -o json \
    | jq -r '.items[] | select(.metadata.deletionTimestamp == null) | "\(.metadata.uid) \([.status.containerStatuses[]?.restartCount] | add)"' | sort
}
pod_json() { # <service>: the single live pod of a service
  k -n "${NS}" get pods -l "serving.knative.dev/service=$1" -o json \
    | jq '[.items[] | select(.metadata.deletionTimestamp == null)] | if length == 1 then .[0] else error("want exactly one live pod, got \(length)") end'
}

forward_up() { (exec 3<>/dev/tcp/127.0.0.1/"${INTERNAL_PORT}") 2>/dev/null; }

# ensure_forward: a port-forward to Knative's cluster-local gateway, started if
# the port is not accepting. `kubectl port-forward` ends when its stream breaks,
# and a long lane must not fail an assertion because of that. Safe to call from
# the watcher's subshell: every pid it starts is written to a file the cleanup
# reads.
ensure_forward() {
  forward_up && return 0
  # kubectl itself, not the k() wrapper: `$!` of a backgrounded shell function is
  # the function's subshell, and killing that leaves kubectl holding the port.
  kubectl -n kourier-system port-forward svc/kourier-internal "${INTERNAL_PORT}:80" >>"${WORK}/pf-internal.log" 2>&1 &
  echo "$!" >>"${PF_PIDS}"
  wait_until 30 1 "port-forward on ${INTERNAL_PORT}" forward_up
}

start_forwards() {
  [ "${FORWARDS_STARTED}" = 1 ] && return 0
  FORWARDS_STARTED=1
  ensure_forward
  # The zone is reached the way its functions are: through the cluster-local
  # gateway, by the host name Knative gave it.
  ZONE_HOST="$(k -n "${NS}" get nextapp "${ZONE}" -o jsonpath='{.status.url}' 2>/dev/null | sed -E 's#^https?://##')"
  [ -n "${ZONE_HOST}" ] || fail "nextapp/${ZONE} has no status.url yet"
}

# ---------------------------------------------------------------- phase: up

phase_up() {
  log "kind cluster ${CLUSTER}"
  if ! kind get clusters 2>/dev/null | grep -qx "${CLUSTER}"; then
    cat <<'YAML' | kind create cluster --name "${CLUSTER}" --wait 120s --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
containerdConfigPatches:
- |-
  [plugins."io.containerd.grpc.v1.cri".registry]
    config_path = "/etc/containerd/certs.d"
YAML
  fi
  use_cluster

  log "local registry ${REG_NAME} (localhost:${REG_PORT}), wired to every node"
  if ! docker inspect "${REG_NAME}" >/dev/null 2>&1; then
    docker run -d --restart=always -p "127.0.0.1:${REG_PORT}:5000" --name "${REG_NAME}" "${REGISTRY_IMAGE}"
  fi
  docker network connect kind "${REG_NAME}" 2>/dev/null || true
  local node
  for node in $(kind get nodes --name "${CLUSTER}"); do
    docker exec "${node}" mkdir -p "/etc/containerd/certs.d/localhost:${REG_PORT}"
    printf '[host."http://%s:5000"]\n' "${REG_NAME}" \
      | docker exec -i "${node}" cp /dev/stdin "/etc/containerd/certs.d/localhost:${REG_PORT}/hosts.toml"
  done

  log "cert-manager and Knative Serving + Kourier (${KNATIVE_VERSION})"
  "${REPO}/scripts/kind-manifests/apply-cert-manager.sh"
  k wait --for=condition=Available --timeout=300s -n cert-manager \
    deployment/cert-manager deployment/cert-manager-webhook deployment/cert-manager-cainjector
  "${REPO}/scripts/kind-manifests/apply-knative-kourier.sh" "${KNATIVE_VERSION}"
  k patch configmap/config-network -n knative-serving --type merge \
    --patch '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'
  k wait --for=condition=Available --timeout=300s -n knative-serving \
    deployment/controller deployment/webhook deployment/autoscaler deployment/activator deployment/net-kourier-controller
  k wait --for=condition=Available --timeout=300s -n kourier-system deployment/3scale-kourier-gateway

  log "the operator, built from this checkout (propagation bound ${BOUND})"
  make -C "${OPERATOR}" manifests kustomize >/dev/null
  local attempt
  for attempt in 1 2 3; do
    make -C "${OPERATOR}" docker-build IMG="${OPERATOR_IMG}" && break
    [ "${attempt}" = 3 ] && fail "the operator image build failed 3 times"
    echo "docker-build attempt ${attempt} failed; retrying"
    sleep 10
  done
  # Tagged by what it is: re-running this phase after the operator changed must
  # roll the Deployment, and the same tag with new bytes would not.
  local operator_id operator_img
  operator_id="$(docker image inspect --format '{{.Id}}' "${OPERATOR_IMG}" | sed 's/^sha256://' | cut -c1-12)"
  operator_img="example.com/kn-next-operator:z7-${operator_id}"
  docker tag "${OPERATOR_IMG}" "${operator_img}"
  kind load docker-image "${operator_img}" --name "${CLUSTER}"

  # Rendered from a COPY of config/, so the checkout is never edited
  # (`make deploy` runs `kustomize edit` in place).
  local cfg="${WORK}/config"
  cp -R "${OPERATOR}/config" "${cfg}"
  (cd "${cfg}/manager" && "${OPERATOR}/bin/kustomize" edit set image "controller=${operator_img}")
  local arg='--health-probe-bind-address=:8081'
  [ "$(grep -c -- "- ${arg}\$" "${cfg}/manager/manager.yaml")" = 1 ] || fail "manager.yaml no longer has exactly one '${arg}' arg to anchor on"
  awk -v bound="${BOUND}" '
    { print }
    /- --health-probe-bind-address=:8081$/ {
      match($0, /^ */)
      printf "%s- --zone-signing-key-propagation-bound=%s\n", substr($0, 1, RLENGTH), bound
    }' "${cfg}/manager/manager.yaml" >"${cfg}/manager/manager.yaml.new"
  mv "${cfg}/manager/manager.yaml.new" "${cfg}/manager/manager.yaml"
  "${OPERATOR}/bin/kustomize" build "${cfg}/default" | k apply -f -
  k wait --for=condition=Established --timeout=120s \
    crd/nextapps.apps.kn-next.dev crd/backendservices.apps.kn-next.dev
  k rollout status deployment/kn-next-operator-controller-manager -n "${OPERATOR_NS}" --timeout=180s
  k wait --for=condition=Ready --timeout=120s -n "${OPERATOR_NS}" certificate/kn-next-operator-serving-cert
  k wait --for=jsonpath='{.subsets[0].addresses[0]}' --timeout=120s \
    -n "${OPERATOR_NS}" endpoints/kn-next-operator-webhook-service
  "${REPO}/scripts/kind-manifests/wait-for-webhook-ready.sh"
  k -n "${OPERATOR_NS}" get deployment kn-next-operator-controller-manager -o json \
    | jq -e --arg a "--zone-signing-key-propagation-bound=${BOUND}" '.spec.template.spec.containers[0].args | index($a) != null' >/dev/null \
    || fail "the operator is not running with --zone-signing-key-propagation-bound=${BOUND}"
  ok "operator running with a ${BOUND} propagation bound"
}

# ---------------------------------------------------------------- phase: images

build_push() { # <name> <context dir>: build, push, record name=<repo>@<digest>
  local name=$1 ctx=$2 ref="localhost:${REG_PORT}/z7/$1:e2e" plog="${WORK}/push-$1.log" digest
  docker build -t "${ref}" "${ctx}"
  docker push "${ref}" | tee "${plog}"
  digest="$(sed -n 's/.*digest: \(sha256:[0-9a-f]\{64\}\).*/\1/p' "${plog}" | tail -1)"
  [ -n "${digest}" ] || fail "could not read the pushed digest of ${name}"
  grep -v "^${name}=" "${STATE}/images.env" >"${STATE}/images.env.new" 2>/dev/null || true
  echo "${name}=localhost:${REG_PORT}/z7/${name}@${digest}" >>"${STATE}/images.env.new"
  mv "${STATE}/images.env.new" "${STATE}/images.env"
  ok "${name} -> ${digest}"
}

phase_images() {
  log "images: Go function, zone, Rust function"
  build_push function-go "${REPO}/templates/go"
  bun "${HERE}/zone-caller/build.ts" "${WORK}/zone-ctx"
  build_push zone-caller "${WORK}/zone-ctx"
  if [ "${WITH_RUST}" = 1 ]; then build_push function-rust "${REPO}/templates/rust"; fi
}

image_ref() { # <name>
  local ref
  ref="$(sed -n "s/^$1=//p" "${STATE}/images.env" 2>/dev/null | tail -1)"
  [ -n "${ref}" ] || fail "no image recorded for $1 (run the images phase)"
  echo "${ref}"
}

# ---------------------------------------------------------------- phase: deploy

phase_deploy() {
  log "namespace ${NS}, the zone ${ZONE} and its functions"
  if k get namespace "${NS}" >/dev/null 2>&1; then
    [ "$(k get namespace "${NS}" -o json | jq -r '.metadata.labels["e2e.kn-next.dev/z7-owned"] // ""')" = true ] \
      || fail "namespace ${NS} exists and this harness did not create it; refusing to delete it"
    k delete namespace "${NS}" --wait=true --timeout=600s
  fi
  k create namespace "${NS}"
  k label namespace "${NS}" e2e.kn-next.dev/z7-owned=true

  local go_img zone_img rust_img backends rust_bs=''
  go_img="$(image_ref function-go)"
  zone_img="$(image_ref zone-caller)"
  backends="    - name: example
      service: ${GO_FN}"
  if [ "${WITH_RUST}" = 1 ]; then
    rust_img="$(image_ref function-rust)"
    backends="${backends}
    - name: inventory
      service: ${RUST_FN}"
    rust_bs="---
apiVersion: apps.kn-next.dev/v1alpha1
kind: BackendService
metadata:
  name: ${RUST_FN}
  namespace: ${NS}
spec:
  zone: ${ZONE}
  image: ${rust_img}
  language: rust
  port: 8080
  protoVersion: 1.0.0
  scaling:
    minScale: 1
    maxScale: 1"
  fi

  # The zone and its functions stay up (minScale 1, maxScale 1) so a rotation
  # meets WARM pods: a pod started after the switch would read the new files on
  # boot and prove nothing about propagation.
  k apply --validate=strict -f - <<YAML
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: ${ZONE}
  namespace: ${NS}
spec:
  image: ${zone_img}
  healthCheckPath: /api/health
  scaling:
    minScale: 1
    maxScale: 1
  backends:
${backends}
---
apiVersion: apps.kn-next.dev/v1alpha1
kind: BackendService
metadata:
  name: ${GO_FN}
  namespace: ${NS}
spec:
  zone: ${ZONE}
  image: ${go_img}
  language: go
  port: 8080
  protoVersion: 1.0.0
  scaling:
    minScale: 1
    maxScale: 1
${rust_bs}
YAML

  wait_until 300 3 "BackendService ${GO_FN} Ready" \
    "k -n ${NS} wait --for=condition=Ready --timeout=2s backendservice/${GO_FN}"
  if [ "${WITH_RUST}" = 1 ]; then
    wait_until 600 3 "BackendService ${RUST_FN} Ready" \
      "k -n ${NS} wait --for=condition=Ready --timeout=2s backendservice/${RUST_FN}"
  fi
  # The zone rolls a second revision once a function reports the version it
  # serves; wait for the settled one: a single live pod that carries the binding.
  start_forwards
  wait_until 300 3 "the zone settled on a revision with its bindings" zone_settled
  ok "the zone and its function(s) are Ready and bound"
}

zone_settled() {
  local pod
  pod="$(pod_json "${ZONE}")" || return 1
  jq -e --argjson rust "${WITH_RUST}" '
    .status.phase == "Running" and ([.status.containerStatuses[]? | .ready] | all)
    and ([.spec.containers[] | select(.name == "user-container") | .env[]?.name]
         | (index("EXAMPLE_SERVICE_URL") != null and index("EXAMPLE_SERVICE_PROTO_VERSION") != null
            and (($rust == 0) or (index("INVENTORY_SERVICE_URL") != null and index("INVENTORY_SERVICE_PROTO_VERSION") != null))))' \
    <<<"${pod}" >/dev/null || return 1
  zone_call /api/health
  [ "${ZC_STATUS}" = 200 ]
}

# ---------------------------------------------------------------- phase: verify

# refusal_matrix <label> <function host> <another function's audience> <key dir>
refusal_matrix() {
  local label=$1 host=$2 other_aud=$3 keydir=$4
  local common=(--host "${host}" --issuer "${ISSUER}" --sub alice)

  # The control: the zone's real key through the real signer. Every refusal
  # below repeats this call with ONE property changed.
  expect "${label}: control, a token from the zone's real key is accepted" 200 "" \
    "${common[@]}" --rpc put --id "ok-${label}" --value "v-${label}" --auth signer --key-dir "${keydir}"
  expect "${label}: the write is visible to a second authorised call" 200 "" \
    "${common[@]}" --rpc get --id "ok-${label}" --auth signer --key-dir "${keydir}"
  expect "${label}: the health check is served with no token" 200 "" "${common[@]}" --rpc health --auth none

  expect "${label}: no token is refused" 401 unauthenticated \
    "${common[@]}" --rpc put --id "evil-${label}" --value x --auth none
  expect "${label}: a token that is not a JWT is refused" 401 unauthenticated \
    "${common[@]}" --rpc put --id "evil-${label}" --value x --auth garbage
  expect "${label}: a token signed by another key is refused" 401 unauthenticated \
    "${common[@]}" --rpc put --id "evil-${label}" --value x --auth foreign
  expect "${label}: a token claiming the zone's real kid, signed by another key, is refused" 401 unauthenticated \
    "${common[@]}" --rpc put --id "evil-${label}" --value x --auth forged "--kid=$(<"${keydir}/current.kid")"
  expect "${label}: a token minted for another function is refused" 401 unauthenticated \
    "${common[@]}" --rpc put --id "evil-${label}" --value x --auth signer --key-dir "${keydir}" --audience "${other_aud}"
  expect "${label}: a token minted for another RPC is refused" 401 unauthenticated \
    "${common[@]}" --rpc put --id "evil-${label}" --value x --auth signer --key-dir "${keydir}" \
    --token-method /example.v1.ExampleService/GetItem
  expect "${label}: an expired token is refused" 401 unauthenticated \
    "${common[@]}" --rpc put --id "evil-${label}" --value x --auth signer --key-dir "${keydir}" --age-seconds 300
  expect "${label}: a token from another zone's issuer is refused" 401 unauthenticated \
    --host "${host}" --issuer "knext:zone:${NS}/not-${ZONE}" --sub alice \
    --rpc put --id "evil-${label}" --value x --auth signer --key-dir "${keydir}"
  # Two tokens the real signer will not mint, so they are hand-built with the zone's
  # real key (--auth raw), next to a control built the same way: the only difference
  # is the one claim under test.
  expect "${label}: control, a hand-built token with the zone key, a user and a 60 s life, is accepted" 200 "" \
    --host "${host}" --issuer "${ISSUER}" --sub alice --rpc put --id "raw-${label}" --value r --auth raw --key-dir "${keydir}" --lifetime 60
  expect "${label}: an AUTH_USER token with an empty sub is refused" 401 unauthenticated \
    --host "${host}" --issuer "${ISSUER}" "--sub=" --rpc put --id "evil-${label}" --value x --auth raw --key-dir "${keydir}" --lifetime 60
  expect "${label}: a token that lives past 60 s is refused" 401 unauthenticated \
    --host "${host}" --issuer "${ISSUER}" --sub alice --rpc put --id "evil-${label}" --value x --auth raw --key-dir "${keydir}" --lifetime 61
  expect "${label}: none of the refused writes took effect" 404 not_found \
    "${common[@]}" --rpc get --id "evil-${label}" --auth signer --key-dir "${keydir}"
}

assert_function_pod_spec() { # <service>
  local pod
  pod="$(pod_json "$1")"
  jq -e --arg cm "${JWKS_CM}" '
    # the JWKS: one directory volume from the zone key ConfigMap, read-only, no subPath
    ([.spec.volumes[] | select(.name == "knext-zone-jwks")] | length == 1)
    and ([.spec.volumes[] | select(.name == "knext-zone-jwks") | .configMap.name] == [$cm])
    and ([.spec.containers[] | select(.name != "queue-proxy") | .volumeMounts[]
          | select(.name == "knext-zone-jwks")] | length == 1)
    and ([.spec.containers[] | select(.name != "queue-proxy") | .volumeMounts[]
          | select(.name == "knext-zone-jwks")
          | .mountPath == "/var/run/knext/jwks" and .readOnly == true and ((.subPath // "") == "")] | all)' \
    <<<"${pod}" >/dev/null || fail "$1: the JWKS is not mounted as a read-only directory volume at /var/run/knext/jwks without a subPath"
  ok "$1: JWKS is a read-only directory volume (no subPath)"
  jq -e '[.spec.containers[].volumeMounts[]? | select((.subPath // "") != "" or (.subPathExpr // "") != "")] | length == 0' \
    <<<"${pod}" >/dev/null || fail "$1: a volume is mounted through a subPath, which a rotated file would not reach"
  jq -e '[.. | strings | select(test("signing-key"))] | length == 0' <<<"$(jq '.spec' <<<"${pod}")" >/dev/null \
    || fail "$1: the pod spec mentions a signing key"
  jq -e '[.spec.volumes[] | select(.secret != null or .projected != null)
          | (.secret.secretName // ([.projected.sources[]?.secret.name] | join(",")))
          | select(test("knext-signing-key|signing"))] | length == 0' <<<"${pod}" >/dev/null \
    || fail "$1: a Secret volume carries a signing key"
  jq -e --arg cm "${JWKS_CM}" '
    # the JWKS and the key never travel by env, and the verifier is configured by plain values
    ([.spec.containers[].env[]? | select((.value // "") | test("PRIVATE KEY|\"keys\"|\"kty\""))] | length == 0)
    and ([.spec.containers[].env[]? | select(.valueFrom != null)
          | (.valueFrom.configMapKeyRef.name // .valueFrom.secretKeyRef.name // "")
          | select(. == $cm or test("signing"))] | length == 0)' <<<"${pod}" >/dev/null \
    || fail "$1: the JWKS or a key is passed through the environment"
  ok "$1: no signing key anywhere in the pod, no key or JWKS in its environment"
}

phase_verify() {
  log "verify: the operator created the zone's key and JWKS"
  k -n "${NS}" get secret "${KEY_SECRET}" >/dev/null 2>&1 \
    || fail "Secret ${KEY_SECRET} does not exist in ${NS}: the operator created no signing key for the zone"
  k -n "${NS}" get configmap "${JWKS_CM}" >/dev/null 2>&1 \
    || fail "ConfigMap ${JWKS_CM} does not exist in ${NS}: the operator published no JWKS for the zone"
  k -n "${NS}" get secret "${KEY_SECRET}" -o json \
    | jq -e --arg zone "${ZONE}" '.metadata.ownerReferences | map(select(.kind == "NextApp" and .name == $zone and .controller == true)) | length == 1' >/dev/null \
    || fail "Secret ${KEY_SECRET} is not controlled by NextApp ${ZONE}"
  k -n "${NS}" get configmap "${JWKS_CM}" -o json \
    | jq -e --arg zone "${ZONE}" '.metadata.ownerReferences | map(select(.kind == "NextApp" and .name == $zone and .controller == true)) | length == 1' >/dev/null \
    || fail "ConfigMap ${JWKS_CM} is not controlled by NextApp ${ZONE}"
  local kid
  kid="$(secret_get current.kid)"
  [ -n "${kid}" ] || fail "the key Secret has no current.kid"
  [ -z "$(secret_get next.kid)" ] && [ -z "$(secret_get previous.kid)" ] || fail "a fresh key Secret holds a staged or previous key"
  [ "$(jwks_kids)" = "${kid}" ] || fail "the JWKS does not publish exactly the current key"
  k -n "${NS}" get configmap "${JWKS_CM}" -o json \
    | jq -e '.data["jwks.json"] | fromjson | [.keys[] | has("d")] | any | not' >/dev/null \
    || fail "the published JWKS carries a private member"
  [ "$(zone_condition ZoneSigningKey)" = "True/KeyActive" ] || fail "ZoneSigningKey is $(zone_condition ZoneSigningKey), want True/KeyActive"
  ok "Secret ${KEY_SECRET} and ConfigMap ${JWKS_CM} exist, are owned by the NextApp and agree on kid ${kid}"

  log "verify: pod specs (the function holds no private key; the JWKS is a directory volume)"
  assert_function_pod_spec "${GO_FN}"
  if [ "${WITH_RUST}" = 1 ]; then assert_function_pod_spec "${RUST_FN}"; fi
  local fnpod
  fnpod="$(pod_json "${GO_FN}")"
  jq -e --arg iss "${ISSUER}" --arg aud "${GO_AUD}" '
    ([.spec.containers[] | select(.name != "queue-proxy") | .env[]? | select(.name == "KNEXT_TOKEN_ISSUER") | .value] == [$iss])
    and ([.spec.containers[] | select(.name != "queue-proxy") | .env[]? | select(.name == "KNEXT_TOKEN_AUDIENCE") | .value] == [$aud])' \
    <<<"${fnpod}" >/dev/null || fail "${GO_FN}: KNEXT_TOKEN_ISSUER/AUDIENCE are not ${ISSUER} / ${GO_AUD}"
  ok "${GO_FN}: verifier configured for ${ISSUER} and ${GO_AUD}"
  local zonepod
  zonepod="$(pod_json "${ZONE}")"
  jq -e --arg secret "${KEY_SECRET}" --arg iss "${ISSUER}" '
    ([.spec.volumes[] | select(.name == "knext-zone-signing-key")] | length == 1)
    and ([.spec.volumes[] | select(.name == "knext-zone-signing-key") | .secret.secretName] == [$secret])
    and ([.spec.volumes[] | select(.name == "knext-zone-signing-key") | .secret.items[].key] | sort
         == ["current.key", "current.kid", "previous.key", "previous.kid"])
    and ([.spec.containers[] | select(.name == "user-container") | .volumeMounts[]
          | select(.name == "knext-zone-signing-key")
          | .mountPath == "/var/run/knext/signing-key" and .readOnly == true and ((.subPath // "") == "")] == [true])
    and ([.spec.containers[] | select(.name == "user-container") | .env[]? | select(.name == "KNEXT_ZONE_ISSUER") | .value] == [$iss])' \
    <<<"${zonepod}" >/dev/null || fail "${ZONE}: the signing key is not a directory volume of current.*/previous.* only, or KNEXT_ZONE_ISSUER is wrong"
  ok "${ZONE}: signing key mounted as a read-only directory volume (current.*/previous.* only, never next.*)"
  local zpod
  zpod="$(jq -r .metadata.name <<<"${zonepod}")"
  local names
  names="$(k -n "${NS}" exec "${zpod}" -c user-container -- ls -A /var/run/knext/signing-key | grep -v '^\.\.' | sort | paste -sd' ' -)"
  [ "${names}" = "current.key current.kid" ] || fail "${ZONE}: the mounted key directory holds '${names}', want exactly current.key current.kid"
  ok "${ZONE}: the key directory holds current.key and current.kid and nothing else"

  log "verify: a call from the zone's generated glue succeeds with a real served token"
  start_forwards
  expect_zone "Go: generated Server Action putItem through the zone" '/example/put?id=g1&value=hello&sub=alice' 200 '.ok == true'
  expect_zone "Go: generated query getItem reads it back" '/example/get?id=g1&sub=alice' 200 '.value == "hello"'
  if [ "${WITH_RUST}" = 1 ]; then
    expect_zone "Rust: the zone writes through the same signer" '/inventory/put?id=r1&value=world&sub=alice' 200 '.ok == true'
    expect_zone "Rust: the zone reads it back" '/inventory/get?id=r1&sub=alice' 200 '.value == "world"'
  fi
  [ "$(zone_kid)" = "${kid}" ] || fail "the zone signs with a key other than the Secret's current key"
  ok "the zone signs with the Secret's current key (${kid})"

  log "verify: refusals, each next to a control that differs in one property"
  export_key "${WORK}/key-current" current
  local other_aud_for_go="${RUST_AUD}" other_aud_for_rust="${GO_AUD}"
  if [ "${WITH_RUST}" != 1 ]; then other_aud_for_go="knext:fn:${NS}/other-function"; fi
  refusal_matrix go "${GO_HOST}" "${other_aud_for_go}" "${WORK}/key-current"
  if [ "${WITH_RUST}" = 1 ]; then
    refusal_matrix rust "${RUST_HOST}" "${other_aud_for_rust}" "${WORK}/key-current"
  fi
  ok "verify phase complete"
}

# ---------------------------------------------------------------- phase: rotate

# await_staged_key <label> <function host> <old kid> <published-at epoch>:
# poll a WARM function with a token signed by the STAGED key until it accepts
# it, and print how long after the publish that was. It fails if signing
# switched first (a function that had not yet read the new JWKS when the zone
# started signing with the new key would refuse the zone's calls), or on any
# status but a refusal while waiting.
await_staged_key() {
  local label=$1 host=$2 old=$3 published=$4 status
  while :; do
    status="$(probe_status --host "${host}" --issuer "${ISSUER}" --sub alice --rpc put --id staged --value s --auth signer --key-dir "${WORK}/key-new")"
    if [ "$(secret_get current.kid)" != "${old}" ]; then
      fail "${label}: signing switched to the new key before the warm function accepted a token signed by it (propagation exceeded the ${BOUND} bound)"
    fi
    if [ "${status}" = 200 ]; then break; fi
    [ "${status}" = 401 ] || fail "${label}: status '${status}' while waiting for the staged key to propagate; want 401 until it does"
    sleep 2
  done
  node -p "(Date.now() / 1000 - ${published}).toFixed(1)"
}

phase_rotate() {
  log "rotate: the zone's key, by annotation"
  start_forwards
  zone_settled || fail "the zone is not settled; run the deploy phase first"
  local old_kid new_kid
  old_kid="$(secret_get current.kid)"
  [ -n "${old_kid}" ] || fail "no current key"
  [ -z "$(secret_get next.kid)" ] && [ -z "$(secret_get previous.kid)" ] || fail "a rotation is already in flight; run the deploy phase for a clean zone"
  export_key "${WORK}/key-old" current

  # Warm-pod identity before the rotation: a restart or a replacement anywhere
  # in it would make "no restart" a false claim.
  local go_before rust_before zone_before
  go_before="$(pod_idents "${GO_FN}")"
  zone_before="$(pod_idents "${ZONE}")"
  rust_before=''
  if [ "${WITH_RUST}" = 1 ]; then rust_before="$(pod_idents "${RUST_FN}")"; fi
  [ "$(wc -l <<<"${go_before}")" -eq 1 ] || fail "want one Go function pod, got: ${go_before}"

  # Calls through the zone every 2 s for the whole rotation. A rotation must not
  # fail one: the point of publish-then-wait-then-switch.
  local watch_log="${WORK}/watch.log" watch_failed="${WORK}/watcher.failed"
  : >"${watch_log}"
  rm -f "${watch_failed}"
  (
    # A `fail` in here would end only this subshell and be seen by no one: it leaves
    # a sentinel, which the parent checks before it trusts the watcher's log.
    fail() {
      printf '%s\n' "$*" >"${watch_failed}"
      exit 1
    }
    i=0
    while :; do
      i=$((i + 1))
      c1="$(zone_status "/example/put?id=w${i}&value=v&sub=watcher")"
      c2="$(zone_status "/example/get?id=w${i}&sub=watcher")"
      c3=200
      if [ "${WITH_RUST}" = 1 ]; then
        c3="$(zone_status "/inventory/put?id=w${i}&value=v&sub=watcher")"
      fi
      echo "$(date +%s) ${c1} ${c2} ${c3}" >>"${watch_log}"
      sleep 2
    done
  ) &
  WATCH_PID=$!
  PIDS+=("${WATCH_PID}")

  log "rotate 1/5: request a rotation; the new key is published, the old one keeps signing"
  local t_request t_published nonce
  nonce="z7-$(date +%s)"
  t_request="$(now_s)"
  k -n "${NS}" annotate nextapp "${ZONE}" "apps.kn-next.dev/rotate-signing-key=${nonce}" --overwrite
  # The operator takes the request and stages the new key in ONE write of the
  # Secret, so once its nonce matches either the key is staged or signing has
  # already switched (a defect: the new key was never published and waited on).
  wait_until 60 1 "the operator to take the rotation request" \
    '[ "$(secret_annotation apps.kn-next.dev/signing-key-rotation-nonce)" = "${nonce}" ]'
  t_published="$(now_s)"
  [ "$(secret_get current.kid)" = "${old_kid}" ] \
    || fail "signing switched in the step that took the rotation request: the new key was not published and waited on (propagation bound ignored)"
  new_kid="$(secret_get next.kid)"
  [ -n "${new_kid}" ] || fail "the rotation request was taken but no key is staged"
  [ "${new_kid}" != "${old_kid}" ] || fail "the staged key has the current key's kid"
  wait_until 30 1 "the JWKS to publish both keys" '[ "$(jwks_kids)" = "$(pair_kids "${old_kid}" "${new_kid}")" ]'
  wait_until 30 1 "the next-published-at stamp" '[ -n "$(secret_annotation apps.kn-next.dev/signing-key-next-published-at)" ]'
  local published_at
  published_at="$(epoch_of "$(secret_annotation apps.kn-next.dev/signing-key-next-published-at)")"
  [ "$(secret_get current.kid)" = "${old_kid}" ] || fail "signing switched before the new key was even stamped"
  [ "$(zone_condition ZoneSigningKey)" = "True/RotationPropagating" ] || fail "ZoneSigningKey is $(zone_condition ZoneSigningKey), want True/RotationPropagating"
  ok "staged key ${new_kid} published beside ${old_kid}; ZoneSigningKey=RotationPropagating"

  log "rotate 2/5: a WARM function accepts the staged key's token before the switch, inside the bound"
  export_key "${WORK}/key-new" next
  local propagation propagation_rust=""
  propagation="$(await_staged_key go "${GO_HOST}" "${old_kid}" "${published_at}")"
  ok "the warm Go function accepted a token signed by the staged key ${propagation}s after it was published (bound ${BOUND_SECONDS}s)"
  if [ "${WITH_RUST}" = 1 ]; then
    propagation_rust="$(await_staged_key rust "${RUST_HOST}" "${old_kid}" "${published_at}")"
    ok "the warm Rust function accepted a token signed by the staged key ${propagation_rust}s after it was published"
  fi
  [ "$(zone_kid)" = "${old_kid}" ] || fail "the zone is not signing with the old key while the new one propagates"

  log "rotate 3/5: signing switches only after the propagation bound"
  wait_until $((BOUND_SECONDS + 90)) 2 "signing to switch to the new key" '[ "$(secret_get current.kid)" = "${new_kid}" ]'
  local t_switched
  t_switched="$(now_s)"
  local stamp_current bound_held
  # The switch clears next-published-at; the operator's own stamp of the
  # publish is the one read BEFORE the switch (published_at).
  stamp_current="$(epoch_of "$(secret_annotation apps.kn-next.dev/signing-key-current-since)")"
  bound_held="$(node -p "(${stamp_current} - ${published_at}).toFixed(1)")"
  node -e "process.exit(${stamp_current} - ${published_at} >= ${BOUND_SECONDS} ? 0 : 1)" \
    || fail "the operator switched ${bound_held}s after publishing; the bound is ${BOUND_SECONDS}s"
  node -e "process.exit(${t_switched} - ${t_request} >= ${BOUND_SECONDS} - 3 ? 0 : 1)" \
    || fail "signing switched less than the bound after the rotation was requested"
  ok "signing switched ${bound_held}s after the new key was published (bound ${BOUND_SECONDS}s)"
  [ "$(secret_get previous.kid)" = "${old_kid}" ] || fail "the old key is not kept as previous after the switch"
  [ -z "$(secret_get next.kid)" ] || fail "the staged slot is not cleared by the switch"
  wait_until 30 1 "the overlap state" '[ "$(zone_condition ZoneSigningKey)" = "True/RotationOverlap" ]'
  [ "$(jwks_kids)" = "$(pair_kids "${old_kid}" "${new_kid}")" ] || fail "the JWKS no longer publishes both keys during the overlap"
  ok "switched: ${new_kid} signs, ${old_kid} is previous and still published; ZoneSigningKey=RotationOverlap"

  log "rotate 4/5: the zone's signer picks up the new key without a restart; the previous key keeps verifying"
  local t_zone
  wait_until 300 3 "the zone's signer to use the new key" '[ "$(zone_kid)" = "${new_kid}" ]'
  t_zone="$(now_s)"
  ok "the zone signs with ${new_kid} $(node -p "(${t_zone} - ${t_switched}).toFixed(1)")s after the switch"
  expect_zone "Go: a call through the zone, signed with the new key, succeeds" '/example/put?id=after&value=v2&sub=alice' 200 '.ok == true'
  if [ "${WITH_RUST}" = 1 ]; then
    expect_zone "Rust: a call through the zone, signed with the new key, succeeds" '/inventory/put?id=after&value=v2&sub=alice' 200 '.ok == true'
  fi
  local fn host
  for fn in go rust; do
    [ "${fn}" = rust ] && [ "${WITH_RUST}" != 1 ] && continue
    host="${GO_HOST}"
    [ "${fn}" = rust ] && host="${RUST_HOST}"
    expect "${fn}: a token signed by the NEW key is accepted" 200 "" \
      --host "${host}" --issuer "${ISSUER}" --sub alice --rpc put --id "n-${fn}" --value n --auth signer --key-dir "${WORK}/key-new"
    expect "${fn}: a token signed by the PREVIOUS key still verifies during the overlap" 200 "" \
      --host "${host}" --issuer "${ISSUER}" --sub alice --rpc put --id "o-${fn}" --value o --auth signer --key-dir "${WORK}/key-old"
  done

  log "rotate 5/5: retirement after the overlap"
  # The overlap is a one-hour constant. The operator keeps every timestamp on the
  # Secret and derives its next step from them, so two hours are taken off the
  # switch stamp and the operator is restarted to re-read it (a restart is also
  # the crash-safety case: all state is in the Secret).
  k -n "${NS}" annotate secret "${KEY_SECRET}" \
    "apps.kn-next.dev/signing-key-switched-at=$(node -p 'new Date(Date.now() - 2 * 3600 * 1000).toISOString()')" --overwrite
  local t_retire
  t_retire="$(now_s)"
  # The restart replaces the operator pods, and their logs (the key's creation,
  # staging and switch) with them: keep what they said for the leak scan.
  collect_operator_logs "${WORK}/operator-before-restart.log"
  k -n "${OPERATOR_NS}" rollout restart deployment/kn-next-operator-controller-manager
  k -n "${OPERATOR_NS}" rollout status deployment/kn-next-operator-controller-manager --timeout=180s
  wait_until 180 3 "the previous key to leave the Secret" '[ -z "$(secret_get previous.kid)" ]'
  [ "$(secret_get current.kid)" = "${new_kid}" ] || fail "retirement changed the signing key"
  wait_until 30 1 "the JWKS to publish only the new key" '[ "$(jwks_kids)" = "${new_kid}" ]'
  wait_until 30 1 "KeyActive" '[ "$(zone_condition ZoneSigningKey)" = "True/KeyActive" ]'
  ok "retired: only ${new_kid} remains in the Secret and the JWKS; ZoneSigningKey=KeyActive"
  for fn in go rust; do
    [ "${fn}" = rust ] && [ "${WITH_RUST}" != 1 ] && continue
    host="${GO_HOST}"
    [ "${fn}" = rust ] && host="${RUST_HOST}"
    wait_until $((BOUND_SECONDS + 150)) 2 "the warm ${fn} function to refuse the retired key" \
      "[ \"\$(probe_status --host ${host} --issuer ${ISSUER} --sub alice --rpc put --id r --value r --auth signer --key-dir ${WORK}/key-old)\" = 401 ]"
    expect "${fn}: the retired key's token is refused" 401 unauthenticated \
      --host "${host}" --issuer "${ISSUER}" --sub alice --rpc put --id r --value r --auth signer --key-dir "${WORK}/key-old"
    expect "${fn}: the new key's token is still accepted" 200 "" \
      --host "${host}" --issuer "${ISSUER}" --sub alice --rpc put --id n2 --value n --auth signer --key-dir "${WORK}/key-new"
  done
  local t_retired_refused
  t_retired_refused="$(now_s)"
  expect_zone "Go: the zone's calls still succeed after retirement" '/example/get?id=after&sub=alice' 200 '.value == "v2"'

  log "rotate: nothing restarted, and no call through the zone failed at any point"
  # "No call failed" is only worth what the watcher saw. It must not have failed on
  # its own, must still be running, and must have made a round at or after the last
  # assertion above (waiting at most a minute for the next one): otherwise it stopped
  # somewhere in the rotation and its log covers only the start of it.
  [ ! -e "${watch_failed}" ] || fail "the watcher failed: $(<"${watch_failed}")"
  kill -0 "${WATCH_PID}" 2>/dev/null \
    || fail "the watcher stopped early: its 'no call failed' would cover only the start of the rotation"
  local end_ts last_ts="" w
  end_ts="${t_retired_refused%.*}"
  for w in $(seq 1 60); do
    last_ts="$(tail -n 1 "${watch_log}" | cut -d' ' -f1)"
    if [ "${last_ts:-0}" -ge "${end_ts}" ]; then break; fi
    kill -0 "${WATCH_PID}" 2>/dev/null || break
    sleep 1
  done
  [ "${last_ts:-0}" -ge "${end_ts}" ] \
    || fail "the watcher's last round (${last_ts:-none}) is older than the end of the rotation (${end_ts}): it stopped or hung, so it did not see all of it"
  [ ! -e "${watch_failed}" ] || fail "the watcher failed: $(<"${watch_failed}")"
  kill "${WATCH_PID}" 2>/dev/null || true
  [ "$(pod_idents "${GO_FN}")" = "${go_before}" ] || fail "the Go function pod was restarted or replaced during the rotation"
  [ "$(pod_idents "${ZONE}")" = "${zone_before}" ] || fail "the zone pod was restarted or replaced during the rotation"
  if [ "${WITH_RUST}" = 1 ]; then
    [ "$(pod_idents "${RUST_FN}")" = "${rust_before}" ] || fail "the Rust function pod was restarted or replaced during the rotation"
  fi
  ok "the same warm pods served the whole rotation (no restart, no replacement)"
  local total bad
  total="$(wc -l <"${watch_log}" | tr -d ' ')"
  bad="$(awk '$2 != 200 || $3 != 200 || $4 != 200' "${watch_log}" | wc -l | tr -d ' ')"
  [ "${total}" -ge 20 ] || fail "only ${total} watcher rounds ran; too few to say nothing failed"
  # The switch and the retirement are the part of the rotation that can break a
  # call, so the rounds after the switch are counted on their own.
  local after_switch
  after_switch="$(awk -v t="${t_switched%.*}" '$1 >= t' "${watch_log}" | wc -l | tr -d ' ')"
  [ "${after_switch}" -ge 10 ] \
    || fail "only ${after_switch} watcher rounds after the switch (want 10 or more): too few to say the switch and the retirement broke no call"
  [ "${bad}" = 0 ] || { awk '$2 != 200 || $3 != 200 || $4 != 200' "${watch_log}" | head -5 >&2; fail "${bad} of ${total} calls through the zone failed during the rotation"; }
  ok "${total} rounds of calls through the zone during the rotation, none failed"

  log "rotation timeline (seconds)"
  printf '  requested -> staged key in the Secret   %s\n' "$(node -p "(${t_published} - ${t_request}).toFixed(1)")"
  printf '  JWKS published -> warm Go fn accepts    %s   (bound %s)\n' "${propagation}" "${BOUND_SECONDS}"
  printf '  JWKS published -> signing switched      %s\n' "${bound_held}"
  printf '  switched -> zone signs with new key     %s\n' "$(node -p "(${t_zone} - ${t_switched}).toFixed(1)")"
  printf '  retire requested -> old key refused     %s\n' "$(node -p "(${t_retired_refused} - ${t_retire}).toFixed(1)")"
}

# ---------------------------------------------------------------- phase: leaks

phase_leaks() {
  log "leaks: no key material in logs, events or published objects"
  local dump="${WORK}/dump"
  mkdir -p "${dump}"
  if [ -f "${WORK}/operator-before-restart.log" ]; then cp "${WORK}/operator-before-restart.log" "${dump}/operator.log"; fi
  collect_operator_logs "${dump}/operator.log"
  k get events -A -o json >"${dump}/events.json" 2>&1 || true
  k -n "${NS}" get nextapp,backendservice,ksvc,configmap,pods -o yaml >"${dump}/objects.yaml" 2>&1 || true
  local svc
  for svc in "${ZONE}" "${GO_FN}" "${RUST_FN}"; do
    k -n "${NS}" logs -l "serving.knative.dev/service=${svc}" --all-containers --tail=-1 >"${dump}/${svc}.log" 2>&1 || true
  done
  [ -s "${dump}/operator.log" ] || fail "no operator log to scan"
  # The scan is only worth something over the log of a pod that did the work.
  grep -q 'reconciled' "${dump}/operator.log" \
    || fail "the operator logs show no reconcile: the scan would be reading the wrong pods"
  # Every private key this run touched (old, new, and the current one now), in every
  # shape a logger could print it (key-needles.ts: the set the operator redacts from
  # its own errors). Each class is one 0600 file of needles, scanned with grep -F -f;
  # a hit is reported by CLASS NAME, and no needle is ever printed.
  export_key "${WORK}/leak-current" current
  local keyfile class_file nd tag=0 classes n=0 leaked_classes=""
  for keyfile in "${WORK}/key-old/current.key" "${WORK}/key-new/current.key" "${WORK}/leak-current/current.key"; do
    [ -s "${keyfile}" ] || continue
    tag=$((tag + 1))
    nd="${WORK}/needles-${tag}"
    bun "${NEEDLES}" "${keyfile}" "${nd}" >/dev/null || fail "could not build the leak-scan needles"
    classes="$(find "${nd}" -type f | wc -l | tr -d ' ')"
    [ "${classes}" -ge 13 ] || fail "the key needles have ${classes} classes, want 13 or more: the scan would prove nothing"
    for class_file in "${nd}"/*; do
      # A line shorter than 40 characters, an empty one above all, could match by
      # accident: as a grep pattern an empty line matches every line of every file.
      awk 'length($0) < 40 { bad = 1 } END { exit bad }' "${class_file}" \
        || fail "a needle file has a line shorter than 40 characters: the scan would prove nothing"
      n=$((n + 1))
      if grep -rqF -f "${class_file}" "${dump}"; then leaked_classes="${leaked_classes} ${class_file##*/}"; fi
    done
  done
  [ "${n}" -gt 0 ] || fail "no key needles to scan for: the scan would prove nothing"
  [ -z "${leaked_classes}" ] \
    || fail "key material appears in the operator's or the pods' logs, the events or the published objects (classes:${leaked_classes}; the needles are not printed)"
  if grep -rqE -- 'BEGIN (EC |RSA |OPENSSH )?PRIVATE KEY' "${dump}"; then fail "a PEM private key header appears in the dumped logs or objects"; fi
  ok "scanned ${n} needle classes (${tag} keys) across the operator logs, events, objects and pod logs: no key material"
}

# ---------------------------------------------------------------- main

if kind get clusters 2>/dev/null | grep -qx "${CLUSTER}"; then use_cluster; fi
for phase in up images deploy verify rotate leaks; do
  if has_phase "${phase}"; then
    "phase_${phase}"
  fi
done
log "PASS (phases: ${PHASES})"
