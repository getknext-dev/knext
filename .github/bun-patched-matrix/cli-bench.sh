#!/usr/bin/env bash
# usage: cli-bench.sh N label -- cmd...   (wall ms per run; prints stats)
set -uo pipefail
N=$1; l=$2; shift 3
v=""
for i in $(seq 1 "$N"); do s=$(date +%s%N); "$@" >/dev/null 2>&1; e=$(date +%s%N); v+="$(( (e-s)/1000000 )) "; done
echo "$v" | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -n | awk -v l="$l" '{a[NR]=$1} END{printf "CLISTAT|%s|n=%d min=%d median=%d max=%d\n", l, NR, a[1], a[int((NR+1)/2)], a[NR]}'
