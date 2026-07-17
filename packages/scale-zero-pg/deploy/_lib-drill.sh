#!/usr/bin/env sh
# _lib-drill.sh — shared, cluster-free helpers for the deploy/_verify-*.sh drill
# battery. SOURCE this ("." it) from a drill; do NOT execute it except for the
# `selftest` subcommand (`sh deploy/_lib-drill.sh selftest`).
#
# WHY (issue #198): the battery's fixed timing budgets were calibrated for a fast
# ~2–5s cold wake. On a slow / CPU-request-constrained cluster cold wakes run
# ~14s mean / ~19s max, so those fixed budgets FALSE-FAIL even though the products
# are healthy. These helpers size idle/hold budgets off ONE knob — WAKE_BUDGET_MS —
# so a single env var (or a future measured probe) re-tunes the whole battery for
# any cluster instead of scattering magic numbers across the drills.
#
#   WAKE_BUDGET_MS   EXPLICIT override of the worst-case cold-wake latency in ms.
#                    When set it ALWAYS wins (operators/CI pin the battery). When
#                    unset, the budget is ADAPTIVE (#340): a drill calls
#                    probe_wake_budget at battery start to measure ONE real cold
#                    wake and exports WAKE_BUDGET_MS_MEASURED, off which the budget
#                    becomes measured*3 + 30s margin (see budget_from_measured_ms).
#                    If no probe ran (or it failed / produced garbage), the budget
#                    falls back to a SAFE 120000 (120s) floor — deliberately NOT the
#                    old fixed 30000, which false-failed wake/multitenant on a
#                    memory-pressured OKE cluster (#340: 30s failed, 210s passed in
#                    12s → the stall was transient scheduling, not a defect).
#   WAKE_BUDGET_MS_MEASURED  set by probe_wake_budget; consumed only when
#                    WAKE_BUDGET_MS is unset. Not meant to be set by hand.
#
# Most functions below are PURE (no cluster, no side effects) so `selftest` can
# unit-test them. The ONLY cluster-touching helper is probe_wake_budget (it scales
# the compute Deployment 0->1->0 to time one wake); its pure MATH lives in
# budget_from_measured_ms so the sizing is unit-tested without a cluster.

# ceil_div <num> <den> — integer ceiling division (den>0 assumed). Pure.
ceil_div() { echo $(( ( $1 + $2 - 1 ) / $2 )); }

# WAKE_FALLBACK_MS — the SAFE budget when there is no explicit override and no
# measured probe (#340). 120000 (120s), NOT the old 30000 that false-failed on a
# pressured cluster. Overridable for tests via the env, sanitized below.
WAKE_FALLBACK_MS="${WAKE_FALLBACK_MS:-120000}"

# budget_from_measured_ms <measured_ms> — PURE sizing math for the adaptive budget:
# measured*3 + 30000 margin, floored at the safe fallback (120000). A non-numeric or
# zero/tiny measured value yields the floor. Factored out of the cluster probe so the
# sizing is unit-tested with a stubbed measured input (#340). Pure.
budget_from_measured_ms() {
  _m="$1"
  case "$_m" in ''|*[!0-9]*) _m=0 ;; esac
  _v=$(( _m * 3 + 30000 ))
  [ "$_v" -lt "$WAKE_FALLBACK_MS" ] && _v="$WAKE_FALLBACK_MS"
  echo "$_v"
}

# wake_budget_ms — echo the effective wake budget (ms), ADAPTIVE (#340) with a strict
# precedence: (1) an EXPLICIT WAKE_BUDGET_MS override always wins; else (2) the
# measured probe result WAKE_BUDGET_MS_MEASURED sized via budget_from_measured_ms;
# else (3) the SAFE WAKE_FALLBACK_MS (120000) floor. Sanitizes non-numeric input and
# floors at 1000 so a bogus tiny override cannot collapse every derived budget. Pure.
wake_budget_ms() {
  if [ -n "${WAKE_BUDGET_MS:-}" ]; then
    b="$WAKE_BUDGET_MS"
    case "$b" in ''|*[!0-9]*) b="$WAKE_FALLBACK_MS" ;; esac
    [ "$b" -lt 1000 ] && b=1000
    echo "$b"; return
  fi
  if [ -n "${WAKE_BUDGET_MS_MEASURED:-}" ]; then
    budget_from_measured_ms "$WAKE_BUDGET_MS_MEASURED"; return
  fi
  echo "$WAKE_FALLBACK_MS"
}

# wake_budget_s — the wake budget as ceil seconds. Pure.
wake_budget_s() { ceil_div "$(wake_budget_ms)" 1000; }

# idle_budget_ms — a gateway idle (ms) that OUTLASTS a cold wake, so a just-woken
# compute is not slept back to 0 before the post-wake assertion runs. = 2× the wake
# budget, floored at 30000. Feeds the test gateway's GW_IDLE_MS / GW_RO_IDLE_MS in
# _verify-readpool.sh (the baked-in 8000 was < the ~14s wake → the pool idled to 0
# before the replicas>=1 check). Pure.
idle_budget_ms() {
  w=$(wake_budget_ms); v=$(( w * 2 )); [ "$v" -lt 30000 ] && v=30000; echo "$v"
}

# hold_budget_s — how long (s) a "busy app stays awake" hold connection must live.
# It has to outlast the OTHER app's ENTIRE cold-wake-then-idle-down sequence plus
# margin, or the busy app idles down first and the assertion false-fails (the exact
# #198 _verify-multitenant.sh:340 artifact: pg_sleep(60) eaten by the slow wake).
# = wake_budget_s × mult + margin. Args: <mult(default 4)> <margin_s(default 30)>.
# Pure. (The hold pod is force-killed on the assertion + on cleanup, so a generous
# value costs nothing but robustness.)
hold_budget_s() {
  mult="${1:-4}"; margin="${2:-30}"
  echo $(( $(wake_budget_s) * mult + margin ))
}

# idle_wait_s — how long (s) to wait for an idle app to scale to zero: the gateway
# idle window (ms) plus a wake-budget-scaled slack for kubelet scale-down latency
# on a busy cluster. Args: <gateway_idle_ms>. Pure.
idle_wait_s() {
  echo $(( $(ceil_div "${1:-8000}" 1000) + $(wake_budget_s) + 15 ))
}

# ro_direct_dsn <cred> <host> [port] [db] — build the direct-to-pool DSN the read
# load generator dials. <cred> is "user:password". CRITICAL (#198/#168/#112): the
# generator MUST pass a TCP-VALID credential (the strong cloud_admin from the
# DATABASE_URL Secret), NOT the public default cloud_admin:cloud_admin, which the
# base compute rejects over TCP — a rejected loader runs NO query, so compute-ro
# CPU never rises and the CPU-target HPA never trips (the "no-op loader" bug). Pure.
ro_direct_dsn() {
  _cred="$1"; _host="$2"; _port="${3:-55433}"; _db="${4:-postgres}"
  echo "postgres://${_cred}@${_host}:${_port}/${_db}?sslmode=disable"
}

# retry_bounded <deadline_s> <step_s> <clock_fn> <probe_fn> — run <probe_fn> with a
# bounded retry/backoff until it succeeds (rc 0) or the total elapsed time exceeds
# <deadline_s>, whichever comes first. <clock_fn> echoes the current epoch seconds
# (injected so selftest can stub a monotonic clock instead of sleeping); the first
# clock reading is t0 and each subsequent reading is compared against t0+deadline.
# Between attempts it sleeps <step_s> (skipped when a stubbed clock_fn is used and
# STEP is small — real drills pass a real clock + a real sleep step). Returns 0 on
# the first successful probe, 1 if the deadline is exceeded first. GUARANTEES a
# bounded total time: a genuinely-broken wake fails within ~deadline_s, never loops
# forever (#340). Pure w.r.t. the injected clock_fn/probe_fn (no cluster of its own).
retry_bounded() {
  _dl="$1"; _step="$2"; _clock="$3"; _probe="$4"
  $_clock; _t0="$RB_NOW"
  while :; do
    if $_probe; then return 0; fi
    $_clock
    if [ "$(( RB_NOW - _t0 ))" -ge "$_dl" ]; then return 1; fi
    sleep "$_step" 2>/dev/null || :
  done
}

# rb_wallclock — the production clock_fn for retry_bounded: assign wall-clock epoch
# seconds to RB_NOW (setter style, so the value survives outside a subshell). Pure.
rb_wallclock() { RB_NOW=$(date +%s); }

# pods_present <get-pods-output> — PURE. True (rc 0) iff <get-pods-output> (the raw
# `kubectl get pods --no-headers` text) contains at least one non-blank line, i.e. a
# pod object exists. Empty/whitespace-only input -> false (rc 1) = the zero state.
# Factored out of probe_wake_budget's settle loop so it is unit-testable, and to avoid
# the `grep -c . || echo 0` bug (grep -c on EMPTY input prints "0" AND exits non-zero,
# so `|| echo 0` appended a SECOND "0" -> "0\n0" != "0" -> the settle loop never saw
# the zero state and burned its whole ~60s cap on every probe, #340 gate finding).
pods_present() {
  # any non-whitespace char present -> at least one pod line exists.
  [ -n "$(printf '%s' "$1" | tr -d ' \t\n\r')" ]
}

# probe_wake_budget — CLUSTER-TOUCHING (#340). Measure ONE real cold-wake latency of
# the default `compute` Deployment and export WAKE_BUDGET_MS_MEASURED so wake_budget_ms
# sizes the whole battery off it (adaptive). Only runs when WAKE_BUDGET_MS is UNSET
# (an explicit override always wins). On any failure (no cluster, no compute, timeout)
# it leaves WAKE_BUDGET_MS_MEASURED unset so wake_budget_ms uses the SAFE 120s floor —
# NEVER the flaky 30s. Args: [kubectl-prefix] (default "kubectl -n scale-zero-pg"),
# [ready_timeout_s] (default 240). Echoes a one-line note; safe to `|| true`.
probe_wake_budget() {
  _kc="${1:-kubectl -n scale-zero-pg}"
  _to="${2:-240}"
  if [ -n "${WAKE_BUDGET_MS:-}" ]; then
    echo "wake-budget probe: WAKE_BUDGET_MS=${WAKE_BUDGET_MS} pinned (probe skipped)" >&2
    return 0
  fi
  # settle to zero first so we time a genuine cold wake, not a warm no-op.
  $_kc scale deploy/compute --replicas=0 >/dev/null 2>&1 || {
    echo "wake-budget probe: no compute deploy -> safe fallback ${WAKE_FALLBACK_MS}ms" >&2
    return 0
  }
  _z=0; while pods_present "$($_kc get pods -l app=compute --no-headers 2>/dev/null)"; do
    _z=$((_z+1)); [ "$_z" -gt 60 ] && break; sleep 1
  done
  _t0=$(date +%s)
  $_kc scale deploy/compute --replicas=1 >/dev/null 2>&1 || {
    echo "wake-budget probe: scale-up failed -> safe fallback ${WAKE_FALLBACK_MS}ms" >&2
    return 0
  }
  if $_kc rollout status deploy/compute --timeout="${_to}s" >/dev/null 2>&1; then
    _t1=$(date +%s)
    _measured_ms=$(( (_t1 - _t0) * 1000 ))
    WAKE_BUDGET_MS_MEASURED="$_measured_ms"
    export WAKE_BUDGET_MS_MEASURED
    $_kc scale deploy/compute --replicas=0 >/dev/null 2>&1 || :
    echo "wake-budget probe: measured cold wake ${_measured_ms}ms -> budget $(wake_budget_ms)ms" >&2
  else
    $_kc scale deploy/compute --replicas=0 >/dev/null 2>&1 || :
    echo "wake-budget probe: cold wake did not become ready in ${_to}s -> safe fallback ${WAKE_FALLBACK_MS}ms" >&2
  fi
  return 0
}

# rollout_ready_retry <kubectl-prefix> <deploy> [total_budget_s] — wait for a
# Deployment to become Ready, tolerating a TRANSIENT scheduling stall (#340). Wraps
# `rollout status` in a bounded retry: each attempt waits up to a per-attempt slice,
# and the whole thing gives up after total_budget_s (default: derived from the
# adaptive wake budget, wake_budget_s + 60s margin) so a GENUINELY-broken wake still
# fails within a bounded time — never an infinite wait. Returns 0 when Ready, 1 on
# the deadline. The #340 live failure was `rollout status ... --timeout=120s` redding
# on a transient Pending; this absorbs that without masking a real outage.
rollout_ready_retry() {
  _rk="$1"; _dep="$2"
  _budget="${3:-$(( $(wake_budget_s) + 60 ))}"
  # per-attempt slice: a third of the budget (min 30s), so ~3 attempts across the
  # whole budget — each attempt re-reads scheduling state after a short backoff.
  _slice=$(( _budget / 3 )); [ "$_slice" -lt 30 ] && _slice=30
  _rr_probe() { $_rk rollout status "$_dep" --timeout="${_slice}s" >/dev/null 2>&1; }
  if retry_bounded "$_budget" 5 rb_wallclock _rr_probe; then
    return 0
  fi
  echo "rollout_ready_retry: $_dep not Ready within ${_budget}s (adaptive budget) — genuine stall" >&2
  return 1
}

# preflight_cluster_health [kubectl-prefix] — one-line NON-BLOCKING warning (#340) if
# any node is memory-pressured or an Evicted pod tombstone exists, so a flaky run is
# attributable. Never fails / never blocks. Best-effort; safe to `|| true`.
preflight_cluster_health() {
  _kc="${1:-kubectl -n scale-zero-pg}"
  _kcn="$(echo "$_kc" | sed -E 's/ -n [^ ]+//')"  # node/cluster-scoped view (drop -n)
  _pressured=$($_kcn get nodes -o jsonpath='{range .items[?(@.status.conditions[?(@.type=="MemoryPressure")].status=="True")]}{.metadata.name}{" "}{end}' 2>/dev/null || echo '')
  _evicted=$($_kc get pods --no-headers 2>/dev/null | grep -c Evicted || echo 0)
  if [ -n "$_pressured" ] || [ "${_evicted:-0}" -gt 0 ]; then
    echo "PREFLIGHT WARN: cluster under pressure (MemoryPressure nodes: [${_pressured:-none}]; Evicted pods: ${_evicted:-0}) — a flaky drill run may be attributable to this, not a defect (#340)." >&2
  fi
  return 0
}

# --- cluster-free unit test (TDD) -- runs ONLY when this file is executed directly
# as `_lib-drill.sh selftest`, never when a drill sources it (guarded on $0).
case "$0" in
  *_lib-drill.sh)
    if [ "${1:-}" = "selftest" ]; then
      fails=0
      check() { # <label> <got> <want>
        if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1: got [$2] want [$3]"; fails=$((fails+1)); fi
      }
      # ceil_div
      check "ceil_div exact"        "$(ceil_div 8000 1000)"  "8"
      check "ceil_div rounds up"    "$(ceil_div 8001 1000)"  "9"
      check "ceil_div 1/1000 -> 1"  "$(ceil_div 1 1000)"     "1"
      check "ceil_div 0 -> 0"       "$(ceil_div 0 1000)"     "0"
      # wake_budget_ms sanitization
      # no override + no probe -> SAFE 120s fallback (was 30000 pre-#340).
      check "wake default (safe)"   "$(WAKE_BUDGET_MS='' wake_budget_ms)"      "120000"
      check "wake honors override"  "$(WAKE_BUDGET_MS=14000 wake_budget_ms)"   "14000"
      check "wake floors at 1000"   "$(WAKE_BUDGET_MS=10 wake_budget_ms)"      "1000"
      check "wake rejects garbage"  "$(WAKE_BUDGET_MS=abc wake_budget_ms)"     "120000"
      check "wake_budget_s"         "$(WAKE_BUDGET_MS=14000 wake_budget_s)"    "14"
      # idle_budget_ms: 2x budget, floored at 30000
      check "idle 2x when large"    "$(WAKE_BUDGET_MS=20000 idle_budget_ms)"   "40000"
      check "idle floor 30000"      "$(WAKE_BUDGET_MS=5000 idle_budget_ms)"    "30000"
      # idle default now 2x the safe 120s fallback (#340).
      check "idle default 240000"   "$(WAKE_BUDGET_MS='' idle_budget_ms)"      "240000"
      # hold_budget_s: outlasts a wake+idle-down sequence
      check "hold default 30s bud"  "$(WAKE_BUDGET_MS=30000 hold_budget_s)"    "150"
      check "hold scales w/ budget" "$(WAKE_BUDGET_MS=14000 hold_budget_s)"    "86"
      check "hold custom mult/marg" "$(WAKE_BUDGET_MS=10000 hold_budget_s 2 10)" "30"
      # idle_wait_s: gateway idle + wake slack + fixed
      check "idle_wait 8s+30s+15"   "$(WAKE_BUDGET_MS=30000 idle_wait_s 8000)" "53"
      # --- adaptive budget (#340) ---
      # budget_from_measured_ms: measured*3 + 30000 margin, floored at 120000.
      check "measured 40s->150s"    "$(budget_from_measured_ms 40000)"          "150000"
      check "measured 100s->330s"   "$(budget_from_measured_ms 100000)"         "330000"
      check "measured tiny->floor"  "$(budget_from_measured_ms 2000)"           "120000"
      check "measured 0->floor"     "$(budget_from_measured_ms 0)"              "120000"
      check "measured garbage->flr" "$(budget_from_measured_ms abc)"            "120000"
      # wake_budget_ms precedence (#340): explicit override ALWAYS wins ...
      check "override beats probe"  "$(WAKE_BUDGET_MS=30000 WAKE_BUDGET_MS_MEASURED=40000 wake_budget_ms)" "30000"
      # ... then the measured probe result (measured*3+margin) ...
      check "probe when no override" "$(WAKE_BUDGET_MS='' WAKE_BUDGET_MS_MEASURED=40000 wake_budget_ms)" "150000"
      # ... then the SAFE fallback floor 120000 (NOT the flaky 30000) when neither is set.
      check "no-probe safe fallback" "$(WAKE_BUDGET_MS='' WAKE_BUDGET_MS_MEASURED='' wake_budget_ms)" "120000"
      check "garbage probe->fallbk"  "$(WAKE_BUDGET_MS='' WAKE_BUDGET_MS_MEASURED=abc wake_budget_ms)" "120000"
      # idle/hold budgets still derive off the (now-adaptive) wake_budget_ms.
      check "idle derives from probe" "$(WAKE_BUDGET_MS='' WAKE_BUDGET_MS_MEASURED=40000 idle_budget_ms)" "300000"
      check "hold derives from probe" "$(WAKE_BUDGET_MS='' WAKE_BUDGET_MS_MEASURED=40000 hold_budget_s)" "630"
      # retry_bounded: bounded-total-time property with a STUBBED clock (setter style,
      # ticks RB_NOW by 7 each call) + attempt counter, step 0 (no real sleeping).
      _rb_clock() { RB_NOW=$((RB_NOW + 7)); }
      _rb_never() { return 1; }  # always "not ready"
      RB_NOW=0; retry_bounded 20 0 _rb_clock _rb_never >/dev/null 2>&1
      check "retry_bounded fails broken wake (rc=1)" "$?" "1"
      # bounded: with clock step 7 and deadline 20 it must stop within a handful of
      # attempts (never loops forever): at least 1, at most 5 tries.
      RB_NOW=0; _rb_tries=0; _rb_countfail() { _rb_tries=$((_rb_tries+1)); return 1; }
      retry_bounded 20 0 _rb_clock _rb_countfail >/dev/null 2>&1 || true
      if [ "$_rb_tries" -ge 1 ] && [ "$_rb_tries" -le 5 ]; then
        echo "ok   - retry_bounded is bounded ($_rb_tries attempts)"
      else echo "FAIL - retry_bounded unbounded/zero attempts ($_rb_tries)"; fails=$((fails+1)); fi
      # succeeds fast: a ready-on-first-try probe returns 0.
      RB_NOW=0; _rb_ok() { return 0; }
      retry_bounded 20 0 _rb_clock _rb_ok >/dev/null 2>&1
      check "retry_bounded returns 0 on success" "$?" "0"
      # pods_present (#340 gate fix): empty `get pods` output = the ZERO state (false),
      # a real pod line = present (true). This replaced the `grep -c . || echo 0` bug
      # that made the settle loop never detect zero and burn its full ~60s cap.
      pods_present ""            2>/dev/null; check "pods_present empty=zero"      "$?" "1"
      pods_present "   "         2>/dev/null; check "pods_present blank=zero"      "$?" "1"
      pods_present "$(printf '\n')" 2>/dev/null; check "pods_present newline=zero" "$?" "1"
      pods_present "compute-abc-1 1/1 Running 0 5s" 2>/dev/null; check "pods_present one pod=present" "$?" "0"
      pods_present "$(printf 'a\nb')" 2>/dev/null; check "pods_present two pods=present" "$?" "0"
      # ro_direct_dsn: builds a DSN with the given (non-default) credential
      check "ro_direct_dsn strong"  "$(ro_direct_dsn 'cloud_admin:S3cret' compute-ro.scale-zero-pg.svc)" \
            "postgres://cloud_admin:S3cret@compute-ro.scale-zero-pg.svc:55433/postgres?sslmode=disable"
      # and it must NOT be the public default that #168/#112 reject over TCP
      case "$(ro_direct_dsn 'cloud_admin:S3cret' h)" in
        *cloud_admin:cloud_admin@*) echo "FAIL - ro_direct_dsn leaked default cred"; fails=$((fails+1)) ;;
        *) echo "ok   - ro_direct_dsn is not the rejected default cred" ;;
      esac
      if [ "$fails" -eq 0 ]; then echo "selftest PASSED"; exit 0; else echo "selftest FAILED ($fails)"; exit 1; fi
    fi
    ;;
esac
