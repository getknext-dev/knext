#!/bin/sh
# Two-event cold-boot timing probe, run as a container's entrypoint:
#
#   docker run --rm -i --entrypoint sh <image> -s < test/e2e-support/boot-timing.sh
#
# Emits ONE line per container lifetime:  <boot->LISTENING ms> <boot->first-SSR-200 ms>
#
# WHY BOTH EVENTS IN ONE PROCESS LIFETIME. The withdrawn 2026-08-17 n=5 draft took
# these from SEPARATE runs and subtracted two medians, which is not a within-run
# difference and cannot support an "of the total, N ms is app-module evaluation"
# attribution. This script exists so the published raw data (two columns per row,
# `docs/benchmarks/bun-exec-bytecode-coverage.md`) is reproducible from a
# committed artifact rather than from a shell snippet in a document. A prior
# revision of that document printed a ONE-column variant that could not have
# produced its own two-column data — caught by the system-designer gate.
#
# /proc/uptime is NOT namespaced, so inside a container it is a usable monotonic
# clock at 10 ms resolution. busybox `date` has no %N, which is why it is not
# used. The 10 ms quantisation and this loop's own polling latency are
# COMMON-MODE — identical in both arms — so they inflate both columns equally and
# cannot manufacture a between-arm difference. They do bound resolution, which is
# why the record reports intervals rather than point estimates.
#
# `nc` rather than wget/curl so the probe needs nothing added to the image (the
# `FROM scratch` variant has neither, and adding one would change what is timed).

read A _ < /proc/uptime
/app/server > /tmp/l 2>&1 &
P=$!
L=""
N=0
while [ $N -lt 100000 ]; do
  # First event: the entry prints LISTENING once both servers are bound.
  if [ -z "$L" ] && grep -q LISTENING /tmp/l 2>/dev/null; then
    read B _ < /proc/uptime
    L="$B"
  fi
  # Second event: a DYNAMIC SSR route, not `/` and not a health check. The app
  # modules arrive via a lazy import() on first request, so a boot-only or
  # static-root probe would miss exactly the interval of interest.
  if [ -n "$L" ]; then
    R=$(printf 'GET /item/42 HTTP/1.0\r\nHost: x\r\n\r\n' | nc 127.0.0.1 3000 2>/dev/null | head -1)
    case "$R" in
      *200*)
        read C _ < /proc/uptime
        awk -v a="$A" -v l="$L" -v c="$C" 'BEGIN{printf "%d %d\n",(l-a)*1000,(c-a)*1000}'
        kill -9 $P 2>/dev/null
        exit 0
        ;;
    esac
  fi
  N=$((N+1))
done

# A probe that cannot observe its subject must not look like a fast sample.
echo "TIMEOUT TIMEOUT"
kill -9 $P 2>/dev/null
exit 1
