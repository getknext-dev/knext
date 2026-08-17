#!/usr/bin/env bash
# Driver for boot-timing.sh: N container lifetimes against one image, one
# `<listen_ms> <ssr_ms>` line per lifetime on stdout.
#
#   ./boot-timing-run.sh <image> [n]        # n defaults to 40
#
# Committed because the published 40x2 tables in
# `docs/benchmarks/bun-exec-bytecode-coverage.md` came from a loop that existed
# only in a shell history. `boot-timing.sh` alone measures ONE lifetime, so
# "committed script" was true per-container and not true of the dataset — caught
# by code review. Both halves are now in the tree.
#
# Each sample is a FRESH container, deliberately: reusing one would measure a warm
# start, and the whole quantity of interest is the cold path.
set -uo pipefail
cd "$(dirname "$0")"

IMAGE="${1:?usage: boot-timing-run.sh <image> [n]}"
N="${2:-40}"

command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }

fails=0
for _ in $(seq 1 "$N"); do
  # `--rm -i` + `-s`: the probe is fed on stdin so the image needs nothing added
  # to it, which matters because adding a tool would change what is being timed.
  line=$(docker run --rm -i --entrypoint sh "$IMAGE" -s < boot-timing.sh 2>/dev/null)
  case "$line" in
    TIMEOUT*|'')
      # A lost sample is REPORTED, never silently dropped: silently discarding
      # them biases the surviving distribution toward fast starts, which is the
      # direction that would flatter the measurement.
      echo "# LOST SAMPLE: ${line:-<no output>}" >&2
      fails=$((fails + 1))
      ;;
    *) echo "$line" ;;
  esac
done

if [ "$fails" -gt 0 ]; then
  echo "# $fails/$N samples lost — the published dataset must state this, not omit it" >&2
  exit 1
fi
