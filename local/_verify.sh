#!/usr/bin/env bash
#
# _verify.sh — acceptance test for the local Neon storage plane.
#
# Proves the headline MVP property: Postgres compute is stateless. We write rows,
# destroy + recreate the compute container from its image (no pgdata carried over),
# and the rows are still there with NO restore step. Also asserts the storage-plane
# services are healthy and prints the measured cold-start time.
#
# Usage:  cd local && ./_verify.sh
# Exit:   0 = PASS, non-zero = FAIL. Leaves the stack running.
#
# Shell-only (plus docker compose + the psql that ships inside the compute image).
# No host psql / node required.

set -euo pipefail

# --- environment ------------------------------------------------------------
# docker (OrbStack shim) and friends may not be on the default PATH.
export PATH="$HOME/.orbstack/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")"

PG=(psql -h localhost -p 55433 -U cloud_admin postgres)          # inside compute
PSQL() { docker compose exec -T compute "${PG[@]}" "$@"; }        # run a psql cmd
EXPECTED_SERVICES="minio storage_broker safekeeper1 pageserver compute"
TABLE=ks_pg_verify

fail() { echo "FAIL: $*" >&2; exit 1; }

# millisecond epoch, portable: GNU date -> perl -> python3 -> seconds*1000
now_ms() {
  local ms
  ms=$(date +%s%3N 2>/dev/null || true)
  if [[ "$ms" =~ ^[0-9]{13,}$ ]]; then echo "$ms"; return; fi
  if command -v perl >/dev/null 2>&1; then
    perl -MTime::HiRes -e 'printf("%d\n", Time::HiRes::time()*1000)'; return
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import time;print(int(time.time()*1000))'; return
  fi
  echo $(( $(date +%s) * 1000 ))
}

# poll until compute answers a trivial query (bounded)
wait_for_compute() {
  local deadline=$(( $(now_ms) + 60000 ))
  until docker compose exec -T compute "${PG[@]}" -tAc "SELECT 1" >/dev/null 2>&1; do
    [[ $(now_ms) -lt $deadline ]] || fail "compute did not accept connections within 60s"
  done
}

echo "== KS-PG local storage-plane verification =="

# --- 1. bring the stack up and assert services are healthy ------------------
echo "-- [1/5] bringing stack up (docker compose up -d --build) --"
docker compose up -d --build >/dev/null
for svc in $EXPECTED_SERVICES; do
  running=$(docker compose ps --status running --services 2>/dev/null | grep -Fx "$svc" || true)
  [[ -n "$running" ]] || fail "service '$svc' is not running"
done
echo "   services running: $EXPECTED_SERVICES"

echo "-- [2/5] waiting for compute to accept connections --"
wait_for_compute

# --- 2. write a known dataset (deterministic: exactly 3 rows) ---------------
echo "-- [3/5] writing test data: 3 rows into $TABLE --"
PSQL -v ON_ERROR_STOP=1 \
  -c "DROP TABLE IF EXISTS $TABLE;" \
  -c "CREATE TABLE $TABLE(id int);" \
  -c "INSERT INTO $TABLE VALUES (1),(2),(3);" >/dev/null
before=$(PSQL -tAc "SELECT count(*) FROM $TABLE;" | tr -d '[:space:]')
[[ "$before" == "3" ]] || fail "expected 3 rows before restart, got '$before'"
echo "   rows before compute kill: $before"

# --- 3. destroy + recreate compute from image (true stateless test) ---------
echo "-- [4/5] destroying + recreating compute container (rm -sfv, no pgdata) --"
docker compose rm -sfv compute >/dev/null 2>&1
t0=$(now_ms)
docker compose up -d compute >/dev/null
wait_for_compute
t1=$(now_ms)
cold_start_ms=$(( t1 - t0 ))
echo "   COLD_START_MS=$cold_start_ms  (recreate -> first successful query)"

# --- 4. data must have survived with no restore step ------------------------
echo "-- [5/5] asserting data survived --"
after=$(PSQL -tAc "SELECT count(*) FROM $TABLE;" | tr -d '[:space:]')
[[ "$after" == "3" ]] || fail "data did NOT survive: expected 3 rows, got '$after'"
echo "   rows after compute recreate: $after"

echo
echo "PASS: storage plane healthy; data survived compute recreate (3 rows); cold start ${cold_start_ms}ms"
