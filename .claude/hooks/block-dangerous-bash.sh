#!/usr/bin/env bash
# PreToolUse / Bash — block irreversible or destructive commands for the agent.
# Exit 2 blocks the tool call and feeds the message back to Claude. Exit 0 = allow.
# The human can still run any of these in their own terminal; this only gates Claude.
#
# THIS IS A SAFETY CONTROL. A false negative here is a security failure, not a bug:
# `security.md` calls force/mirror/--all push, direct push to main/master, history
# rewrite, `rm -rf` and `kubectl delete` "never acceptable" on the agent's behalf.
# It has been wrong subtly twice — #712 introduced a continuation bypass while fixing
# false positives, and #717's fix for THAT introduced a worse one (below). Both looked
# correct on inspection. Change nothing here without running
# `.claude/hooks/block-dangerous-bash.test.sh`.
set -uo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
[ -z "$cmd" ] && exit 0

deny() { echo "BLOCKED (block-dangerous-bash): $1" >&2; exit 2; }

# ── normalisation ────────────────────────────────────────────────────────────
#
# `joined` resolves BACKSLASH-NEWLINE continuations the way the shell does, WITHOUT
# flattening ordinary newlines (which would let a flag on an adjacent line read as a
# flag on the push — the #712 false positive).
#
# It is pure bash parameter expansion, deliberately. The previous implementation used
#   sed -e :a -e '/\\$/N; s/\\\n[[:space:]]*/ /; ta'
# and a command ENDING in a backslash made it emit NOTHING: BSD/macOS sed executes `N`
# at EOF and discards the pattern space, so `joined` became the empty string and every
# segment-based rule below silently passed. `git push --force origin main \` was
# ALLOWED. Worse, GNU sed *prints* on `N` at EOF, so the bypass existed on macOS and not
# on Linux CI — a test would have gone green while the hook was open where it ran.
# Parameter expansion has no such platform split.
#
# The continuation pattern is written LITERALLY as \\$nl — a DOUBLED backslash. In bash
# pattern context a single backslash ESCAPES the next character, so the obvious
# `bs='\'; ${cmd//${bs}${nl}/ }` matches a BARE newline and silently flattens every
# multi-line command into one line. That reintroduced the #712 false positive (a `-f`
# on an adjacent LINE reading as a flag on the push) while reading as if it did the
# opposite — caught only because a false-positive case in the probe suite went red.
cr=$'\r'
nl=$'\n'
cmd=${cmd//$cr/}                 # CRLF input must not change matching
joined=${cmd//\\$nl/ }           # a real continuation joins; a trailing \ at EOF stays
norm=${joined//$nl/ }          # whole-command view, for rules that are not positional

# split_segments <text> — one shell command per line, split on separators.
split_segments() { printf '%s' "$1" | tr ';|&\n' '\n\n\n\n'; }

# strip_prefix <segment> — drop leading VAR=val, `sudo`, `env`, `command`, `exec`,
# `time`, `nohup` so the COMMAND WORD can be identified. Without this, `sudo rm -rf`
# and `env FOO=1 git push --force` look like they are running `sudo` and `env`.
strip_prefix() {
  local s="$1" prev=""
  while [ "$s" != "$prev" ]; do
    prev="$s"
    s="${s#"${s%%[![:space:]]*}"}"                       # ltrim
    case "$s" in
      [A-Za-z_][A-Za-z0-9_]*=*) s="${s#* }" ;;           # VAR=val
      sudo\ *|env\ *|command\ *|exec\ *|time\ *|nohup\ *) s="${s#* }" ;;
    esac
  done
  printf '%s' "$s"
}

# cmd_word <segment> — the executable being run, basename-ed, with a leading backslash
# or path stripped. `/bin/rm`, `\rm` and `rm` must all read as `rm`; that they did not
# was a live bypass.
cmd_word() {
  local w
  w=$(strip_prefix "$1")
  w=${w%%[[:space:]]*}
  w=${w#\\}                                               # \rm  -> rm
  w=${w##*/}                                              # /bin/rm -> rm
  printf '%s' "$w"
}

# ── rm -rf ───────────────────────────────────────────────────────────────────
#
# Both a RECURSIVE flag and a FORCE flag must be present; either alone is ordinary
# work (`rm -f file`, `rm -r dir`) and blocking it teaches the reader to route around
# the guard. They need not share a token (`rm -r -f` is `rm -rf`), and `-R` is the
# POSIX/BSD synonym for `-r`.
#
# The old single-token patterns `-[A-Za-z]*r[A-Za-z]*f` also matched the STRING
# `--force` (f-o-r), so `rm --force onefile` — the long form of a case this guard
# explicitly allows — was blocked, while `rm -Rf` sailed through.
while IFS= read -r seg; do
  [ -z "$seg" ] && continue
  [ "$(cmd_word "$seg")" = "rm" ] || continue
  has_r=0; has_f=0
  printf '%s' "$seg" | grep -qE '(^|[[:space:]])(--recursive|--dir|-[A-Za-z]*[Rr][A-Za-z]*)([[:space:]]|=|$)' && has_r=1
  printf '%s' "$seg" | grep -qE '(^|[[:space:]])(--force|-[A-Za-z]*f[A-Za-z]*)([[:space:]]|=|$)' && has_f=1
  # `--force` also matches the short-flag alternative above (f-o-r-c-e contains r and
  # f), so recursion is only credited when a SHORT flag carries r, or --recursive/--dir
  # is present explicitly.
  printf '%s' "$seg" | grep -qE '(^|[[:space:]])--force([[:space:]]|=|$)' &&
    ! printf '%s' "$seg" | grep -qE '(^|[[:space:]])(--recursive|--dir|-[A-Za-z]*[Rr])' && has_r=0
  if [ "$has_r" = 1 ] && [ "$has_f" = 1 ]; then
    deny "destructive 'rm -rf'. Remove specific paths deliberately, or run it yourself."
  fi
done <<EOF
$(split_segments "$joined")
EOF

# ── git push ─────────────────────────────────────────────────────────────────
#
# Feature-branch pushes are ALLOWED so agents can open PRs autonomously (security.md
# grants this explicitly). Still forbidden: force/mirror/--all, and any push that
# targets main/master.
#
# The rules apply ONLY to a segment whose command really is `git … push`. Matching
# `git` and `push` anywhere in the text blocked `git commit -m 'do not push --force to
# main'` — and workflow.md records that a hook firing on MESSAGE TEXT is exactly what
# led to a docs file being pushed straight to main, because the human re-ran only the
# tail of a blocked command.
while IFS= read -r seg; do
  [ -z "$seg" ] && continue
  [ "$(cmd_word "$seg")" = "git" ] || continue
  # the git SUBCOMMAND: first non-flag word after `git` (skips -C dir, -c k=v, …)
  sub=$(printf '%s' "$(strip_prefix "$seg")" | awk '
    { for (i = 2; i <= NF; i++) {
        if ($i ~ /^-/) { if ($i == "-C" || $i == "-c" || $i == "--git-dir" || $i == "--work-tree") i++; continue }
        print $i; exit } }')
  [ "$sub" = "push" ] || continue

  if printf '%s' "$seg" | grep -qE -- '(^|[[:space:]])(--force|--force-with-lease|--mirror|--all)([[:space:]]|=|$)|(^|[[:space:]])-[A-Za-z]*f[A-Za-z]*([[:space:]]|$)|(^|[[:space:]])\+[A-Za-z0-9._/-]'; then
    deny "force/mirror/--all push is forbidden. Push a single feature branch and open a PR."
  fi
  # Quotes count as delimiters: `git push origin "main"` reaches main exactly as the
  # unquoted form does, and quoting a branch name is ordinary rather than obfuscation.
  if printf '%s' "$seg" | grep -qE -- '(^|[[:space:]:/+"'"'"'])(main|master)([[:space:]"'"'"']|$)'; then
    deny "direct push to main/master is forbidden — push a feature branch and open a PR instead."
  fi
done <<EOF
$(split_segments "$joined")
EOF

# ── history rewrite / hard reset ─────────────────────────────────────────────
if printf '%s' "$norm" | grep -qE '\bgit\b[^|;&]*\b(filter-branch|filter-repo)\b|\bgit\b[^|;&]*reset[[:space:]]+--hard'; then
  deny "history rewrite / hard reset is human-gated."
fi
# ── kubectl delete — the operator owns cluster state (ADR-0001) ───────────────
if printf '%s' "$norm" | grep -qE '\bkubectl\b[^|;&]*\bdelete\b'; then
  deny "'kubectl delete' is human-gated — the operator is the single source of truth (ADR-0001). Express deletes via the CR, or run it yourself."
fi
# ── cluster / infra teardown ─────────────────────────────────────────────────
if printf '%s' "$norm" | grep -qE '\boci ce cluster delete\b|\boci ce node-pool delete\b|\bterraform destroy\b|\bkind delete cluster\b'; then
  deny "cluster/infra teardown is human-gated. Run it yourself if intended."
fi
exit 0
