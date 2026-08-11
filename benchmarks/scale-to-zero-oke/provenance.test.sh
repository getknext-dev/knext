#!/usr/bin/env bash
#
# provenance.test.sh — tests for benchmark ADMISSIBILITY (S8 / #551, sprint-2
# track D). A run that cannot say which application it measured, at which
# endpoint, in which sitting, is INADMISSIBLE — not merely weaker.
#
# The three failures this pins, all of them observed rather than hypothetical:
#
#   D1  Run 25/26's two A/B arms served DIFFERENT APPLICATIONS (`p1b-node`
#       renders a 4000-byte Next document at `/`, `p1b-bunexec` a 1397-byte
#       vinext page; they agree only at `/api/health`). Nothing in the harness
#       noticed. It must now REFUSE the run, before it mutates anything.
#   D2  The requested endpoint reached the results file (`url=`) but never the
#       write-up, so the endpoint of a published run had to be recovered from a
#       DIFFERENT run's file.
#   D14 Run 26's per-sample results files were never persisted — one `p1b-*`
#       file exists on disk where 26 should. A run must leave a durable record
#       of its own existence, so a lost file is DETECTABLE rather than silent.
#
# Same test seam as the sibling suites: DRY_RUN=1 + DRY_RUN_EXERCISE_KC=1 with a
# stub kubectl, so every cluster-reading path executes without a cluster.
#
# Run: bash benchmarks/scale-to-zero-oke/provenance.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="${SCRIPT_DIR}/run.sh"
PROV_SH="${SCRIPT_DIR}/provenance.sh"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  ok   — $1"; }
nope() { FAIL=$((FAIL + 1)); echo "  FAIL — $1"; }
assert_contains() {
  if grep -qF -- "$2" "$1"; then ok "$3"; else
    nope "$3"; echo "        expected to find: $2"; echo "        in:"; sed 's/^/          /' "$1"
  fi
}
assert_not_contains() {
  if grep -qF -- "$2" "$1"; then
    nope "$3"; echo "        did NOT expect: $2"; echo "        in:"; sed 's/^/          /' "$1"
  else ok "$3"; fi
}
assert_rc_nonzero() {
  if [ "$1" -ne 0 ]; then ok "$2 (got $1)"; else nope "$2 (got 0 — an inadmissible run must FAIL, not warn)"; fi
}
assert_rc_zero() {
  if [ "$1" -eq 0 ]; then ok "$2"; else nope "$2 (got $1)"; fi
}

# ── stub kubectl ─────────────────────────────────────────────────────────────
# Per-service fixtures so an A/B (two ksvcs) can be modelled:
#   ksvc_<name>.json      the ksvc document (capture + image ref + ready revision)
#   rev_<revision>.json   the Revision document (carries the resolved digest)
make_stub() {
  local dir="$1"
  cat > "${dir}/kubectl" <<STUB
#!/usr/bin/env bash
echo "\$*" >> "${dir}/calls.log"
args="\$*"
set -- \$args
case "\$args" in
  *"get ksvc"*)
    svc=""
    for i in \$(seq 1 \$#); do [ "\${!i}" = "ksvc" ] && { j=\$((i+1)); svc="\${!j}"; }; done
    if [ -f "${dir}/ksvc_\${svc}.json" ]; then cat "${dir}/ksvc_\${svc}.json"
    else echo "Error from server (NotFound): services.serving.knative.dev \\"\$svc\\" not found" >&2; exit 1; fi ;;
  *"get revision"*)
    rev=""
    for i in \$(seq 1 \$#); do [ "\${!i}" = "revision" ] && { j=\$((i+1)); rev="\${!j}"; }; done
    if [ -f "${dir}/rev_\${rev}.json" ]; then cat "${dir}/rev_\${rev}.json"
    else echo "Error from server (NotFound): revision \\"\$rev\\" not found" >&2; exit 1; fi ;;
  *"get pods"*"job-name="*) printf 'Running' ;;
  *"get pods"*) echo "pod-1 1/1 Running 0 1s" ;;
  *"apply -f"*) cat > /dev/null ;;
  *"logs"*) cat "${dir}/k6_logs" 2>/dev/null || true ;;
  *"patch ksvc"*)
    n=\$(cat "${dir}/patch_count" 2>/dev/null || echo 0); echo \$((n + 1)) > "${dir}/patch_count" ;;
  *) : ;;
esac
exit 0
STUB
  chmod +x "${dir}/kubectl"
  : > "${dir}/calls.log"
  : > "${dir}/k6_logs"
  echo 0 > "${dir}/patch_count"
}

# make_svc <dir> <service> <revision> <image-ref> <digest>
# A digest of "" models a service whose digest cannot be resolved.
make_svc() {
  local dir="$1" svc="$2" rev="$3" ref="$4" digest="$5"
  cat > "${dir}/ksvc_${svc}.json" <<JSON
{ "spec": { "template": { "metadata": {}, "spec": { "containers": [ { "image": "${ref}" } ] } } },
  "status": { "latestReadyRevisionName": "${rev}" } }
JSON
  cat > "${dir}/rev_${rev}.json" <<JSON
{ "spec": { "containers": [ { "image": "${ref}" } ] },
  "status": { "containerStatuses": [ { "imageDigest": "${digest}" } ] } }
JSON
}

# run_bench <dir> <args...>
run_bench() {
  local dir="$1"; shift
  DRY_RUN=1 DRY_RUN_EXERCISE_KC=1 KUBECTL_BIN="${dir}/kubectl" \
  OUT="${dir}/results.txt" SCALE_DOWN_TIMEOUT=0 APPLY_SETTLE_SECONDS=0 \
  POD_SAMPLE_BUDGET=3 SCHEDULE_CHECK_TIMEOUT=2 K6_JOB_TIMEOUT=5 \
  RESULTS_INDEX="${dir}/INDEX.tsv" \
    bash "$RUN_SH" --namespace bench "$@" > "${dir}/out.txt" 2>&1
}

echo "== provenance.test.sh =="

# ── D2 ───────────────────────────────────────────────────────────────────────
echo
echo "[D2-1] the results file carries a machine-readable PROVENANCE block naming the endpoint"
T="$(mktemp -d)"; make_stub "$T"; make_svc "$T" demo-svc demo-svc-00001 reg.io/app:v1 sha256:aaaa
run_bench "$T" --service demo-svc --url http://demo-svc.bench.svc.cluster.local/api/health --phases none
assert_contains "${T}/results.txt" "## PROVENANCE" \
  "the results file has a PROVENANCE block"
assert_contains "${T}/results.txt" "endpoint=http://demo-svc.bench.svc.cluster.local/api/health" \
  "the REQUESTED endpoint (the exact URL k6 hits) is recorded verbatim"
assert_contains "${T}/results.txt" "latency-metric=http_req_duration" \
  "the block names http_req_duration as the only valid latency metric"
assert_contains "${T}/results.txt" "app-image-digest=sha256:aaaa" \
  "the deployed image digest is recorded — what was measured, not what was intended"

echo
echo "[D2-2] provenance survives a run that aborts before it measures anything"
T2="$(mktemp -d)"; make_stub "$T2"   # no ksvc fixture => capture_original FATALs
run_bench "$T2" --service ghost-svc --url http://ghost/x --phases none
rc=$?
assert_rc_nonzero "$rc" "a run whose target cannot be read still fails"
assert_contains "${T2}/results.txt" "endpoint=http://ghost/x" \
  "the endpoint is written BEFORE the first cluster mutation, so an aborted run still records it"

# ── D4 ───────────────────────────────────────────────────────────────────────
echo
echo "[D4] the sitting is recorded, and is settable"
T3="$(mktemp -d)"; make_stub "$T3"; make_svc "$T3" demo-svc demo-svc-00001 reg.io/app:v1 sha256:aaaa
run_bench "$T3" --service demo-svc --sitting 2026-07-28-morning --phases none
assert_contains "${T3}/results.txt" "sitting=2026-07-28-morning" \
  "--sitting lands in the provenance block (D5 forbids pooling across sittings; you cannot obey that without knowing the sitting)"

# ── D1 ───────────────────────────────────────────────────────────────────────
echo
echo "[D1-1] an A/B whose arms share a digest is admissible"
T4="$(mktemp -d)"; make_stub "$T4"
make_svc "$T4" arm-a arm-a-1 reg.io/app:v1 sha256:same
make_svc "$T4" arm-b arm-b-1 reg.io/app:v1 sha256:same
run_bench "$T4" --service arm-a --peer arm-b --phases none
rc=$?
assert_rc_zero "$rc" "identical-digest arms are allowed to run"
assert_contains "${T4}/results.txt" "arms-same-app=yes" \
  "the block states positively that the arms were proven to be one application"

echo
echo "[D1-2] an A/B whose arms serve DIFFERENT images is REFUSED before any mutation"
T5="$(mktemp -d)"; make_stub "$T5"
make_svc "$T5" p1b-node node-1 reg.io/node:v1 sha256:nnnn
make_svc "$T5" p1b-bunexec bun-1 reg.io/bun:v1 sha256:bbbb
run_bench "$T5" --service p1b-node --peer p1b-bunexec --phases none
rc=$?
assert_rc_nonzero "$rc" "different-app arms ABORT the run"
assert_contains "${T5}/results.txt" "sha256:nnnn" "the abort names the first arm's digest"
assert_contains "${T5}/results.txt" "sha256:bbbb" "the abort names the peer's digest"
if [ "$(cat "${T5}/patch_count")" = "0" ]; then
  ok "no kubectl patch was issued — the refusal happens before the cluster is touched"
else
  nope "no kubectl patch was issued (got $(cat "${T5}/patch_count") — the harness mutated a target it then refused to measure)"
fi

echo
echo "[D1-3] an UNRESOLVABLE digest fails the A/B — never passes"
T6="$(mktemp -d)"; make_stub "$T6"
make_svc "$T6" arm-a arm-a-1 reg.io/app:v1 sha256:same
make_svc "$T6" arm-b arm-b-1 reg.io/app:v1 ""      # digest cannot be resolved
run_bench "$T6" --service arm-a --peer arm-b --phases none
rc=$?
assert_rc_nonzero "$rc" "an unresolvable peer digest aborts (a checker that goes green when it cannot check is worse than none)"
assert_not_contains "${T6}/results.txt" "arms-same-app=yes" \
  "an unresolved identity is never rendered as a positive same-app verdict"

echo
echo "[D1-4] label identity admits a build-target A/B only when the label agrees"
T7="$(mktemp -d)"; make_stub "$T7"
make_svc "$T7" arm-a arm-a-1 reg.io/node:v1 sha256:nnnn
make_svc "$T7" arm-b arm-b-1 reg.io/bun:v1 sha256:bbbb
cat > "${T7}/resolver" <<'RES'
#!/usr/bin/env bash
# $1 = pinned image ref, $2 = label key
case "$2" in
  dev.knext.app.id) echo "app-fixture-7f3a" ;;
  dev.knext.build.command) echo "bun build --compile --minify --bytecode" ;;
  *) echo "" ;;
esac
RES
chmod +x "${T7}/resolver"
IMAGE_LABEL_RESOLVER="${T7}/resolver" run_bench "$T7" --service arm-a --peer arm-b --app-id-label dev.knext.app.id --phases none
rc=$?
assert_rc_zero "$rc" "two DIFFERENT images that declare the same app id are admissible (the build-target A/B case)"
assert_contains "${T7}/results.txt" "app-id=app-fixture-7f3a" "the app id is recorded"
assert_contains "${T7}/results.txt" "build-command=bun build --compile --minify --bytecode" \
  "the build command is a one-line lookup from the image label, not forensics"

echo
echo "[D1-5] label identity REFUSES arms whose declared app ids differ"
T8="$(mktemp -d)"; make_stub "$T8"
make_svc "$T8" arm-a arm-a-1 reg.io/node:v1 sha256:nnnn
make_svc "$T8" arm-b arm-b-1 reg.io/bun:v1 sha256:bbbb
cat > "${T8}/resolver" <<'RES'
#!/usr/bin/env bash
case "$1" in
  *node*) echo "app-hello-next" ;;
  *) echo "app-bun-sample" ;;
esac
RES
chmod +x "${T8}/resolver"
IMAGE_LABEL_RESOLVER="${T8}/resolver" run_bench "$T8" --service arm-a --peer arm-b --app-id-label dev.knext.app.id --phases none
rc=$?
assert_rc_nonzero "$rc" "differing declared app ids abort the run"
assert_contains "${T8}/results.txt" "app-hello-next" "the abort names the first arm's app id"
assert_contains "${T8}/results.txt" "app-bun-sample" "the abort names the peer's app id"

echo
echo "[D1-6] an app-id label that cannot be read is a FAILURE, not a pass"
T9="$(mktemp -d)"; make_stub "$T9"
make_svc "$T9" arm-a arm-a-1 reg.io/node:v1 sha256:nnnn
make_svc "$T9" arm-b arm-b-1 reg.io/bun:v1 sha256:bbbb
cat > "${T9}/resolver" <<'RES'
#!/usr/bin/env bash
echo "unable to reach registry" >&2; exit 1
RES
chmod +x "${T9}/resolver"
IMAGE_LABEL_RESOLVER="${T9}/resolver" run_bench "$T9" --service arm-a --peer arm-b --app-id-label dev.knext.app.id --phases none
rc=$?
assert_rc_nonzero "$rc" "an unreachable label resolver aborts the run"
assert_contains "${T9}/results.txt" "unable to reach registry" "the resolver's own error is reported verbatim"

echo
echo "[D1-7] an unlabelled image fails the label gate rather than matching on emptiness"
TA="$(mktemp -d)"; make_stub "$TA"
make_svc "$TA" arm-a arm-a-1 reg.io/node:v1 sha256:nnnn
make_svc "$TA" arm-b arm-b-1 reg.io/bun:v1 sha256:bbbb
printf '#!/usr/bin/env bash\necho ""\n' > "${TA}/resolver"; chmod +x "${TA}/resolver"
IMAGE_LABEL_RESOLVER="${TA}/resolver" run_bench "$TA" --service arm-a --peer arm-b --app-id-label dev.knext.app.id --phases none
rc=$?
assert_rc_nonzero "$rc" "two images with an EMPTY app-id label are not 'equal' — empty == empty must not pass the gate"

# ── D14 ──────────────────────────────────────────────────────────────────────
echo
echo "[D14-1] every run registers itself in a durable index BEFORE it measures"
TB="$(mktemp -d)"; make_stub "$TB"; make_svc "$TB" demo-svc demo-svc-00001 reg.io/app:v1 sha256:aaaa
run_bench "$TB" --service demo-svc --url http://demo-svc/api/health --phases none
assert_contains "${TB}/INDEX.tsv" "STARTED" "a STARTED row is appended when the run begins"
assert_contains "${TB}/INDEX.tsv" "http://demo-svc/api/health" "the index row carries the endpoint"
if [ "$(grep -c . "${TB}/INDEX.tsv")" -ge 2 ]; then
  ok "a terminal row is appended when the run ends (so a killed run is visible as STARTED-with-no-end)"
else
  nope "a terminal row is appended when the run ends — index has $(grep -c . "${TB}/INDEX.tsv") row(s)"
fi

echo
echo "[D14-2] provenance.sh audit flags an indexed run whose results file vanished"
TC="$(mktemp -d)"; mkdir -p "${TC}/results"
printf '2026-07-28T00:00:00Z\trun-1\tsit-a\tsvc\thttp://x/\tsha256:a\t%s\tSTARTED\n' "${TC}/results/gone.txt" > "${TC}/results/INDEX.tsv"
printf '2026-07-28T00:01:00Z\trun-1\tsit-a\tsvc\thttp://x/\tsha256:a\t%s\tCOMPLETE\n' "${TC}/results/gone.txt" >> "${TC}/results/INDEX.tsv"
bash "$PROV_SH" audit "${TC}/results" > "${TC}/audit.txt" 2>&1
rc=$?
assert_rc_nonzero "$rc" "audit fails when an indexed results file is missing"
assert_contains "${TC}/audit.txt" "run-1" "the audit names the run whose file was lost"

echo
echo "[D14-3] provenance.sh audit flags a run that STARTED and never ended"
TD="$(mktemp -d)"; mkdir -p "${TD}/results"
: > "${TD}/results/live.txt"
printf '2026-07-28T00:00:00Z\trun-2\tsit-a\tsvc\thttp://x/\tsha256:a\t%s\tSTARTED\n' "${TD}/results/live.txt" > "${TD}/results/INDEX.tsv"
bash "$PROV_SH" audit "${TD}/results" > "${TD}/audit.txt" 2>&1
rc=$?
assert_rc_nonzero "$rc" "audit fails on a run with no terminal row (SIGKILL mid-run)"
assert_contains "${TD}/audit.txt" "run-2" "the audit names the run that never finished"

echo
echo "[D14-4] a clean results dir audits green"
TE="$(mktemp -d)"; make_stub "$TE"; make_svc "$TE" demo-svc demo-svc-00001 reg.io/app:v1 sha256:aaaa
mkdir -p "${TE}/results"
DRY_RUN=1 DRY_RUN_EXERCISE_KC=1 KUBECTL_BIN="${TE}/kubectl" \
OUT="${TE}/results/demo.txt" SCALE_DOWN_TIMEOUT=0 APPLY_SETTLE_SECONDS=0 \
RESULTS_INDEX="${TE}/results/INDEX.tsv" \
  bash "$RUN_SH" --namespace bench --service demo-svc --phases none > "${TE}/out.txt" 2>&1
bash "$PROV_SH" audit "${TE}/results" > "${TE}/audit.txt" 2>&1
assert_rc_zero $? "a run that completed and kept its file audits clean"

# ── extraction: the write-up bridge (D2) ─────────────────────────────────────
echo
echo "[X-1] provenance.sh extract turns a results file into the write-up block"
bash "$PROV_SH" extract "${T}/results.txt" > "${T}/extract.txt" 2>&1
assert_rc_zero $? "extract succeeds on a results file with provenance"
assert_contains "${T}/extract.txt" "http://demo-svc.bench.svc.cluster.local/api/health" \
  "the extracted block carries the endpoint into the write-up"
assert_contains "${T}/extract.txt" "sha256:aaaa" "the extracted block carries the image digest"

echo
echo "[X-2] extract REFUSES a results file with no recorded endpoint"
TF="$(mktemp -d)"
printf '=== some old run ===\nhttp_req_duration..: med=3.4s\n' > "${TF}/old.txt"
bash "$PROV_SH" extract "${TF}/old.txt" > "${TF}/x.txt" 2>&1
assert_rc_nonzero $? "a results file without provenance cannot be turned into a write-up block"

echo
echo "[X-3] medians read http_req_duration ONLY — never iteration_duration"
TG="$(mktemp -d)"
cat > "${TG}/r.txt" <<'EOF'
    http_req_duration..............: avg=41ms med=3.4s p(95)=98ms
    iteration_duration.............: avg=51ms med=3.41s p(95)=108ms
EOF
bash "$PROV_SH" medians "${TG}/r.txt" > "${TG}/m.txt" 2>&1
assert_rc_zero $? "medians succeeds on a file with http_req_duration"
assert_contains "${TG}/m.txt" "3.4s" "the http_req_duration median is reported"
assert_not_contains "${TG}/m.txt" "3.41s" "the iteration_duration median (~10ms longer) is never reported"

echo
echo "[X-4] medians FAILS on a file that only has iteration_duration"
cat > "${TG}/only-iter.txt" <<'EOF'
    iteration_duration.............: avg=51ms med=3.41s p(95)=108ms
EOF
bash "$PROV_SH" medians "${TG}/only-iter.txt" > "${TG}/m2.txt" 2>&1
assert_rc_nonzero $? "no http_req_duration means NO latency figure, not a substituted one"
assert_not_contains "${TG}/m2.txt" "3.41s" "iteration_duration is never substituted for the missing metric"

# ── write-up gate (D2 in the document, where the gap actually was) ───────────
echo
echo "[W-1] verify-writeup fails a new Run section with no endpoint"
TH="$(mktemp -d)"
cat > "${TH}/doc.md" <<'EOF'
## Run 26 (2026-07-27) — an older run, exempt

median 3.4 s.

## Run 27 (2026-07-29) — a new run

median 3.4 s.
EOF
bash "$PROV_SH" verify-writeup "${TH}/doc.md" 27 > "${TH}/w.txt" 2>&1
assert_rc_nonzero $? "a Run section at/after the cutoff without an endpoint line fails"
assert_contains "${TH}/w.txt" "Run 27" "the failure names the offending section"
assert_not_contains "${TH}/w.txt" "Run 26" "sections before the cutoff are not retro-flagged"

echo
echo "[W-2] verify-writeup passes a Run section that carries its endpoint"
cat > "${TH}/doc-ok.md" <<'EOF'
## Run 27 (2026-07-29) — a new run

- endpoint: `http://p1b-node.default.svc.cluster.local/api/health`
- app-image-digest: `sha256:aaaa`
- sitting: `2026-07-29-a`

median 3.4 s.
EOF
bash "$PROV_SH" verify-writeup "${TH}/doc-ok.md" 27 > "${TH}/w2.txt" 2>&1
assert_rc_zero $? "a Run section carrying endpoint + digest + sitting passes"

echo
echo "[D14-5] a results file written into a GITIGNORED directory says so, while it can still be copied out"
TG2="$(mktemp -d)"; make_stub "$TG2"; make_svc "$TG2" demo-svc demo-svc-00001 reg.io/app:v1 sha256:aaaa
REPO="${TG2}/repo"
mkdir -p "${REPO}/results" "${REPO}/kept"
git -C "$REPO" init -q 2>/dev/null
printf 'results/\n' > "${REPO}/.gitignore"
DRY_RUN=1 DRY_RUN_EXERCISE_KC=1 KUBECTL_BIN="${TG2}/kubectl" \
OUT="${REPO}/results/r.txt" SCALE_DOWN_TIMEOUT=0 APPLY_SETTLE_SECONDS=0 \
RESULTS_INDEX="${TG2}/INDEX.tsv" \
  bash "$RUN_SH" --namespace bench --service demo-svc --phases none > "${TG2}/o.txt" 2>&1
assert_contains "${REPO}/results/r.txt" "is GITIGNORED" \
  "the run states that its own results file lives outside git — the mechanism by which a run's files vanish with a throwaway worktree"

DRY_RUN=1 DRY_RUN_EXERCISE_KC=1 KUBECTL_BIN="${TG2}/kubectl" \
OUT="${REPO}/kept/r.txt" SCALE_DOWN_TIMEOUT=0 APPLY_SETTLE_SECONDS=0 \
RESULTS_INDEX="${TG2}/INDEX.tsv" \
  bash "$RUN_SH" --namespace bench --service demo-svc --phases none > "${TG2}/o2.txt" 2>&1
assert_not_contains "${REPO}/kept/r.txt" "is GITIGNORED" \
  "a tracked output path is not falsely flagged"

# ── build-flag provenance (the label the harness reads) ─────────────────────
# Tying a deployed digest to the flags it was built with used to require
# extracting the binary from the image and fingerprinting it against
# version-matched controls. These assert the one-line-lookup replacement.
BUILD_SH="${SCRIPT_DIR}/../../examples/bun-exec/build.sh"
echo
echo "[B-1] the bun-exec build stamps its EXACT build command as an image label"
TI="$(mktemp -d)"
bash "$BUILD_SH" --print-labels linux-x64 > "${TI}/labels.txt" 2>&1
assert_rc_zero $? "--print-labels works without building (and without a registry)"
assert_contains "${TI}/labels.txt" "dev.knext.build.command=bun build --compile --minify --bytecode" \
  "the label carries the real --compile --minify --bytecode command"
assert_contains "${TI}/labels.txt" "dev.knext.build.target=bun-linux-x64-musl" \
  "the label carries the compile target"
# The app id must be TARGET-INDEPENDENT, so both halves are asserted.
#
# This assertion used to expect the prefix `bun-exec-`, and that expectation was
# the defect: an id that names its own build target can never match the node
# arm's id, so ADR-0036 condition A1 ("same app on both arms") was unsatisfiable
# by construction — the A/B it gates could not have been admissible whatever the
# arms actually contained. `app-id.sh` now derives the id from `app/` +
# `package.json` alone, and both arms call it.
#
# Asserting only "an id is declared" would stay green if the target crept back
# into it, which is exactly the regression that matters here — hence the second
# assertion.
assert_contains "${TI}/labels.txt" "dev.knext.app.id=app-" \
  "the image declares an app id — the only thing that can make a build-target A/B admissible"
assert_not_contains "${TI}/labels.txt" "dev.knext.app.id=bun-exec-" \
  "the app id does NOT name its build target — a target-prefixed id makes A1 unsatisfiable"

echo
echo "[B-2] the stamped command is the command that RUNS — one array, no second copy"
if [ "$(grep -c '"${BUN_BUILD_CMD\[@\]}"' "$BUILD_SH")" = "1" ] \
   && [ "$(grep -c 'dev.knext.build.command=%s' "$BUILD_SH")" = "1" ]; then
  ok "build.sh executes and stamps the same BUN_BUILD_CMD array"
else
  nope "build.sh executes and stamps the same BUN_BUILD_CMD array (a hand-copied label string is free to drift from the build)"
fi

echo
echo "== provenance.test.sh: ${PASS} passed, ${FAIL} failed =="
[ "$FAIL" -eq 0 ]
