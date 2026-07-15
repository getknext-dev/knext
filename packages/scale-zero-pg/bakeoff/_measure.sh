#!/usr/bin/env sh
# _measure.sh — foundation-agnostic cold-wake timing harness for the bake-off.
#
# Identical client-side methodology for BOTH foundations: it times, from a single
# in-cluster psql client pod, a connect + `SELECT <PROBE_SQL>` through a gateway
# DSN. The only thing that differs per foundation is the "force cold" step
# (COLD_CMD) — hibernate for CNPG, wait-for-idle-scale-to-zero for Neon — which
# is inherent to each foundation, not to the measurement. Same timer, same query,
# same client, same percentile math.
#
# Output: p50/p95/p99 to stdout + a raw-samples CSV under bakeoff/results/.
#
# Config via env:
#   LABEL        (required) short tag, e.g. cnpg or neon
#   GW_HOST      gateway service DNS (default pggw.bakeoff-cnpg.svc)
#   GW_PORT      gateway port       (default 55432)
#   PGUSER/PGPASSWORD/PGDATABASE  creds (default app/app/app)
#   PROBE_SQL    query to run       (default: SELECT count(*) FROM t)
#   N            sample count       (default 5)
#   CLIENT_NS    client pod ns      (default bakeoff-cnpg)
#   CLIENT_POD   client pod name    (default pgclient)
#   COLD_CMD     sh snippet run before each sample to force a cold target
#                (default: none -> measures whatever state the target is in)
#
# Requires: kubectl on PATH, a running CLIENT_POD with psql, python3 on host.
set -eu

LABEL="${LABEL:?set LABEL (e.g. cnpg|neon)}"
GW_HOST="${GW_HOST:-pggw.bakeoff-cnpg.svc}"
GW_PORT="${GW_PORT:-55432}"
PGUSER="${PGUSER:-app}"
PGPASSWORD="${PGPASSWORD:-app}"
PGDATABASE="${PGDATABASE:-app}"
PROBE_SQL="${PROBE_SQL:-SELECT count(*) FROM t}"
N="${N:-5}"
CLIENT_NS="${CLIENT_NS:-bakeoff-cnpg}"
CLIENT_POD="${CLIENT_POD:-pgclient}"
COLD_CMD="${COLD_CMD:-}"

DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DIR/results"
STAMP="$(python3 -c 'import time;print(time.strftime("%Y%m%dT%H%M%S"))')"
CSV="$DIR/results/${LABEL}-${STAMP}.csv"
echo "idx,wake_ms,rows,ok" > "$CSV"

now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

echo "== bake-off measure: label=$LABEL target=$GW_HOST:$GW_PORT samples=$N =="
i=1
while [ "$i" -le "$N" ]; do
  if [ -n "$COLD_CMD" ]; then
    printf '  [%d/%d] forcing cold ... ' "$i" "$N"
    sh -c "$COLD_CMD" >/dev/null 2>&1 || true
    echo "done"
  fi
  t0="$(now_ms)"
  out="$(kubectl -n "$CLIENT_NS" exec "$CLIENT_POD" -- sh -c \
    "PGPASSWORD='$PGPASSWORD' psql -h '$GW_HOST' -p '$GW_PORT' -U '$PGUSER' -d '$PGDATABASE' -tAc \"$PROBE_SQL\" -v ON_ERROR_STOP=1" 2>/dev/null)" && ok=1 || ok=0
  t1="$(now_ms)"
  ms=$((t1 - t0))
  rows="$(printf '%s' "$out" | tr -d '[:space:]')"
  [ -z "$rows" ] && rows="NA"
  echo "$i,$ms,$rows,$ok" >> "$CSV"
  echo "  [$i/$N] wake+query=${ms}ms rows=$rows ok=$ok"
  i=$((i + 1))
done

echo "== percentiles ($LABEL) =="
python3 - "$CSV" <<'PY'
import sys, csv
rows=[r for r in csv.DictReader(open(sys.argv[1])) if r["ok"]=="1"]
xs=sorted(int(r["wake_ms"]) for r in rows)
def pct(p):
    if not xs: return float("nan")
    k=(len(xs)-1)*p/100.0
    f=int(k); c=min(f+1,len(xs)-1)
    return xs[f]+(xs[c]-xs[f])*(k-f)
n=len(xs)
print(f"  samples_ok={n}  min={xs[0] if xs else 'NA'}  p50={pct(50):.0f}  p95={pct(95):.0f}  p99={pct(99):.0f}  max={xs[-1] if xs else 'NA'}  (ms)")
PY
echo "  raw CSV -> $CSV"
