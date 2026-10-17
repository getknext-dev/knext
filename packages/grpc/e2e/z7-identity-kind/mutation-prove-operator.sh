#!/usr/bin/env bash
# Mutation proof for the Z7 kind e2e, operator half: break ONE rule in the
# operator and the lane must go red, for the reason the rule exists.
#
# A guard that stays green when the behaviour it protects is removed is
# decoration. The lane's assertions cannot be mutated from inside the lane, so
# this mutates the operator's source (the rows are in mutation-rows.mjs), builds
# that operator, rolls it out on the kind cluster, and runs the lane phases that
# should notice:
#
#   M1 bound-ignored           signing switches in the same pass that publishes
#                              the new key (the propagation bound is not waited)
#   M2 staged-key-unpublished  the JWKS never lists the staged key
#   M3 no-overlap              the previous key is retired the moment it is stamped
#   M4 staged-key-projected    the zone's key volume also projects next.*
#   M5 jwks-subpath            a function mounts the JWKS through a subPath
#   M6 key-in-operator-log     the operator logs the private key it stores (the PEM string)
#   M6b key-bytes-in-operator-log  ... as the []byte zap prints, base64 of the PEM
#   M6c jwk-d-in-operator-log  ... as a JWK `d`, the seed in unpadded base64url
#   M7 watcher-dies-early      the LANE's rotation watcher stops after three rounds
#                              (this row mutates run.sh, not the operator)
#
# A row is KILLED only when run.sh exits non-zero AND its output names the
# expected reason: a red for another reason (a flake, an unready pod) is not a
# kill. Each file is snapshotted and restored through the shared harness
# (scripts/lib/mutation-harness.mjs: every anchor must occur exactly once, the
# restore is content-verified, every mutation carries the residue marker), and a
# final CONTROL runs the unmutated operator through every phase and must pass: a
# row is only evidence if it does.
#
# The cluster-free half (the probe's tokens, the workflow, the path filter, the
# script) is scripts/mutation-prove-2461-z7-kind-e2e.mjs, which the nightly prover
# sweep runs. This half needs a cluster that has had the lane's `up` and `images`
# phases and takes 10 to 15 minutes a row, so it is run by hand:
#
#   PHASES="up images" packages/grpc/e2e/z7-identity-kind/run.sh
#   packages/grpc/e2e/z7-identity-kind/mutation-prove-operator.sh [M1 M3 ...]
#
# Env: KIND_CLUSTER (default knext-z7-e2e); Z7_KEEP_LOGS=1 keeps each row's log
# (object status and log tails, never a key).
#
# Exit 0 = every row killed for its reason and the control passed; 1 = a row
# survived or went red for another reason, or the control failed; 2 = it could not run.
set -euo pipefail
set +x
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/../../../.." && pwd)"
OPERATOR="${REPO}/packages/kn-next-operator"
HARNESS="${REPO}/scripts/lib/mutation-harness.mjs"
CLUSTER="${KIND_CLUSTER:-knext-z7-e2e}"
OPERATOR_NS=kn-next-operator-system
DEPLOY=deployment/kn-next-operator-controller-manager
BUILD_IMG='example.com/kn-next-operator:z7-build'

WORK="$(mktemp -d "${TMPDIR:-/tmp}/knext-z7-mutation.XXXXXX")"
export KUBECONFIG="${WORK}/kubeconfig"
ACTIVE_SNAP=""

die() { printf 'mutation-prove-operator: %s\n' "$*" >&2; exit 2; }

restore_active() {
  if [ -n "${ACTIVE_SNAP}" ] && [ -f "${ACTIVE_SNAP}" ]; then
    node "${HARNESS}" restore "${ACTIVE_SNAP}" || printf 'RESTORE FAILED for %s: do not commit\n' "${ACTIVE_SNAP}" >&2
    ACTIVE_SNAP=""
  fi
}
cleanup() {
  local rc=$?
  restore_active
  if [ -n "${Z7_KEEP_LOGS:-}" ]; then echo "logs kept in ${WORK}"; else rm -rf "${WORK}"; fi
  exit "${rc}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

kind get kubeconfig --name "${CLUSTER}" >"${KUBECONFIG}" 2>/dev/null \
  || die "no kind cluster ${CLUSTER}; run run.sh with PHASES=\"up images\" first"

# The rows, as JSON: one object per row with file, anchor, replacement, phases, reason.
ROWS="$(node --input-type=module -e "import { ROWS } from '${HERE}/mutation-rows.mjs'; console.log(JSON.stringify(ROWS));")"
COUNT="$(jq 'length' <<<"${ROWS}")"
WANTED=" $* "

# install_operator <log>: build the operator from the CURRENT tree, tag it by its
# image id (the same tag with new bytes would not roll the Deployment), load it
# into kind and roll it.
install_operator() {
  local log=$1 id img
  {
    make -C "${OPERATOR}" docker-build IMG="${BUILD_IMG}"
    id="$(docker image inspect --format '{{.Id}}' "${BUILD_IMG}" | sed 's/^sha256://' | cut -c1-12)"
    img="example.com/kn-next-operator:z7-${id}"
    docker tag "${BUILD_IMG}" "${img}"
    kind load docker-image "${img}" --name "${CLUSTER}"
    kubectl -n "${OPERATOR_NS}" set image "${DEPLOY}" "manager=${img}"
    kubectl -n "${OPERATOR_NS}" rollout status "${DEPLOY}" --timeout=240s
  } >>"${log}" 2>&1 || die "building or rolling out the operator failed (see ${log})"
}

# run_lane <phases> <log>: run.sh exit status; its whole output goes to <log>.
run_lane() {
  local rc=0
  KIND_CLUSTER="${CLUSTER}" PHASES="$1" "${HERE}/run.sh" >"$2" 2>&1 || rc=$?
  return "${rc}"
}

killed=0 total=0
for ((i = 0; i < COUNT; i++)); do
  id="$(jq -r ".[${i}].id" <<<"${ROWS}")"
  case "${WANTED}" in "  ") ;; *" ${id} "*) ;; *) continue ;; esac
  name="$(jq -r ".[${i}].name" <<<"${ROWS}")"
  file="$(jq -r ".[${i}].file" <<<"${ROWS}")"
  anchor="$(jq -r ".[${i}].anchor" <<<"${ROWS}")"
  replacement="$(jq -r ".[${i}].replacement" <<<"${ROWS}")"
  phases="$(jq -r ".[${i}].phases" <<<"${ROWS}")"
  reason="$(jq -r ".[${i}].reason" <<<"${ROWS}")"
  log="${WORK}/${id}.log"
  total=$((total + 1))

  snap="${WORK}/${id}.snap.json"
  node "${HARNESS}" snapshot "${REPO}/${file}" "${snap}"
  ACTIVE_SNAP="${snap}"
  node "${HARNESS}" mutate "${snap}" "${anchor}" "${replacement}" \
    || { restore_active; die "${id}: the anchor does not occur exactly once in ${file}"; }
  rc=0
  install_operator "${log}"
  run_lane "${phases}" "${log}" || rc=$?
  restore_active

  if [ "${rc}" != 0 ] && grep -qF -- "${reason}" "${log}"; then
    verdict=KILLED
    killed=$((killed + 1))
  elif [ "${rc}" != 0 ]; then
    verdict=RED-FOR-ANOTHER-REASON
  else
    verdict=SURVIVED
  fi
  printf '%s %s: %s (run.sh exit %s; log %s)\n' "${id}" "${name}" "${verdict}" "${rc}" "${log}"
  if [ "${verdict}" != KILLED ]; then grep -E '^(FAIL|==)' "${log}" | tail -4 | sed 's/^/  /' || true; fi
done
[ "${total}" -gt 0 ] || die "no row matches${WANTED}"

# The control: the unmutated operator, rebuilt from the restored tree, through
# every phase the rows used. A row is only evidence if the lane passes on it.
control_log="${WORK}/control.log"
install_operator "${control_log}"
control_rc=0
run_lane "deploy verify rotate leaks" "${control_log}" || control_rc=$?
printf 'CONTROL (unmutated operator, deploy verify rotate leaks): exit %s\n' "${control_rc}"
printf '%s/%s rows killed for their reason\n' "${killed}" "${total}"
[ "${killed}" = "${total}" ] && [ "${control_rc}" = 0 ]
