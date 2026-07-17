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
#   WAKE_BUDGET_MS   assumed worst-case cold-wake latency in ms. Default 30000
#                    (30s): generous for the slow 2-node OKE cluster, still bounded.
#                    Lower it on a fast cluster to tighten the battery; raise it on
#                    an even slower one.
#
# Every function below is PURE (no cluster, no side effects) so `selftest` can
# unit-test it. Keep it that way — cluster calls belong in the drills, not here.

# ceil_div <num> <den> — integer ceiling division (den>0 assumed). Pure.
ceil_div() { echo $(( ( $1 + $2 - 1 ) / $2 )); }

# wake_budget_ms — echo the effective wake budget (ms). Sanitizes a non-numeric or
# missing override to the 30000 default and floors at 1000 so a bogus tiny value
# cannot collapse every derived budget to ~0. Pure.
wake_budget_ms() {
  b="${WAKE_BUDGET_MS:-30000}"
  case "$b" in ''|*[!0-9]*) b=30000 ;; esac
  [ "$b" -lt 1000 ] && b=1000
  echo "$b"
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
      check "wake default"          "$(WAKE_BUDGET_MS='' wake_budget_ms)"      "30000"
      check "wake honors override"  "$(WAKE_BUDGET_MS=14000 wake_budget_ms)"   "14000"
      check "wake floors at 1000"   "$(WAKE_BUDGET_MS=10 wake_budget_ms)"      "1000"
      check "wake rejects garbage"  "$(WAKE_BUDGET_MS=abc wake_budget_ms)"     "30000"
      check "wake_budget_s"         "$(WAKE_BUDGET_MS=14000 wake_budget_s)"    "14"
      # idle_budget_ms: 2x budget, floored at 30000
      check "idle 2x when large"    "$(WAKE_BUDGET_MS=20000 idle_budget_ms)"   "40000"
      check "idle floor 30000"      "$(WAKE_BUDGET_MS=5000 idle_budget_ms)"    "30000"
      check "idle default 60000"    "$(WAKE_BUDGET_MS='' idle_budget_ms)"      "60000"
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
      check "override beats probe"  "$(WAKE_BUDGET_MS=30000 WAKE_BUDGET_MS_MEASURED=40000 wake_budget_ms)" "30000"
      check "probe when no override" "$(WAKE_BUDGET_MS= WAKE_BUDGET_MS_MEASURED=40000 wake_budget_ms)" "150000"
      check "no-probe safe fallback" "$(WAKE_BUDGET_MS= WAKE_BUDGET_MS_MEASURED= wake_budget_ms)" "120000"
      check "garbage probe->fallbk"  "$(WAKE_BUDGET_MS= WAKE_BUDGET_MS_MEASURED=abc wake_budget_ms)" "120000"
      check "idle derives from probe" "$(WAKE_BUDGET_MS= WAKE_BUDGET_MS_MEASURED=40000 idle_budget_ms)" "300000"
      check "hold derives from probe" "$(WAKE_BUDGET_MS= WAKE_BUDGET_MS_MEASURED=40000 hold_budget_s)" "630"
      _rb_clock() { RB_NOW=$((RB_NOW + 7)); }
      _rb_never() { return 1; }
      RB_NOW=0; retry_bounded 20 0 _rb_clock _rb_never >/dev/null 2>&1
      check "retry_bounded fails broken wake (rc=1)" "$?" "1"
      RB_NOW=0; _rb_ok() { return 0; }
      retry_bounded 20 0 _rb_clock _rb_ok >/dev/null 2>&1
      check "retry_bounded returns 0 on success" "$?" "0"
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
