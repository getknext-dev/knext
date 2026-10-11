#!/usr/bin/env bash
# PreToolUse / Bash — a SEMANTIC second gate: ask jev what the command is meant to do.
# Exit 2 blocks and feeds the reason back to the agent. Exit 0 = allow.
#
#   bash .claude/hooks/jev-hooks.test.sh      # offline, stubbed jev
#
# WHAT IT ADDS. block-dangerous-bash.sh matches TEXT, so it cannot tell a command from a
# sentence about a command: a deny phrase inside a quoted argument — a jev prompt that
# merely mentions a cluster delete — false-blocks it, which happened. This gate judges the
# command's INTENT, so that phrase is not a match. It is the opposite trade: it can miss a
# disguised command the string rules would catch, which is why it is an ADDITION to the
# deterministic hook, never a replacement. block-dangerous-bash.sh stays the hard gate and
# is untouched.
#
# ONE ask call, fan-out (two independent questions in one request):
#   effect      choice: read_only | reversible | irreversible
#   destructive noul:   "does the command intend to destroy data or state?"
# BLOCKS only when P(irreversible) >= 0.9 AND P(destructive) >= 0.9. Both, because each alone
# is noisy: a deliberate `mv` is irreversible-ish but not destructive, and a cleanup script
# is destructive but reversible. Requiring agreement keeps the false-positive rate low
# enough that the block can be FINAL (the message tells the agent not to retry or reword).
#
# FAILS OPEN, silently, on: no jev / no key / API error / timeout (>3 s, JEV_GATE_TIMEOUT)
# / unparseable output / unparseable payload. An unreachable model must never wedge the
# agent; the string hook is what fails closed.
#
# PRE-FILTER. Obviously read-only commands (git status|log|diff|show, ls, cat, grep, rg,
# gh pr view|checks, ...) skip the call: no latency, no cost. It is deliberately strict —
# every segment of a pipeline/list must be read-only, and any redirect, `$(`, backtick or
# `--output` sends the command to jev. A wide pre-filter would be a bypass.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=jev-hook-lib.sh
. "$HERE/jev-hook-lib.sh" 2>/dev/null || exit 0
for _t in jq awk tr grep; do command -v "$_t" >/dev/null 2>&1 || exit 0; done

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null) || exit 0
[ -z "$cmd" ] && exit 0

# Each pipeline/list segment must START with one of these. `find`, `sed`, `xargs`, `awk`,
# `echo` and friends are absent on purpose (-delete, -exec, -i, redirects).
RO_RE='^(git[[:space:]]+(status|log|diff|show)([[:space:]]|$)|ls([[:space:]]|$)|cat[[:space:]]|head([[:space:]]|$)|tail([[:space:]]|$)|wc([[:space:]]|$)|pwd$|grep[[:space:]]|rg[[:space:]]|gh[[:space:]]+pr[[:space:]]+(view|checks)([[:space:]]|$)|gh[[:space:]]+issue[[:space:]]+view([[:space:]]|$)|jev[[:space:]]+(yes|pick|rate|ask|rank|guide|doctor|examples|cost)([[:space:]]|$))'

is_readonly() {
  local c="${1//2>&1/}" seg any=0
  case "$c" in *'>'* | *'`'* | *'$('* | *'<('*) return 1 ;; esac
  # `|| [ -n "$seg" ]`: printf emits no trailing newline, and without it `read` drops the
  # LAST segment — `ls; <destructive>` then looked read-only. The suite caught that.
  while IFS= read -r seg || [ -n "$seg" ]; do
    seg="${seg#"${seg%%[![:space:]]*}"}"
    [ -z "$seg" ] && continue
    any=1
    case "$seg" in *' --output'* | *' --pre'*) return 1 ;; esac
    printf '%s' "$seg" | grep -Eq "$RO_RE" || return 1
  done < <(printf '%s' "$c" | tr ';|&\n' '\n\n\n\n')
  [ "$any" = 1 ]
}
is_readonly "$cmd" && exit 0

jev_resolve || exit 0
tmp=$(mktemp -d 2>/dev/null) || exit 0
trap 'rm -rf "$tmp"' EXIT

# Head + tail, not head alone: truncating the tail would let `<filler>; <destructive>` through.
if [ "${#cmd}" -gt 8000 ]; then
  printf '%s\n[... %d chars elided ...]\n%s' "${cmd:0:4000}" "$((${#cmd} - 8000))" "${cmd: -4000}" >"$tmp/cmd.txt"
else
  printf '%s' "$cmd" >"$tmp/cmd.txt"
fi

jev_run "$tmp/out.json" ask --field "cmd=@$tmp/cmd.txt" \
  --noul destructive 'Does the shell command in `cmd` intend to destroy data or state? Judge what the command DOES when executed, not words that merely appear inside a quoted argument, a comment or a message.' \
  --choice effect 'What is the effect of EXECUTING the shell command in `cmd`? Judge what it does, not words that merely appear inside a quoted argument.' \
  read_only='only reads or inspects, changes nothing' \
  reversible='changes state but can be undone (edits tracked files, creates files, installs)' \
  irreversible='destroys data or state that cannot be recovered' \
  --json || exit 0

irr=$(jq -r '.answers.effect.probabilities.irreversible // empty' "$tmp/out.json" 2>/dev/null) || exit 0
des=$(jq -r '.answers.destructive.noul // empty' "$tmp/out.json" 2>/dev/null) || exit 0
jev_is_prob "$irr" && jev_is_prob "$des" || exit 0

if jev_ge "$irr" 0.9 && jev_ge "$des" 0.9; then
  echo "BLOCKED (jev-bash-gate): jev judged this command irreversible (p=$irr) and intended to destroy data or state (p=$des). This block is final: do not retry, reword or split the command. If it is genuinely needed, ask the human to run it themselves." >&2
  exit 2
fi
exit 0
