#!/usr/bin/env bash
# PreToolUse / Bash — block irreversible or destructive commands for the agent.
# Exit 2 blocks the tool call and feeds the message back to Claude. Exit 0 = allow.
# The human can still run any of these in their own terminal; this only gates Claude.
set -uo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
[ -z "$cmd" ] && exit 0

norm=$(printf '%s' "$cmd" | tr '\n' ' ')
deny() { echo "BLOCKED (block-dangerous-bash): $1" >&2; exit 2; }

# rm -rf / rm -fr (any order of r and f flags)
if printf '%s' "$norm" | grep -qE '\brm\b[^|;&]*-[A-Za-z]*r[A-Za-z]*f|\brm\b[^|;&]*-[A-Za-z]*f[A-Za-z]*r'; then
  deny "destructive 'rm -rf'. Remove specific paths deliberately, or run it yourself."
fi
# git push: feature-branch pushes are ALLOWED so agents can open PRs autonomously.
# Still forbidden: force/mirror/--all (history rewrite / review bypass) and direct
# pushes to main/master (PRs only). See .claude/rules/security.md.
if printf '%s' "$norm" | grep -qE '\bgit\b[^|;&]*\bpush\b'; then
  if printf '%s' "$norm" | grep -qE -- '--force|--force-with-lease|--mirror|--all|(^|[[:space:]])-[A-Za-z]*f[A-Za-z]*([[:space:]]|$)'; then
    deny "force/mirror/--all push is forbidden. Push a single feature branch and open a PR."
  fi
  if printf '%s' "$norm" | grep -qE -- '(^|[[:space:]:])(main|master)([[:space:]]|$)'; then
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
