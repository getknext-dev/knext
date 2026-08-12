#!/usr/bin/env bash
# PreToolUse / Bash — block irreversible or destructive commands for the agent.
# Exit 2 blocks the tool call and feeds the message back to Claude. Exit 0 = allow.
# The human can still run any of these in their own terminal; this only gates Claude.
#
# THIS IS A SAFETY CONTROL. A false negative here is a security failure, not a bug:
# `security.md` calls force/mirror/--all push, direct push to main/master, history
# rewrite, `rm -rf` and `kubectl delete` "never acceptable" on the agent's behalf.
# It has been wrong subtly FOUR times — #712 introduced a continuation bypass while
# fixing false positives; #717's fix for THAT introduced a worse one; #725 round 1
# fixed nine and opened the `=` glob and wrapper-narrowing holes; #725 round 2 fixed
# those and still let command substitution through the `git commit` exemption.
# Every one of them looked correct on inspection. Change nothing here without running
# `.claude/hooks/block-dangerous-bash.test.sh` — which CI now runs, so a regression
# no longer waits on someone remembering to type it.
set -uo pipefail

deny() { echo "BLOCKED (block-dangerous-bash): $1" >&2; exit 2; }

input=$(cat)

# ── fail CLOSED, never open ──────────────────────────────────────────────────
#
# Everything below is text processing, so a missing tool does not degrade the
# check — it DELETES it. Measured on the previous revision by pruning PATH one
# tool at a time against `git push --force origin main`: no `jq` → exit 0 with no
# stderr at all; no `grep` → exit 0 with all eleven rules dead; no `tr` → exit 0
# with the segment rules dead. The hook announced nothing in any case.
#
# `security.md` already states the principle for the action-pin checker — "an
# unreachable API is a failure, never a pass: a checker that goes green when it
# cannot reach upstream is worse than none." Same rule, applied to this control's
# own dependencies. A contributor without `jq` was running a 100% decorative hook
# that reported success.
for _t in jq tr awk grep; do
  command -v "$_t" >/dev/null 2>&1 ||
    deny "hook dependency '$_t' is missing — refusing to vet this command. Install it, or run the command yourself."
done

# An unparseable payload is an ERROR, not consent. The matcher is `Bash` only
# (`.claude/settings.json`), so there is no legitimate invocation without
# `.tool_input.command`; treating a missing field as "nothing to check" turned an
# upstream schema change into a permanent, silent, undetectable bypass.
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""') ||
  deny "unparseable PreToolUse payload — refusing to vet this command."
[ -z "$cmd" ] &&
  deny "PreToolUse payload carried no .tool_input.command — refusing to vet this command."

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
# Parameter expansion has no such platform split. (Reproduced during review:
# `printf 'x\\\n' | sed -e :a -e '/\\$/N; …'` emits nothing on BSD sed.)
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

# split_segments <text> — one shell command per line, split on separators.
split_segments() { printf '%s' "$1" | tr ';|&\n' '\n\n\n\n'; }

# ── shared delimiter classes ─────────────────────────────────────────────────
#
# Quotes and a leading backslash are DELIMITERS, not obfuscation: `rm "-rf" x`,
# `git push origin 'main'` and `git push origin \main` all do exactly what their
# bare forms do. Round 2 fixed this for ONE rule each — quotes on the branch rule,
# backslash on the rm command word — and left the other side of both open
# (`git push origin \main` and `rm "-rf" x` were both ALLOWED). That asymmetry is
# this repo's most common defect class, so the classes are defined ONCE here and
# every rule below uses them; a future rule cannot get half of it.
#
# The trailing class carries the shell's own metacharacters as well as quotes: a
# branch name at the end of a substitution is followed by `)`, not by whitespace, so
# `git commit -m x < <(git push origin main)` reached `main)` and matched nothing.
# Found by adding the process-substitution case, not by reading the regex.
sq=\'
delim="[[:space:]\"$sq()<>]"
lead="(^|[;&|(){}!]|[[:space:]\"$sq\\])"

rm_cmd_re="${lead}(\\\\)?([^[:space:]]*/)?rm(${delim}|\$)"

# NOTE — a `strip_prefix`/`cmd_word` pair lived here and was REMOVED, not fixed.
#
# The idea was to identify each segment's real command word so the rules could apply
# only to genuine `rm` / `git push` invocations. It failed twice over:
#
#   * Its VAR=val glob `[A-Za-z_][A-Za-z0-9_]*=*` used `*` as a WILDCARD, so it matched
#     any segment containing an `=` anywhere and then ate the real command word. A path,
#     a comment, `-o x=y`, or `git -c a=b push --force origin main` all silently
#     disabled BOTH rules. One stray `=` opened the whole guard.
#   * Even correct, requiring the command word to BE `rm`/`git` narrowed the control:
#     `xargs rm -rf`, `find … -exec rm -rf`, `bash -c '…'`, `$( … )`, `( … )`,
#     `if …; then git push …; fi` all escaped, and the suite stayed green because every
#     case in it was a bare invocation.
#
# Both defects pointed the same way: for this control, cleverness about WHICH command is
# running is a liability. Match the text broadly and exclude specific proven-safe cases.

# git_subcommand <segment> — the first non-flag word after `git`, or empty.
git_subcommand() {
  printf '%s' "$1" | awk '
    { for (i = 1; i < NF; i++) if ($i == "git") {
        for (j = i + 1; j <= NF; j++) {
          if ($j ~ /^-/) { if ($j == "-C" || $j == "-c" || $j == "--git-dir" || $j == "--work-tree") j++; continue }
          print $j; exit } } }'
}

# is_literal_commit <segment> — the ONE exemption, and the reason it is safe.
#
# `git commit -m …` routinely quotes the very strings every rule below matches, and
# `workflow.md` records that a hook firing on MESSAGE TEXT is what put a docs file on
# `main`: the human re-ran only the tail of the blocked command. So the exemption has
# to exist.
#
# Its previous justification — "`git commit` cannot delete or push, so the exemption
# costs no coverage" — was MEASURED FALSE by both sign-off gates. A commit segment can
# run anything through command substitution, and all three of these were ALLOWED:
#     git commit -m "$(git push --force origin main)"
#     git commit -m "$(rm -rf ~/scratch)"
#     git commit -m "`git push --force origin main`"
# That is precisely the wrapper class the command-word helper was deleted for, handed
# back for one command word.
#
# The honest justification is narrower, and it is what this function enforces: a
# LITERAL commit message cannot execute anything. So the exemption applies only when
# the segment contains no command substitution and no process substitution. Parameter
# expansion (`${x}`) is deliberately still exempt — it substitutes text into the
# message, it does not execute it.
is_literal_commit() {
  case "$1" in
    *'$('* | *'`'* | *'<('* | *'>('*) return 1 ;;
  esac
  [ "$(git_subcommand "$1")" = "commit" ]
}

# ── the rules, one pass over the segments ────────────────────────────────────
#
# All five families run in ONE loop so the commit-message exemption reaches all of
# them. Previously the last three matched the whole flattened command with no
# exemption at all, so `git commit -m 'docs: why kubectl delete is gated'` was BLOCKED
# — the exact cry-wolf case the exemption exists to prevent, displaced rather than
# removed. Segments already contain no `;`, `|` or `&` (split_segments), so a
# segment-scoped match is no weaker than the old `[^|;&]*` whole-command form.
while IFS= read -r seg; do
  [ -z "$seg" ] && continue
  is_literal_commit "$seg" && continue

  # ── rm -rf ─────────────────────────────────────────────────────────────────
  #
  # Both a RECURSIVE flag and a FORCE flag must be present; either alone is ordinary
  # work (`rm -f file`, `rm -r dir`) and blocking it teaches the reader to route
  # around the guard. They need not share a token (`rm -r -f` is `rm -rf`), and `-R`
  # is the POSIX/BSD synonym for `-r`.
  #
  # The old single-token patterns `-[A-Za-z]*r[A-Za-z]*f` also matched the STRING
  # `--force` (f-o-r), so `rm --force onefile` — the long form of a case this guard
  # explicitly allows — was blocked, while `rm -Rf` sailed through.
  #
  # MATCH BROADLY, EXCLUDE NARROWLY. The command-word class excludes a preceding `-`,
  # which is what keeps `docker run --rm` out; it allows `\rm`, quoted and
  # path-qualified forms, which were live bypasses.
  if printf '%s' "$seg" | grep -qE "$rm_cmd_re"; then
    has_r=0; has_f=0
    printf '%s' "$seg" | grep -qE "${lead}(--recursive|--dir|-[A-Za-z]*[Rr][A-Za-z]*)(${delim}|=|\$)" && has_r=1
    printf '%s' "$seg" | grep -qE "${lead}(--force|-[A-Za-z]*f[A-Za-z]*)(${delim}|=|\$)" && has_f=1
    # `--force` also matches the short-flag alternative above (f-o-r-c-e contains r and
    # f), so recursion is only credited when a SHORT flag carries r, or --recursive/--dir
    # is present explicitly.
    printf '%s' "$seg" | grep -qE "${lead}--force(${delim}|=|\$)" &&
      ! printf '%s' "$seg" | grep -qE "${lead}(--recursive|--dir|-[A-Za-z]*[Rr])" && has_r=0
    if [ "$has_r" = 1 ] && [ "$has_f" = 1 ]; then
      deny "destructive 'rm -rf'. Remove specific paths deliberately, or run it yourself."
    fi
  fi

  # ── git push ───────────────────────────────────────────────────────────────
  #
  # Feature-branch pushes are ALLOWED so agents can open PRs autonomously
  # (security.md grants this explicitly). Still forbidden: force/mirror/--all, and
  # any push that targets main/master.
  if printf '%s' "$seg" | grep -qE '\bgit\b' && printf '%s' "$seg" | grep -qE '\bpush\b'; then
    if printf '%s' "$seg" | grep -qE -- "${lead}(--force|--force-with-lease|--mirror|--all)(${delim}|=|\$)|${lead}-[A-Za-z]*f[A-Za-z]*(${delim}|\$)|${lead}\\+[A-Za-z0-9._/-]"; then
      deny "force/mirror/--all push is forbidden. Push a single feature branch and open a PR."
    fi
    # Quotes and a leading backslash count as delimiters: `git push origin "main"` and
    # `git push origin \main` reach main exactly as the bare form does.
    if printf '%s' "$seg" | grep -qE -- "(^|[[:space:]:/+\"$sq\\(<])(main|master)(${delim}|\$)"; then
      deny "direct push to main/master is forbidden — push a feature branch and open a PR instead."
    fi
  fi

  # ── history rewrite / hard reset ───────────────────────────────────────────
  if printf '%s' "$seg" | grep -qE '\bgit\b.*\b(filter-branch|filter-repo)\b|\bgit\b.*reset[[:space:]]+--hard'; then
    deny "history rewrite / hard reset is human-gated."
  fi
  # ── kubectl delete — the operator owns cluster state (ADR-0001) ────────────
  if printf '%s' "$seg" | grep -qE '\bkubectl\b.*\bdelete\b'; then
    deny "'kubectl delete' is human-gated — the operator is the single source of truth (ADR-0001). Express deletes via the CR, or run it yourself."
  fi
  # ── cluster / infra teardown ───────────────────────────────────────────────
  if printf '%s' "$seg" | grep -qE '\boci ce cluster delete\b|\boci ce node-pool delete\b|\bterraform destroy\b|\bkind delete cluster\b'; then
    deny "cluster/infra teardown is human-gated. Run it yourself if intended."
  fi
done <<EOF
$(split_segments "$joined")
EOF

exit 0
