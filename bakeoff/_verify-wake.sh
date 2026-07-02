#!/usr/bin/env sh
# _verify-wake.sh — the bake-off's end-to-end gate (red until the infra is up).
#
# Asserts the review's core claim mechanically: hibernate the CNPG cluster, then
# a single cold connect THROUGH the exec-mode gateway (same gateway binary) must
# wake it and return the seeded row count. Exit 0 = green.
set -eu
NS=bakeoff-cnpg
POD=pgclient
EXPECT_ROWS=3

fail() { echo "FAIL: $*" >&2; exit 1; }

command -v kubectl >/dev/null 2>&1 || fail "kubectl not on PATH (try: export PATH=\$HOME/.orbstack/bin:\$PATH)"
kubectl -n "$NS" get deploy/pggw >/dev/null 2>&1 || fail "exec-mode gateway not deployed (kubectl apply -f bakeoff/gateway-exec-mode.yaml)"
kubectl -n "$NS" get cluster/pg >/dev/null 2>&1 || fail "CNPG cluster 'pg' not found (apply bakeoff/cnpg/*)"
kubectl -n "$NS" get pod/"$POD" >/dev/null 2>&1 || fail "client pod '$POD' not found"

echo "[verify] hibernating CNPG (force cold) ..."
kubectl -n "$NS" annotate --overwrite cluster/pg cnpg.io/hibernation=on >/dev/null
i=0; while [ "$i" -lt 30 ]; do
  [ "$(kubectl -n "$NS" get pods -l cnpg.io/cluster=pg --no-headers 2>/dev/null | grep -c .)" = "0" ] && break
  i=$((i+1)); sleep 1
done
[ "$(kubectl -n "$NS" get pods -l cnpg.io/cluster=pg --no-headers 2>/dev/null | grep -c .)" = "0" ] || fail "CNPG did not hibernate"

echo "[verify] cold connect through gateway (must wake + return $EXPECT_ROWS rows) ..."
rows="$(kubectl -n "$NS" exec "$POD" -- sh -c \
  "PGPASSWORD=app psql -h pggw.bakeoff-cnpg.svc -p 55432 -U app -d app -tAc 'SELECT count(*) FROM t' -v ON_ERROR_STOP=1" 2>/dev/null | tr -d '[:space:]')"

[ "$rows" = "$EXPECT_ROWS" ] || fail "expected $EXPECT_ROWS rows through gateway, got '$rows'"
echo "PASS: same gateway binary woke hibernated CNPG and served $rows rows"
