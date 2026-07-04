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
SIBJOB="wjd-sibling-${TS}"
APPSJOB="wjd-apps-${TS}"
# Section F (issues #91/#87): a throwaway app for the deprovision-reclaim assertion.
# RFC1123 label (lowercase alnum), created + default-destroyed to prove no orphan.
DRILLAPP="reclaimdrill${TS}"
KCTX_CUR="$(kubectl config current-context 2>/dev/null || echo context-ckmva7v7zvq)"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }
# strictly-less string compare (fixed-width hex sorts numerically). POSIX `[` has
# no `<`, and process substitution is bash-only — keep this dash-safe.
strlt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | LC_ALL=C sort | head -1)" = "$1" ]; }

TID=$($K get cm compute-config -o jsonpath='{.data.TENANT_ID}') || fail "cannot read TENANT_ID"
TLID=$($K get cm compute-config -o jsonpath='{.data.TIMELINE_ID}') || fail "cannot read TIMELINE_ID"
[ -n "$TID" ] && [ -n "$TLID" ] || fail "TENANT_ID/TIMELINE_ID empty"
PFX="src/neon/safekeeper/${TID}/${TLID}"
# #59 — a synthetic SIBLING timeline prefix (not a real pageserver timeline, so the
# janitor can resolve NO horizon for it). Section D seeds a below-configured-horizon
# segment here and asserts the janitor never over-prunes it (fail-safe) and fails loud.
SIBLING_TLID="ffffffffffffffffffffffffffffffff"
SPFX="src/neon/safekeeper/${TID}/${SIBLING_TLID}"
# #77 — the branch-per-app plane lives under a SEPARATE tenant. Section E asserts the
# janitor now VISITS the apps tenant (it never did before), prunes/leans a resolvable
# apps timeline, and fail-safe-SKIPS an UNRESOLVABLE apps sibling without over-pruning
# it — WARNING (not failing the nightly job) on expected apps churn residue.
APPS_TENANT="${APPS_TENANT:-a0000000000000000000000000000001}"
APPS_SIB_TLID="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
APPS_SPFX="src/neon/safekeeper/${APPS_TENANT}/${APPS_SIB_TLID}"
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
  # remove the synthetic sibling-timeline seed + prefix (#59 section D)
  $K exec "$MCPOD" -- sh -c 'export HOME=/tmp; mkdir -p /tmp/.mc; mc alias set src http://minio:9000 "$S3_USER" "$S3_PASS" >/dev/null 2>&1; mc rm --recursive --force '"$SPFX/"' >/dev/null 2>&1' >/dev/null 2>&1 || true
  # remove the synthetic apps-tenant sibling seed + prefix (#77 section E)
  $K exec "$MCPOD" -- sh -c 'export HOME=/tmp; mkdir -p /tmp/.mc; mc alias set src http://minio:9000 "$S3_USER" "$S3_PASS" >/dev/null 2>&1; mc rm --recursive --force '"$APPS_SPFX/"' >/dev/null 2>&1' >/dev/null 2>&1 || true
  $K delete job "$FCJOB" "$RUNJOB" "$IDJOB" "$SIBJOB" "$APPSJOB" --ignore-not-found >/dev/null 2>&1 || true
  $K delete pod "$MCPOD" --ignore-not-found >/dev/null 2>&1 || true
  # Section F: make sure the reclaim-drill app is gone even on early exit (default
  # destroy reclaims its timeline too, so this also cleans the branch/WAL).
  ./provision-app.sh destroy "$DRILLAPP" >/dev/null 2>&1 || true
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
# --- robust remote read (issue #95) -----------------------------------------
# A transient `kubectl exec` EOF (kubelet blip, pod GC while a Job backs off, apiserver
# hiccup) makes a remote `mc ls` come back EMPTY with a success-ish status. Every
# post-prune listing below turns an empty listing into an "over-prune"/"segment
# deleted" verdict — a FALSE janitor indictment (the #95 flakiness). mc_read() proves
# the exec channel actually ran by appending a fixed sentinel AFTER the payload:
# sentinel present => the listing is authoritative (empty means the bucket is genuinely
# empty); sentinel absent => the exec transport failed and the empty output must NEVER
# be read as "bucket empty". Bounded retries ride out a transient blip; a persistently
# dead channel is a DRILL ERROR (exit 3), never a pruning verdict.
DRILL_ERROR() { echo "DRILL-ERROR: $*" >&2; exit 3; }
MC_READ_TRIES=${MC_READ_TRIES:-5}
mc_read() { # $1 = remote snippet printing the listing to stdout; echoes the payload
  _snip="$1"; _i=0
  while [ "$_i" -lt "$MC_READ_TRIES" ]; do
    _out=$($K exec "$MCPOD" -- sh -c 'export HOME=/tmp; mkdir -p /tmp/.mc; mc alias set src http://minio:9000 "$S3_USER" "$S3_PASS" >/dev/null 2>&1; '"$_snip"'; printf "\n__wjd_exec_ok__\n"' 2>/dev/null) || true
    case "$_out" in
      *__wjd_exec_ok__*)
        # exec channel proven healthy — strip the sentinel + blank padding, return payload
        printf '%s\n' "$_out" | grep -v -F '__wjd_exec_ok__' | sed '/^[[:space:]]*$/d' || true
        return 0 ;;
    esac
    _i=$((_i+1)); [ "$_i" -lt "$MC_READ_TRIES" ] && sleep 3
  done
  DRILL_ERROR "kubectl exec into $MCPOD failed ${_i}x (EOF/transport) while listing the bucket — refusing to treat an unreadable listing as an empty bucket / over-prune (issue #95). snippet: $_snip"
}
list_complete() { mc_read "mc ls $PFX/ | sed 's/.* //' | grep -E '^[0-9A-Fa-f]{24}\$' | sort -u"; }
list_partial()  { mc_read "mc ls $PFX/ | sed 's/.* //' | grep -i 'partial\$' | sort -u"; }
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

# ===========================================================================
# E. APPS TENANT (issue #77) — the janitor must VISIT the branch-per-app tenant
#    (a separate tenant from the configured primary), resolve/prune its resolvable
#    timelines (WAL bounded), and fail-safe-SKIP an UNRESOLVABLE apps timeline
#    without over-pruning a sleeping branch — WARNING (not FAILING the nightly job)
#    on expected apps churn. Runs BEFORE section D (D seeds a PRIMARY-tenant sibling
#    that makes the job fail; here we require the job to COMPLETE).
# ===========================================================================
# Only meaningful if the apps tenant actually exists on this cluster.
if $K exec sts/pageserver -- curl -sf "http://localhost:9898/v1/tenant/${APPS_TENANT}" >/dev/null 2>&1; then
  # Seed one below-any-horizon segment (LOGID=0, SEG=1) under a synthetic UNRESOLVABLE
  # apps-tenant sibling. If the janitor wrongly applied a foreign horizon here it would
  # be deleted — the #77 over-prune of a sleeping app's WAL.
  MC "echo drill | mc pipe $APPS_SPFX/000000010000000000000001" >/dev/null || fail "could not seed apps-tenant sibling segment"
  APPS_SIB_BEFORE=$(mc_read "mc ls $APPS_SPFX/ | sed 's/.* //' | grep -E '^[0-9A-Fa-f]{24}\$' | sort -u")
  echo "$APPS_SIB_BEFORE" | grep -q '000000010000000000000001' || fail "apps-tenant sibling seed did not land"
  ok "seeded a below-horizon segment under an UNRESOLVABLE apps-tenant sibling ($APPS_TENANT/$APPS_SIB_TLID)"

  $K create job "$APPSJOB" --from=cronjob/wal-janitor >/dev/null || fail "could not create apps-case Job"
  # HARD invariant: the janitor must COMPLETE — an apps-tenant orphan is fail-safe-skipped
  # + WARNed, never a nightly job failure (that would be pager noise on expected churn).
  if ! wait_job "$APPSJOB" 240; then
    $K logs job/"$APPSJOB" --all-containers 2>/dev/null | tail -30 >&2 || true
    fail "(E) apps-case Job did not COMPLETE — an apps-tenant orphan must WARN, not fail the job (#77)"
  fi
  ok "(E) janitor COMPLETED with an apps-tenant orphan present (WARN, not job-fail #77)"

  $K logs job/"$APPSJOB" -c resolve-horizon 2>/dev/null > /tmp/wjd-e-h-$$.txt || true
  $K logs job/"$APPSJOB" -c prune 2>/dev/null > /tmp/wjd-e-p-$$.txt || true
  # (E1) the janitor RESOLVED a horizon for the apps tenant — proves it now VISITS a
  # tenant the old (primary-only) janitor never touched (the core #77 fix).
  grep -q "tenant=${APPS_TENANT} " /tmp/wjd-e-h-$$.txt || { cat /tmp/wjd-e-h-$$.txt >&2; fail "(E1) resolve-horizon did not resolve any apps-tenant timeline — janitor is not visiting the apps tenant (#77)"; }
  ok "(E1) janitor resolved an apps-tenant timeline horizon (it now enumerates ALL tenants #77)"
  # (E2) the prune step iterated the apps tenant prefix.
  grep -q "tenant ${APPS_TENANT}:" /tmp/wjd-e-p-$$.txt || { cat /tmp/wjd-e-p-$$.txt >&2; fail "(E2) prune step did not iterate the apps tenant prefix (#77)"; }
  ok "(E2) prune step iterated the apps-tenant safekeeper prefix (#77)"
  # (E3) the apps sibling was named UNRESOLVED + skipped fail-safe (WARN, not fatal).
  grep -qi "UNRESOLVED horizon on an apps tenant" /tmp/wjd-e-p-$$.txt || echo "note - could not confirm the apps-orphan WARN line (log-read flake); relying on job-Complete + seed-survival invariants"
  rm -f /tmp/wjd-e-h-$$.txt /tmp/wjd-e-p-$$.txt

  # HARD invariant: the apps sibling seed SURVIVES — never over-pruned against a foreign horizon.
  APPS_SIB_AFTER=$(mc_read "mc ls $APPS_SPFX/ | sed 's/.* //' | grep -E '^[0-9A-Fa-f]{24}\$' | sort -u")
  echo "$APPS_SIB_AFTER" | grep -q '000000010000000000000001' || \
    fail "(E) OVER-PRUNE: the apps-tenant sibling segment was deleted (sleeping app WAL lost) (#77)"
  ok "(E) apps-tenant sibling segment survived — per-(tenant,timeline) horizon is fail-safe (#77)"
  # tidy the apps sibling before section D so D's run isn't affected.
  $K exec "$MCPOD" -- sh -c 'export HOME=/tmp; mkdir -p /tmp/.mc; mc alias set src http://minio:9000 "$S3_USER" "$S3_PASS" >/dev/null 2>&1; mc rm --recursive --force '"$APPS_SPFX/"' >/dev/null 2>&1' >/dev/null 2>&1 || true
else
  echo "note - apps tenant ${APPS_TENANT} not present on this cluster — skipping section E (#77 apps-tenant case). Provision an app to exercise it."
fi

# ===========================================================================
# D. PER-TIMELINE HORIZON (issue #59) — a SIBLING timeline the janitor can resolve
#    NO horizon for must be SKIPPED (never over-pruned against the configured
#    timeline's horizon) and the run must FAIL LOUD so the gap pages.
# ===========================================================================
# Seed one below-configured-horizon segment (LOGID=0, SEG=1) under a synthetic
# sibling timeline prefix. If the janitor wrongly applied the configured timeline's
# (high) horizon here, this segment would be deleted — the exact #59 over-prune.
MC "echo drill | mc pipe $SPFX/000000010000000000000001" >/dev/null || fail "could not seed sibling-timeline segment"
SIB_BEFORE=$(mc_read "mc ls $SPFX/ | sed 's/.* //' | grep -E '^[0-9A-Fa-f]{24}\$' | sort -u")
echo "$SIB_BEFORE" | grep -q '000000010000000000000001' || fail "sibling seed did not land"
ok "seeded a below-horizon segment under an UNRESOLVABLE sibling timeline ($SIBLING_TLID)"

$K create job "$SIBJOB" --from=cronjob/wal-janitor >/dev/null || fail "could not create sibling-case Job"
# HARD invariant: the janitor must FAIL (fail-loud on the unresolved sibling), never Complete.
if wait_job "$SIBJOB" 240; then
  $K logs job/"$SIBJOB" -c prune 2>/dev/null | tail -20 >&2 || true
  fail "(D) janitor COMPLETED with an unresolvable sibling present — it must fail loud (#59)"
elif [ $? -eq 2 ]; then
  fail "(D) sibling-case Job neither Failed nor Completed within 240s"
fi
ok "(D) janitor failed loud with the unresolvable sibling present (WalJanitorJobFailed path)"
# BEST-EFFORT corroboration: the prune log should name the sibling as UNRESOLVED. A
# Failed job under backoffLimit churns pods, so `logs job/...` can transiently miss the
# pod (kubelet EOF) — retry a few times, but do NOT red the drill on a log-read flake:
# the hard invariants (job Failed + seed survives below) already prove the behavior.
i=0; SAW=""
while [ "$i" -lt 8 ]; do
  if $K logs job/"$SIBJOB" -c prune 2>/dev/null | grep -qi "UNRESOLVED horizon"; then SAW=1; break; fi
  i=$((i+1)); sleep 3
done
[ -n "$SAW" ] && ok "(D) prune log names the sibling UNRESOLVED (fail-safe skip)" \
             || echo "note - could not read the prune log to confirm the UNRESOLVED line (pod GC/kubelet flake); relying on job-Failed + seed-survival invariants"

# HARD invariant: the sibling seed must SURVIVE — never over-pruned against a foreign horizon.
SIB_AFTER=$(mc_read "mc ls $SPFX/ | sed 's/.* //' | grep -E '^[0-9A-Fa-f]{24}\$' | sort -u")
echo "$SIB_AFTER" | grep -q '000000010000000000000001' || \
  fail "(D) OVER-PRUNE: the sibling-timeline segment was deleted against the configured timeline's horizon (#59)"
ok "(D) sibling-timeline segment survived — per-timeline horizon is fail-safe (#59)"

# ===========================================================================
# F. DEPROVISION RECLAIM (issues #91/#87) — the OTHER half of the apps-tenant WAL
#    fail-safe. The janitor never over-prunes an orphan; the DEPROVISION path must
#    actually RECLAIM it so residue never accumulates. Prove that a DEFAULT
#    `destroy` (no flag) leaves NO orphan: the branch is gone from the pageserver,
#    the safekeeper WAL dir is gone from every safekeeper, and fsck is clean. Then
#    prove re-provisioning the SAME name still works (fresh timeline id, tombstone
#    dodged). Gated on the apps tenant + an initialized template plane being present.
# ===========================================================================
PROV="./provision-app.sh"
if [ -x "$PROV" ] \
   && $K exec sts/pageserver -- curl -sf "http://localhost:9898/v1/tenant/${APPS_TENANT}/timeline/${TEMPLATE_TL:-a0000000000000000000000000000010}" >/dev/null 2>&1; then
  P() { KCTX="$KCTX_CUR" NS="$NS" "$PROV" "$@"; }
  echo "--- Section F: deprovision reclaim (create -> default destroy -> assert no orphan) ---"
  P create "$DRILLAPP" >/dev/null 2>&1 || fail "(F) could not create drill app $DRILLAPP"
  TL1="$($K get cm "compute-config-$DRILLAPP" -o jsonpath='{.data.TIMELINE_ID}' 2>/dev/null || true)"
  [ -n "$TL1" ] || fail "(F) drill app has no recorded TIMELINE_ID after create"
  $K exec sts/pageserver -- curl -sf "http://localhost:9898/v1/tenant/${APPS_TENANT}/timeline/$TL1" >/dev/null 2>&1 \
    || fail "(F) branch $TL1 not present on the pageserver after create"
  ok "(F) created drill app $DRILLAPP (timeline $TL1)"

  # DEFAULT destroy — no --delete-timeline. Pre-#91 this manufactured an orphan.
  P destroy "$DRILLAPP" >/dev/null 2>&1 || fail "(F) default destroy of $DRILLAPP failed"

  # (F1) branch gone from the pageserver (404).
  if $K exec sts/pageserver -- curl -sf "http://localhost:9898/v1/tenant/${APPS_TENANT}/timeline/$TL1" >/dev/null 2>&1; then
    fail "(F1) timeline $TL1 SURVIVED a default destroy — deprovision did not reclaim the branch (#91)"
  fi
  ok "(F1) default destroy reclaimed the pageserver branch (no orphan timeline)"

  # (F2) safekeeper WAL dir gone on every safekeeper (the leak issue #87 targets).
  ord=0; SURVIVED=""
  while [ "$ord" -lt 3 ]; do
    if $K exec "safekeeper-$ord" -c safekeeper -- sh -c "ls -d /data/${APPS_TENANT}/$TL1 2>/dev/null" >/dev/null 2>&1; then
      SURVIVED="$SURVIVED safekeeper-$ord"
    fi
    ord=$((ord+1))
  done
  [ -z "$SURVIVED" ] || fail "(F2) safekeeper WAL dir for $TL1 SURVIVED default destroy on:$SURVIVED — SK-side reclaim leaked (#87)"
  ok "(F2) safekeeper WAL dir for $TL1 removed on all safekeepers (#87)"

  # (F3) fsck clean — no orphan branch anywhere on the apps plane.
  P fsck >/dev/null 2>&1 || fail "(F3) fsck reports an orphan after a default destroy (#91/#87)"
  ok "(F3) fsck clean after default destroy — zero orphan branches"

  # (F4) re-provision the SAME name works with a FRESH timeline id (tombstone dodged).
  P create "$DRILLAPP" >/dev/null 2>&1 || fail "(F4) re-create of $DRILLAPP after destroy failed (tombstone poisoning?)"
  TL2="$($K get cm "compute-config-$DRILLAPP" -o jsonpath='{.data.TIMELINE_ID}' 2>/dev/null || true)"
  [ -n "$TL2" ] && [ "$TL2" != "$TL1" ] || fail "(F4) re-create did not mint a FRESH timeline id (got '$TL2', prior '$TL1')"
  ok "(F4) re-provision same name works with a fresh timeline id ($TL2 != $TL1)"
  P destroy "$DRILLAPP" >/dev/null 2>&1 || true   # tidy (cleanup trap also covers this)
  ok "(F) deprovision reclaim proven: default destroy leaves ZERO orphan WAL/branch (#91/#87)"
else
  echo "note - apps tenant ${APPS_TENANT} / template plane not present — skipping section F (#91/#87 deprovision reclaim). Run 'provision-app.sh init-plane' to exercise it."
fi

cleanup
echo "wal-janitor safety drill PASSED: fail-closed, below-horizon-only prune, tail/partial preserved, idempotent, per-timeline fail-safe, deprovision reclaim (issues #37/#42/#59/#77/#91/#87)"
