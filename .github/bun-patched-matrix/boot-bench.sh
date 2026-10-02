#!/usr/bin/env bash
# Spike (#1822): cold boot -> first 200, interleaved across executables.
# usage: boot-bench.sh N /path label=exe [label=exe ...]
set -uo pipefail
N=$1; PATHQ=$2; shift 2
declare -A T
port=4100
for i in $(seq 1 "$N"); do
  for pair in "$@"; do
    l=${pair%%=*}; e=${pair#*=}
    port=$((port+1))
    s=$(date +%s%N)
    PORT=$port HOSTNAME=0.0.0.0 NODE_ENV=production "$e" >"/tmp/boot-$l.log" 2>&1 & pid=$!
    ok=0
    for _ in $(seq 1 4000); do
      if curl -fs -o /dev/null "http://127.0.0.1:$port$PATHQ"; then ok=1; break; fi
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.005
    done
    e2=$(date +%s%N)
    kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
    if [ "$ok" = 1 ]; then T[$l]+="$(( (e2-s)/1000000 )) "; else T[$l]+="FAIL "; tail -n 5 "/tmp/boot-$l.log"; fi
  done
done
for pair in "$@"; do
  l=${pair%%=*}
  echo "BOOT|$l|${T[$l]}"
  echo "${T[$l]}" | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -n | awk -v l="$l" '{a[NR]=$1} END{ if(NR==0){print "BOOTSTAT|"l"|n=0"; exit} p=int(NR*0.9+0.5); if(p>NR)p=NR; if(p<1)p=1; printf "BOOTSTAT|%s|n=%d min=%d median=%d p90=%d max=%d\n", l, NR, a[1], a[int((NR+1)/2)], a[p], a[NR]}'
done
