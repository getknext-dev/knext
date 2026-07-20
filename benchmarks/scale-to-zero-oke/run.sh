#!/usr/bin/env bash
#
# benchmarks/scale-to-zero-oke/run.sh — reproducible scale-to-zero / burst benchmark
# harness (#423), committed so the numbers in docs/benchmarks/scale-to-zero-oke.md
# can be re-run against ANY cluster/service instead of living only in throwaway
# temp scripts.
#
# Phases (see README.md for full methodology + how to read the output):
#   cold  — N sequential single-request samples after the service scales to 0.
#   soak  — sustained think-time load (default 120 VUs / 3m) at baseline config.
#   burst — A/B "discriminating" burst test: pins containerConcurrency AND uses
#           continuous (no-think-time) load sized so VUs / containerConcurrency
#           ~= max-scale, so it genuinely forces fan-out to the pod cap instead
#           of quietly absorbing all load in one pod (the #422 round-1 trap).
#
# Hard-won lessons encoded here (do not regress):
#   - Knative's autoscaling annotation keys are KEBAB-CASE:
#       autoscaling.knative.dev/max-scale
#       autoscaling.knative.dev/target-burst-capacity
#       autoscaling.knative.dev/panic-window-percentage
#       autoscaling.knative.dev/panic-threshold-percentage
#     camelCase ("maxScale") is silently ignored by the Knative KPA.
#   - A think-time (sleep-between-requests) workload rarely generates enough
#     concurrent in-flight requests to force fan-out past 1 pod — the burst
#     phase MUST use continuous, no-think-time load, sized against
#     containerConcurrency, or the A/B is inconclusive (peak pods = 1).
#   - The k6 load-generator CPU request must be small (default 150m). An
#     oversized request can leave the generator pod Pending on a modest node
#     pool, producing a ZERO-load run that still "completes" and looks like a
#     result. This script warns if the k6 pod doesn't leave Pending quickly and
#     reports peak pods prominently so a failed-to-fan-out / failed-to-schedule
#     run is visibly distinguishable from a real one.
#   - Every mutation this script makes to the target ksvc (max-scale,
#     containerConcurrency, burst/panic annotations) is captured BEFORE the run
#     and restored via a trap on EXIT/INT/TERM — including on early abort — so
#     an interrupted run never leaves the cluster in test config.
#
# No hardcoded cluster identity: kube-context, namespace, service name, target
# URL, max-scale, containerConcurrency, k6 image, and output path are all
# flags/env vars with sane (documented) defaults — see --help.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── defaults (all overridable via flags; see --help) ─────────────────────────
KCTX="${KCTX:-}"                                   # kube context; empty = current context
NS="${NS:-default}"                                # namespace
SERVICE="${SERVICE:-}"                             # ksvc name — REQUIRED
URL="${URL:-}"                                     # target URL; default derived from SERVICE/NS
# k6 image. NOTE: .claude/rules/security.md asks for digest pinning. This is left
# tag-pinned deliberately: resolving the real digest for grafana/k6:0.49.0
# requires a registry round-trip that was not available in the environment this
# was written in, and inventing a digest would be worse than an honest tag.
# TODO(#423): replace with grafana/k6@sha256:<digest> once resolvable
# (`docker buildx imagetools inspect grafana/k6:0.49.0`). Overridable via --k6-image,
# so a digest can be passed today without editing this file.
IMG="${IMG:-grafana/k6:0.49.0}"                     # k6 image
KUBECTL_BIN="${KUBECTL_BIN:-kubectl}"              # kubectl binary (test seam; see below)
# Test seam: with DRY_RUN=1, kc() normally echoes instead of running. Setting
# DRY_RUN_EXERCISE_KC=1 makes kc() actually invoke $KUBECTL_BIN, so the
# capture/restore path (the only code here that can destroy a real service's
# config) and the run_k6 metrics-capture path can be exercised against a stub
# kubectl. See capture-restore.test.sh and k6-metrics-integrity.test.sh.
# NOTE: with this set, the run IS mutating — the banner says so (#425 item 2).
DRY_RUN_EXERCISE_KC="${DRY_RUN_EXERCISE_KC:-0}"
# Test seam (#425 item 1): simulate the pod sampler being killed before its TERM
# trap can flush, so the "<no sampler data>" branch is coverable. The real race
# is near-unreachable (0/200 losses measured), but the branch must still be
# correct: lost data must never be rendered as a measured peak of 0.
SAMPLER_SIMULATE_LOST="${SAMPLER_SIMULATE_LOST:-0}"
MAXSCALE="${MAXSCALE:-6}"                          # autoscaling.knative.dev/max-scale during the run
CC="${CC:-15}"                                     # containerConcurrency pinned during the burst phase
K6_CPU_REQUEST="${K6_CPU_REQUEST:-150m}"           # keep small — see "oversized k6 request" trap in README
K6_MEM_REQUEST="${K6_MEM_REQUEST:-200Mi}"
K6_CPU_LIMIT="${K6_CPU_LIMIT:-1}"
K6_MEM_LIMIT="${K6_MEM_LIMIT:-512Mi}"
COLD_SAMPLES="${COLD_SAMPLES:-5}"                  # Phase A: sequential single-request samples
SOAK_VUS="${SOAK_VUS:-120}"                        # Phase C: sustained VUs
SOAK_RAMP="${SOAK_RAMP:-20s}"
SOAK_HOLD="${SOAK_HOLD:-3m}"
BURST_VUS="${BURST_VUS:-}"                         # Phase B; default computed = CC * MAXSCALE
BURST_RAMP="${BURST_RAMP:-15s}"
BURST_HOLD="${BURST_HOLD:-50s}"
BURST_COOLDOWN="${BURST_COOLDOWN:-10s}"
BURST_REPS="${BURST_REPS:-2}"
BURST_VUS_PER_POD_WHEN_UNBOUNDED="${BURST_VUS_PER_POD_WHEN_UNBOUNDED:-15}" # used only when CC=0 (unbounded)
BASELINE_CFG="${BASELINE_CFG:-200,10,200}"         # target-burst-capacity,panic-window-pct,panic-threshold-pct
TUNED_CFG="${TUNED_CFG:--1,6,150}"
PHASES="${PHASES:-cold,soak,burst}"                # comma list: cold,soak,burst,all
SCALE_DOWN_TIMEOUT="${SCALE_DOWN_TIMEOUT:-150}"    # seconds to wait for pods -> 0
POD_SAMPLE_BUDGET="${POD_SAMPLE_BUDGET:-240}"      # seconds to sample pod count during a k6 run
K6_JOB_TIMEOUT="${K6_JOB_TIMEOUT:-600}"             # seconds to wait for the k6 Job to complete
SCHEDULE_CHECK_TIMEOUT="${SCHEDULE_CHECK_TIMEOUT:-20}" # seconds before warning k6 pod is still Pending
APPLY_SETTLE_SECONDS="${APPLY_SETTLE_SECONDS:-8}"   # settle time after an autoscaling patch (0 in tests)
OUT="${OUT:-}"                                      # results file; default computed below
DRY_RUN="${DRY_RUN:-0}"

usage() {
  cat <<EOF
Usage: $(basename "$0") --service <ksvc-name> [options]

Required:
  --service <name>          Knative Service (ksvc) name to benchmark.

Cluster targeting:
  --context <ctx>           kubectl context (default: current context; \$KCTX)
  --namespace <ns>          namespace (default: default; \$NS)
  --url <url>               target URL for k6 (default: in-cluster DNS name
                             http://<service>.<namespace>.svc.cluster.local)

Autoscaling knobs:
  --max-scale <n>            autoscaling.knative.dev/max-scale during the run (default: 6)
  --container-concurrency <n> containerConcurrency pinned for the burst phase (default: 15)
  --baseline <tbc,pw,pt>      baseline target-burst-capacity,panic-window-pct,panic-threshold-pct
                              (default: 200,10,200)
  --tuned <tbc,pw,pt>         tuned burst config (default: -1,6,150)

Load generator:
  --k6-image <img>           k6 container image (default: grafana/k6:0.49.0)
  --k6-cpu-request <cpu>     k6 pod CPU request (default: 150m — keep this small;
                              an oversized request can leave the pod Pending, see README)

Phase sizing:
  --phases <list>             comma list of: cold,soak,burst,all,none (default: cold,soak,burst;
                              'none' = capture+restore only, no load phases)
  --cold-samples <n>          Phase A sequential samples (default: 5)
  --soak-vus <n>              Phase C sustained VUs (default: 120)
  --soak-ramp <dur>           Phase C ramp-up duration (default: 20s)
  --soak-hold <dur>           Phase C hold duration (default: 3m)
  --burst-vus <n>             Phase B continuous VUs (default: container-concurrency * max-scale,
                              so the ratio forces fan-out to max-scale)
  --burst-ramp <dur>          Phase B ramp-up duration (default: 15s)
  --burst-hold <dur>          Phase B hold duration (default: 50s)
  --burst-reps <n>            reps per burst config (default: 2)

Output:
  --out <path>                results file (default: ./results/<service>-<UTC timestamp>.txt)

Other:
  --dry-run                   print the actions/manifests that would run; never touch a cluster
  -h, --help                   show this help

Every flag has an equivalent env var (shown above). Flags win over env vars.
See README.md for methodology, output interpretation, and known false-result traps.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --context) KCTX="$2"; shift 2 ;;
    --namespace) NS="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --max-scale) MAXSCALE="$2"; shift 2 ;;
    --container-concurrency) CC="$2"; shift 2 ;;
    --baseline) BASELINE_CFG="$2"; shift 2 ;;
    --tuned) TUNED_CFG="$2"; shift 2 ;;
    --k6-image) IMG="$2"; shift 2 ;;
    --k6-cpu-request) K6_CPU_REQUEST="$2"; shift 2 ;;
    --phases) PHASES="$2"; shift 2 ;;
    --cold-samples) COLD_SAMPLES="$2"; shift 2 ;;
    --soak-vus) SOAK_VUS="$2"; shift 2 ;;
    --soak-ramp) SOAK_RAMP="$2"; shift 2 ;;
    --soak-hold) SOAK_HOLD="$2"; shift 2 ;;
    --burst-vus) BURST_VUS="$2"; shift 2 ;;
    --burst-ramp) BURST_RAMP="$2"; shift 2 ;;
    --burst-hold) BURST_HOLD="$2"; shift 2 ;;
    --burst-reps) BURST_REPS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [ -z "$SERVICE" ]; then
  echo "Error: --service <ksvc-name> is required (no hardcoded target)." >&2
  usage >&2
  exit 1
fi

if [ -z "$URL" ]; then
  URL="http://${SERVICE}.${NS}.svc.cluster.local"
fi

# containerConcurrency 0 is LEGAL in Knative (means "unbounded"), so it must not
# be used as a divisor. With CC=0 there is no VUs-per-pod ratio to size against;
# fall back to sizing the burst purely off max-scale.
if [ -z "$BURST_VUS" ]; then
  if [ "$CC" -gt 0 ] 2>/dev/null; then
    BURST_VUS=$((CC * MAXSCALE))
  else
    BURST_VUS=$((BURST_VUS_PER_POD_WHEN_UNBOUNDED * MAXSCALE))
  fi
fi

if [ -z "$OUT" ]; then
  mkdir -p "${SCRIPT_DIR}/results"
  OUT="${SCRIPT_DIR}/results/${SERVICE}-$(date -u +%Y%m%dT%H%M%SZ).txt"
else
  mkdir -p "$(dirname "$OUT")"
fi
: > "$OUT"

IFS=',' read -r BASELINE_TBC BASELINE_PW BASELINE_PT <<< "$BASELINE_CFG"
IFS=',' read -r TUNED_TBC TUNED_PW TUNED_PT <<< "$TUNED_CFG"

# kc_live: true when kc() actually talks to a cluster (or a stub), i.e. when the
# mutating/capturing code paths are real and must be handled honestly.
kc_live() { [ "$DRY_RUN" != "1" ] || [ "$DRY_RUN_EXERCISE_KC" = "1" ]; }

kc() {
  if ! kc_live; then
    # Callers already pass their own `-n <ns>`; don't echo a doubled namespace.
    echo "[dry-run] kubectl ${KCTX:+--context $KCTX }$*" >&2
    return 0
  fi
  if [ -n "$KCTX" ]; then
    "$KUBECTL_BIN" --context "$KCTX" "$@"
  else
    "$KUBECTL_BIN" "$@"
  fi
}

log() { echo "$@" | tee -a "$OUT"; }

log "=== knext scale-to-zero benchmark — service=$SERVICE namespace=$NS ==="
log "context=${KCTX:-<current>} url=$URL max-scale=$MAXSCALE containerConcurrency(burst)=$CC"
log "phases=$PHASES burst-vus=$BURST_VUS (>= container-concurrency*max-scale forces fan-out to cap)"
log "k6 image=$IMG cpu-request=$K6_CPU_REQUEST (kept small — see README 'oversized k6 request' trap)"
if [ "$DRY_RUN" = "1" ]; then
  if [ "$DRY_RUN_EXERCISE_KC" = "1" ]; then
    # The old banner claimed "no kubectl mutation" even under the test seam,
    # i.e. while the script WAS mutating (#425 item 2). Never say "safe" here.
    log "*** DRY RUN + DRY_RUN_EXERCISE_KC=1 (TEST SEAM) — kubectl ('${KUBECTL_BIN}') IS being invoked and the target IS being mutated. This is NOT a safe dry run. ***"
  else
    log "*** DRY RUN — no kubectl mutation, no cluster required ***"
  fi
fi
log ""

# ── capture original ksvc autoscaling state, once, before any mutation ───────
ORIG_MAXSCALE=""
ORIG_CC=""
ORIG_TBC=""
ORIG_PW=""
ORIG_PT=""
CAPTURED=0

# ── run-integrity accounting (#425 item 5) ───────────────────────────────────
# A benchmark that silently omits a rep is worse than one that crashes: the
# partial dataset LOOKS complete. REPS_RUN / INCOMPLETE_REPS make "we measured
# N reps and got data for M of them" an explicit, always-printed fact, and the
# run exits non-zero if M < N so no caller can mistake it for a clean dataset.
REPS_RUN=0
INCOMPLETE_REPS=""

# Capture is ATOMIC and FAIL-CLOSED. It does ONE `get -o json`, checks the exit
# code, and only then sets CAPTURED=1.
#
# The bug this replaces (PR #424 review): the old version ran five separate
# jsonpath gets with `2>/dev/null || true` and set CAPTURED=1 unconditionally, so
# "the get failed" was indistinguishable from "the field is unset". cleanup()
# then dutifully "restored" every field to unset — resetting containerConcurrency
# to 0 and stripping all four autoscaling annotations off a service that may have
# had a real, load-bearing config. A transient API error, a typo'd --service, or
# RBAC that denies `get` but allows `patch` was enough to trigger it.
#
# Rule: never mutate a target whose original state you could not read.
capture_original() {
  if ! kc_live; then
    log "captured original config: (dry-run — no cluster read, nothing will be mutated)"
    return 0
  fi

  if ! command -v jq >/dev/null 2>&1; then
    log "FATAL: 'jq' is required to capture the target's original autoscaling config."
    log "       Refusing to mutate '${SERVICE}' without a reliable way to restore it."
    exit 1
  fi

  local json rc
  json=$(kc get ksvc "$SERVICE" -n "$NS" -o json 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$json" ]; then
    log "FATAL: could not read ksvc '${SERVICE}' in namespace '${NS}' (kubectl get exited ${rc})."
    log "       ABORTING before any mutation — restoring a config we never captured would"
    log "       silently destroy this service's real autoscaling settings."
    log "       kubectl said: ${json:-<no output>}"
    exit 1
  fi

  # One JSON document -> all five values. `// empty` yields "" for genuinely
  # unset fields, which is what cleanup() treats as "remove the annotation".
  local parsed
  parsed=$(printf '%s' "$json" | jq -r '
    .spec.template as $t
    | ($t.metadata.annotations // {}) as $a
    | [ ($a["autoscaling.knative.dev/max-scale"] // ""),
        ($t.spec.containerConcurrency // "" | tostring),
        ($a["autoscaling.knative.dev/target-burst-capacity"] // ""),
        ($a["autoscaling.knative.dev/panic-window-percentage"] // ""),
        ($a["autoscaling.knative.dev/panic-threshold-percentage"] // "") ]
    | .[]' 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    log "FATAL: could not parse the ksvc JSON for '${SERVICE}' (jq exited ${rc}). ABORTING before any mutation."
    log "       jq said: ${parsed}"
    exit 1
  fi

  { read -r ORIG_MAXSCALE; read -r ORIG_CC; read -r ORIG_TBC; read -r ORIG_PW; read -r ORIG_PT; } <<< "$parsed"
  # `null` can survive an explicit JSON null; normalise it to "unset".
  for v in ORIG_MAXSCALE ORIG_CC ORIG_TBC ORIG_PW ORIG_PT; do
    [ "${!v}" = "null" ] && printf -v "$v" '%s' ""
  done

  CAPTURED=1
  log "captured original config: max-scale='${ORIG_MAXSCALE:-<unset>}' containerConcurrency='${ORIG_CC:-<unset(0=unbounded)>}' target-burst-capacity='${ORIG_TBC:-<unset>}' panic-window-pct='${ORIG_PW:-<unset>}' panic-threshold-pct='${ORIG_PT:-<unset>}'"
}

# ── cleanup: restore captured original config + delete any k6 artifacts ──────
# Registered via trap on EXIT/INT/TERM so it runs on success, failure, AND
# interrupt (Ctrl-C) — the two real runs that produced docs/benchmarks/
# scale-to-zero-oke.md were interrupted mid-run and left the cluster patched;
# this trap is the fix.
CLEANED_UP=0
cleanup() {
  [ "$CLEANED_UP" = "1" ] && return 0
  CLEANED_UP=1
  log ""
  log "## CLEANUP — restoring $SERVICE to its captured original autoscaling config"
  if ! kc_live || [ "$CAPTURED" != "1" ]; then
    # Reaching here with CAPTURED=0 outside dry-run means we aborted BEFORE any
    # mutation (see capture_original) — so there is genuinely nothing to undo.
    log "  (dry-run, or aborted before capture — no mutation was made, nothing to restore)"
  else
    local cc_restore="${ORIG_CC:-0}"
    kc patch ksvc "$SERVICE" -n "$NS" --type merge -p \
      "{\"spec\":{\"template\":{\"spec\":{\"containerConcurrency\":${cc_restore}}}}}" \
      >/dev/null 2>&1 || true

    if [ -n "$ORIG_MAXSCALE" ]; then
      kc patch ksvc "$SERVICE" -n "$NS" --type merge -p \
        "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"autoscaling.knative.dev/max-scale\":\"${ORIG_MAXSCALE}\"}}}}}" \
        >/dev/null 2>&1 || true
    else
      kc patch ksvc "$SERVICE" -n "$NS" --type json -p \
        '[{"op":"remove","path":"/spec/template/metadata/annotations/autoscaling.knative.dev~1max-scale"}]' \
        >/dev/null 2>&1 || true
    fi

    for pair in "ORIG_TBC:target-burst-capacity" "ORIG_PW:panic-window-percentage" "ORIG_PT:panic-threshold-percentage"; do
      local var="${pair%%:*}" key="${pair##*:}" val
      val="${!var}"
      if [ -n "$val" ]; then
        kc patch ksvc "$SERVICE" -n "$NS" --type merge -p \
          "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"autoscaling.knative.dev/${key}\":\"${val}\"}}}}}" \
          >/dev/null 2>&1 || true
      else
        kc patch ksvc "$SERVICE" -n "$NS" --type json -p \
          "[{\"op\":\"remove\",\"path\":\"/spec/template/metadata/annotations/autoscaling.knative.dev~1${key}\"}]" \
          >/dev/null 2>&1 || true
      fi
    done
    log "  restored: containerConcurrency=${cc_restore}, max-scale=${ORIG_MAXSCALE:-<removed>}, burst/panic annotations restored/removed to captured originals"
  fi

  # NOTE: reps that lost their metrics deliberately keep their Job (see run_k6).
  # This label-wide sweep still removes them, because leaving Jobs behind after
  # the run ends would leak cluster resources — the operator is told in the
  # warning to read the logs, and Jobs carry ttlSecondsAfterFinished=300 anyway.
  # The Job survives the rep, not the run.
  kc delete job,configmap -n "$NS" -l "app=k6-loadtest,bench-run=${RUN_ID:-scale-to-zero}" --ignore-not-found >/dev/null 2>&1 || true
  log "  k6 Jobs/ConfigMaps for this run deleted (label bench-run=${RUN_ID:-scale-to-zero})"

  # ── run integrity verdict — ALWAYS printed, so a partial dataset can never
  # masquerade as a complete one (#425 item 5).
  log ""
  if [ -n "$INCOMPLETE_REPS" ]; then
    log "*** RUN INCOMPLETE — no k6 metrics captured for: ${INCOMPLETE_REPS} ***"
    log "*** ${REPS_RUN} rep(s) ran; this results file is MISSING data for the reps above. ***"
    log "*** Do NOT publish these numbers as a complete dataset — scope any claim to the reps that have data, and say so. ***"
  else
    log "run integrity: k6 metrics captured for all ${REPS_RUN} rep(s) — dataset is complete"
  fi
  log "=== DONE (results: $OUT) ==="
}
# IMPORTANT: a signal trap that only runs cleanup does NOT terminate the
# script — bash resumes execution after the handler returns, which would
# leave the phase loop running. INT/TERM must explicitly `exit` after
# cleanup; the plain EXIT trap covers normal completion and `set -e`-style
# early returns (cleanup() is idempotent via CLEANED_UP, so double-firing is
# harmless).
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

RUN_ID="s2z-$(date -u +%s)-$$"

# ── helpers ───────────────────────────────────────────────────────────────────
running_pods() {
  kc get pods -n "$NS" -l "serving.knative.dev/service=${SERVICE}" \
    --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' '
}

wait_zero() {
  if ! kc_live; then log "  [dry-run] skip wait-for-zero"; return 0; fi
  # n MUST be initialised: with SCALE_DOWN_TIMEOUT=0 the loop body never runs and
  # the trailing log line would abort the script under `set -u`.
  local t=0 n=0
  while [ "$t" -lt "$SCALE_DOWN_TIMEOUT" ]; do
    n=$(running_pods)
    if [ "$n" = "0" ]; then
      log "  -> scaled to 0 after ${t}s"
      return 0
    fi
    sleep 6
    t=$((t + 6))
  done
  log "  -> still ${n} pod(s) after ${t}s (continuing anyway)"
}

# apply_autoscaling tbc pw pt [cc]  — cc omitted => containerConcurrency untouched
apply_autoscaling() {
  local tbc="$1" pw="$2" pt="$3" cc="${4:-}"
  local cc_patch=""
  [ -n "$cc" ] && cc_patch="\"spec\":{\"containerConcurrency\":${cc}},"
  # A silently-failed patch produces a complete, plausible-looking result file
  # for a config that was never applied — i.e. the whole A/B becomes a lie.
  # Keep stderr and check the exit code.
  local out rc
  out=$(kc patch ksvc "$SERVICE" -n "$NS" --type merge -p \
    "{\"spec\":{\"template\":{${cc_patch}\"metadata\":{\"annotations\":{\"autoscaling.knative.dev/max-scale\":\"${MAXSCALE}\",\"autoscaling.knative.dev/target-burst-capacity\":\"${tbc}\",\"autoscaling.knative.dev/panic-window-percentage\":\"${pw}\",\"autoscaling.knative.dev/panic-threshold-percentage\":\"${pt}\"}}}}}" 2>&1)
  rc=$?
  # In dry-run, kc()'s "[dry-run] kubectl ..." line lands in $out — surface it
  # rather than swallowing it, so --dry-run still shows the patch it would make.
  if ! kc_live; then
    [ -n "$out" ] && log "  ${out}"
    return 0
  fi
  if [ "$rc" -ne 0 ]; then
    log "FATAL: failed to apply autoscaling config (tbc=${tbc} pw=${pw} pt=${pt} cc=${cc:-<unchanged>}); kubectl exited ${rc}."
    log "       Results for an unapplied config would be meaningless — aborting (cleanup will restore the original)."
    log "       kubectl said: ${out}"
    exit 1
  fi
  if kc_live && [ "$APPLY_SETTLE_SECONDS" -gt 0 ] 2>/dev/null; then sleep "$APPLY_SETTLE_SECONDS"; fi
}

# run_k6 rid k6-options-js-fragment iteration-body sample(0|1) phase(cold|soak|burst)
# `phase` exists so the fan-out warning can be scoped to the phase that actually
# measures fan-out (#425 item 4): in cold, 1 request => 1 pod is the only correct
# outcome, and soak is think-time load, so warning there is pure noise on the one
# signal that makes a false-result run visible.
run_k6() {
  local rid="$1" opts="$2" body="$3" sample="$4" phase_kind="${5:-burst}"
  local name="k6-${RUN_ID}-${rid}"

  if ! kc_live; then
    log "  [dry-run] would run k6 job '$name' opts={${opts}} body={${body}} cpu=${K6_CPU_REQUEST}"
    return 0
  fi
  REPS_RUN=$((REPS_RUN + 1))

  cat <<YAML | kc apply -f - >/dev/null 2>&1
apiVersion: v1
kind: ConfigMap
metadata: { name: ${name}, namespace: ${NS}, labels: { app: k6-loadtest, bench-run: "${RUN_ID}" } }
data:
  test.js: |
    import http from 'k6/http'; import { check, sleep } from 'k6';
    export const options = { summaryTrendStats:['avg','med','p(90)','p(95)','p(99)','max'], ${opts} };
    export default function () { const r=http.get('${URL}'); check(r,{'200':(x)=>x.status===200}); ${body} }
---
apiVersion: batch/v1
kind: Job
metadata: { name: ${name}, namespace: ${NS}, labels: { app: k6-loadtest, bench-run: "${RUN_ID}" } }
spec:
  ttlSecondsAfterFinished: 300
  backoffLimit: 0
  template:
    metadata: { labels: { app: k6-loadtest, bench-run: "${RUN_ID}" } }
    spec:
      restartPolicy: Never
      containers:
      - name: k6
        image: ${IMG}
        args: ["run","/scripts/test.js"]
        volumeMounts: [{ name: s, mountPath: /scripts }]
        resources:
          requests: { cpu: "${K6_CPU_REQUEST}", memory: "${K6_MEM_REQUEST}" }
          limits: { cpu: "${K6_CPU_LIMIT}", memory: "${K6_MEM_LIMIT}" }
      volumes: [{ name: s, configMap: { name: ${name} } }]
YAML

  # schedule-check: warn if the k6 pod is still Pending after SCHEDULE_CHECK_TIMEOUT
  # (the "oversized k6 CPU request => Pending => zero-load run" trap, README).
  local st=0 phase=""
  while [ "$st" -lt "$SCHEDULE_CHECK_TIMEOUT" ]; do
    phase=$(kc get pods -n "$NS" -l "job-name=${name}" -o jsonpath='{.items[0].status.phase}' 2>/dev/null || true)
    [ "$phase" = "Running" ] || [ "$phase" = "Succeeded" ] || [ "$phase" = "Failed" ] && break
    sleep 2
    st=$((st + 2))
  done
  if [ "$phase" != "Running" ] && [ "$phase" != "Succeeded" ] && [ "$phase" != "Failed" ]; then
    log "  *** WARNING: k6 pod for '${rid}' still '${phase:-Pending}' after ${SCHEDULE_CHECK_TIMEOUT}s — likely unschedulable (check node CPU headroom vs --k6-cpu-request=${K6_CPU_REQUEST}). This run's metrics may be a FALSE zero-load result. ***"
  fi

  local samp_pid="" peak_file=""
  if [ "$sample" = "1" ]; then
    peak_file=$(mktemp)
    (
      local t=0 mx=0 f2="" fmax=""
      # POD_SAMPLE_BUDGET is an upper bound, not a target: the parent kills this
      # sampler the moment the k6 Job finishes. Emit the collected data from a
      # trap so a killed sampler still reports peak/time-to-N — otherwise the
      # early kill would trade a 240s stall for lost measurements.
      emit() {
        # Test seam only (#425 item 1): pretend the sampler died before it could
        # flush, leaving peak_file empty — the branch the parent must NOT round
        # down to a measured "0".
        [ "$SAMPLER_SIMULATE_LOST" = "1" ] && exit 0
        echo "$mx" > "$peak_file"
        echo "    pods: peak=${mx}  time_to_2pods=${f2:->${POD_SAMPLE_BUDGET}}s  time_to_${MAXSCALE}pods=${fmax:-not-reached}" >> "$OUT"
      }
      trap 'emit; exit 0' TERM
      while [ "$t" -lt "$POD_SAMPLE_BUDGET" ]; do
        n=$(running_pods)
        { [ "$n" -gt "$mx" ]; } 2>/dev/null && mx=$n
        { [ -z "$f2" ] && [ "$n" -ge 2 ]; } 2>/dev/null && f2=$t
        { [ -z "$fmax" ] && [ "$n" -ge "$MAXSCALE" ]; } 2>/dev/null && fmax=$t
        sleep 3
        t=$((t + 3))
      done
      emit
    ) &
    samp_pid=$!
  fi

  # The bug this replaces (#425 item 5): BOTH waits discarded their exit code
  # (`>/dev/null 2>&1 || true`), so "the Job finished" and "the Job is still
  # running / the wait timed out" were indistinguishable. k6 prints its summary
  # ONLY at end of run, so an unfinished pod's logs contain no summary, the grep
  # below matched nothing, and the rep was dropped in silence. Observed live on
  # OKE: `tuned burst rep 2` produced pod metrics, no k6 metrics, and exit 0.
  local wait_state=""
  if kc wait --for=condition=complete "job/${name}" -n "$NS" --timeout="${K6_JOB_TIMEOUT}s" >/dev/null 2>&1; then
    wait_state="completed"
  elif kc wait --for=condition=failed "job/${name}" -n "$NS" --timeout=10s >/dev/null 2>&1; then
    wait_state="failed"
  else
    wait_state="timed-out"
  fi

  # The Job is done — stop sampling NOW. Waiting out the full POD_SAMPLE_BUDGET
  # cost ~21 min of idle polling per cold phase (~40 min per default run) for
  # ~10s of actual work. The TERM trap above flushes the results first.
  if [ -n "$samp_pid" ]; then
    kill -TERM "$samp_pid" 2>/dev/null
    wait "$samp_pid" 2>/dev/null
  fi

  if [ "$wait_state" != "completed" ]; then
    log "  *** WARNING: the k6 Job for '${rid}' did not complete — kubectl wait result: ${wait_state}. ***"
    [ "$wait_state" = "timed-out" ] && \
      log "  ***   'timed-out' = neither condition=complete nor condition=failed within ${K6_JOB_TIMEOUT}s; the Job may still be running, so any metrics below are partial or absent. ***"
  fi

  # Capture metrics into a variable FIRST so "how many lines did we get?" is a
  # checkable fact, instead of appending straight to $OUT where zero lines is
  # indistinguishable from a rep that was never run.
  local metrics metric_lines=0
  metrics=$(kc logs -n "$NS" "job/${name}" 2>/dev/null \
    | grep -E 'http_req_duration|http_req_failed|http_reqs|iteration_duration|checks\.\.\.|vus_max|dropped' \
    | sed 's/^/    /')
  if [ -n "$metrics" ]; then
    metric_lines=$(printf '%s\n' "$metrics" | wc -l | tr -d ' ')
    printf '%s\n' "$metrics" >> "$OUT"
  fi

  if [ -n "$peak_file" ]; then
    local peak_raw
    peak_raw=$(tr -d '[:space:]' < "$peak_file" 2>/dev/null)
    rm -f "$peak_file"
    if [ -z "$peak_raw" ]; then
      # An empty peak_file means the sampler never reported — which is NOT the
      # same fact as "the service peaked at 0 pods" (#425 item 1). Coercing it
      # to 0 published an unmeasured number as a measurement.
      log "  *** WARNING: peak pods = <no sampler data> for '${rid}' — the pod sampler produced no measurement. Fan-out for this rep is UNKNOWN, not zero. ***"
    else
      case "$phase_kind" in
        burst)
          if [ "$peak_raw" -le 1 ] 2>/dev/null; then
            log "  *** WARNING: peak pods = ${peak_raw} — this burst rep did NOT fan out past 1 pod, so the A/B is inconclusive for this rep (think-time load or too-low VUs/containerConcurrency ratio — see README false-result traps). ***"
          fi ;;
        cold)
          # 1 request => 1 pod is the only correct cold-start outcome; warning
          # here trains the reader to skim past the one signal that matters.
          log "    (peak pods = ${peak_raw} — expected for the cold phase: a single request needs a single pod; fan-out is not measured here)" ;;
        soak)
          log "    (peak pods = ${peak_raw} — soak is think-time load; sustained throughput, not fan-out, is what this phase measures)" ;;
      esac
    fi
  fi

  if [ "$metric_lines" -eq 0 ]; then
    INCOMPLETE_REPS="${INCOMPLETE_REPS}${INCOMPLETE_REPS:+, }${rid}"
    log "  *** WARNING: no k6 metrics captured for '${rid}' — this rep's result is INCOMPLETE (k6 Job ${wait_state}). ***"
    log "  *** The k6 Job has been KEPT rather than deleted, because it is now the only remaining evidence. Read it with: ***"
    log "  ***   kubectl logs -n ${NS} job/${name} ***"
    log "  *** (the Job still carries ttlSecondsAfterFinished: 300, so it is reaped shortly — capture the logs now.) ***"
    return 0
  fi

  kc delete job,configmap -n "$NS" "${name}" >/dev/null 2>&1 || true
}

# ── phases ────────────────────────────────────────────────────────────────────
phase_cold() {
  log ""
  log "## PHASE A — cold start: ${COLD_SAMPLES} sequential single-request samples (baseline config)"
  apply_autoscaling "$BASELINE_TBC" "$BASELINE_PW" "$BASELINE_PT"
  for i in $(seq 1 "$COLD_SAMPLES"); do
    log "  -- cold-start sample $i/${COLD_SAMPLES} --"
    wait_zero
    run_k6 "cold-${i}" "vus: 1, iterations: 1" "" 1 cold
  done
}

phase_soak() {
  log ""
  log "## PHASE C — sustained soak: ramp 0->${SOAK_VUS} VU/${SOAK_RAMP}, hold ${SOAK_HOLD} (baseline config, think-time load)"
  apply_autoscaling "$BASELINE_TBC" "$BASELINE_PW" "$BASELINE_PT"
  wait_zero
  run_k6 "soak" "stages:[{duration:'${SOAK_RAMP}',target:${SOAK_VUS}},{duration:'${SOAK_HOLD}',target:${SOAK_VUS}},{duration:'10s',target:0}]" "sleep(1);" 1 soak
  log ""
  log "## PHASE D — scale-down after soak (time-to-zero)"
  wait_zero
}

phase_burst() {
  log ""
  log "## PHASE B — discriminating burst A/B: containerConcurrency pinned to ${CC}, continuous"
  if [ "$CC" -gt 0 ] 2>/dev/null; then
    log "   (no-think-time) load at ${BURST_VUS} VUs. ${BURST_VUS} / ${CC} = $((BURST_VUS / CC))"
    log "   pods needed — sized against --max-scale=${MAXSCALE} to force real fan-out to the cap."
  else
    # containerConcurrency=0 is Knative's "unbounded" — there is no VUs-per-pod
    # ratio, so fan-out is driven by the autoscaler's RPS target, not by CC.
    log "   (no-think-time) load at ${BURST_VUS} VUs. containerConcurrency=0 (unbounded):"
    log "   no VUs-per-pod cap, so fan-out depends on the autoscaler's RPS target, not CC."
    log "   Expect a WEAKER A/B signal than with a pinned containerConcurrency."
  fi
  local burst_opts="stages:[{duration:'${BURST_RAMP}',target:${BURST_VUS}},{duration:'${BURST_HOLD}',target:${BURST_VUS}},{duration:'${BURST_COOLDOWN}',target:10}]"
  for cfg in "baseline $BASELINE_TBC $BASELINE_PW $BASELINE_PT" "tuned $TUNED_TBC $TUNED_PW $TUNED_PT"; do
    # shellcheck disable=SC2086 # intentional word-split of "name tbc pw pt"
    set -- $cfg
    local nm="$1" tbc="$2" pw="$3" pt="$4"
    log ""
    log "## BURST CONFIG=$nm (target-burst-capacity=$tbc panic-window-pct=$pw panic-threshold-pct=$pt), ${BURST_REPS} reps"
    apply_autoscaling "$tbc" "$pw" "$pt" "$CC"
    for r in $(seq 1 "$BURST_REPS"); do
      log "  -- $nm burst rep $r --"
      wait_zero
      run_k6 "burst-${nm}-${r}" "$burst_opts" "" 1 burst
    done
  done
}

# ── main ──────────────────────────────────────────────────────────────────────
capture_original

IFS=',' read -ra PHASE_LIST <<< "$PHASES"
for p in "${PHASE_LIST[@]}"; do
  case "$p" in
    cold) phase_cold ;;
    soak) phase_soak ;;
    burst) phase_burst ;;
    all) phase_cold; phase_soak; phase_burst ;;
    # `none` runs no load phases (capture + restore only). NOTE: PHASES="" does
    # NOT mean this — run.sh reads `${PHASES:-cold,soak,burst}`, and `:-` treats
    # an EMPTY value as unset, so PHASES="" silently runs ALL THREE phases. That
    # trap cost real debugging time (#425): capture-restore.test.sh believed it
    # was running zero phases for months. Use `none` when you mean none.
    none|"") ;;
    *) log "Unknown phase '$p' — skipping (valid: cold,soak,burst,all,none)" ;;
  esac
done

# cleanup runs via the EXIT trap (and prints the run-integrity verdict there).
#
# Exit non-zero if ANY rep lost its metrics (#425 item 5). The observed failure
# was a run that dropped a rep and still exited 0, so every automated caller —
# and every human skimming the tail — read it as a clean, complete dataset.
# A partial result must be loud in the exit code too, not just in the text.
if [ -n "$INCOMPLETE_REPS" ]; then
  exit 2
fi
# Explicit: falling off the end would leak the exit status of the test above (1),
# turning every clean run into a spurious failure.
exit 0
