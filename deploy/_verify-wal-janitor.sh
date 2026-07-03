#!/bin/sh
# Runtime safety drill for the wal-janitor (issue #37). The janitor DELETES objects
# from the live durability bucket; before this, it was guarded only by string-matching
# the manifest (deploy/_validate.sh). A prune-set off-by-one (wrong hex width, TLI
# assumption #42, sort-boundary regression) would silently destroy WAL the writable
# restore needs — the highest-blast-radius code in the release. This drill RUNS the
# real janitor against the live storage plane and asserts its safety invariants:
#
#   A. FAIL-CLOSED: with the pageserver unreachable (remote_consistent_lsn unreadable)
#      the Job exits NON-zero and deletes NOTHING.
#   B. PRUNE CORRECTNESS: seed known dead segments far below the horizon, run the real
#      janitor, and assert (1) every seed is gone, (2) EVERY deleted complete segment
#      sorts strictly below the janitor's own published threshold, (3) NO complete
#      segment below the horizon survived, (4) every .partial and every segment at/
#      above the horizon survived.
#   C. IDEMPOTENCE: a second run on the now-lean bucket prunes nothing and exits 0.
#
# SAFETY: the drill only ever SEEDS synthetic segments guaranteed below the horizon
# (LOGID=0, SEG=1..3) and asserts the janitor never touches anything at/above it. It
# never deletes real WAL by hand; the real deletions are the janitor's own (below-
# horizon, which is exactly its nightly job). All synthetic seeds + drill Jobs/pods
# are removed on ANY exit.
set -eu
cd "$(dirname "$0")"
NS=scale-zero-pg
K="kubectl --request-timeout=20s -n $NS"
TS=$(date +%s)
MCPOD="wjd-mc-${TS}"
FCJOB="wjd-failclosed-${TS}"
RUNJOB="wjd-run-${TS}"
IDJOB="wjd-idem-${TS}"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }
# strictly-less string compare (fixed-width hex sorts numerically). POSIX `[` has
# no `<`, and process substitution is bash-only — keep this dash-safe.
strlt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | LC_ALL=C sort | head -1)" = "$1" ]; }

TID=$($K get cm compute-config -o jsonpath='{.data.TENANT_ID}') || fail "cannot read TENANT_ID"
TLID=$($K get cm compute-config -o jsonpath='{.data.TIMELINE_ID}') || fail "cannot read TIMELINE_ID"
[ -n "$TID" ] && [ -n "$TLID" ] || fail "TENANT_ID/TIMELINE_ID empty"
PFX="src/neon/safekeeper/${TID}/${TLID}"
$K get cronjob wal-janitor >/dev/null 2>&1 || fail "wal-janitor CronJob not deployed"

# --- cleanup: remove seeds + all drill Jobs/pods on any exit -----------------
CLEANED=0
cleanup() {
  [ "$CLEANED" = "1" ] && return 0
  CLEANED=1
  # best-effort delete of any synthetic seeds still present
  for s in 000000010000000000000001 000000010000000000000002 000000010000000000000003; do
    $K exec "$MCPOD" -- sh -c 'export HOME=/tmp; mkdir -p /tmp/.mc; mc alias set src http://minio:9000 "$S3_USER" "$S3_PASS" >/dev/null 2>&1; mc rm '"$PFX/$s"' >/dev/null 2>&1' >/dev/null 2>&1 || true
  done
  $K delete job "$FCJOB" "$RUNJOB" "$IDJOB" --ignore-not-found >/dev/null 2>&1 || true
  $K delete pod "$MCPOD" --ignore-not-found >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# --- helper mc pod for seeding/listing the bucket ----------------------------
cat <<EOF | $K apply -f - >/dev/null || fail "could not create mc helper pod"
apiVersion: v1
kind: Pod
metadata:
  name: ${MCPOD}
  labels: { drill: wal-janitor }
spec:
  restartPolicy: Never
  securityContext: { seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: mc
      image: minio/mc:RELEASE.2023-01-28T20-29-38Z
      command: ["/bin/sh","-c","sleep 900"]
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } }
      env:
        - { name: S3_USER, valueFrom: { secretKeyRef: { name: storage-s3-creds, key: user } } }
        - { name: S3_PASS, valueFrom: { secretKeyRef: { name: storage-s3-creds, key: password } } }
      resources:
        requests: { cpu: 20m, memory: 32Mi, ephemeral-storage: 50Mi }
        limits: { memory: 128Mi, ephemeral-storage: 128Mi }
EOF
$K wait --for=condition=Ready pod/"$MCPOD" --timeout=90s >/dev/null || fail "mc helper pod not ready"
ok "mc helper pod ready"

MC() { $K exec "$MCPOD" -- sh -c 'export HOME=/tmp; mkdir -p /tmp/.mc; mc alias set src http://minio:9000 "$S3_USER" "$S3_PASS" >/dev/null 2>&1; '"$1"; }
list_complete() { MC "mc ls $PFX/" | sed 's/.* //' | grep -E '^[0-9A-Fa-f]{24}$' | sort -u || true; }
list_partial()  { MC "mc ls $PFX/" | sed 's/.* //' | grep -i 'partial$' | sort -u || true; }
seed() { for s in "$@"; do MC "echo drill | mc pipe $PFX/$s" >/dev/null || fail "could not seed $s"; done; }

SEEDS="000000010000000000000001 000000010000000000000002 000000010000000000000003"

wait_job() { # name, timeoutsec -> 0 Complete, 1 Failed, 2 timeout
  j="$1"; t="$2"; i=0
  while [ "$i" -lt "$t" ]; do
    if $K get job "$j" -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null | grep -q True; then return 0; fi
    if $K get job "$j" -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null | grep -q True; then return 1; fi
    i=$((i+3)); sleep 3
  done
  return 2
}

# ===========================================================================
# A. FAIL-CLOSED — pageserver unreachable => Job Failed, nothing deleted.
# ===========================================================================
seed $SEEDS
BEFORE_A=$(list_complete)
echo "$BEFORE_A" | grep -q '000000010000000000000001' || fail "seed did not land in the bucket"
ok "seeded 3 synthetic below-horizon segments"

# Build a one-shot Job from the live CronJob's jobTemplate, overriding the
# resolve-horizon initContainer's PAGESERVER_HOST to an unreachable name (env
# overrides envFrom on name collision). rcl becomes unreadable => the fail-closed
# guard aborts the initContainer => the prune container never runs => 0 deletions.
$K get cronjob wal-janitor -o json > /tmp/wjd-cj-$$.json || fail "could not dump wal-janitor CronJob"
python3 - "$FCJOB" /tmp/wjd-cj-$$.json > /tmp/wjd-fc-$$.json <<'PY'
import json, sys
name = sys.argv[1]
cj = json.load(open(sys.argv[2]))
spec = cj["spec"]["jobTemplate"]["spec"]
spec["backoffLimit"] = 0
for ic in spec["template"]["spec"].get("initContainers", []):
    if ic.get("name") == "resolve-horizon":
        env = ic.setdefault("env", [])
        env = [e for e in env if e.get("name") != "PAGESERVER_HOST"]
        env.append({"name": "PAGESERVER_HOST", "value": "pageserver-nonexistent.invalid"})
        ic["env"] = env
job = {"apiVersion": "batch/v1", "kind": "Job",
       "metadata": {"name": name, "labels": {"drill": "wal-janitor"}},
       "spec": spec}
job["spec"]["template"].setdefault("metadata", {}).setdefault("labels", {})["drill"] = "wal-janitor"
print(json.dumps(job))
PY
$K apply -f /tmp/wjd-fc-$$.json >/dev/null || fail "could not create fail-closed Job"
rm -f /tmp/wjd-fc-$$.json /tmp/wjd-cj-$$.json
if wait_job "$FCJOB" 120; then
  fail "fail-closed Job COMPLETED — it must exit non-zero when the pageserver is unreachable"
elif [ $? -eq 2 ]; then
  fail "fail-closed Job neither Failed nor Completed within 120s"
fi
ok "fail-closed: Job Failed with pageserver unreachable (rcl unreadable)"
AFTER_A=$(list_complete)
[ "$BEFORE_A" = "$AFTER_A" ] || fail "fail-closed run DELETED segments — it must prune nothing when rcl is unreadable"
echo "$AFTER_A" | grep -q '000000010000000000000001' || fail "fail-closed run removed a seed (must delete nothing)"
ok "fail-closed: bucket unchanged (nothing pruned)"

# ===========================================================================
# B. PRUNE CORRECTNESS — run the real janitor, assert the safety invariants.
# ===========================================================================
BEFORE_COMPLETE=$(list_complete)
BEFORE_PARTIAL=$(list_partial)
$K create job "$RUNJOB" --from=cronjob/wal-janitor >/dev/null || fail "could not create janitor Job"
if ! wait_job "$RUNJOB" 240; then
  $K logs job/"$RUNJOB" --all-containers 2>/dev/null | tail -30 >&2 || true
  fail "real janitor Job did not Complete within 240s"
fi
$K logs job/"$RUNJOB" -c resolve-horizon 2>/dev/null > /tmp/wjd-h-$$.txt || true
$K logs job/"$RUNJOB" -c prune 2>/dev/null > /tmp/wjd-p-$$.txt || true
echo "--- janitor resolve-horizon ---"; cat /tmp/wjd-h-$$.txt
echo "--- janitor prune ---"; cat /tmp/wjd-p-$$.txt
THRESH=$(grep -oE 'threshold_suffix=[0-9A-Fa-f]{16}' /tmp/wjd-h-$$.txt | head -1 | cut -d= -f2)
rm -f /tmp/wjd-h-$$.txt /tmp/wjd-p-$$.txt
[ -n "$THRESH" ] || fail "janitor did not publish a threshold_suffix (issue #42 derivation missing)"
ok "janitor published TLI-independent threshold_suffix=$THRESH"

AFTER_COMPLETE=$(list_complete)
AFTER_PARTIAL=$(list_partial)

# (1) every seed gone
for s in $SEEDS; do
  echo "$AFTER_COMPLETE" | grep -q "^$s\$" && fail "seed $s survived — janitor failed to prune a below-horizon segment"
done
ok "(1) all 3 synthetic below-horizon seeds were pruned"

# (2) every DELETED complete segment sorts strictly below its timeline's threshold.
#     suffix = chars 9..24 of the 24-hex name (LOGID+SEG), compared to threshold_suffix.
echo "$BEFORE_COMPLETE" | grep . > /tmp/wjd-before-$$ || true
echo "$AFTER_COMPLETE"  | grep . > /tmp/wjd-after-$$  || true
DELETED=$(comm -23 /tmp/wjd-before-$$ /tmp/wjd-after-$$ || true)   # inputs are sort -u'd
rm -f /tmp/wjd-before-$$ /tmp/wjd-after-$$
NDEL=$(echo "$DELETED" | grep -c . || true)
BAD=""
for name in $DELETED; do
  suf=$(printf '%s' "$name" | cut -c9-24)
  # fixed-width hex suffix must sort strictly below the janitor's threshold
  strlt "$suf" "$THRESH" || BAD="$BAD $name(suffix=$suf)"
done
[ -z "$BAD" ] || fail "(2) janitor deleted segment(s) NOT below the horizon:$BAD (threshold=$THRESH)"
ok "(2) all $NDEL deleted segments sort strictly below threshold_suffix=$THRESH"

# (3) no complete segment below the horizon SURVIVED (prune is complete, no dead WAL left).
LEFTOVER=""
for name in $AFTER_COMPLETE; do
  [ -n "$name" ] || continue
  suf=$(printf '%s' "$name" | cut -c9-24)
  if strlt "$suf" "$THRESH"; then LEFTOVER="$LEFTOVER $name"; fi
done
[ -z "$LEFTOVER" ] || fail "(3) below-horizon segment(s) survived the prune:$LEFTOVER (threshold=$THRESH)"
ok "(3) no below-horizon complete segment survived — prune is complete"

# (4) every .partial and every at/above-horizon segment survived.
for p in $BEFORE_PARTIAL; do
  [ -n "$p" ] || continue
  echo "$AFTER_PARTIAL" | grep -q -F "$p" || fail "(4) janitor deleted a .partial live-tail segment: $p"
done
for name in $BEFORE_COMPLETE; do
  [ -n "$name" ] || continue
  suf=$(printf '%s' "$name" | cut -c9-24)
  if strlt "$suf" "$THRESH"; then continue; fi   # legitimately prunable, skip
  echo "$AFTER_COMPLETE" | grep -q "^$name\$" || fail "(4) janitor deleted an AT/ABOVE-horizon segment: $name (threshold=$THRESH)"
done
NPART=$(echo "$BEFORE_PARTIAL" | grep -c . || true)
ok "(4) all $NPART .partial segments + every at/above-horizon segment survived"

# ===========================================================================
# C. IDEMPOTENCE — a second run on the lean bucket prunes nothing, exits 0.
# ===========================================================================
$K create job "$IDJOB" --from=cronjob/wal-janitor >/dev/null || fail "could not create idempotence Job"
if ! wait_job "$IDJOB" 240; then
  $K logs job/"$IDJOB" --all-containers 2>/dev/null | tail -20 >&2 || true
  fail "idempotence Job did not Complete within 240s"
fi
$K logs job/"$IDJOB" -c prune 2>/dev/null | grep -q 'nothing to prune' || \
  fail "idempotence: second run did NOT report 'nothing to prune' on the lean bucket"
ok "(C) second run is idempotent: nothing to prune, exit 0"

cleanup
echo "wal-janitor safety drill PASSED: fail-closed, below-horizon-only prune, tail/partial preserved, idempotent (issues #37/#42)"
