#!/usr/bin/env bash
# abba-integrity.test.sh — the sample-loss guard in abba.sh, exercised end to end.
#
#   bash benchmarks/scale-to-zero-oke/abba-integrity.test.sh
#
# WHY IT EXISTS. The guard shipped in review without ever being RUN, and it failed on
# clean data: it globbed `results/` and kept the newest `BLOCKS * 8` files, but a
# `--restore-pending` call also writes a results file, so a block emits ~10. A run that
# lost nothing reported `LOST 3 of 12` and exited 1. A guard that cries wolf gets
# ignored exactly as fast as one that stays silent, so this pins BOTH directions:
# it must be quiet on a clean run and loud on a lossy one.
#
# run.sh is stubbed. That is the point — the guard's job is to notice what run.sh
# produced, so the test controls exactly what it produces. No cluster, no kubectl.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fails=0

ok()   { printf '  ok    %s\n' "$1"; }
nope() { printf '  FAIL  %s\n' "$1"; fails=1; }

# Build a throwaway dir containing abba.sh + a stub run.sh that mimics the real one's
# file semantics: EVERY invocation (sample or --restore-pending) truncates a results
# file; only a real sample writes a latency line.
scaffold() { # scaffold <dir> <mode>
  local dir="$1" mode="$2"
  mkdir -p "$dir/results"
  cp "$HERE/abba.sh" "$dir/abba.sh"
  cat > "$dir/run.sh" <<STUB
#!/usr/bin/env bash
set -uo pipefail
svc=""; restore=0
while [ \$# -gt 0 ]; do
  case "\$1" in
    --service) svc="\$2"; shift 2 ;;
    --restore-pending) restore=1; shift ;;
    *) shift ;;
  esac
done
out="\$(cd "\$(dirname "\$0")" && pwd)/results/\${svc}-\$(date -u +%Y%m%dT%H%M%S)\$RANDOM.txt"
: > "\$out"
echo "=== knext scale-to-zero benchmark — service=\$svc ===" >> "\$out"
if [ "\$restore" = "1" ]; then
  echo "no pending restore for '\$svc' — nothing to do." >> "\$out"
else
  case "$mode" in
    clean)   echo "http_req_duration...: avg=2.5s" >> "\$out" ;;
    refused) if [ -f "\$(dirname "\$0")/.refuse" ]; then
               echo "*** REFUSING TO START: an unfinished restore is outstanding ***" >> "\$out"
             else
               echo "http_req_duration...: avg=2.5s" >> "\$out"
               touch "\$(dirname "\$0")/.refuse"
             fi ;;
  esac
fi
echo "=== DONE (results: \$out) ===" >> "\$out"
echo "=== DONE (results: \$out) ==="
STUB
  chmod +x "$dir/run.sh"
  : > "$dir/image-label-cluster.sh"; chmod +x "$dir/image-label-cluster.sh"
}

echo "== a CLEAN run must be silent and exit 0 =="
d=$(mktemp -d); scaffold "$d" clean
out=$(cd "$d" && LOG="$d/log" ./abba.sh 3 testsit 2>&1); rc=$?
if [ "$rc" -eq 0 ]; then ok "exit 0 on a clean run"; else nope "exit $rc on a CLEAN run — the guard cries wolf"; fi
if echo "$out" | grep -q 'no samples lost'; then ok "reports no loss"; else nope "did not report 'no samples lost'"; fi
if echo "$out" | grep -q 'attempted=12  with-data=12'; then ok "counted all 12 attempts as data"; else
  nope "miscounted: $(echo "$out" | grep -m1 attempted=)"; fi
if echo "$out" | grep -q 'LOST'; then nope "reported LOST on a clean run"; else ok "no false LOST"; fi

echo
echo "== a run with a REFUSED sample must be loud and exit 1 =="
d2=$(mktemp -d); scaffold "$d2" refused
out2=$(cd "$d2" && LOG="$d2/log" ./abba.sh 2 testsit2 2>&1); rc2=$?
if [ "$rc2" -eq 1 ]; then ok "exit 1 when a sample was refused"; else nope "exit $rc2 — a lost sample did not fail the run"; fi
if echo "$out2" | grep -q 'REFUSED (pending restore)'; then ok "names the refused file"; else nope "did not NAME the refused file"; fi
if echo "$out2" | grep -q '\*\*\* LOST'; then ok "reports the loss"; else nope "did not report LOST"; fi
# the loss must be attributable: every lost sample is named, so the printed buckets
# must account for the shortfall rather than leaving it a bare number.
named=$(echo "$out2" | grep -c 'REFUSED (pending restore)')
claimed=$(echo "$out2" | sed -n 's/.*\*\*\* LOST \([0-9]*\) of.*/\1/p')
if [ "${named:-0}" = "${claimed:-x}" ]; then ok "named files ($named) match the claimed loss ($claimed)"; else
  nope "claimed LOST $claimed but named $named files — undiagnosable"; fi

echo
echo "== a sample whose run.sh reports NO results path is also a loss =="
# The guard reads each sample's own reported path. A run.sh that dies before printing
# one used to leave that sample in NO bucket at all — silently shrinking the dataset
# while the totals still looked self-consistent.
d4=$(mktemp -d); scaffold "$d4" clean
cat > "$d4/run.sh" <<'STUB'
#!/usr/bin/env bash
# reports nothing at all — the shape of a run.sh that died mid-sample
exit 0
STUB
chmod +x "$d4/run.sh"
out4=$(cd "$d4" && LOG="$d4/log" ./abba.sh 1 testsit4 2>&1); rc4=$?
if [ "$rc4" -eq 1 ]; then ok "exit 1 when no results path is reported"; else nope "exit $rc4 — silent sample loss not caught"; fi
if echo "$out4" | grep -q 'NO RESULTS FILE'; then ok "names the no-path samples"; else nope "did not report NO RESULTS FILE"; fi
if echo "$out4" | grep -q 'ACCOUNTING BROKEN'; then nope "accounting broke — buckets must still sum"; else ok "buckets still sum to attempts"; fi

echo
echo "== argument validation =="
d3=$(mktemp -d); scaffold "$d3" clean
(cd "$d3" && ./abba.sh 0 s >/dev/null 2>&1); [ $? -eq 2 ] && ok "rejects blocks=0 (BSD seq counts down)" || nope "accepted blocks=0"
(cd "$d3" && ./abba.sh abc s >/dev/null 2>&1); [ $? -eq 2 ] && ok "rejects non-numeric blocks" || nope "accepted non-numeric blocks"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; fi
exit "$fails"
