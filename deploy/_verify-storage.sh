#!/usr/bin/env bash
#
# _verify-storage.sh — acceptance test for the Neon storage plane ON KUBERNETES.
#
# Proves the headline MVP property on the cluster: Postgres compute is stateless.
# We scale compute up, write rows THROUGH it, DELETE the compute pod (a fresh pod
# is recreated from the image with no pgdata), and the rows are still there — no
# restore step. Also asserts the storage-plane workloads are Ready, the init Job
# completed, and the tenant + timeline exist in the pageserver. Prints the
# measured cold-start time.
#
# All Postgres/HTTP access happens INSIDE the cluster (kubectl exec / kubectl run);
# the host has no psql and host curl is blocked.
#
# Usage:  ./deploy/_verify-storage.sh      (run from the repo root or deploy/)
# Exit:   0 = PASS, non-zero = FAIL. Leaves compute scaled to 1.

set -euo pipefail
export PATH="$HOME/.orbstack/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

NS=scale-zero-pg
TENANT_ID=f000f000f000f000f000f000f000f001
TIMELINE_ID=f000f000f000f000f000f000f000f002
TABLE=ks_pg_verify
K="kubectl -n $NS"

fail() { echo "FAIL: $*" >&2; exit 1; }

now_ms() {
  local ms; ms=$(date +%s%3N 2>/dev/null || true)
  if [[ "$ms" =~ ^[0-9]{13,}$ ]]; then echo "$ms"; return; fi
  if command -v perl >/dev/null 2>&1; then perl -MTime::HiRes -e 'printf("%d\n",Time::HiRes::time()*1000)'; return; fi
  if command -v python3 >/dev/null 2>&1; then python3 -c 'import time;print(int(time.time()*1000))'; return; fi
  echo $(( $(date +%s) * 1000 ))
}

# run a psql command inside whichever compute pod the deployment currently has
PSQL() { $K exec deploy/compute -c compute -- psql -h localhost -p 55433 -U cloud_admin -d postgres "$@"; }

# poll until compute answers a trivial query (bounded, returns 0/1)
wait_compute_query() {
  local deadline=$(( $(now_ms) + 180000 ))
  until PSQL -tAc "SELECT 1" >/dev/null 2>&1; do
    [[ $(now_ms) -lt $deadline ]] || return 1
    sleep 0.2
  done
}

echo "== KS-PG storage-plane verification (k8s ns=$NS) =="

# --- 1. storage-plane workloads Ready ---------------------------------------
echo "-- [1/6] asserting storage-plane workloads Ready --"
for d in minio storage-broker; do
  $K rollout status deploy/$d --timeout=180s >/dev/null 2>&1 || fail "deploy/$d not Ready"
done
for s in safekeeper pageserver; do
  $K rollout status statefulset/$s --timeout=180s >/dev/null 2>&1 || fail "statefulset/$s not Ready"
done
echo "   Ready: deploy/minio deploy/storage-broker sts/safekeeper sts/pageserver"

# --- 2. storage-init Job completed ------------------------------------------
echo "-- [2/6] asserting storage-init Job completed --"
$K wait --for=condition=complete job/storage-init --timeout=180s >/dev/null 2>&1 \
  || fail "job/storage-init did not complete"

# --- 3. tenant + timeline exist (pageserver HTTP API, curl INSIDE a pod) -----
echo "-- [3/6] asserting tenant + timeline exist in pageserver --"
tl=$($K run verify-curl-$$ --image=curlimages/curl:8.11.1 --restart=Never --rm -i --quiet \
       --command -- curl -sf "http://pageserver:9898/v1/tenant/${TENANT_ID}/timeline" 2>/dev/null || true)
echo "$tl" | grep -q "$TIMELINE_ID" \
  || fail "timeline $TIMELINE_ID not found on tenant $TENANT_ID (got: ${tl:0:200})"
echo "   tenant $TENANT_ID / timeline $TIMELINE_ID present"

# --- 4. scale compute up and write a known dataset --------------------------
echo "-- [4/6] scaling compute to 1 and writing 3 rows --"
$K scale deploy/compute --replicas=1 >/dev/null
$K rollout status deploy/compute --timeout=180s >/dev/null 2>&1 || true
wait_compute_query || fail "compute did not accept connections after scale-up"
PSQL -v ON_ERROR_STOP=1 \
  -c "DROP TABLE IF EXISTS $TABLE;" \
  -c "CREATE TABLE $TABLE(id int);" \
  -c "INSERT INTO $TABLE VALUES (1),(2),(3);" >/dev/null
before=$(PSQL -tAc "SELECT count(*) FROM $TABLE;" | tr -d '[:space:]')
[[ "$before" == "3" ]] || fail "expected 3 rows before kill, got '$before'"
echo "   rows before compute kill: $before"

# --- 5. kill the compute pod; a fresh one is recreated (stateless) ----------
echo "-- [5/6] deleting compute pod (fresh pod, no pgdata) and timing cold start --"
t0=$(now_ms)
$K delete pod -l app=compute --wait=true >/dev/null
wait_compute_query || fail "compute did not come back after pod delete"
t1=$(now_ms)
cold_ms=$(( t1 - t0 ))

# --- 6. data survived with no restore step ----------------------------------
echo "-- [6/6] asserting data survived --"
after=$(PSQL -tAc "SELECT count(*) FROM $TABLE;" | tr -d '[:space:]')
[[ "$after" == "3" ]] || fail "data did NOT survive: expected 3 rows, got '$after'"
echo "   rows after compute recreate: $after"

echo
printf 'PASS: storage plane healthy; data survived compute pod kill (3 rows); cold start %d.%03ds\n' \
  $(( cold_ms / 1000 )) $(( cold_ms % 1000 ))
