#!/bin/sh
# Base-tier cloud_admin hardening drill (issue #168).
#
# PROVES, LIVE, that the BASE single-DB tiers (compute / compute-ro, fronted by
# pggw) no longer accept the PUBLIC DEFAULT cloud_admin:cloud_admin over TCP, and
# that the strong DATABASE_URL[_RO] credential (gen-secrets.sh -> pg-base-admin ->
# the myapp-database Secret) still wakes + serves them. The gap this closes: a base
# compute co-resident with the multi-tenant plane could be woken and dialed as
# cloud_admin:cloud_admin -> superuser on the base DB (the #112 vector on the base
# tier). See docs/operations.md "Base-tier cloud_admin".
#
# Preconditions: deploy/gen-secrets.sh has run (mints pg-base-admin + the strong
# myapp-database Secret) and deploy/20 + deploy/26 are applied (inject
# CLOUD_ADMIN_MD5 from pg-base-admin). Client runs in-cluster exactly like a knext
# app would (psql from the DATABASE_URL Secret).
set -eu
NS=scale-zero-pg
K="kubectl -n $NS"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

# The STRONG base credential, straight from the Secret gen-secrets.sh owns.
STRONG_URL=$($K get secret myapp-database -o jsonpath='{.data.DATABASE_URL}' 2>/dev/null | base64 -d 2>/dev/null || true)
STRONG_RO_URL=$($K get secret myapp-database -o jsonpath='{.data.DATABASE_URL_RO}' 2>/dev/null | base64 -d 2>/dev/null || true)
[ -n "$STRONG_URL" ] || fail "myapp-database Secret has no DATABASE_URL — run deploy/gen-secrets.sh first (issue #168)"
case "$STRONG_URL" in
  *cloud_admin:cloud_admin@*) fail "myapp-database still ships the PUBLIC DEFAULT cloud_admin:cloud_admin — gen-secrets.sh must derive it from pg-base-admin (issue #168)" ;;
esac
ok "base DATABASE_URL is a STRONG cloud_admin credential (not the public default)"

# pg-base-admin must exist and NOT carry the public-default md5.
$K get secret pg-base-admin >/dev/null 2>&1 || fail "Secret pg-base-admin missing — run deploy/gen-secrets.sh (issue #168)"
BA_MD5=$($K get secret pg-base-admin -o jsonpath='{.data.CLOUD_ADMIN_MD5}' | base64 -d)
[ "$BA_MD5" = "b093c0d3b281ba6da1eacc608620abd8" ] && fail "pg-base-admin carries the PUBLIC DEFAULT cloud_admin md5 (issue #168)"
ok "pg-base-admin carries a strong (non-default) cloud_admin md5"

# The PUBLIC DEFAULT DSN that must now be REJECTED over TCP, and its RO twin.
PUBLIC_URL="postgres://cloud_admin:cloud_admin@pggw:55432/postgres?sslmode=disable"
PUBLIC_RO_URL="postgres://cloud_admin:cloud_admin@pggw:55434/postgres?sslmode=disable"

# One-shot psql from a throwaway in-cluster pod (image already on the node).
# Returns 0 (prints logs) on Succeeded, 1 (prints logs to stderr) otherwise.
CLIENT() { # $1 tag  $2 dsn  $3 sql
  P=pgbaseadmin-$$-$1
  $K run "$P" --image=neondatabase/compute-node-v17:8464 --image-pull-policy=Never \
    --restart=Never --quiet --command -- psql "$2" -tA -c "$3" >/dev/null 2>&1 || true
  $K wait --for=jsonpath='{.status.phase}'=Succeeded pod/$P --timeout=150s >/dev/null 2>&1 || true
  OUT=$($K logs "$P" 2>&1 || true)
  PHASE=$($K get pod "$P" -o jsonpath='{.status.phase}' 2>/dev/null || true)
  $K delete pod "$P" --ignore-not-found --wait=false >/dev/null 2>&1
  [ "$PHASE" = "Succeeded" ] || { echo "$OUT" >&2; return 1; }
  echo "$OUT"
}

$K rollout status deploy/pggw --timeout=120s >/dev/null || fail "base gateway pggw not ready"
ok "base gateway pggw ready"

# 1. STRONG credential works: wakes the base writer + returns a row.
[ "$(CLIENT strong "$STRONG_URL" 'select 1' | tail -1)" = "1" ] \
  || fail "strong DATABASE_URL did not connect through pggw (base writer regression, issue #168)"
ok "strong DATABASE_URL connects through pggw and the base writer serves (no regression)"

# 2. PUBLIC DEFAULT is REJECTED over TCP on the base writer. The compute is warm
#    now (step 1 woke it), so this is a pure auth check, not a wake race: a success
#    here would mean cloud_admin:cloud_admin is still a skeleton key (#112/#168).
if CLIENT publicreject "$PUBLIC_URL" 'select 1' >/dev/null 2>&1; then
  fail "PUBLIC DEFAULT cloud_admin:cloud_admin was ACCEPTED over TCP on the base writer — #168 NOT closed"
fi
ok "PUBLIC DEFAULT cloud_admin:cloud_admin REJECTED over TCP on the base writer (issue #168 / #112)"

# 3. Read pool (compute-ro / DATABASE_URL_RO), when a strong RO URL is present.
if [ -n "$STRONG_RO_URL" ]; then
  [ "$(CLIENT strongro "$STRONG_RO_URL" 'select 1' | tail -1)" = "1" ] \
    || fail "strong DATABASE_URL_RO did not connect through pggw:55434 (base RO regression, issue #168)"
  ok "strong DATABASE_URL_RO connects through the RO port and compute-ro serves (no regression)"
  if CLIENT publicrejectro "$PUBLIC_RO_URL" 'select 1' >/dev/null 2>&1; then
    fail "PUBLIC DEFAULT accepted over TCP on the base RO pool — #168 NOT closed on compute-ro"
  fi
  ok "PUBLIC DEFAULT cloud_admin:cloud_admin REJECTED over TCP on the base RO pool (issue #168)"
else
  echo "note - no DATABASE_URL_RO in myapp-database; skipping the RO-pool assertion"
fi

echo "base-admin verification: strong cloud_admin serves DATABASE_URL[_RO]; the public default is rejected over TCP (issue #168)"
