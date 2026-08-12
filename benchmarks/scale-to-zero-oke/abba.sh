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
SITTING="${2:-abba-$(date -u +%Y%m%dT%H%M%SZ)}"
NS="${3:-default}"
CTX="${BENCH_CONTEXT:-context-ckmva7v7zvq}"
A="${ARM_A:-p1b-bunexec}"
B="${ARM_B:-p1b-node}"

SAMPLES_ATTEMPTED=0

one() { # one() <service> <peer>
  SAMPLES_ATTEMPTED=$((SAMPLES_ATTEMPTED + 1))
  # Clear THIS service's pending restore first. run.sh only refuses for the service
  # it is about to mutate, so the target is the one that matters — and clearing it
  # here rather than once per block is what stops one failure taking the rest of
  # the block with it.
  ./run.sh --context "$CTX" --namespace "$NS" --service "$1" --restore-pending >/dev/null 2>&1
  BENCH_CONTEXT="$CTX" IMAGE_LABEL_RESOLVER="$PWD/image-label-cluster.sh" \
    ./run.sh --context "$CTX" --namespace "$NS" \
      --service "$1" --peer "$2" --app-id-label dev.knext.app.id \
      --phases cold --cold-samples 1 --sitting "$SITTING" >>"$LOG" 2>&1
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
# complete. This counts files that carry an actual latency figure, attributes the
# rest, and exits non-zero when anything was lost — a partially-collected dataset
# should not be read as a small one.
echo
echo "== run integrity =="
started_at_epoch="${RUN_STARTED_EPOCH:-0}"
with_data=0; refused=0; other=0
for f in $(ls -t results/"$A"-*.txt results/"$B"-*.txt 2>/dev/null | head -$((BLOCKS * 8))); do
  # only files written by THIS sitting
  grep -q "sitting=$SITTING\|$SITTING" "$f" 2>/dev/null || continue
  if grep -q 'http_req_duration' "$f" 2>/dev/null; then
    with_data=$((with_data + 1))
  elif grep -q 'REFUSING TO START' "$f" 2>/dev/null; then
    refused=$((refused + 1)); echo "  REFUSED (pending restore): $(basename "$f")"
  elif grep -qE 'no pending restore|applying pending restore' "$f" 2>/dev/null; then
    # A --restore-pending housekeeping call, not a sample — BOTH outcomes of one.
    # Matching only "no pending restore" mis-read the case where a restore actually
    # APPLIED as a lost sample, which inflated the loss count by 2 the first time
    # this ran. A guard that over-reports gets ignored as fast as one that
    # under-reports.
    :
  else
    other=$((other + 1)); echo "  NO DATA (other): $(basename "$f")"
  fi
done

echo "  attempted=$SAMPLES_ATTEMPTED  with-data=$with_data  refused=$refused  other-empty=$other"
lost=$((SAMPLES_ATTEMPTED - with_data))
if [ "$lost" -gt 0 ]; then
  echo "  *** LOST $lost of $SAMPLES_ATTEMPTED samples — treat this dataset as INCOMPLETE. ***"
  echo "  Cells this small cannot measure an effect whose base rate swings 0-42%;"
  echo "  re-run rather than reading the surviving samples as the intended n."
  exit 1
fi
echo "  no samples lost"

echo
echo "done — results files:"
ls -t results/"$A"-*.txt results/"$B"-*.txt 2>/dev/null | head -$((BLOCKS * 4))
