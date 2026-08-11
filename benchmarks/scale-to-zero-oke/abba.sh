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
# PENDING RESTORES ARE CHECKED BETWEEN RUNS, not just at the end. run.sh refuses
# to start when one is outstanding — correctly, since starting would capture
# benchmark values as the new "original" and lose the real one permanently — so
# a mid-sequence kill would otherwise wedge every subsequent run. Seen: a run
# died on API i/o timeouts at sample 7 of 10 and left exactly that.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BLOCKS="${1:-6}"
SITTING="${2:-abba-$(date -u +%Y%m%dT%H%M%SZ)}"
NS="${3:-default}"
CTX="${BENCH_CONTEXT:-context-ckmva7v7zvq}"
A="${ARM_A:-p1b-bunexec}"
B="${ARM_B:-p1b-node}"

one() { # one() <service> <peer>
  BENCH_CONTEXT="$CTX" IMAGE_LABEL_RESOLVER="$PWD/image-label-cluster.sh" \
    ./run.sh --context "$CTX" --namespace "$NS" \
      --service "$1" --peer "$2" --app-id-label dev.knext.app.id \
      --phases cold --cold-samples 1 --sitting "$SITTING" >>"$LOG" 2>&1
}

clear_pending() { # a wedged restore stops the whole sequence, so clear it eagerly
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
echo "done — results files:"
ls -t results/"$A"-*.txt results/"$B"-*.txt 2>/dev/null | head -$((BLOCKS * 4))
