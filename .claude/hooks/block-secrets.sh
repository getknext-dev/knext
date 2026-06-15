#!/usr/bin/env bash
# PreToolUse / Edit|Write — block writing real secrets into files.
# High-confidence patterns only (to avoid false-blocking docs/config/placeholders).
# Secrets belong in Kubernetes Secrets / env — never in committed files, images, or URLs.
# Exit 2 blocks; exit 0 allows.
set -uo pipefail

input=$(cat)
content=$(printf '%s' "$input" | jq -r '.tool_input.new_string // .tool_input.content // ""' 2>/dev/null || echo "")
path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")
[ -z "$content" ] && exit 0

deny() { echo "BLOCKED (block-secrets): $1 in $path. Put it in a Kubernetes Secret / env var, not a file." >&2; exit 2; }

# Private key blocks
printf '%s' "$content" | grep -qE -- '-----BEGIN ([A-Z ]+ )?PRIVATE KEY-----' && deny "a private-key block"
# AWS access key id + secret
printf '%s' "$content" | grep -qE 'AKIA[0-9A-Z]{16}' && deny "an AWS access key id"
printf '%s' "$content" | grep -qiE 'aws_secret_access_key[[:space:]]*[:=][[:space:]]*[A-Za-z0-9/+]{40}' && deny "an AWS secret access key"
# GitHub / Slack / Google / Stripe tokens
printf '%s' "$content" | grep -qE 'gh[pousr]_[0-9A-Za-z]{30,}' && deny "a GitHub token"
printf '%s' "$content" | grep -qE 'xox[baprs]-[0-9A-Za-z-]{10,}' && deny "a Slack token"
printf '%s' "$content" | grep -qE 'AIza[0-9A-Za-z_\-]{35}' && deny "a Google API key"
printf '%s' "$content" | grep -qE 'sk_(live|test)_[0-9A-Za-z]{24,}' && deny "a Stripe secret key"
# OCI auth-token-shaped / generic high-entropy secret assigned to a secret-named key
# (require a long, mixed value to avoid hitting placeholders like "postgres"/"changeme")
if printf '%s' "$content" | grep -qiE '(secret|password|token|api[_-]?key|client[_-]?secret|private[_-]?key)[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"' ]{24,}["'"'"']'; then
  # skip obvious placeholders
  if ! printf '%s' "$content" | grep -qiE 'example|changeme|placeholder|your[-_]|xxxx|redacted|\$\{|process\.env|<[a-z_]+>'; then
    deny "a hardcoded credential literal"
  fi
fi
exit 0
