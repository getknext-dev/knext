#!/usr/bin/env bash
# abba.sh — drive run.sh as an INTERLEAVED A/B.
#
#   ./abba.sh <blocks> <sitting> [namespace]
#
# WHY THIS EXISTS. run.sh measures ONE service per invocation, so the obvious way
# to compare two arms is to run all of A then all of B. That is precisely the
# defect that withdrew ADR-0036 Run 24: its apparent 4.5x win was an artifact of
# WHEN each arm ran, not what it was, because a bimodal slow mode drifts between
# sittings. ADR-0036 condition A3 therefore requires arms INTERLEAVED, ABBA
# within pair — which no committed script did, so every interleaved run so far
# was assembled by hand.
#
# One block = A B B A, one cold sample each. ABBA rather than ABAB so that a
# monotone drift over the block (a node warming up, a registry getting slower)
# cancels within the block instead of loading onto one arm.
#
# PENDING RESTORES ARE CLEARED BEFORE EVERY SAMPLE, not once per block. run.sh
# refuses to start when one is outstanding — correctly, since starting would capture
# benchmark values as the new "original" and lose the real one permanently — so one
# failed sample otherwise wedges every LATER sample in the same block.
#
# This comment used to claim "between runs" while the code cleared once per block,
# and the gap cost real data: in the 2026-08-12 probe-timeout crossover, four
# samples died with "REFUSING TO START: an unfinished restore is outstanding",
# leaving cells of n≈4 that could not measure a 0–42% effect. The mismatch was
# invisible because a refused sample still writes a results file — it just contains
# no reps — so the loss only shows up if someone counts.
#
# Hence the integrity report at the end: a run that loses samples now SAYS so.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BLOCKS="${1:-6}"
# BSD `seq 1 0` counts DOWN and yields "1 0", so `./abba.sh 0` silently ran two
# blocks. Reject anything that is not a positive integer rather than run a different
# experiment than the one that was asked for.
case "$BLOCKS" in
  ''|*[!0-9]*) echo "blocks must be a positive integer (got '$BLOCKS')" >&2; exit 2 ;;
  0) echo "blocks must be >= 1" >&2; exit 2 ;;
esac
SITTING="${2:-abba-$(date -u +%Y%m%dT%H%M%SZ)}"
NS="${3:-default}"
CTX="${BENCH_CONTEXT:-context-ckmva7v7zvq}"
A="${ARM_A:-p1b-bunexec}"
B="${ARM_B:-p1b-node}"

SAMPLES_ATTEMPTED=0
SAMPLE_FILES=""   # newline-separated results paths, one per ATTEMPTED sample

one() { # one() <service> <peer>
  SAMPLES_ATTEMPTED=$((SAMPLES_ATTEMPTED + 1))
  # Clear THIS service's pending restore first. run.sh only refuses for the service
  # it is about to mutate, so the target is the one that matters — and clearing it
  # here rather than once per block is what stops one failure taking the rest of
  # the block with it.
  ./run.sh --context "$CTX" --namespace "$NS" --service "$1" --restore-pending >/dev/null 2>&1

  # Capture THIS sample's own output so the integrity check never has to guess which
  # files belong to it.
  #
  # The first version of that check globbed `results/` and took the newest
  # `BLOCKS * 8`. That was wrong twice over: a `--restore-pending` call also writes a
  # results file (run.sh truncates $OUT before its early exit), so a block writes ~10
  # files, not 8 — the window silently dropped a clean run's earliest samples and the
  # guard reported loss on data that was entirely intact. Reviewed and reproduced with
  # a stubbed run.sh: `attempted=12 with-data=9 *** LOST 3 ***` on a run that lost
  # nothing. Tracking the exact path run.sh reports removes the glob, the cap and the
  # sitting filter together — none of them can be wrong if none of them exist.
  local out
  out=$(BENCH_CONTEXT="$CTX" IMAGE_LABEL_RESOLVER="$PWD/image-label-cluster.sh" \
    ./run.sh --context "$CTX" --namespace "$NS" \
      --service "$1" --peer "$2" --app-id-label dev.knext.app.id \
      --phases cold --cold-samples 1 --sitting "$SITTING" 2>&1 \
    | tee -a "$LOG" \
    | sed -n 's/^.*=== DONE (results: \(.*\)) ===.*$/\1/p' | tail -1)
  # A sample that never reported a path is a LOST sample, not an absent one. Record a
  # sentinel so it lands in a bucket: skipping empty entries silently dropped such a
  # sample from the accounting entirely, leaving the totals to disagree with the
  # attempt count — which the accounting check would then have to catch after the fact.
  SAMPLE_FILES="${SAMPLE_FILES}${out:-<no-results-path-reported>}
"
}

clear_pending() { # belt-and-braces at block boundaries and on the way out
  for s in "$A" "$B"; do
    ./run.sh --context "$CTX" --namespace "$NS" --service "$s" --restore-pending >/dev/null 2>&1
  done
}

LOG="${LOG:-/tmp/abba-$SITTING.log}"
: >"$LOG"
echo "sitting=$SITTING blocks=$BLOCKS arms=$A/$B log=$LOG"

for i in $(seq 1 "$BLOCKS"); do
  echo "== block $i/$BLOCKS =="
  clear_pending
  one "$A" "$B"; one "$B" "$A"; one "$B" "$A"; one "$A" "$B"
done

clear_pending

# ── integrity: did every attempted sample actually produce a datapoint? ────────
#
# A REFUSED sample still writes a results file; it just contains no reps. So file
# count is not sample count, and a run can lose a third of its data while looking
# complete.
#
# This iterates the EXACT files the samples reported, never a glob. Every attempted
# sample is accounted for in one of four buckets and the four sum to `attempted` by
# construction, so a loss can never be reported without also being named — the first
# version printed `LOST 3` with zero named files, which is undiagnosable.
echo
echo "== run integrity =="
with_data=0; refused=0; empty=0; nopath=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if [ ! -f "$f" ]; then
    nopath=$((nopath + 1)); echo "  NO RESULTS FILE: run.sh reported no path for one sample"
  elif grep -q 'http_req_duration' "$f" 2>/dev/null; then
    with_data=$((with_data + 1))
  elif grep -q 'REFUSING TO START' "$f" 2>/dev/null; then
    refused=$((refused + 1)); echo "  REFUSED (pending restore): $(basename "$f")"
  else
    empty=$((empty + 1)); echo "  NO DATA: $(basename "$f")"
  fi
done <<EOF
$SAMPLE_FILES
EOF

echo "  attempted=$SAMPLES_ATTEMPTED  with-data=$with_data  refused=$refused  empty=$empty  no-path=$nopath"
lost=$((refused + empty + nopath))
accounted=$((with_data + lost))
if [ "$accounted" -ne "$SAMPLES_ATTEMPTED" ]; then
  # The buckets must sum to the attempts. If they ever do not, the accounting itself
  # is broken and its "no samples lost" would be worthless — so say that rather than
  # print a reassuring number derived from a broken count.
  echo "  *** ACCOUNTING BROKEN: $accounted buckets vs $SAMPLES_ATTEMPTED attempts. ***"
  echo "  Do not trust this run's integrity verdict either way."
  exit 2
fi
if [ "$lost" -gt 0 ]; then
  echo "  *** LOST $lost of $SAMPLES_ATTEMPTED samples — treat this dataset as INCOMPLETE. ***"
  echo "  Cells this small cannot measure an effect whose base rate swings 0-42%;"
  echo "  re-run rather than reading the surviving samples as the intended n."
  exit 1
fi
echo "  no samples lost ($with_data/$SAMPLES_ATTEMPTED carry a latency figure)"

echo
echo "done — this run's results files:"
printf '%s' "$SAMPLE_FILES" | sed '/^$/d;s|.*/|  |'
