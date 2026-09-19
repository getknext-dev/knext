#!/usr/bin/env bash
# seed-ledger.sh — CREATE-IF-ABSENT seed of the pageserver-generation ledger (#1095).
#
# The ledger's `generation` key is intentionally NOT declared in deploy/57 (a declared
# key is not `kubectl apply`-safe: apply reconciles it back to the manifest value —
# proven on kind, live 5 -> apply -> 1 — and a reset "1" is indistinguishable from a
# genesis "1", so the fail-closed attach readers would silently attach low). This script
# seeds it OUT OF BAND so `kubectl apply` never touches it, and it NEVER overwrites a
# live value: it writes generation=1 ONLY when the key is absent. It never LOWERS a
# value — advancing is pswatcher's job on failover. Idempotent; run it after every
# `kubectl apply -f deploy/` (the Makefile `deploy` target does this for you; GitOps
# users run it as a post-sync hook).
#
# Env: NS (default scale-zero-pg), KCTX (kube context; empty = current context).
#
# Testable seam: ledger_seed_action <current-value> echoes seed|keep|refuse; the main
# block below turns that into the kubectl write. test_seed-ledger.sh sources this file
# (PROVISION guard) and asserts create-if-absent + never-overwrite + refuse-non-numeric.
set -euo pipefail
NS="${NS:-scale-zero-pg}"
KCTX="${KCTX:-}"

kube() { if [ -n "$KCTX" ]; then kubectl --context "$KCTX" -n "$NS" "$@"; else kubectl -n "$NS" "$@"; fi; }

# ledger_seed_action <current> -> echoes the action for a given current ledger value:
#   ""            -> "seed"   (absent key: write the genesis 1)
#   all-digits    -> "keep"   (a live value: NEVER lower/overwrite it)
#   anything else -> "refuse" (non-numeric: do not guess; a human must fix it)
ledger_seed_action() {
  case "$1" in
    '')          echo seed ;;
    *[!0-9]*)    echo refuse ;;
    *)           echo keep ;;
  esac
}

seed_ledger() {
  local cur action
  # A missing ConfigMap (57 not applied yet) makes `get` fail; treat that as absent so
  # we surface a clear message rather than a silent seed against a non-existent CM.
  if ! kube get configmap pageserver-generation >/dev/null 2>&1; then
    echo "seed-ledger: ConfigMap pageserver-generation not found in ns $NS — apply deploy/57 first (kubectl apply -f deploy/)" >&2
    return 1
  fi
  cur="$(kube get configmap pageserver-generation -o jsonpath='{.data.generation}' 2>/dev/null || true)"
  action="$(ledger_seed_action "$cur")"
  case "$action" in
    seed)
      echo "seed-ledger: seeding pageserver-generation=1 (key was absent)"
      kube patch configmap pageserver-generation --type merge -p '{"data":{"generation":"1"}}' >/dev/null
      ;;
    keep)
      echo "seed-ledger: pageserver-generation already set (generation=$cur) — leaving it untouched (never lower a live value)"
      ;;
    refuse)
      echo "seed-ledger: pageserver-generation has a NON-NUMERIC value '$cur' — refusing to overwrite or guess; fix it manually" >&2
      return 1
      ;;
  esac
}

# Source guard: test_seed-ledger.sh sets SEED_LEDGER_SOURCED=1 to load the functions
# (ledger_seed_action / seed_ledger) without running the seed.
[ "${SEED_LEDGER_SOURCED:-0}" = 1 ] && return 0 2>/dev/null

seed_ledger
