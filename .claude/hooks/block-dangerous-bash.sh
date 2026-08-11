#!/usr/bin/env bash
# PreToolUse / Bash — block irreversible or destructive commands for the agent.
# Exit 2 blocks the tool call and feeds the message back to Claude. Exit 0 = allow.
# The human can still run any of these in their own terminal; this only gates Claude.
set -uo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
[ -z "$cmd" ] && exit 0

norm=$(printf '%s' "$cmd" | tr '\n' ' ')

# `joined` resolves BACKSLASH-NEWLINE continuations the way the shell itself does,
# WITHOUT flattening ordinary newlines. Everything that splits the command into
# segments must use this, never the raw `$cmd`.
#
# Why: segment-splitting on `\n` (added to stop a flag on an adjacent LINE reading as
# a flag on the push) also split a single command written across lines. So
#
#     git push \
#       --force origin main
#
# put `git push` in one segment and `--force origin main` in the next, and the force
# and main/master rules — which only look at the segment containing the push — saw
# neither. The shell joins those two lines into ONE command; the guard has to as well
# or it is reasoning about a command that was never run. Measured: this exact payload
# exited 0 (allowed) while the pre-segmentation version of this hook blocked it.
joined=$(printf '%s' "$cmd" | sed -e :a -e '/\\$/N; s/\\\n[[:space:]]*/ /; ta')

deny() { echo "BLOCKED (block-dangerous-bash): $1" >&2; exit 2; }

# rm -rf / rm -fr (any order of r and f flags)
#
# `rm` must be a COMMAND WORD — start of line, or after whitespace or a shell
# separator — and NOT preceded by a dash. `\brm\b` treated `--rm` as the rm
# command, because `-` is a word boundary, so every `docker run --rm --platform …`
# was blocked: `--rm` supplied the command and `--platform` satisfied the
# `-…f…r` alternative (p-l-a-t-F-o-R-m). Measured on
# `docker run --rm --platform linux/arm64 …`; podman and nerdctl take the same
# flag, and the workaround (reorder the flags) is undiscoverable from the message.
#
# Verified when changing this: `rm -rf /some/dir` and `…; rm -rf …` still block.
# A guard that cries wolf gets worked around, which is worse than one that is
# narrower and trusted.
#
# The flags do NOT have to share a token. `rm -r -f dir` is the same command as
# `rm -rf dir`, and the single-token patterns below missed it entirely (measured:
# exit 0). So the segment containing the `rm` is tested for a recursive flag and a
# force flag INDEPENDENTLY — both must be present, which keeps `rm -f file` and
# `rm -r dir` allowed exactly as before.
rm_seg=$(printf '%s' "$joined" | tr ';|&\n' '\n\n\n\n' \
  | grep -E '(^|[;&|(]|[[:space:]])rm[[:space:]]' | grep -vE '(^|[[:space:]])--?[A-Za-z-]*rm([[:space:]]|=|$)')
if [ -n "$rm_seg" ] \
  && printf '%s' "$rm_seg" | grep -qE '(^|[[:space:]])(-[A-Za-z]*r[A-Za-z]*|--recursive)([[:space:]]|$)' \
  && printf '%s' "$rm_seg" | grep -qE '(^|[[:space:]])(-[A-Za-z]*f[A-Za-z]*|--force)([[:space:]]|$)'; then
  deny "destructive 'rm -rf'. Remove specific paths deliberately, or run it yourself."
fi
if printf '%s' "$norm" | grep -qE '(^|[;&|(]|[[:space:]])rm[[:space:]][^|;&]*-[A-Za-z]*r[A-Za-z]*f|(^|[;&|(]|[[:space:]])rm[[:space:]][^|;&]*-[A-Za-z]*f[A-Za-z]*r'; then
  deny "destructive 'rm -rf'. Remove specific paths deliberately, or run it yourself."
fi
# git push: feature-branch pushes are ALLOWED so agents can open PRs autonomously.
# Still forbidden: force/mirror/--all (history rewrite / review bypass) and direct
# pushes to main/master (PRs only). See .claude/rules/security.md.
if printf '%s' "$norm" | grep -qE '\bgit\b[^|;&]*\bpush\b'; then
  # SCAN ONLY THE SEGMENT CONTAINING THE PUSH, not the whole command line.
  # Scanning the whole line meant any `-f` belonging to ANOTHER command in a
  # compound line read as a force push. Measured: `git push origin x | tail -1;
  # pgrep -f "…"` was blocked as a force push, and so is a plain
  # `git push origin x && grep -f pattern file`. `-f` is one of the most common
  # flags there is, so the rule fired on ordinary work and taught the reader to
  # regard the message as noise — which is how a real force push gets waved past.
  #
  # A force flag has to sit in the same segment as the push to affect it, so
  # narrowing loses no coverage. Verified when changing this: `git push --force
  # origin main` still blocks on both this rule and the main/master rule below.
  # Split the ORIGINAL command, not `norm`: `norm` has already flattened
  # newlines to spaces, so splitting it would merge a command on one line with
  # the command on the next — which is the same false positive one level out.
  # Caught by this rule firing on a PR body that contained `pgrep -f docker` and
  # `git push …` on consecutive lines.
  # Split `joined`, not `$cmd`: see the note on `joined` above — a backslash
  # continuation is ONE command, and splitting the raw text tore it in half.
  push_seg=$(printf '%s' "$joined" | tr ';|&\n' '\n\n\n\n' | grep -E '\bgit\b.*\bpush\b')
  # A leading `+` on a refspec IS a force push (`git push origin +main` rewrites the
  # remote branch exactly like `--force` does) and carried no flag for the rule above
  # to find.
  if printf '%s' "$push_seg" | grep -qE -- '--force|--force-with-lease|--mirror|--all|(^|[[:space:]])-[A-Za-z]*f[A-Za-z]*([[:space:]]|$)|(^|[[:space:]])\+[A-Za-z0-9._/-]'; then
    deny "force/mirror/--all push is forbidden. Push a single feature branch and open a PR."
  fi
  # `/` and `+` join the allowed prefixes so a fully-qualified or force refspec still
  # names the branch: `HEAD:refs/heads/main` and `+main` both reached the remote's
  # main branch while this rule, which only accepted a space or `:` before the name,
  # saw nothing.
  if printf '%s' "$push_seg" | grep -qE -- '(^|[[:space:]:/+])(main|master)([[:space:]]|$)'; then
    deny "direct push to main/master is forbidden — push a feature branch and open a PR instead."
  fi
  # otherwise: feature-branch push allowed (needed to open PRs).
fi
# history rewrite / hard reset
if printf '%s' "$norm" | grep -qE '\bgit\b[^|;&]*\b(filter-branch|filter-repo)\b|\bgit\b[^|;&]*reset[[:space:]]+--hard'; then
  deny "history rewrite / hard reset is human-gated."
fi
# kubectl delete against clusters — operator owns cluster state (ADR-0001)
if printf '%s' "$norm" | grep -qE '\bkubectl\b[^|;&]*\bdelete\b'; then
  deny "'kubectl delete' is human-gated — the operator is the single source of truth (ADR-0001). Express deletes via the CR, or run it yourself."
fi
# cluster / infra teardown
if printf '%s' "$norm" | grep -qE '\boci ce cluster delete\b|\boci ce node-pool delete\b|\bterraform destroy\b|\bkind delete cluster\b'; then
  deny "cluster/infra teardown is human-gated. Run it yourself if intended."
fi
exit 0
