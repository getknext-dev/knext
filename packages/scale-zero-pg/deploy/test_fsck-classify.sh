#!/usr/bin/env bash
# test_fsck-classify.sh — unit test for provision-app.sh `fsck` intent-reconciliation
# classification (issue #337). Runs WITHOUT a cluster by sourcing provision-app.sh
# and stubbing the K (kubectl) and PS (pageserver) helpers.
#
# The bug (#337): fsck listed owner ConfigMaps by the broad `tier=apps` label, which
# is ALSO carried by the wal-reclaim SYSTEM marker $RECLAIM_CM (apps-wal-reclaim-pending,
# empty data / no TIMELINE_ID). fsck then misclassified that marker as a "DANGLING
# INTENT: ConfigMap apps-wal-reclaim-pending has no TIMELINE_ID" and returned non-zero,
# failing the multitenant drill's fsck step.
#
# The fix keys intent-reconciliation off the compute-config-<app> NAMING convention,
# so:
#   (a) the reclaim marker (and any future tier=apps system marker) is NOT flagged, but
#   (b) a GENUINE app intent (compute-config-<app>) with no TIMELINE_ID IS still flagged.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PROV="$HERE/provision-app.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
pass=0

# Source the script (source-guard skips CLI dispatch) so we can stub K/PS and call cmd_fsck.
# shellcheck disable=SC1090
PROVISION_APP_SOURCED=1 . "$PROV"
# provision-app.sh sets `set -euo pipefail`; the test intentionally inspects non-zero
# cmd_fsck exits (dangling-intent cases), so re-relax -e for the harness.
set +e

# Stubs. FSCK_CMLIST feeds the `K get configmap -l tier=apps ... name TIMELINE_ID` listing;
# FSCK_TIMELINES feeds the live pageserver branch list; FSCK_SECLIST feeds the secret list.
K() {
  case "$*" in
    *"get configmap -l tier=apps"*) printf '%s\n' "$FSCK_CMLIST" ;;
    *"get secret -l tier=apps"*)    printf '%s\n' "${FSCK_SECLIST:-}" ;;
    "get configmap "*)              return 0 ;;  # ownership check for orphan-secret path: assume owned
    *)                              return 0 ;;
  esac
}
PS() { printf '%s' "$FSCK_TIMELINES"; }

# run_fsck: invoke cmd_fsck with the given fixtures, capture output + rc.
run_fsck() {
  FSCK_OUT="$(cmd_fsck 2>&1)"; FSCK_RC=$?
}

TL_APP="ffffffffffffffffffffffffffffff01"   # a real app's live branch

# --- CASE 1: reclaim marker present alongside a HEALTHY app -> fsck must be CLEAN ----
# Pageserver has the app's branch AND the shared template; ConfigMap listing includes
# the healthy app intent AND the timeline-less reclaim marker (tier=apps, no TIMELINE_ID).
FSCK_TIMELINES="$(python3 -c "import json;print(json.dumps([{'timeline_id':'$TL_APP'},{'timeline_id':'$TEMPLATE_TL'}]))")"
FSCK_CMLIST="$(printf 'compute-config-goodapp %s\napps-wal-reclaim-pending \n' "$TL_APP")"
FSCK_SECLIST=""
run_fsck
case "$FSCK_OUT" in
  *"DANGLING INTENT: ConfigMap apps-wal-reclaim-pending"*)
    fail "reclaim marker misclassified as a dangling intent (#337 regression). Got: $FSCK_OUT" ;;
esac
[ "$FSCK_RC" -eq 0 ] || fail "fsck should be clean with a healthy app + reclaim marker, got rc=$FSCK_RC. Out: $FSCK_OUT"
echo "ok - reclaim system marker (apps-wal-reclaim-pending) is NOT flagged as a dangling intent"
pass=$((pass + 1))

# --- CASE 2: a GENUINE dangling intent (compute-config-<app>, no TIMELINE_ID) IS flagged ---
# Same reclaim marker present, PLUS a real app intent with an empty TIMELINE_ID. The
# marker must be ignored but the genuine intent MUST still trip a problem (rc!=0).
FSCK_TIMELINES="$(python3 -c "import json;print(json.dumps([{'timeline_id':'$TEMPLATE_TL'}]))")"
FSCK_CMLIST="$(printf 'compute-config-brokenapp \napps-wal-reclaim-pending \n')"
FSCK_SECLIST=""
run_fsck
case "$FSCK_OUT" in
  *"DANGLING INTENT: ConfigMap compute-config-brokenapp has no TIMELINE_ID"*) ;;
  *) fail "genuine timeline-less app intent (compute-config-brokenapp) was NOT flagged. Out: $FSCK_OUT" ;;
esac
case "$FSCK_OUT" in
  *"apps-wal-reclaim-pending"*) fail "reclaim marker still surfaced in output alongside genuine intent. Out: $FSCK_OUT" ;;
esac
[ "$FSCK_RC" -ne 0 ] || fail "fsck must exit non-zero for a genuine dangling intent, got rc=$FSCK_RC"
echo "ok - a genuine timeline-less compute-config-<app> intent IS still flagged (detection not weakened)"
pass=$((pass + 1))

echo "provision-app.sh fsck classification: $pass cases — PASSED"
