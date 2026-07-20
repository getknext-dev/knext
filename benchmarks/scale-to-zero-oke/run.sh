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
# ── bounded retry for TRANSIENT control-plane errors (#427) ──────────────────
# Two of the three OKE runs behind docs/benchmarks/scale-to-zero-oke.md died on
# "Unable to connect to the server: net/http: TLS handshake timeout" while
# applying a burst config, throwing away an otherwise-valid partial dataset. The
# refusal to measure an UNAPPLIED config is correct and is preserved exactly —
# these knobs only decide how long we wait for a blip to pass before concluding
# the failure is real. Bounded means bounded: a genuinely unreachable cluster
# still aborts, just a few seconds later.
API_RETRY_ATTEMPTS="${API_RETRY_ATTEMPTS:-4}"      # total attempts (1 = no retry)
API_RETRY_BASE_MS="${API_RETRY_BASE_MS:-500}"      # first backoff step
API_RETRY_MAX_MS="${API_RETRY_MAX_MS:-8000}"       # per-step backoff ceiling
# Wall-clock box per operation. Enforced BOTH between attempts and, via
# timeout(1), on each individual call — so a hung apiserver is bounded too. If
# no timeout/gtimeout binary exists (stock macOS), it degrades to bounding only
# the retry *scheduling*: the worst case is then attempts x per-call duration,
# and the run says so at startup.
API_RETRY_DEADLINE_S="${API_RETRY_DEADLINE_S:-60}"
# Per-CALL cap, distinct from the TOTAL budget above. Making one knob do both
# jobs made API_RETRY_ATTEMPTS dead for the case this feature exists for: a hung
# first attempt consumed the entire budget, so a stalled apiserver got exactly
# one attempt however many were configured. Default: deadline/attempts (>=1s),
# so all configured attempts fit inside the total budget by construction and the
# budget stays the authoritative bound. Set explicitly to override; an override
# larger than the total budget is clamped to it, because no single call may
# outlive the budget that bounds the whole operation.
API_CALL_TIMEOUT_S="${API_CALL_TIMEOUT_S:-}"
API_TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then API_TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then API_TIMEOUT_BIN="gtimeout"; fi
KC_TIMEOUT_S=0   # >0 only while an api_retry attempt is in flight (see kc())

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

Transient-API retry (see README "Transient API retry"):
  --api-retry-attempts <n>    total attempts per API operation, 1 = no retry (default: 4;
                               \$API_RETRY_ATTEMPTS)
  --api-retry-base-ms <ms>    first backoff step (default: 500; \$API_RETRY_BASE_MS)
  --api-retry-max-ms <ms>     per-step backoff ceiling (default: 8000; \$API_RETRY_MAX_MS)
  --api-call-timeout-s <s>    hard cap on a SINGLE API call (default: derived as
                              \$API_RETRY_DEADLINE_S / attempts, min 1s; \$API_CALL_TIMEOUT_S).
                              Clamped to the total budget.
                              \$API_RETRY_DEADLINE_S (default 60) is the TOTAL wall-clock
                              budget for one operation; the per-call cap above bounds each
                              individual (possibly hung) call via timeout(1), so every
                              configured attempt fits inside the budget. Without
                              timeout/gtimeout on PATH only the scheduling is bounded
                              (the run says so at startup).
                              ONLY transient errors (TLS handshake timeout, connection
                              refused/reset, i/o timeout, 5xx, TooManyRequests/throttling)
                              are retried;
                              NotFound/Forbidden/Invalid and anything unrecognised fail fast.

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
    --api-retry-attempts) API_RETRY_ATTEMPTS="$2"; shift 2 ;;
    --api-call-timeout-s) API_CALL_TIMEOUT_S="$2"; shift 2 ;;
    --api-retry-base-ms) API_RETRY_BASE_MS="$2"; shift 2 ;;
    --api-retry-max-ms) API_RETRY_MAX_MS="$2"; shift 2 ;;
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
  # KC_TIMEOUT_S (>0) hard-caps this single invocation. api_retry sets it for the
  # duration of an attempt so API_RETRY_DEADLINE_S bounds a HUNG call and not
  # merely the gap between attempts. It stays unset everywhere else, so the
  # bounded poll loops (wait_zero/running_pods) are untouched.
  local tmo=()
  if [ -n "$API_TIMEOUT_BIN" ] && [ "${KC_TIMEOUT_S:-0}" -gt 0 ] 2>/dev/null; then
    # -k: KILL shortly after TERM, so the box holds even against a wedged client.
    tmo=("$API_TIMEOUT_BIN" -k 5 "$KC_TIMEOUT_S")
  fi
  if [ -n "$KCTX" ]; then
    ${tmo[@]+"${tmo[@]}"} "$KUBECTL_BIN" --context "$KCTX" "$@"
  else
    ${tmo[@]+"${tmo[@]}"} "$KUBECTL_BIN" "$@"
  fi
}

log() { echo "$@" | tee -a "$OUT"; }

# ── transient-vs-terminal API error classification (#427) ────────────────────
# Mirrors the spirit of isTerminalWakeErr() in
# packages/scale-zero-pg/gateway/internal/wake/retry.go: TERMINAL means "retrying
# cannot fix this", so fail loud immediately instead of burning the budget.
#
# The bias here is deliberately the OPPOSITE of the Go version's. There, retrying
# is safe by default because GetScale->UpdateScale is idempotent and the caller is
# a latency-sensitive wake path. Here, a wrong "transient" verdict turns a real
# misconfiguration (typo'd --service, missing RBAC, invalid annotation value) into
# a SLOW failure in an interactive benchmark run — so terminal patterns are
# checked FIRST and ANYTHING UNRECOGNISED IS TREATED AS TERMINAL. Adding a new
# transient pattern is a deliberate act, never an accident of matching order.
#
#   terminal  — NotFound, Forbidden, Unauthorized, Invalid/validation, BadRequest,
#               AlreadyExists, MethodNotAllowed, Gone, unknown-field  ... and any
#               message this function does not recognise.
#   transient — TLS handshake timeout, connection refused/reset, broken pipe,
#               i/o timeout, "unable to connect to the server", context deadline
#               exceeded, etcd/request timed out, TooManyRequests/throttling,
#               5xx (InternalError/ServiceUnavailable/ServerTimeout), unexpected EOF.
#
# NOTE: there is deliberately NO bare "429" pattern. kubectl renders a real
# rate-limit as "Error from server (TooManyRequests): ..." (already matched), so
# the substring only ever fired on 429 appearing as a *number* — e.g. a Knative
# admission denial "expected 0 <= 429 <= 100" for a USER-SUPPLIED --tuned value,
# which carries no invalid/validating token and would otherwise be retried. That
# turns a typo'd flag into a slow failure: exactly what the terminal-first bias
# is here to prevent.
classify_api_error() {
  local m
  # LC_ALL=C: kubectl stderr can carry binary bytes, and a locale-aware tr(1)
  # then prints "tr: Illegal byte sequence" to our stderr. Classification already
  # falls back to terminal in that case; the stray diagnostic is pure noise.
  m=$(printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]' 2>/dev/null)
  # TERMINAL first — a terminal error mentioning a timeout must stay terminal.
  case "$m" in
    *notfound*|*"not found"*|*forbidden*|*unauthorized*|*"is invalid"*|*invalid*|\
    *badrequest*|*"bad request"*|*"already exists"*|*"error validating"*|\
    *"unknown field"*|*methodnotallowed*|*"method not allowed"*|*"(gone)"*|\
    *"no such host"*|*"couldn't get current server api group list"*)
      echo terminal; return 0 ;;
  esac
  case "$m" in
    *"tls handshake timeout"*|*"connection refused"*|*"connection reset"*|\
    *"was refused"*|*"time allotted"*|\
    *"broken pipe"*|*"i/o timeout"*|*"unable to connect to the server"*|\
    *"context deadline exceeded"*|*"request timed out"*|*"etcdserver"*|\
    *"server timeout"*|*servertimeout*|*"too many requests"*|*toomanyrequests*|\
    *throttl*|*internalerror*|*"internal error"*|*serviceunavailable*|\
    *"service unavailable"*|*"an error on the server"*|*"unexpected eof"*|\
    *"the server is currently unable to handle the request"*|\
    *"transport is closing"*|*"network is unreachable"*|*"no route to host"*)
      echo transient; return 0 ;;
  esac
  # Unrecognised => TERMINAL. Failing fast on an unknown error is recoverable by
  # a human; slowly retrying a real misconfiguration wastes a long benchmark run.
  echo terminal
}

# ── retry accounting — a degraded run must never look like a clean one ───────
# This harness has already shipped three "the results look cleaner than reality"
# bugs (#424, #425, #426). A run that limped through a flaky control-plane window
# is NOT the same artifact as a first-try-clean run, so every retry is recorded
# in the results file and summarised in the final verdict.
API_RETRY_COUNT=0
API_RETRY_OPS=""   # newline-separated op names, one line per retry performed
# Retries are only half the story. An operation that hit transient errors and
# was then GIVEN UP ON (attempts exhausted, or the wall-clock budget spent while
# a call was still hanging) recorded nothing at all: the wall-clock check
# returned before the retry counter was incremented, so a run whose control
# plane demonstrably stalled was filed as "api retries: 0 ... clean
# control-plane run". Abandonments are therefore counted separately and
# reported, and the "clean" claim requires BOTH counters to be zero.
API_ABANDONED_COUNT=0
API_ABANDONED_OPS=""

# record_api_abandon <op-label> <why> — a transient failure we stopped fighting.
record_api_abandon() {
  API_ABANDONED_COUNT=$((API_ABANDONED_COUNT + 1))
  API_ABANDONED_OPS="${API_ABANDONED_OPS}${1}"$'\n'
  log "  api-abandoned: op='${1}' — giving up after transient failures: ${2}; the API said: $(printf '%s' "$API_RETRY_LAST_OUT" | head -n 1)"
}

# api_call_cap <attempts> — the per-call timeout(1) cap for one attempt.
api_call_cap() {
  local attempts="$1" deadline="$API_RETRY_DEADLINE_S" cap
  [ "$deadline" -ge 1 ] 2>/dev/null || { echo 0; return 0; }
  if [ -n "$API_CALL_TIMEOUT_S" ]; then
    cap="$API_CALL_TIMEOUT_S"
    [ "$cap" -ge 1 ] 2>/dev/null || cap=0
  else
    cap=$(( deadline / attempts ))
    [ "$cap" -lt 1 ] && cap=1
  fi
  # A single call may never outlive the budget for the whole operation.
  [ "$cap" -gt "$deadline" ] && cap="$deadline"
  echo "$cap"
}

# api_retry <op-label> <command...>
# Runs the command, retrying ONLY transient failures with capped exponential
# backoff, bounded by API_RETRY_ATTEMPTS and deadline-boxed by API_RETRY_DEADLINE_S.
# Returns the command's exit code; the combined output is left in API_RETRY_LAST_OUT
# so callers keep their existing "kubectl said: ..." reporting verbatim.
#
# MUST NOT be called inside $(...) — it sets globals the caller depends on.
API_RETRY_LAST_OUT=""
API_RETRY_LAST_ATTEMPTS=0

# ── per-call enforcement of API_RETRY_DEADLINE_S ─────────────────────────────
# The deadline used to be checked only BETWEEN attempts, so a *hung* call was
# not bounded at all: a 25s-hanging kubectl under API_RETRY_DEADLINE_S=5 still
# took 26s, and the worst case was attempts x per-call duration. Each attempt is
# now wrapped in timeout(1) so the box is real. `timeout` is coreutils; on a
# stock macOS without it we degrade to the old scheduling-only bound and SAY SO
# rather than keep claiming a guarantee we are not providing.
api_retry() {
  local op="$1"; shift
  local attempts="$API_RETRY_ATTEMPTS"
  [ "$attempts" -ge 1 ] 2>/dev/null || attempts=1
  local backoff_ms="$API_RETRY_BASE_MS" n=1 rc=0 class="" start now
  [ "$backoff_ms" -ge 0 ] 2>/dev/null || backoff_ms=0
  start=$(date +%s)
  local per_call
  per_call=$(api_call_cap "$attempts")
  while :; do
    # Set explicitly rather than as an assignment prefix: prefix assignments on a
    # shell-function call have surprising persistence semantics across bash modes.
    KC_TIMEOUT_S="$per_call"
    API_RETRY_LAST_OUT=$("$@" 2>&1)
    rc=$?
    KC_TIMEOUT_S=0
    # timeout(1) reports 124 on expiry (137 if it had to KILL). Synthesise a
    # message so the stall classifies as the transient it is, and so the caller's
    # verbatim "kubectl said: ..." reporting stays truthful instead of blank.
    if [ -n "$API_TIMEOUT_BIN" ] && [ "$per_call" -gt 0 ] \
       && { [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; }; then
      API_RETRY_LAST_OUT="i/o timeout: the API call did not return within the per-call cap of ${per_call}s (budget API_RETRY_DEADLINE_S=${API_RETRY_DEADLINE_S}s / ${attempts} attempts) and was terminated${API_RETRY_LAST_OUT:+ — partial output: ${API_RETRY_LAST_OUT}}"
    fi
    API_RETRY_LAST_ATTEMPTS=$n
    [ "$rc" -eq 0 ] && return 0

    class=$(classify_api_error "$API_RETRY_LAST_OUT")
    # Terminal: fail exactly as fast as before this feature existed.
    [ "$class" != "transient" ] && return "$rc"
    # Bounded by attempts...
    if [ "$n" -ge "$attempts" ]; then
      record_api_abandon "$op" "API_RETRY_ATTEMPTS=${attempts} exhausted"
      return "$rc"
    fi
    # ...and by wall clock. With timeout(1) present this is a genuine box: each
    # attempt is itself capped at ${per_call}s, so a hung apiserver cannot
    # stretch a run. Without it, this check only bounds *scheduling*.
    # The abandonment is RECORDED before returning: this return used to be the
    # one exit that left no trace, which is how a stalled run got filed as clean.
    now=$(date +%s)
    if [ $((now - start)) -ge "$API_RETRY_DEADLINE_S" ] 2>/dev/null; then
      record_api_abandon "$op" "the API_RETRY_DEADLINE_S=${API_RETRY_DEADLINE_S}s budget was spent after ${n} attempt(s)"
      return "$rc"
    fi

    # Equal jitter (d/2 + rand[0,d/2]) so repeated ops don't synchronise.
    local sleep_ms sleep_s
    sleep_ms=$(( backoff_ms / 2 + (RANDOM % (backoff_ms / 2 + 1)) ))
    sleep_s=$(awk -v ms="$sleep_ms" 'BEGIN { printf "%.3f", ms / 1000 }')
    sleep "$sleep_s"

    # Committed to another attempt: count it NOW so the record matches reality.
    API_RETRY_COUNT=$((API_RETRY_COUNT + 1))
    API_RETRY_OPS="${API_RETRY_OPS}${op}"$'\n'
    log "  api-retry: op='${op}' attempt=${n}/${attempts} class=transient — retrying after ${sleep_ms}ms; the API said: $(printf '%s' "$API_RETRY_LAST_OUT" | head -n 1)"

    backoff_ms=$((backoff_ms * 2))
    [ "$backoff_ms" -gt "$API_RETRY_MAX_MS" ] 2>/dev/null && backoff_ms="$API_RETRY_MAX_MS"
    n=$((n + 1))
  done
}

log "=== knext scale-to-zero benchmark — service=$SERVICE namespace=$NS ==="
log "context=${KCTX:-<current>} url=$URL max-scale=$MAXSCALE containerConcurrency(burst)=$CC"
log "phases=$PHASES burst-vus=$BURST_VUS (>= container-concurrency*max-scale forces fan-out to cap)"
log "k6 image=$IMG cpu-request=$K6_CPU_REQUEST (kept small — see README 'oversized k6 request' trap)"
if [ -z "$API_TIMEOUT_BIN" ]; then
  log "NOTE: no timeout(1)/gtimeout on PATH — API_RETRY_DEADLINE_S=${API_RETRY_DEADLINE_S}s bounds only retry SCHEDULING, not an individual hung API call (worst case ~ ${API_RETRY_ATTEMPTS} x per-call duration). Install coreutils for a hard per-call box."
else
  log "api retry: up to ${API_RETRY_ATTEMPTS} attempt(s) per operation, each call capped at $(api_call_cap "$API_RETRY_ATTEMPTS")s, total budget API_RETRY_DEADLINE_S=${API_RETRY_DEADLINE_S}s (worst case ~ budget + one per-call cap)."
fi
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
# Did the script reach its normal end-of-phases fall-through? Without this, a
# FATAL *after* >=1 clean rep exited 1 while cleanup() still printed "dataset is
# complete": no rep was flagged incomplete, so "nothing was flagged" was read as
# "nothing is missing". It is not — the run was truncated, so the reps that never
# ran are missing from a file that claimed to be the configured experiment. The
# verdict is therefore derived from all three facts (reps run, incomplete reps,
# finished normally), not from the absence of a flag.
PHASES_COMPLETED=0
# How much of a lost rep's raw k6 log to embed in the results file. Bounded so a
# chatty Job cannot bury the rest of the results, but large enough to contain a
# k6 summary plus the surrounding failure context.
RAW_LOG_TAIL_LINES="${RAW_LOG_TAIL_LINES:-200}"

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

  # The READ is retried on transient errors (#427) — but the fail-closed contract
  # is untouched: retrying a blip before CONCLUDING failure is fine, silently
  # proceeding with an unread config is not. On exhaustion (or on any terminal
  # error, which is not retried at all) we still abort BEFORE any mutation.
  local json rc
  api_retry "capture-original" kc get ksvc "$SERVICE" -n "$NS" -o json
  rc=$?
  json="$API_RETRY_LAST_OUT"
  if [ "$rc" -ne 0 ] || [ -z "$json" ]; then
    log "FATAL: could not read ksvc '${SERVICE}' in namespace '${NS}' (kubectl get exited ${rc} after ${API_RETRY_LAST_ATTEMPTS} attempt(s))."
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
  # Per-rep data loss is reported independently of how the run ended, because a
  # run can be BOTH truncated and missing a rep's metrics — reporting only one
  # of the two would hide the other.
  # Transient-retry disclosure (#427). Printed ALWAYS, including the zero case,
  # so "this run hit no API trouble" is a positive statement in the artifact
  # rather than the absence of a line a reader might not know to look for.
  # A run is degraded if the control plane misbehaved AT ALL — whether we
  # recovered by retrying or gave up. Keying this on the retry count alone meant
  # a run killed by a stalled apiserver (0 retries, 1 abandonment) printed the
  # "clean control-plane run" line.
  if [ "$API_RETRY_COUNT" -gt 0 ] || [ "$API_ABANDONED_COUNT" -gt 0 ]; then
    local ops_summary
    ops_summary=$(printf '%s%s' "$API_RETRY_OPS" "$API_ABANDONED_OPS" | grep -v '^$' | sort | uniq -c \
      | awk '{ printf "%s%s x%s", (NR>1 ? ", " : ""), $2, $1 }')
    log "*** RUN DEGRADED BY TRANSIENT API ERRORS — ${API_RETRY_COUNT} retry/retries, ${API_ABANDONED_COUNT} abandoned call(s): ${ops_summary} ***"
    # "The data is valid" is a claim about DATA, so it may only be made when
    # there IS complete data. Printed unconditionally it contradicted the
    # authoritative verdict two lines below on a zero-rep or data-losing run —
    # the fifth "reads cleaner than reality" bug in this harness.
    if [ "$REPS_RUN" -gt 0 ] && [ -z "$INCOMPLETE_REPS" ] && [ "$PHASES_COMPLETED" -eq 1 ]; then
      log "*** The control plane was flaky during this run. The data is valid (every config was verified applied), but timings may include control-plane stalls — see the 'api-retry:'/'api-abandoned:' lines above. ***"
    else
      log "*** The control plane was flaky during this run. Every config that WAS applied was verified applied, but this run did not produce a complete dataset — see the run-integrity verdict below, and the 'api-retry:' lines above. ***"
    fi
    # One line, both facts. Reporting only the retry count let "api retries: 0"
    # stand alone on a run that stalled and was abandoned — a reader grepping
    # for that line would have read it as "clean".
    log "api retries: ${API_RETRY_COUNT}, api calls abandoned after transient failure(s): ${API_ABANDONED_COUNT} (the control plane misbehaved — this run is NOT a clean first-try run)"
  else
    log "api retries: 0 (no transient API errors — clean control-plane run)"
  fi

  if [ -n "$INCOMPLETE_REPS" ]; then
    log "*** RUN INCOMPLETE — untrustworthy rep(s): ${INCOMPLETE_REPS} ***"
    log "*** ${REPS_RUN} rep(s) ran; this results file is MISSING or UNRELIABLE data for the reps above. ***"
    log "*** Do NOT publish these numbers as a complete dataset — scope any claim to the reps that have data, and say so. ***"
  fi
  # The verdict is a function of (finished normally, reps run, incomplete reps).
  # "Complete" requires the run to have finished ALL configured work — never
  # merely "nothing was flagged".
  if [ "$PHASES_COMPLETED" -ne 1 ]; then
    if [ "$REPS_RUN" -eq 0 ]; then
      # A FATAL before the first rep: nothing was measured at all.
      log "run integrity: no reps ran; no data collected — this file is NOT a dataset"
    else
      log "run integrity: ABORTED after ${REPS_RUN} rep(s) — partial dataset, NOT the configured experiment"
    fi
  elif [ -n "$INCOMPLETE_REPS" ]; then
    log "run integrity: ${REPS_RUN} rep(s) ran but some LOST data — dataset is NOT complete"
  elif [ "$REPS_RUN" -eq 0 ]; then
    # "metrics captured for all 0 rep(s) — dataset is complete" is literally
    # true and completely misleading: it fired on `--phases none`, i.e. the
    # designated integrity verdict asserted completeness for a run that
    # collected nothing.
    log "run integrity: no reps ran; no data collected — this file is NOT a dataset"
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
  local out rc payload
  payload="{\"spec\":{\"template\":{${cc_patch}\"metadata\":{\"annotations\":{\"autoscaling.knative.dev/max-scale\":\"${MAXSCALE}\",\"autoscaling.knative.dev/target-burst-capacity\":\"${tbc}\",\"autoscaling.knative.dev/panic-window-percentage\":\"${pw}\",\"autoscaling.knative.dev/panic-threshold-percentage\":\"${pt}\"}}}}}"
  # In dry-run, kc()'s "[dry-run] kubectl ..." line lands in $out — surface it
  # rather than swallowing it, so --dry-run still shows the patch it would make.
  if ! kc_live; then
    out=$(kc patch ksvc "$SERVICE" -n "$NS" --type merge -p "$payload" 2>&1)
    [ -n "$out" ] && log "  ${out}"
    return 0
  fi
  # This is THE call site that killed two of three OKE runs (#427): a TLS
  # handshake timeout here discarded an otherwise-valid partial dataset. Retry
  # transient blips; terminal errors (and exhaustion) fall through to the
  # UNCHANGED FATAL below, because measuring an unapplied config is still a lie.
  api_retry "apply-autoscaling" kc patch ksvc "$SERVICE" -n "$NS" --type merge -p "$payload"
  rc=$?
  out="$API_RETRY_LAST_OUT"
  if [ "$rc" -ne 0 ]; then
    log "FATAL: failed to apply autoscaling config (tbc=${tbc} pw=${pw} pt=${pt} cc=${cc:-<unchanged>}); kubectl exited ${rc} after ${API_RETRY_LAST_ATTEMPTS} attempt(s)."
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

  # Capture the raw logs ONCE, then derive both the metrics block and the
  # completeness check from them — a second `kubectl logs` could race the Job's
  # TTL and see different output.
  local raw_logs metrics
  raw_logs=$(kc logs -n "$NS" "job/${name}" 2>/dev/null)
  metrics=$(printf '%s\n' "$raw_logs" \
    | grep -E 'http_req_duration|http_req_failed|http_reqs|iteration_duration|checks\.\.\.|vus_max|dropped' \
    | sed 's/^/    /')
  [ -n "$metrics" ] && printf '%s\n' "$metrics" >> "$OUT"

  # Completeness is a check for an expected SET of keys, NOT a line count.
  # A count-based test ("did we get >=1 matching line?") let a truncated or
  # partially-flushed k6 summary — e.g. an http_reqs line and nothing else —
  # pass as a complete rep, which is exactly the "partial dataset masquerading
  # as complete" failure this harness exists to prevent (#425, PR #426 review).
  local missing_keys="" key
  for key in http_req_duration http_req_failed http_reqs checks; do
    printf '%s\n' "$metrics" | grep -q "$key" || \
      missing_keys="${missing_keys}${missing_keys:+, }${key}"
  done

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

  # Two independent ways a rep can fail to be trustworthy. Both are recorded
  # with the REASON, so the final verdict says what is wrong, not just that
  # something is.
  local rep_problem=""
  if [ -z "$metrics" ]; then
    rep_problem="no k6 metrics captured (k6 Job ${wait_state})"
  elif [ -n "$missing_keys" ]; then
    rep_problem="k6 metrics INCOMPLETE — missing: ${missing_keys}"
  elif [ "$wait_state" != "completed" ]; then
    # DELIBERATE: metrics that look whole are still not trusted when the Job did
    # not finish cleanly. `kubectl wait` never saw condition=complete, so the
    # summary may have been flushed mid-flight (k6 prints a summary on abort
    # too) and the numbers describe a truncated test, not the configured one.
    # Under-reporting confidence is the safe direction for a benchmark whose
    # output gets published.
    rep_problem="k6 Job did not finish cleanly (kubectl wait result: ${wait_state})"
  fi

  if [ -n "$rep_problem" ]; then
    INCOMPLETE_REPS="${INCOMPLETE_REPS}${INCOMPLETE_REPS:+, }${rid} [${rep_problem}]"
    log "  *** WARNING: ${rep_problem} for '${rid}' — this rep's result is INCOMPLETE. ***"
    # Copy the raw logs into the RESULTS FILE. The Job is kept for the rest of
    # this rep, but cleanup()'s label sweep reaps it when the run ends — for the
    # final rep (the observed #425 failure) that is seconds later, so a printed
    # `kubectl logs` instruction would point at an object already gone. Evidence
    # only counts if it outlives the run.
    log "  *** The raw k6 Job log is captured below, in this results file, because the Job itself does not survive the run. ***"
    log "  --- raw k6 Job log for '${rid}' (job/${name}, last ${RAW_LOG_TAIL_LINES} lines) ---"
    if [ -n "$raw_logs" ]; then
      printf '%s\n' "$raw_logs" | tail -n "$RAW_LOG_TAIL_LINES" | sed 's/^/  | /' >> "$OUT"
    else
      log "  | (kubectl logs returned nothing for job/${name} — the Job's pod may already be gone)"
    fi
    log "  --- end raw k6 Job log for '${rid}' ---"
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
# Every configured phase ran to completion. Set BEFORE the exit below so the
# EXIT trap can tell "finished, but a rep lost data" (exit 2) apart from
# "aborted part-way through" (a FATAL's exit 1) — those are different datasets.
PHASES_COMPLETED=1

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
