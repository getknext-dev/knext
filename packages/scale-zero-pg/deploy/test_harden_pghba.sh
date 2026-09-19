#!/usr/bin/env bash
# test_harden_pghba.sh — off-cluster unit test for the pg_hba rewrite performed by
# harden_pg_hba() in compute-files/lib-harden.sh (F5 phase 4 mTLS enforcement, on
# top of the #112 cloud_admin reject and the #117 SCRAM catch-all).
#
# It does NOT re-implement the transform: it EXTRACTS the awk program AND the two
# catch-all strings out of the shipped lib-harden.sh (and, separately, out of the
# inline copy embedded in 54-compute-files.yaml — the copy that actually runs on the
# compute) and feeds a representative compute_ctl initdb pg_hba.conf through it. So
# editing the awk or either catch-all in either file changes this test's result —
# that is what makes it mutation-provable.
#
# WHY `clientcert=verify-ca` AND NOT `verify-full` (pinned here so it is not "upgraded"
# back — verify-full LOOKS stronger and is a total outage on this topology):
#   `clientcert=verify-full` does not merely verify the client certificate chain — it
#   ADDITIONALLY requires the certificate's Common Name to EQUAL the connecting database
#   username (or to map to it through a `map=` usermap + pg_ident.conf, neither of which
#   this deployment has). The gateway presents ONE SHARED client leaf whose CN is a
#   service name (see the gateway client leaf in deploy/11-mtls-certs.yaml) while it
#   connects
#   as the app role `app_<app>` — it replays the app's startup packet. Under verify-full
#   EVERY gateway→compute connection would therefore be refused for a common-name
#   mismatch the moment the backgrounded harden reloads pg_hba on a wake: a total,
#   wake-triggered per-app data-plane outage.
#   `clientcert=verify-ca` is exactly the intended semantics: the client certificate must
#   be issued by the shared CA (that is the mTLS identity we want), and SCRAM-SHA-256
#   still authenticates the USER. Chain identity from the certificate, user identity from
#   SCRAM. Moving to verify-full would require per-role client certificates (CN ==
#   app_<app>) or a pg_ident usermap — neither exists; do not make this a one-token edit.
#
# ENFORCED mode (the compute is serving TLS, `SHOW ssl` = on) must produce:
#   (1) a NETWORK catch-all of `hostssl all all all scram-sha-256
#       clientcert=verify-ca` — TLS required AND a CA-verified client certificate,
#       with the auth-option AFTER the method field (pg_hba's field order);
#   (2) the cloud_admin reject still BROAD `host` (never hostssl) so cloud_admin is
#       refused over ANY transport, encrypted or not, inserted BEFORE the catch-all
#       (pg_hba is first-match);
#   (3) the loopback trust lines (127.0.0.1/32, ::1/128) and the `local` line
#       BYTE-UNCHANGED — first-match keeps the pod's own cloud_admin@localhost:55433
#       admin ops working after enforcement lands;
#   (4) no plaintext-permitting `host all all all <method>` catch-all surviving;
#   (5) idempotency — a second harden pass cannot duplicate the reject or downgrade
#       the enforced catch-all.
#
# PLAINTEXT-FALLBACK mode (no server cert/CA mounted, `SHOW ssl` = off) must produce
# the PRE-phase-4 result instead: a `host … scram-sha-256` catch-all and NO hostssl
# line anywhere. That is not a weakening, it is the only safe output: Postgres refuses
# a hostssl line when ssl is off, and ONE bad line makes the entire pg_hba fail to
# parse — the reload is discarded and the #112 reject / #117 SCRAM rules would be lost
# with it. The test pins that branch so nobody "simplifies" it away.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LIB="$HERE/compute-files/lib-harden.sh"
CM="$HERE/54-compute-files.yaml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
pass=0
ok() { pass=$((pass+1)); echo "ok - $*"; }

# --- extract the harden awk program out of a lib-harden.sh body ---------------
# From the `awk … '{` inside harden_pg_hba() up to the closing `}' "$HBA"`, keeping
# the awk source only (the shell quoting stripped).
extract_awk() {
  awk '
    /^[[:space:]]*harden_pg_hba\(\)/ { inf=1 }
    inf && !ina && /awk .*'"'"'\{/ { ina=1; print "{"; next }
    ina {
      if ($0 ~ /^[[:space:]]*\}'"'"'/) { print "}"; exit }
      print
    }
  ' "$1"
}
# the two `_catchall='…'` assignments, selected by CONTENT (not position).
catchall_of() { # $1 file, $2 = enforced|fallback
  awk -F"'" -v want="$2" '
    /^[[:space:]]*_catchall=/ {
      v=$2
      if (want=="enforced" && v ~ /clientcert=verify-ca/) { print v; exit }
      if (want=="fallback" && v !~ /clientcert=verify-ca/) { print v; exit }
    }
  ' "$1"
}

PROG_LIB="$(extract_awk "$LIB")"
[ -n "$PROG_LIB" ] || fail "could not extract the harden awk program from $LIB (did harden_pg_hba's awk block move?)"

# the inline-54 copy is what actually runs on the compute; extract it the same way
# _validate.sh contract 34 does (strip the 4-space YAML block indent).
awk 'f && /^kind:/ {exit} f {sub(/^    /,""); print} /^  lib-harden\.sh: \|/ {f=1}' "$CM" > "$TMP/inline-lib-harden.sh"
[ -s "$TMP/inline-lib-harden.sh" ] || fail "could not extract the inline lib-harden.sh block from $CM"
PROG_CM="$(extract_awk "$TMP/inline-lib-harden.sh")"
[ "$PROG_LIB" = "$PROG_CM" ] \
  || fail "the harden awk in $CM differs from $LIB — the inline copy is what runs on the compute"

ENFORCED="$(catchall_of "$LIB" enforced)"
FALLBACK="$(catchall_of "$LIB" fallback)"
[ -n "$ENFORCED" ] || fail "$LIB has no _catchall carrying clientcert=verify-ca — the compute never enforces client-cert mTLS"
[ -n "$FALLBACK" ] || fail "$LIB has no plaintext-mode _catchall — a compute booted without certs would get a hostssl line, whose parse error discards the WHOLE pg_hba reload (#112 reject + #117 SCRAM lost with it)"
[ "$ENFORCED" = "$(catchall_of "$TMP/inline-lib-harden.sh" enforced)" ] \
  || fail "the enforced catch-all in $CM differs from $LIB — the inline copy is what runs on the compute"
ok "harden awk + both catch-alls extracted from lib-harden.sh and the inline 54 ConfigMap copy; identical"

# the ENFORCED catch-all must be the one selected when the compute IS serving TLS.
awk '/^[[:space:]]*if \[ "\$_ssl" = "on" \]/ {g=1; next}
     g && /^[[:space:]]*_catchall=/ {print; exit}' "$LIB" | grep -q 'clientcert=verify-ca' \
  || fail "the clientcert=verify-ca catch-all is not the branch taken when \$_ssl = on — enforcement must be gated on the compute ACTUALLY serving TLS, and must be what that gate selects"
ok "clientcert=verify-ca is the catch-all selected when the compute is serving TLS (\$_ssl = on)"

# --- the verify-ca-not-verify-full TAXONOMY, pinned (see the header) -----------
# Two halves, because either alone is decoration:
#   (i) no EXECUTABLE line in either copy may say verify-full — that option ties the
#       certificate CN to the connecting username, and the gateway's shared leaf CN is a
#       service name while it connects as app_<app>, so it would refuse every connection;
#  (ii) the WHY must be written down in the shipped lib (a comment naming verify-full and
#       the common-name/username tie), so the next maintainer reads the reason before
#       "upgrading" the token. A comment-only mention is allowed; code is not.
for f in "$LIB" "$TMP/inline-lib-harden.sh"; do
  grep -vE '^[[:space:]]*#' "$f" | grep -q 'verify-full' \
    && fail "$f: an executable line uses clientcert=verify-full — verify-full ALSO requires the client certificate's CN to equal the connecting username (no map=/pg_ident.conf here). The gateway holds ONE shared leaf (CN = a service name) and connects as app_<app>, so every gateway→compute connection would be refused on a common-name mismatch as soon as the harden reloads pg_hba: a wake-triggered per-app outage. Use verify-ca (CA-verified client identity) + scram-sha-256 (user identity)."
  grep -qE '^[[:space:]]*#.*verify-full' "$f" \
    || fail "$f: the WHY-not-verify-full rationale comment is gone — without it the next maintainer reads verify-ca as a weaker verify-full and 'upgrades' it back into a total data-plane outage"
  grep -qiE '^[[:space:]]*#.*(common name|CN)' "$f" \
    || fail "$f: the rationale comment must name the actual mechanism (verify-full ties the certificate's common name to the connecting username), not just the conclusion"
done
ok "verify-ca taxonomy pinned in both copies: no executable verify-full, and the CN-equals-username rationale is documented in the shipped lib"

# --- representative compute_ctl initdb pg_hba.conf ----------------------------
cat > "$TMP/pg_hba.conf" <<'HBA'
# TYPE  DATABASE        USER            ADDRESS                 METHOD
local   all             all                                     trust
host    all             all             127.0.0.1/32            trust
host    all             all             ::1/128                 trust
host    all             all             all                     md5
HBA

run_harden() { awk -v catchall="$2" "$PROG_LIB" "$1"; }

loopback_and_local_unchanged() { # $1 = hardened file
  for L in 'local   all             all                                     trust' \
           'host    all             all             127.0.0.1/32            trust' \
           'host    all             all             ::1/128                 trust'; do
    grep -qxF "$L" "$1" || fail "loopback/local line was modified by the harden: '$L' not found verbatim in:
$(cat "$1")"
  done
  awk '($4=="127.0.0.1/32" || $4=="::1/128") && $1!="host"' "$1" | grep -q . \
    && fail "a loopback line was rewritten away from 'host' — cloud_admin@localhost:55433 admin ops would break"
  return 0
}

cloud_admin_reject_is_broad() { # $1 = hardened file
  REJ="$(awk '$2=="all" && $3=="cloud_admin" && $5=="reject"' "$1")"
  [ -n "$REJ" ] || fail "the cloud_admin reject (issue #112) disappeared from the hardened pg_hba"
  printf '%s\n' "$REJ" | awk '$1=="host" {found=1} END{exit !found}' \
    || fail "the cloud_admin reject MUST stay broad 'host' (rejects over ANY transport, ssl or not), got: $REJ"
  printf '%s\n' "$REJ" | grep -q hostssl \
    && fail "the cloud_admin reject was narrowed to hostssl — a PLAINTEXT cloud_admin attempt would then fall past it: $REJ"
  REJ_N="$(awk '$3=="cloud_admin" && $5=="reject" {print NR; exit}' "$1")"
  CA_N="$(awk '($1=="host"||$1=="hostssl") && $2=="all" && $3=="all" && $4=="all" {print NR; exit}' "$1")"
  [ "$REJ_N" -lt "$CA_N" ] \
    || fail "the cloud_admin reject (line $REJ_N) must come BEFORE the catch-all (line $CA_N) — pg_hba is first-match"
  return 0
}

# ============================ ENFORCED mode (ssl=on) =========================
run_harden "$TMP/pg_hba.conf" "$ENFORCED" > "$TMP/out1" || fail "harden awk errored on the fixture"

# (1) the network catch-all REQUIRES TLS + a verified client certificate.
CATCHALL="$(awk '$1=="hostssl" && $2=="all" && $3=="all" && $4=="all"' "$TMP/out1")"
[ -n "$CATCHALL" ] \
  || fail "no hostssl network catch-all in the hardened pg_hba — TLS is not required:
$(cat "$TMP/out1")"
[ "$(printf '%s\n' "$CATCHALL" | grep -c .)" = "1" ] \
  || fail "expected exactly ONE hostssl catch-all, got:
$CATCHALL"
printf '%s\n' "$CATCHALL" | awk '$5=="scram-sha-256" && $6=="clientcert=verify-ca" {found=1} END{exit !found}' \
  || fail "the hostssl catch-all must be method scram-sha-256 with clientcert=verify-ca AFTER the method (pg_hba puts auth-options after the method field); got: $CATCHALL"
ok "enforced: catch-all is 'hostssl all all all scram-sha-256 clientcert=verify-ca' (TLS + CA-verified client cert required)"

# (2) the cloud_admin reject stays BROAD host, and precedes the catch-all.
cloud_admin_reject_is_broad "$TMP/out1"
ok "enforced: cloud_admin reject stays broad 'host' (any transport) and precedes the catch-all"

# (3) loopback trust + local lines byte-unchanged (the pod's own admin ops).
loopback_and_local_unchanged "$TMP/out1"
ok "enforced: loopback (127.0.0.1/32, ::1/128) trust lines and the local line are byte-unchanged"

# (4) no plaintext-permitting network catch-all survives.
awk '$1=="host" && $2=="all" && $3=="all" && $4=="all"' "$TMP/out1" | grep -q . \
  && fail "a plaintext 'host all all all' catch-all survived — TLS is not enforced:
$(cat "$TMP/out1")"
ok "enforced: no plaintext 'host all all all' catch-all remains"

# (5) idempotent: a second harden pass changes nothing.
run_harden "$TMP/out1" "$ENFORCED" > "$TMP/out2" || fail "harden awk errored on its own output"
diff -u "$TMP/out1" "$TMP/out2" >/dev/null \
  || fail "the harden is NOT idempotent — a second pass changed the file:
$(diff -u "$TMP/out1" "$TMP/out2")"
ok "enforced: harden is idempotent (a second pass neither duplicates the reject nor downgrades the catch-all)"

# ====================== PLAINTEXT-FALLBACK mode (ssl=off) ====================
run_harden "$TMP/pg_hba.conf" "$FALLBACK" > "$TMP/out3" || fail "harden awk errored in fallback mode"
grep -qi hostssl "$TMP/out3" \
  && fail "a compute that is NOT serving TLS got a hostssl line — Postgres rejects it ('hostssl record cannot match because SSL is disabled') and the whole pg_hba reload is discarded, taking the #112 reject and #117 SCRAM rules with it:
$(cat "$TMP/out3")"
awk '$1=="host" && $2=="all" && $3=="all" && $4=="all" && $5=="scram-sha-256"' "$TMP/out3" | grep -q . \
  || fail "fallback mode must still produce the pre-phase-4 'host all all all scram-sha-256' catch-all (#117):
$(cat "$TMP/out3")"
cloud_admin_reject_is_broad "$TMP/out3"
loopback_and_local_unchanged "$TMP/out3"
ok "fallback (compute not serving TLS): no hostssl line, #117 scram catch-all and #112 reject intact, loopback unchanged"

# fallback idempotency — the branch that CAN duplicate. In enforced mode the catch-all
# becomes `hostssl …`, so a second pass no longer matches $1=="host" and the reject
# insert cannot fire again. In fallback mode the catch-all STAYS `host all all all …`,
# so a second pass re-matches it and would append ANOTHER cloud_admin reject on every
# run — unbounded growth of pg_hba on a compute that hardens repeatedly. First-match
# makes the duplicates inert, but a rules file that grows every pass is a defect, and
# pg_hba_file_rules/drills read it. The insert must therefore be guarded on a reject
# already being present (it always precedes the catch-all, so one pass can see it).
run_harden "$TMP/out3" "$FALLBACK" > "$TMP/out4" || fail "harden awk errored on its own fallback output"
diff -u "$TMP/out3" "$TMP/out4" >/dev/null \
  || fail "the fallback-branch harden is NOT idempotent — a second pass changed the file:
$(diff -u "$TMP/out3" "$TMP/out4")"
N_REJ="$(awk '$3=="cloud_admin" && $5=="reject"' "$TMP/out4" | grep -c .)"
[ "$N_REJ" = "1" ] \
  || fail "expected EXACTLY ONE cloud_admin reject after two fallback passes, got $N_REJ:
$(cat "$TMP/out4")"
N_CA="$(awk '$1=="host" && $2=="all" && $3=="all" && $4=="all" && $5=="scram-sha-256"' "$TMP/out4" | grep -c .)"
[ "$N_CA" = "1" ] \
  || fail "expected EXACTLY ONE fallback catch-all after two passes, got $N_CA:
$(cat "$TMP/out4")"
cloud_admin_reject_is_broad "$TMP/out4"
# a THIRD pass too — a guard that merely caps the growth at two is not idempotency.
run_harden "$TMP/out4" "$FALLBACK" > "$TMP/out5" || fail "harden awk errored on the third fallback pass"
diff -u "$TMP/out4" "$TMP/out5" >/dev/null \
  || fail "the fallback harden changed the file on a THIRD pass:
$(diff -u "$TMP/out4" "$TMP/out5")"
ok "fallback: harden is idempotent across repeated passes (exactly one cloud_admin reject, one scram catch-all, ordering preserved)"

echo "test_harden_pghba.sh: $pass checks passed"
