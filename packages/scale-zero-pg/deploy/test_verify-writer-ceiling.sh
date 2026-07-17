#!/usr/bin/env bash
# test_verify-writer-ceiling.sh — cluster-free unit test for _verify-writer-ceiling.sh
# (issue #379, W4 of the high-traffic wave #375). The live drill (an in-cluster write
# loader Deployment driving sustained INSERTs through the apps-gateway on the app's
# own branch) needs a real OKE cluster + a provisioned app to produce numbers; this
# test pins the CLUSTER-FREE parts so the harness can be reviewed + regression-guarded
# without a cluster:
#
#   1. SELFTEST mode runs, renders the loader manifest, dry-run-applies it (a fake
#      kubectl), self-checks the pure parsers, and reports PASSED.
#   2. The pure per-loader parser (parse_wcount) turns a loader's OK/ERR/SECONDS
#      counter line into a per-loader write-RPS + error fields.
#   3. The fleet aggregator (aggregate_wcounts) SUMS the per-loader write-RPS across N
#      loaders (disjoint INSERT streams) and request-weights the error rate.
#   4. The injection guard rejects a poisoned knob before it is interpolated into the
#      loader's /bin/sh -c arg; a benign app-name/DSN/int is accepted.
#   5. The loader manifest renders from the CPU/mem/replica knobs (schedules-shaped on
#      a CPU-request-constrained cluster) and drives INSERTs through pggw-apps (never a
#      bypass DB path) into a throwaway drill table.
#
# Run: bash deploy/test_verify-writer-ceiling.sh   (no cluster, no psql binary needed).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SUT="$HERE/_verify-writer-ceiling.sh"
pass=0
ok()   { echo "ok   - $*"; pass=$((pass+1)); }
fail() { echo "FAIL: $*" >&2; exit 1; }
has()  { case "$2" in *"$1"*) return 0;; *) return 1;; esac; }

[ -f "$SUT" ] || fail "sut missing: $SUT"
[ -x "$SUT" ] || fail "sut not executable: $SUT"

# --- fake kubectl on a shim PATH: every op succeeds, dry-run apply echoes 'created'
SHIM="$(mktemp -d)"
trap 'rm -rf "$SHIM"' EXIT
cat > "$SHIM/kubectl" <<'FAKE'
#!/bin/sh
case "$*" in
  *"apply"*"--dry-run=client"*) echo "deployment.apps/wcload created (dry run)"; exit 0;;
  *"apply"*)                    echo "applied"; exit 0;;
  *"get"*"jsonpath"*)           echo ""; exit 0;;
  *"top"*)                       exit 0;;
  *)                             exit 0;;
esac
FAKE
chmod +x "$SHIM/kubectl"
export PATH="$SHIM:$PATH"

# ---------------------------------------------------------------------------------
# 1. SELFTEST: render + dry-run-apply the loader manifest + parser self-checks.
# ---------------------------------------------------------------------------------
out="$( SELFTEST=1 WC_CONTEXT=context-ckmva7v7zvq bash "$SUT" 2>&1 || true )"
has "SELFTEST" "$out"            || fail "selftest: no SELFTEST banner:\n$out"
has "dry-run" "$out"             || fail "selftest: loader manifest not dry-run applied:\n$out"
has "selftest PASSED" "$out"     || fail "selftest did NOT report PASSED:\n$out"
ok "SELFTEST mode renders + dry-runs the loader manifest and self-checks the parsers"

# ---------------------------------------------------------------------------------
# 2. parse_wcount: a per-loader counter line -> per-loader write-RPS + error fields.
#    Source the SUT LIB-ONLY (defines functions, touches nothing) then call the pure
#    parser directly. Loader emits a sentinel line: WCLOAD ok=<N> err=<M> secs=<S>.
# ---------------------------------------------------------------------------------
# shellcheck disable=SC1090
WRITER_CEILING_LIB_ONLY=1 . "$SUT"

# 9000 OK inserts, 90 errors, over 30s -> 300.00 write-RPS, 0.99% err.
row="$(parse_wcount 'WCLOAD ok=9000 err=90 secs=30' "file-manager" "soak")"
has "file-manager" "$row"        || fail "parser: app name missing from row:\n$row"
has "300.00" "$row"              || fail "parser: write-RPS != ok/secs = 9000/30 = 300.00:\n$row"
# err% = 90 / (9000+90) = 0.9901% -> 0.99%
has "0.99%" "$row"               || fail "parser: err% != err/(ok+err) = 0.99%:\n$row"
ok "parse_wcount turns a loader counter line into write-RPS + err% (per loader)"

# a zero-error loader renders 0.00% and passes RPS through.
row0="$(parse_wcount 'WCLOAD ok=1500 err=0 secs=30' "file-manager" "ramp")"
has "0.00%" "$row0"              || fail "parser: zero-error loader not rendered 0.00%:\n$row0"
has "50.00" "$row0"              || fail "parser: RPS != 1500/30 = 50.00:\n$row0"
ok "parse_wcount renders a zero-error loader as 0.00% write-RPS"

# a garbage / missing counter line yields a zeroed row, not a crash.
rowz="$(parse_wcount 'no counter here' "app" "soak")"
has "| 0.00 |" "$rowz"           || fail "parser: garbage line did not zero the RPS:\n$rowz"
ok "parse_wcount zeroes a missing/garbage counter line (partial-run provenance)"

# ---------------------------------------------------------------------------------
# 3. aggregate_wcounts: SUM write-RPS across N loaders (disjoint INSERT streams);
#    request-weight the error rate. Two fake loader lines -> one fleet row.
# ---------------------------------------------------------------------------------
# loader A: 6000 ok / 0 err / 30s -> 200 RPS ; loader B: 3000 ok / 30 err / 30s -> 100 RPS
# fleet RPS = 300 ; fleet err% = 30/(9000+30) = 0.3322% -> 0.33%
LA="$(mktemp)"; LB="$(mktemp)"; trap 'rm -rf "$SHIM" "$LA" "$LB"' EXIT
printf 'WCLOAD ok=6000 err=0 secs=30\n'   > "$LA"
printf 'WCLOAD ok=3000 err=30 secs=30\n'  > "$LB"
agg="$(aggregate_wcounts "file-manager" "rampsoak" "$LA" "$LB")"
has "file-manager" "$agg" || fail "aggregate_wcounts dropped the app name:\n$agg"
has "| 300.00 |" "$agg"   || fail "aggregate_wcounts did not SUM write-RPS (200+100=300):\n$agg"
has "0.33%" "$agg"        || fail "aggregate_wcounts error% not request-weighted (want 0.33%):\n$agg"
ok "aggregate_wcounts sums write-RPS across loaders and request-weights err%"

# a single loader aggregates to itself (identity — WC_LOADERS=1 path).
agg1="$(aggregate_wcounts "file-manager" "soak" "$LA")"
has "| 200.00 |" "$agg1" || fail "single-loader aggregate did not pass RPS through (200.00):\n$agg1"
ok "aggregate_wcounts is identity on a single loader"

# ---------------------------------------------------------------------------------
# 4. Injection guard: a knob carrying a shell metachar must be REJECTED before it is
#    interpolated into the loader's /bin/sh -c arg. A benign app-name / int is accepted.
# ---------------------------------------------------------------------------------
_wc_unsafe_knob "file-manager" && fail "guard: benign app name flagged unsafe"
_wc_unsafe_knob "150m" && fail "guard: cpu quantity 150m flagged unsafe"
_wc_unsafe_knob "6" && fail "guard: loader count 6 flagged unsafe"
_wc_unsafe_knob "x'; touch /tmp/pwned; '" || fail "guard: single-quote breakout NOT flagged"
_wc_unsafe_knob 'x$(id)' || fail "guard: command-substitution NOT flagged"
_wc_unsafe_knob 'a`id`b' || fail "guard: backtick NOT flagged"
_wc_unsafe_knob 'a;b' || fail "guard: semicolon NOT flagged"
_wc_unsafe_knob 'a|b' || fail "guard: pipe NOT flagged"
ok "_wc_unsafe_knob flags shell-injection vectors, accepts benign app-names/ints"

# render_loader must FAIL CLOSED on a poisoned APP_NAME (does not emit the manifest).
poison_out="$( APP_NAME="x'; rm -rf /; '" APP_PW="p" render_loader 2>&1 )"; poison_rc=$?
[ "$poison_rc" -ne 0 ] || fail "render_loader did NOT fail on a poisoned APP_NAME:\n$poison_out"
case "$poison_out" in *"kind: Deployment"*) fail "render_loader EMITTED a manifest with a poisoned knob:\n$poison_out";; esac
ok "render_loader fails closed on a poisoned knob (no manifest emitted)"

# ---------------------------------------------------------------------------------
# 5. render_loader: renders from CPU/mem/replica knobs and drives INSERTs THROUGH the
#    apps-gateway (pggw-apps) on the app's own branch (never a bypass path) into a
#    throwaway drill table.
# ---------------------------------------------------------------------------------
# APP_PW is exported to PROVE the plaintext password does NOT leak into the manifest —
# render_loader must ignore it and inject via secretKeyRef instead (security defect fix).
PW_SENTINEL='pl41nt3xt-pw-must-not-leak'
clean_out="$( APP_NAME='file-manager' APP_PW="$PW_SENTINEL" WC_LOADERS=4 \
              WC_CPU_REQUEST=150m WC_MEM_REQUEST=128Mi render_loader 2>&1 )"; clean_rc=$?
[ "$clean_rc" -eq 0 ] || fail "render_loader failed on CLEAN knobs:\n$clean_out"
has "kind: Deployment" "$clean_out" || fail "render_loader did not emit a Deployment:\n$clean_out"
has "replicas: 4" "$clean_out"      || fail "render_loader did not honor WC_LOADERS=4:\n$clean_out"
# the write path MUST be through the apps-gateway (pggw-apps:55432) as app_<app> on the
# app's own database — NOT a direct compute-<app> dial (that would bypass sovereignty).
has "pggw-apps:55432" "$clean_out"  || fail "render_loader does not write THROUGH the apps-gateway (pggw-apps:55432):\n$clean_out"
has "app_file-manager" "$clean_out" || fail "render_loader does not connect as the per-app role app_<app>:\n$clean_out"
case "$clean_out" in
  *"compute-file-manager:55433"*) fail "render_loader dials the per-app compute DIRECTLY (bypasses the apps-gateway/sovereignty):\n$clean_out";;
esac
# it must INSERT into a throwaway drill table (created/dropped in setup/teardown).
has "insert into" "$clean_out"      || fail "render_loader loader does not run INSERTs:\n$clean_out"
has "wc_drill" "$clean_out"         || fail "render_loader does not use the throwaway drill table wc_drill:\n$clean_out"
# resources render from the knobs (schedules-shaped on a constrained cluster).
case "$clean_out" in *'${WC_CPU_REQUEST}'*) fail "render_loader left WC_CPU_REQUEST as a placeholder:\n$clean_out";; esac
has "150m" "$clean_out"             || fail "render_loader did not render the CPU-request knob (150m):\n$clean_out"
ok "render_loader drives INSERTs THROUGH pggw-apps as app_<app> into the throwaway wc_drill table (no bypass)"

# ---------------------------------------------------------------------------------
# 5b. SECURITY (security.md — secrets never in config files / URLs / container images).
#     The REGRESSED property: the app-branch password must NOT be interpolated as
#     plaintext into the loader manifest (on-disk tmp yaml AND etcd via the Deployment).
#     It must reach the pod ONLY via a secretKeyRef to app-db-<app>, and the DSN must be
#     PASSWORDLESS (psql picks the password up from PGPASSWORD). Pin this so the
#     plaintext-in-manifest defect can never come back silently.
# ---------------------------------------------------------------------------------
has "$PW_SENTINEL" "$clean_out" && fail "SECURITY: plaintext password leaked into the rendered loader manifest (etcd/tmp yaml):\n$clean_out"
# the DSN must be the passwordless form — no `app_<app>:<pw>@pggw` inline credential.
case "$clean_out" in
  *"app_file-manager@pggw-apps:55432"*) : ;;  # passwordless DSN, good
  *) fail "SECURITY: loader DSN is not the expected passwordless form app_<app>@pggw-apps:55432:\n$clean_out" ;;
esac
printf '%s' "$clean_out" | grep -Eq 'app_[^@[:space:]]+:[^@[:space:]]+@pggw' \
  && fail "SECURITY: loader DSN carries an inline password (:<pw>@pggw) — must be passwordless:\n$clean_out"
# PGPASSWORD must be injected via secretKeyRef to the app's Secret, not a literal value.
has "secretKeyRef" "$clean_out"        || fail "SECURITY: loader does not inject PGPASSWORD via secretKeyRef:\n$clean_out"
has "name: PGPASSWORD" "$clean_out"    || fail "SECURITY: loader does not set a PGPASSWORD env var:\n$clean_out"
has "app-db-file-manager" "$clean_out" || fail "SECURITY: secretKeyRef does not target the app credential Secret app-db-<app>:\n$clean_out"
ok "SECURITY: no plaintext password in the manifest; PGPASSWORD via secretKeyRef(app-db-<app>); DSN passwordless"

# the one-shot table create/drop must ALSO avoid a plaintext password on the command
# line — the drill's psql_oneshot injects PGPASSWORD via an --overrides secretKeyRef and
# NO longer builds a `psql "$_dsn"` with a password-bearing DSN.
sut_src2="$(cat "$SUT")"
has "psql_oneshot" "$sut_src2" || fail "SECURITY: drill has no psql_oneshot helper (one-shot create/drop path)"
printf '%s' "$sut_src2" | grep -Eq 'run wc(init|drop)[^\n]*psql "\$_dsn"' \
  && fail "SECURITY: a one-shot pod still runs psql with an inline-password DSN on the command line"
ok "SECURITY: wcinit/wcdrop one-shots inject PGPASSWORD via secretKeyRef (no password on the pod command line)"

# ---------------------------------------------------------------------------------
# 6. The drill samples the #103 autoscaler proof: the ACTUATED cpu-limit (from pod
#    status, not spec), restartCount (must stay 0), and compute-$APP writer CPU.
# ---------------------------------------------------------------------------------
sut_src="$(cat "$SUT")"
has 'restartCount' "$sut_src"        || fail "#103 proof: drill never reads restartCount (in-place-resize evidence)"
has 'resources.limits.cpu' "$sut_src" || fail "#103 proof: drill never reads the ACTUATED cpu-limit from pod status"
has 'compute-' "$sut_src"            || fail "drill does not target the per-app compute-<app> writer"
ok "drill samples the #103 autoscaler proof (actuated cpu-limit + restartCount==0 + compute-<app> CPU)"

echo "PASSED ($pass checks)"
