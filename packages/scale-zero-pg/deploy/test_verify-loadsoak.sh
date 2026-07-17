#!/usr/bin/env bash
# test_verify-loadsoak.sh — cluster-free unit test for _verify-loadsoak.sh (issue #376,
# W1 of the high-traffic wave #375). The harness itself (the in-cluster k6 Job) needs a
# live OKE cluster to produce numbers; this test pins the CLUSTER-FREE parts so the
# harness can be reviewed + regression-guarded without a cluster:
#
#   1. SELFTEST mode runs, applies the manifest with --dry-run=client (a fake kubectl),
#      and reports OK — the manifest is well-formed and the drill's control flow is sound.
#   2. The pure summary parser (parse_k6_summary) turns a real k6 summary-export JSON
#      into the exact BENCHMARKS row fields the issue lists: RPS, p50/p95/p99, error rate.
#      This is the "bash assertion that the summary parser produces the expected row
#      format from a sample k6 JSON" the mission requires — a stub/weakened parser fails.
#   3. The concurrency->latency CSV row builder emits the paste-ready W2 sizing line.
#
# Run: bash deploy/test_verify-loadsoak.sh   (no cluster, no k6 binary needed).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SUT="$HERE/_verify-loadsoak.sh"
pass=0
ok()   { echo "ok   - $*"; pass=$((pass+1)); }
fail() { echo "FAIL: $*" >&2; exit 1; }
has()  { case "$2" in *"$1"*) return 0;; *) return 1;; esac; }

[ -f "$SUT" ] || fail "sut missing: $SUT"
[ -x "$SUT" ] || fail "sut not executable: $SUT"

# --- fake kubectl on a shim PATH: every op succeeds, dry-run apply echoes 'configured'
SHIM="$(mktemp -d)"
trap 'rm -rf "$SHIM"' EXIT
cat > "$SHIM/kubectl" <<'FAKE'
#!/bin/sh
case "$*" in
  *"apply"*"--dry-run=client"*) echo "job.batch/loadsoak-k6 created (dry run)"; exit 0;;
  *"apply"*)                    echo "applied"; exit 0;;
  *"get"*"jsonpath"*)           echo ""; exit 0;;
  *"config current-context"*)   echo "context-ckmva7v7zvq"; exit 0;;
  *"get crd"*|*"get node"*)      exit 0;;
  *)                             exit 0;;
esac
FAKE
chmod +x "$SHIM/kubectl"
export PATH="$SHIM:$PATH"

# ---------------------------------------------------------------------------------
# 1. SELFTEST: dry-run apply of the manifest + parser self-checks, no live cluster.
# ---------------------------------------------------------------------------------
out="$( SELFTEST=1 LOADSOAK_CONTEXT=context-ckmva7v7zvq bash "$SUT" 2>&1 || true )"
has "SELFTEST" "$out"            || fail "selftest: no SELFTEST banner:\n$out"
has "dry-run" "$out"             || fail "selftest: manifest not dry-run applied:\n$out"
has "selftest PASSED" "$out"     || fail "selftest did NOT report PASSED:\n$out"
ok "SELFTEST mode dry-runs the manifest and self-checks the parser"

# ---------------------------------------------------------------------------------
# 2. parse_k6_summary: from a REAL k6 summary-export JSON -> BENCHMARKS row fields.
#    We source the SUT with LOADSOAK_LIB_ONLY=1 so it defines its functions and
#    returns WITHOUT touching a cluster, then call the pure parser directly.
# ---------------------------------------------------------------------------------
# shellcheck disable=SC1090
LOADSOAK_LIB_ONLY=1 . "$SUT"

# A representative k6 --summary-export JSON (the shape k6 actually writes).
SAMPLE="$(mktemp)"; trap 'rm -rf "$SHIM" "$SAMPLE"' EXIT
cat > "$SAMPLE" <<'JSON'
{
  "metrics": {
    "http_reqs":      { "count": 90000, "rate": 300.0 },
    "http_req_failed":{ "value": 0.0021, "passes": 89811, "fails": 189 },
    "http_req_duration": {
      "avg": 41.2, "min": 8.1, "med": 33.5, "max": 812.0,
      "p(50)": 33.5, "p(90)": 78.9, "p(95)": 96.4, "p(99)": 210.7
    },
    "vus_max": { "value": 120 }
  }
}
JSON

row="$(parse_k6_summary "$SAMPLE" "file-manager" "soak")"
# Expect a single-line, pipe-delimited row carrying every issue-listed metric.
has "file-manager" "$row"        || fail "parser: app name missing from row:\n$row"
has "300"  "$row"                || fail "parser: RPS (rate) missing:\n$row"
has "33.5" "$row"                || fail "parser: p50/med missing:\n$row"
has "96.4" "$row"                || fail "parser: p95 missing:\n$row"
has "210.7" "$row"               || fail "parser: p99 missing:\n$row"
has "0.21%" "$row"               || fail "parser: error-rate% missing/misformatted:\n$row"
has "120" "$row"                 || fail "parser: peak VUs missing:\n$row"
ok "parse_k6_summary emits RPS/p50/p95/p99/error-rate/VUs from real k6 JSON"

# A ZERO-error run must render 0.00% (the cold-storm/#339 confirm-errors-0 case).
cat > "$SAMPLE" <<'JSON'
{ "metrics": {
  "http_reqs": { "count": 5000, "rate": 250.0 },
  "http_req_failed": { "value": 0.0 },
  "http_req_duration": { "med": 20.0, "p(95)": 40.0, "p(99)": 60.0 },
  "vus_max": { "value": 40 }
} }
JSON
row0="$(parse_k6_summary "$SAMPLE" "file-manager" "coldstorm")"
has "0.00%" "$row0"              || fail "parser: zero-error run not rendered as 0.00%:\n$row0"
ok "parse_k6_summary renders a zero-error run as 0.00% (cold-storm errors=0)"

# ---------------------------------------------------------------------------------
# 3. conc_lat_row: concurrency->latency CSV line for the W2 ContainerConcurrency curve.
# ---------------------------------------------------------------------------------
cl="$(conc_lat_row 20 33.5 96.4 210.7 0.21 300)"
has "20" "$cl"                   || fail "conc_lat_row: concurrency col missing:\n$cl"
has "96.4" "$cl"                 || fail "conc_lat_row: p95 col missing:\n$cl"
# comma-delimited CSV (paste-ready for the W2 curve table)
case "$cl" in *,*,*) ok "conc_lat_row emits a CSV concurrency->latency line" ;; *) fail "conc_lat_row not CSV:\n$cl" ;; esac

echo "PASSED ($pass checks)"
