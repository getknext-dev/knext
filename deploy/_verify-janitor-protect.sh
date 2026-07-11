#!/usr/bin/env bash
# _verify-janitor-protect.sh — OFFLINE (no cluster) behavioral contract test for
# issue #144: the wal-janitor's resolve-slot-floors pass must FAIL-SAFE when an
# AWAKE writer compute cannot be mapped to a (tenant,timeline) because its
# ConfigMap is unreadable (the #142 CM-deletion hazard class).
#
# BEFORE #144 the unmappable branch merely `continue`d — no floor AND no PROTECT
# marker — so the prune step pruned that compute's timeline against the rcl
# horizon (a narrow FAIL-OPEN: a live active slot's WAL could be crossed; today
# only backstopped by the KEEP_SEGMENTS=32=512MiB==max_slot_wal_keep_size numeric
# alignment). #144 makes it FAIL-CLOSED: resolve-slot-floors writes a GLOBAL
# protect marker (/state/protect/.unmapped-compute) — we cannot know WHICH
# timeline's active-slot WAL is at risk, so we cannot scope a per-timeline PROTECT
# — and the prune step, seeing that marker, SKIPS ALL PRUNING this pass and FAILS
# LOUD (exit 1 -> WalJanitorJobFailed) so an operator restores the compute config.
#
# This test extracts the ACTUAL shell fragments embedded in deploy/62-backup.yaml
# (delimited by #144 sentinel comments) and executes them against a throwaway
# state dir — no cluster, no drift from a hand-copied snippet. The LIVE proof runs
# on OKE via _verify-slot-janitor.sh PROOF 4.
#
# Usage: deploy/_verify-janitor-protect.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
YAML="$HERE/62-backup.yaml"
ok()  { printf '\033[32mPASS:\033[0m %s\n' "$*"; }
bad() { printf '\033[31mFAIL:\033[0m %s\n' "$*" >&2; FAILED=1; }
FAILED=0

[ -f "$YAML" ] || { echo "missing $YAML" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
STATE="$TMP/state"

# Extract the shell fragment between a pair of #144 sentinel comments, dedent-safe
# (leading whitespace is harmless to /bin/sh), and rewrite the hardcoded /state
# path to our throwaway dir so the fragment can run unprivileged.
extract() { # sentinel-tag  ->  fragment text on stdout
  local tag="$1"
  sed -n "/>>> #144 ${tag}/,/<<< #144 ${tag}/p" "$YAML" \
    | sed '1d;$d' \
    | sed "s#/state/#${STATE}/#g; s#/state\b#${STATE}#g"
}

# The resolve-slot-floors unmappable branch uses `continue`, so it must run inside
# a loop to be valid /bin/sh. This harness runs the extracted branch once with the
# caller-supplied TEN/TL/pod/cm and reports whether it wrote the global marker.
FRAG_BRANCH="$(extract unmap-branch)"
run_branch() { # TEN TL pod cm
  local T="$1" L="$2" P="$3" C="$4"
  ( export TEN="$T" TL="$L" pod="$P" cm="$C"
    for _ in x; do eval "$FRAG_BRANCH"; done ) 2>/dev/null
}
MARK="$STATE/protect/.unmapped-compute"

# ---------------------------------------------------------------------------
# CONTRACT 1 — resolve-slot-floors writes the GLOBAL marker when a compute is
#              unmappable (records which pod/cm so an operator can find it).
# ---------------------------------------------------------------------------
if [ -z "$FRAG_BRANCH" ]; then
  bad "CONTRACT 1: no '#144 unmap-branch' fragment in 62-backup.yaml (resolve-slot-floors unmappable branch must write a global protect marker, not silently skip)"
else
  rm -rf "$STATE"; mkdir -p "$STATE"
  run_branch "" "" "compute-appx-abc" "compute-config-appx"   # unmappable: TEN/TL blank
  if [ -f "$MARK" ] && grep -q "compute-appx-abc" "$MARK" && grep -q "compute-config-appx" "$MARK"; then
    ok "CONTRACT 1: unmappable compute -> global marker written recording pod+cm ($(tr -d '\n' < "$MARK"))"
  else
    bad "CONTRACT 1: unmappable branch did not write $MARK with the pod/cm identity"
  fi

  # CONTRACT 1b — a READABLE compute must NOT write the marker (the branch is scoped
  # to the unmappable case; a healthy compute leaves pruning enabled).
  rm -rf "$STATE"; mkdir -p "$STATE"
  run_branch "f0000000000000000000000000000001" "a0000000000000000000000000000002" "compute-ok-xyz" "compute-config-ok"
  if [ ! -f "$MARK" ]; then
    ok "CONTRACT 1b: readable compute -> NO marker written (branch scoped to the unmappable case)"
  else
    bad "CONTRACT 1b: readable compute wrongly wrote the global marker ($(tr -d '\n' < "$MARK"))"
  fi
fi

# ---------------------------------------------------------------------------
# CONTRACT 2 — the prune step, with the global marker present, SKIPS ALL pruning
#              and FAILS LOUD (exit 1). This is the fail-CLOSED guarantee.
# ---------------------------------------------------------------------------
FRAG_GUARD="$(extract unmapped-compute-guard)"
if [ -z "$FRAG_GUARD" ]; then
  bad "CONTRACT 2: no '#144 unmapped-compute-guard' fragment in 62-backup.yaml (prune must check the global marker before any mc listing)"
else
  # 2a: marker PRESENT -> must exit non-zero (fail loud) and emit a skip-all line.
  rm -rf "$STATE"; mkdir -p "$STATE/protect"
  printf 'compute-appx-abc (cm=compute-config-appx)\n' > "$STATE/protect/.unmapped-compute"
  set +e
  OUT2A="$( ( eval "$FRAG_GUARD" ) 2>&1 )"; RC2A=$?
  set -e
  if [ "$RC2A" -ne 0 ] && printf '%s' "$OUT2A" | grep -qi "SKIP"; then
    ok "CONTRACT 2a: marker present -> prune exits $RC2A (fail loud) and logs a SKIP-ALL line (fail-closed, prunes nothing)"
  else
    bad "CONTRACT 2a: marker present but prune guard rc=$RC2A / output did not skip-all+fail-loud: $OUT2A"
  fi

  # 2b: marker ABSENT -> guard must be a no-op (fall through, no exit) so a healthy
  #     plane prunes normally (no regression to the load-bearing prune).
  rm -rf "$STATE"; mkdir -p "$STATE/protect"
  set +e
  OUT2B="$( ( eval "$FRAG_GUARD"; echo "__fellthrough__" ) 2>&1 )"; RC2B=$?
  set -e
  if [ "$RC2B" -eq 0 ] && printf '%s' "$OUT2B" | grep -q "__fellthrough__"; then
    ok "CONTRACT 2b: no marker -> guard is a no-op, prune proceeds normally (no regression)"
  else
    bad "CONTRACT 2b: guard did not fall through cleanly when no marker present (rc=$RC2B): $OUT2B"
  fi
fi

# ---------------------------------------------------------------------------
# CONTRACT 3 — REGRESSION: the #143 guarantees must remain wired.
#   (a) the per-timeline PROTECT marker path (Postgres-unreadable) still exists;
#   (b) the ACTIVE-slot floor path still exists.
# Static wiring checks (these are load-bearing #143 lines the #144 change must not remove).
# ---------------------------------------------------------------------------
if grep -q 'protect/$TEN/$TL' "$YAML" && grep -q 'SLOT-PROTECT' "$YAML"; then
  ok "CONTRACT 3a: per-timeline PROTECT (Postgres-unreadable) path still wired (#143 not regressed)"
else
  bad "CONTRACT 3a: per-timeline PROTECT path missing — #143 active-slot protection regressed"
fi
if grep -q 'ACTIVE-slot floor' "$YAML" && grep -q 'SLOT-FLOOR' "$YAML"; then
  ok "CONTRACT 3b: ACTIVE-slot floor path still wired (#143 not regressed)"
else
  bad "CONTRACT 3b: ACTIVE-slot floor path missing — #143 floor logic regressed"
fi

# ---------------------------------------------------------------------------
# CONTRACT 4 — RECOVERY: the marker is PER-PASS (self-clearing), so a one-time
#   unmappable blip must NOT permanently block pruning. The /state volume is an
#   emptyDir (per-Job ephemeral), so each Job run starts with a fresh /state.
#   Pass 1 (unmappable) -> marker + prune fails. Pass 2 (fresh /state, CM readable
#   again) -> no marker -> prune guard falls through -> pruning RESUMES automatically.
# ---------------------------------------------------------------------------
if [ -n "$FRAG_BRANCH" ] && [ -n "$FRAG_GUARD" ]; then
  # Pass 1: unmappable -> marker present -> guard fails loud.
  rm -rf "$STATE"; mkdir -p "$STATE"
  run_branch "" "" "compute-appx-abc" "compute-config-appx"
  set +e; ( eval "$FRAG_GUARD" ) >/dev/null 2>&1; RCP1=$?; set -e
  # Pass 2: SIMULATE the next Job run — a FRESH emptyDir /state — with the CM readable.
  rm -rf "$STATE"; mkdir -p "$STATE"
  run_branch "f0000000000000000000000000000001" "a0000000000000000000000000000002" "compute-ok-xyz" "compute-config-ok"
  set +e; ( eval "$FRAG_GUARD"; echo "__pruned__" ) > "$TMP/p2.out" 2>/dev/null; RCP2=$?; set -e
  if [ "$RCP1" -ne 0 ] && [ ! -f "$MARK" ] && [ "$RCP2" -eq 0 ] && grep -q "__pruned__" "$TMP/p2.out"; then
    ok "CONTRACT 4: RECOVERY — unmappable pass fails+skips (rc=$RCP1); next pass (fresh /state, CM readable) has NO marker and prunes normally (rc=$RCP2). One blip never sticks."
  else
    bad "CONTRACT 4: recovery broken — pass1 rc=$RCP1, marker-after-pass2=$( [ -f "$MARK" ] && echo present || echo absent ), pass2 rc=$RCP2"
  fi
fi

# ---------------------------------------------------------------------------
# CONTRACT 5 — the marker's home (/state) MUST be an emptyDir (per-Job ephemeral),
#   or a one-time blip would persist across runs and block pruning forever.
# ---------------------------------------------------------------------------
if awk '/- name: state/{f=1} f&&/emptyDir/{print "yes"; exit}' "$YAML" | grep -q yes; then
  ok "CONTRACT 5: /state (the marker volume) is an emptyDir — per-Job ephemeral, marker self-clears each run"
else
  bad "CONTRACT 5: /state volume is NOT an emptyDir — a sticky marker could block pruning permanently"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  ok "ALL CONTRACTS GREEN — janitor fails SAFE (global PROTECT + skip-all + page) on an unmappable awake compute (#144)"
else
  bad "one or more #144 contracts FAILED"; exit 1
fi
