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
# Throwaway psql CLIENT pods use a small, ALWAYS-PULLABLE psql image (issue #171):
# the neon compute image is pre-pulled on only SOME nodes, so a client pod pinned
# to it with imagePullPolicy=Never intermittently hits ErrImageNeverPull (and its
# 150s pod-wait then expires). postgres:17-alpine ships a v17 psql, is public +
# ~80MB, and schedules on ANY node with a normal pull policy. Override via PSQL_IMG.
PSQL_IMG="${PSQL_IMG:-postgres:17-alpine}"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

# Retry a read-only kubectl call under transient API/TLS flakiness (issue #171): the
# OKE control plane intermittently returns "net/http: TLS handshake timeout", which
# a single-shot read would surface as a spurious drill FAIL. Only wraps idempotent
# reads/waits — never a reject probe (that stays exactly-once via CLIENT).
kretry() { n=0; while [ "$n" -lt 5 ]; do "$@" && return 0; n=$((n + 1)); sleep 3; done; return 1; }

# The STRONG base credential, straight from the Secret gen-secrets.sh owns.
STRONG_URL=$(kretry $K get secret myapp-database -o jsonpath='{.data.DATABASE_URL}' 2>/dev/null | base64 -d 2>/dev/null || true)
STRONG_RO_URL=$(kretry $K get secret myapp-database -o jsonpath='{.data.DATABASE_URL_RO}' 2>/dev/null | base64 -d 2>/dev/null || true)
[ -n "$STRONG_URL" ] || fail "myapp-database Secret has no DATABASE_URL — run deploy/gen-secrets.sh first (issue #168)"
case "$STRONG_URL" in
  *cloud_admin:cloud_admin@*) fail "myapp-database still ships the PUBLIC DEFAULT cloud_admin:cloud_admin — gen-secrets.sh must derive it from pg-base-admin (issue #168)" ;;
esac
ok "base DATABASE_URL is a STRONG cloud_admin credential (not the public default)"

# pg-base-admin must exist and NOT carry the public-default md5.
kretry $K get secret pg-base-admin >/dev/null 2>&1 || fail "Secret pg-base-admin missing — run deploy/gen-secrets.sh (issue #168)"
BA_MD5=$(kretry $K get secret pg-base-admin -o jsonpath='{.data.CLOUD_ADMIN_MD5}' | base64 -d)
[ "$BA_MD5" = "b093c0d3b281ba6da1eacc608620abd8" ] && fail "pg-base-admin carries the PUBLIC DEFAULT cloud_admin md5 (issue #168)"
ok "pg-base-admin carries a strong (non-default) cloud_admin md5"

# The PUBLIC DEFAULT DSN that must now be REJECTED over TCP, and its RO twin.
PUBLIC_URL="postgres://cloud_admin:cloud_admin@pggw:55432/postgres?sslmode=disable"
PUBLIC_RO_URL="postgres://cloud_admin:cloud_admin@pggw:55434/postgres?sslmode=disable"

# One-shot psql from a throwaway in-cluster pod (small always-pullable psql image,
# issue #171 — schedules on ANY node, so a stray ErrImageNeverPull can no longer
# masquerade as a wake failure or, worse, a silent-pass on the reject probes).
# Returns 0 (prints logs) on Succeeded, 1 (prints logs to stderr) otherwise.
CLIENT() { # $1 tag  $2 dsn  $3 sql
  P=pgbaseadmin-$$-$1
  # Create the throwaway pod, RETRYING the API call under transient TLS/API flakiness
  # (issue #171): a lost `kubectl run` (TLS handshake timeout) must not read as a
  # connection failure (false FAIL on the strong probe) or, worse, a silent pass on a
  # reject probe. Retry until the pod object actually exists.
  n=0
  while [ "$n" -lt 5 ]; do
    $K run "$P" --image="$PSQL_IMG" --image-pull-policy=IfNotPresent \
      --restart=Never --quiet --command -- psql "$2" -tA -c "$3" >/dev/null 2>&1 || true
    $K get pod "$P" >/dev/null 2>&1 && break
    n=$((n + 1)); sleep 3
  done
  # Single-shot wait (a reject pod ends Failed, so retrying the wait would burn the
  # full timeout each round); then resolve the TERMINAL phase, tolerating TLS blips on
  # the get so an API flake is not misread as the wrong verdict (issue #171).
  $K wait --for=jsonpath='{.status.phase}'=Succeeded pod/$P --timeout=150s >/dev/null 2>&1 || true
  PHASE=""; m=0
  while [ "$m" -lt 10 ]; do
    PHASE=$($K get pod "$P" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    case "$PHASE" in Succeeded | Failed) break ;; esac
    m=$((m + 1)); sleep 3
  done
  OUT=$(kretry $K logs "$P" 2>&1 || true)
  $K delete pod "$P" --ignore-not-found --wait=false >/dev/null 2>&1
  [ "$PHASE" = "Succeeded" ] || { echo "$OUT" >&2; return 1; }
  echo "$OUT"
}

kretry $K rollout status deploy/pggw --timeout=120s >/dev/null || fail "base gateway pggw not ready"
ok "base gateway pggw ready"

# 1. STRONG credential works: wakes the base writer + returns a row.
[ "$(CLIENT strong "$STRONG_URL" 'select 1' | tail -1)" = "1" ] \
  || fail "strong DATABASE_URL did not connect through pggw (base writer regression, issue #168)"
ok "strong DATABASE_URL connects through pggw and the base writer serves (no regression)"

# 2. PUBLIC DEFAULT is REJECTED over TCP on the base writer. Step 1's strong probe
#    blocks until the writer returns a row, so the compute is provably Ready here
#    (pre-warm before the reject probe, issue #171): this is a pure auth check, not a
#    wake race — a success here would mean cloud_admin:cloud_admin is still a
#    skeleton key (#112/#168).
if CLIENT publicreject "$PUBLIC_URL" 'select 1' >/dev/null 2>&1; then
  fail "PUBLIC DEFAULT cloud_admin:cloud_admin was ACCEPTED over TCP on the base writer — #168 NOT closed"
fi
ok "PUBLIC DEFAULT cloud_admin:cloud_admin REJECTED over TCP on the base writer (issue #168 / #112)"

# 3. Read pool (compute-ro / DATABASE_URL_RO), when a strong RO URL is present.
#    The writer tier (steps 1-2) is done before compute-ro is woken here, so the two
#    base computes are never warmed at once — the base plane has room for one compute
#    tier at a time ("Insufficient cpu" otherwise), so pre-warm is SEQUENTIAL (#171).
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
