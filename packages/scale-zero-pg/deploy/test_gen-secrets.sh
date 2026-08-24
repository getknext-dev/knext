#!/usr/bin/env bash
# test_gen-secrets.sh — unit test for the gateway host gen-secrets.sh bakes into the
# base DATABASE_URL[_RO] Secret (myapp-database), issue #798.
#
# Runs WITHOUT a cluster: a stub `kubectl` earlier on PATH records every argv and
# reports "nothing exists yet" (the fresh-cluster path), so the script mints its
# Secrets against the stub and we read the DSN it actually wrote. Textually grepping
# the script would prove only that a string exists somewhere; this proves the value
# that reaches the Secret.
#
# Why this matters: the base DSN was a hardcoded host, so on a cluster with a custom
# DNS zone / gateway Service, re-running gen-secrets.sh RECONCILED a working
# DATABASE_URL to an unresolvable one — the same silent-clobber class as #798's
# rotate-cred half, on the other writer.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
GEN="$HERE/gen-secrets.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
pass=0

STUBDIR="$(mktemp -d)"
LOG="$STUBDIR/argv.log"
trap 'rm -rf "$STUBDIR"' EXIT

cat >"$STUBDIR/kubectl" <<'STUB'
#!/usr/bin/env bash
# Records the full argv, then answers as an EMPTY cluster: every `get` misses (so
# every Secret takes its mint path), every other verb succeeds.
printf '%s\n' "$*" >>"$KUBECTL_STUB_LOG"
case "$3" in
  get) exit 1 ;;
esac
case "$1" in
  get) exit 1 ;;
esac
exit 0
STUB
chmod +x "$STUBDIR/kubectl"

# minted_base_host [env assignments...] — echo the host of the DATABASE_URL that
# gen-secrets.sh writes into the myapp-database Secret.
minted_base_host() {
  : >"$LOG"
  env KUBECTL_STUB_LOG="$LOG" PATH="$STUBDIR:$PATH" "$@" sh "$GEN" >/dev/null 2>&1
  grep -o -- '--from-literal=DATABASE_URL=postgres://[^ ]*' "$LOG" \
    | head -1 | sed -e 's|^.*@||' -e 's|:55432/.*$||'
}

# (a) no override -> the ROOTED default. The trailing dot is the whole point: at
#     ndots:5 with the live 5-entry search path, an unrooted name costs 5 wasted
#     name attempts on a fresh pod's first flows.
got="$(minted_base_host)"
[ "$got" = "pggw.scale-zero-pg.svc.cluster.local." ] \
  || fail "default base gateway host = '$got', want the rooted 'pggw.scale-zero-pg.svc.cluster.local.'"
echo "ok - gen-secrets.sh mints the rooted default base gateway host"
pass=$((pass + 1))

# (b) DBHOST is honoured VERBATIM — the #798 half on this writer.
custom="pggw.scale-zero-pg.svc.k8s-zone.test."
got="$(minted_base_host DBHOST="$custom")"
[ "$got" = "$custom" ] \
  || fail "DBHOST='$custom' was NOT honoured (minted '$got') — re-running gen-secrets.sh on a custom-zone cluster would reconcile a working DSN to an unresolvable one (#798)"
echo "ok - gen-secrets.sh honours DBHOST verbatim"
pass=$((pass + 1))

# (c) verbatim means VERBATIM: never auto-qualified or auto-rooted, matching the
#     operator's APPDB_GATEWAY_HOST contract. The fixture carries no `.svc` so it is
#     not itself a rooting violation.
got="$(minted_base_host DBHOST='base-gw.example.test')"
[ "$got" = "base-gw.example.test" ] \
  || fail "an unrooted DBHOST was rewritten to '$got' — overrides are passed through verbatim"
echo "ok - an unrooted DBHOST override is passed through verbatim"
pass=$((pass + 1))

# (d) EMPTY behaves as UNSET — the operator's env() semantic (`${VAR:-…}`, not
#     `${VAR-…}`); an empty env must never mint a host-less DSN.
got="$(minted_base_host DBHOST='')"
[ "$got" = "pggw.scale-zero-pg.svc.cluster.local." ] \
  || fail "DBHOST='' minted '$got' — an empty override must fall back to the rooted default"
echo "ok - an EMPTY DBHOST falls back to the rooted default (operator env() parity)"
pass=$((pass + 1))

# (e) the RO URL rides the SAME host — a half-fix that rooted/overrode only the
#     writer DSN would leave the reader pointing at the old host.
: >"$LOG"
env KUBECTL_STUB_LOG="$LOG" PATH="$STUBDIR:$PATH" DBHOST="$custom" sh "$GEN" >/dev/null 2>&1
ro="$(grep -o -- '--from-literal=DATABASE_URL_RO=postgres://[^ ]*' "$LOG" | head -1 | sed -e 's|^.*@||' -e 's|:55434/.*$||')"
[ "$ro" = "$custom" ] \
  || fail "DATABASE_URL_RO host = '$ro', want '$custom' — both keys must ride the same resolved host"
echo "ok - DATABASE_URL_RO rides the same resolved host as DATABASE_URL"
pass=$((pass + 1))

echo "gen-secrets.sh base-DSN host: $pass cases — PASSED"
