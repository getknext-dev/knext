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

# PRESENT IS NOT ENOUGH — the tool must actually do the thing. `\b` is a GNU extension,
# not POSIX ERE. Four rule families (git/push, the cluster-delete rule, history rewrite,
# teardown) are built on it, so a `grep` that ignores `\b` would kill them SILENTLY
# while sailing through the check above, because the binary exists. Measured working on
# GNU grep and on macOS BSD grep 2.6; busybox is the case this catches. Both directions
# are asserted, since a `\b` that matches everything is as broken as one that matches
# nothing.
printf 'a git b' | grep -qE '\bgit\b' 2>/dev/null &&
  ! printf 'agitb' | grep -qE '\bgit\b' 2>/dev/null ||
  deny "this 'grep -E' does not support \\b word boundaries — four rules would silently not match. Refusing to vet this command."

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
# The backtick belongs here for the same reason `(` does — it OPENS a command. Without
# it the rm rule died inside backtick substitution while its `$( )` twin blocked:
# `echo `rm -rf x`` was allowed, `echo $(rm -rf x)` was not. The file contradicted
# itself, since is_literal_commit already treated a backtick as substitution-significant.
# Exactly the both-halves asymmetry the shared classes exist to prevent, surviving
# because the `$( )` case was added and its twin was not.
lead="(^|[;&|(){}!\`]|[[:space:]\"$sq\\])"
# The branch rule additionally honours `:` `/` `+` `<` before the name. Defined HERE
# with the others rather than inline at the use site: round 3 claimed the classes were
# "defined once and shared" while that rule still hand-rolled its own, which is a false
# assurance about precisely the defect class the sharing was meant to remove.
blead="(^|[;&|(){}!<]|[[:space:]\"$sq\\:/+])"
ws="[[:space:]]+"          # multi-word rules separate on WHITESPACE, never a literal space

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
#
# It exists ONLY to recognise `git commit`, and it decides whether the one exemption
# applies — so an error here is a bypass, not a mis-parse. It had one: the arg-skip
# list covered `-C -c --git-dir --work-tree` and nothing else, so a global flag that
# takes a SEPARATE argument let its argument read as the subcommand:
#
#     git --namespace commit push --force origin main   -> ALLOWED
#     git --exec-path commit push --force origin main   -> ALLOWED
#
# `commit` there is the VALUE of `--namespace`; the real subcommand is `push`. The
# exemption fired on a genuine force push to main.
#
# So the flag tables are explicit and the function FAILS CLOSED: an unrecognised flag
# means the subcommand cannot be determined, and an undetermined subcommand must not
# earn the exemption. Adding a global flag to git upstream therefore costs a false
# positive on commit-message text — never a bypass. `--opt=value` is self-contained
# and consumes no following word.
git_subcommand() {
  printf '%s' "$1" | awk '
    BEGIN {
      split("-C -c --git-dir --work-tree --namespace --super-prefix --config-env --exec-path", a, " ")
      for (k in a) takes_arg[a[k]] = 1
      split("-p -P -v -h --paginate --no-pager --bare --no-replace-objects --literal-pathspecs --glob-pathspecs --noglob-pathspecs --icase-pathspecs --no-optional-locks --version --help", b, " ")
      for (k in b) no_arg[b[k]] = 1
    }
    { for (i = 1; i < NF; i++) if ($i == "git") {
        for (j = i + 1; j <= NF; j++) {
          if ($j ~ /^-/) {
            if ($j ~ /=/)          { continue }
            if (takes_arg[$j])     { j++; continue }
            if (no_arg[$j])        { continue }
            exit                    # unknown flag: undetermined, so no exemption
          }
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
# Round 5 added the two conditions below, each proven by a sign-off gate running the
# payload rather than reading the code:
#
#   * `${ cmd; }` and `${| cmd; }` are bash 5.3 VALUE SUBSTITUTION — they execute,
#     and they contain neither `$(` nor a backtick. This machine runs bash 5.3.
#   * The segment's first word must be `git`. `git_subcommand` scans for a `git` token
#     ANYWHERE, so everything to its left was invisible, and two literal words at the
#     END of a segment disabled all five rule families:
#         rm -rf /tmp/x # git commit          -> ALLOWED
#         kubectl delete pod foo # git commit -> ALLOWED
#     An environment-variable prefix reached it the same way, and that one EXECUTES:
#         GIT_EDITOR='<cmd>' git commit       -> ALLOWED, and git runs <cmd> via sh -c
#     confirmed in a scratch repo. So a `NAME=value` prefix does NOT earn the exemption,
#     even though it is ordinary shell — the safe direction, since the whole point is
#     that a LITERAL commit cannot execute anything.
#
# This is NOT the deleted `cmd_word` helper coming back, and the distinction is the
# whole lesson of rounds 1-2: that helper narrowed what gets CHECKED, which loses
# coverage silently. This narrows what gets EXEMPTED, which can only add blocks. Do not
# "simplify" it away in a later round.
#
# `has_subst` is computed on the WHOLE command, BEFORE splitting, and that ordering is
# load-bearing rather than incidental. split_segments cuts on `|`, which is part of the
# `${| cmd; }` marker itself — so a per-segment test never sees it, the first fragment
# (`git commit -m "${`) looks like a literal commit, and the quote-tracking below then
# swallowed the executed command as message text. Caught by the test, not by reading:
# adding the `${|` case to the per-segment check alone left the payload ALLOWED.
#
# Consequence, deliberately accepted: a command containing substitution ANYWHERE gets no
# exemption anywhere, so `git commit -m "$(date)"` is vetted on its message text. That is
# the safe direction — the contents of a substitution are not knowable here.
# Only the markers that CANNOT SURVIVE SPLITTING are tested whole-command. `${ ` and
# `${|` are the pair at issue: `|` is a separator, so `${| cmd; }` is torn apart and no
# per-segment test can see it. Everything else (`$(`, a backtick, `<(`, `>(`) stays
# intact inside its own segment and is tested there.
#
# Round 5 tested ALL of them whole-command, which was over-broad in a way that lands on
# plausible work: `V=$(cat v) && git commit -m 'docs: why <gated verb> is gated'` blocked
# on the substitution in a DIFFERENT command. Fail-safe, but cry-wolf is the mechanism
# workflow.md blames for the direct-push-to-main incident, so the granularity matters.
has_subst=0
case "$joined" in
  *'${ '* | *'${|'*) has_subst=1 ;;
esac

# The per-segment substitution `case` below was DELETED in round 6 and is BACK in round
# 7 — for a different reason, which is worth stating rather than letting it look like a
# revert. Round 6 deleted it as decoration, correctly: when `has_subst` tested every
# marker whole-command it strictly subsumed the per-segment copy, and mutation-proving
# showed the copy green. Round 7 narrowed `has_subst` to only the split-surviving
# markers to cut a false-positive cliff, which un-subsumes the rest — so the per-segment
# test is now the ONLY thing catching `$(`, a backtick, `<(` and `>(`, and it is
# mutation-proved red. Same lines, opposite status, because the code around them moved.
# `awk` is checked for PRESENCE above, but presence is not enough for the one tool that
# decides the EXEMPTION. A broken `grep` fails closed — rules stop matching, nothing is
# exempted. A broken `awk` fails OPEN: git_subcommand returns garbage, and if that
# garbage is "commit" the exemption fires on everything. So it is probed on known input,
# in both directions, exactly as `grep -E \b` is.
[ "$(git_subcommand 'git commit -m x')" = "commit" ] &&
  [ "$(git_subcommand 'git push origin x')" = "push" ] ||
  deny "awk is not resolving git subcommands correctly — the commit exemption cannot be trusted. Refusing to vet this command."

is_literal_commit() {
  [ "$has_subst" = 1 ] && return 1
  case "$1" in
    *'$('* | *'`'* | *'<('* | *'>('*) return 1 ;;
  esac
  local head=${1#"${1%%[![:space:]]*}"}     # drop leading whitespace
  head=${head#\(}; head=${head#\{}
  head=${head#"${head%%[![:space:]]*}"}
  case "$head" in
    git | git[[:space:]]*) ;;
    *) return 1 ;;
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
#
# TWO views of each segment. Quoting is a delimiter at token EDGES *and inside* a
# token — `ma"in"`, `-r"f"`, `p"us"h` and `ma\in` are the same words to the shell as
# their bare forms, and all of them were ALLOWED while the edge cases blocked. That is
# the round-3 argument ("quotes are delimiters, not obfuscation") applied to only half
# the places it holds. Every rule now runs against the raw segment AND a copy with
# quotes and backslashes removed, via one shared helper, so the two views cannot drift
# apart rule by rule.
#
# The EXEMPTION deliberately keeps using the raw segment only: stripping quotes from
# `git commit -m 'push --force to main'` would turn the message into bare words and
# block it, which is the false positive the exemption exists to prevent.
#
# `in_msg` carries an unterminated quote across segments. split_segments cuts on `;`,
# `|`, `&` and newline, which a commit MESSAGE routinely contains — this repo's own
# messages are multi-line and discuss these very verbs — so without this a message body
# line reads as a fresh command. The shell agrees with the tracking rather than the
# splitting: while a quote is open, following text is message content, not a command.
seg_matches() {   # <regex> — raw view OR stripped view
  printf '%s' "$seg" | grep -qE -- "$1" && return 0
  printf '%s' "$sseg" | grep -qE -- "$1"
}
# quote_state <text> <initial-state> -> none | sq | dq
#
# A left-to-right scanner, NOT a parity count. Round 5 counted occurrences of one quote
# character and ignored the other's context, which made the hook FAIL OPEN on ordinary
# typing — an apostrophe inside a double-quoted message opened the tracking and every
# following segment was skipped:
#
#     git commit -m "don't" && git push --force origin main   -> ALLOWED
#     git commit -m "it's fine" ; rm -rf /tmp/x               -> ALLOWED
#
# The shell does not agree: `"don't"` is closed, so those are real commands. It was
# data-dependent (two apostrophes -> even -> blocked), needed no obfuscation, and this
# repo's own commit messages contain apostrophes. It was the only fail-open path left in
# the hook, and it was introduced by the fix for multi-line messages.
#
# Rules the scanner encodes: inside single quotes NOTHING escapes and only `'` closes;
# elsewhere a backslash consumes the next character; `"` and `'` open their own state
# only when not already inside the other. The state is always determined, so there is no
# "undetermined" branch that could silently skip.
quote_state() {
  printf '%s' "$1" | awk -v st="${2:-none}" '
    {
      n = length($0)
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1)
        if (st == "sq") { if (c == "'"'"'") st = "none" }
        else if (st == "dq") {
          if (c == "\\") i++
          else if (c == "\"") st = "none"
        } else {
          if (c == "\\") i++
          else if (c == "'"'"'") st = "sq"
          else if (c == "\"") st = "dq"
        }
      }
    }
    END { print st }'
}

in_msg="none"
while IFS= read -r seg; do
  if [ "$in_msg" != "none" ]; then
    in_msg=$(quote_state "$seg" "$in_msg")
    continue
  fi
  [ -z "$seg" ] && continue
  if is_literal_commit "$seg"; then
    in_msg=$(quote_state "$seg" none)
    continue
  fi
  sseg=${seg//\"/}; sseg=${sseg//$sq/}; sseg=${sseg//\\/}

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
  if seg_matches "$rm_cmd_re"; then
    has_r=0; has_f=0
    seg_matches "${lead}(--recursive|--dir|-[A-Za-z]*[Rr][A-Za-z]*)(${delim}|=|\$)" && has_r=1
    seg_matches "${lead}(--force|-[A-Za-z]*f[A-Za-z]*)(${delim}|=|\$)" && has_f=1
    # `--force` also matches the short-flag alternative above (f-o-r-c-e contains r and
    # f), so recursion is only credited when a SHORT flag carries r, or --recursive/--dir
    # is present explicitly.
    seg_matches "${lead}--force(${delim}|=|\$)" &&
      ! seg_matches "${lead}(--recursive|--dir|-[A-Za-z]*[Rr])" && has_r=0
    if [ "$has_r" = 1 ] && [ "$has_f" = 1 ]; then
      deny "destructive 'rm -rf'. Remove specific paths deliberately, or run it yourself."
    fi
  fi

  # ── git push ───────────────────────────────────────────────────────────────
  #
  # Feature-branch pushes are ALLOWED so agents can open PRs autonomously
  # (security.md grants this explicitly). Still forbidden: force/mirror/--all, and
  # any push that targets main/master.
  if seg_matches '\bgit\b' && seg_matches '\bpush\b'; then
    if seg_matches "${lead}(--force|--force-with-lease|--mirror|--all)(${delim}|=|\$)|${lead}-[A-Za-z]*f[A-Za-z]*(${delim}|\$)|${lead}\\+[A-Za-z0-9._/-]"; then
      deny "force/mirror/--all push is forbidden. Push a single feature branch and open a PR."
    fi
    # Quotes and a leading backslash count as delimiters: `git push origin "main"` and
    # `git push origin \main` reach main exactly as the bare form does.
    if seg_matches "${blead}(main|master)(${delim}|\$)"; then
      deny "direct push to main/master is forbidden — push a feature branch and open a PR instead."
    fi
  fi

  # ── history rewrite / hard reset ───────────────────────────────────────────
  if seg_matches '\bgit\b.*\b(filter-branch|filter-repo)\b|\bgit\b.*reset[[:space:]]+--hard'; then
    deny "history rewrite / hard reset is human-gated."
  fi
  # ── kubectl delete — the operator owns cluster state (ADR-0001) ────────────
  if seg_matches '\bkubectl\b.*\bdelete\b'; then
    deny "'kubectl delete' is human-gated — the operator is the single source of truth (ADR-0001). Express deletes via the CR, or run it yourself."
  fi
  # ── cluster / infra teardown ───────────────────────────────────────────────
  # `${ws}` not a literal space: this rule hand-rolled its separator, so `terraform<TAB>
  # destroy`, `oci ce cluster<2 spaces>delete` and `kind  delete cluster` were all
  # ALLOWED while their single-space forms blocked. Finding 3 of the round-3 review was
  # "no rule may hand-roll a delimiter class"; it was applied to the branch rule and not
  # to this one — the same half-applied-fix shape, one rule later.
  if seg_matches "\\boci ce cluster${ws}delete\\b|\\boci ce node-pool${ws}delete\\b|\\bterraform${ws}destroy\\b|\\bkind${ws}delete${ws}cluster\\b"; then
    deny "cluster/infra teardown is human-gated. Run it yourself if intended."
  fi
done <<EOF
$(split_segments "$joined")
EOF

exit 0
