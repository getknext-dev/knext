#!/usr/bin/env bash
# PostToolUse / Edit|Write — format the edited file. Idempotent, exit 0, never loops/blocks.
# Biome for TS/JS/JSON; gofmt for Go. No-ops if the formatter isn't installed.
set -uo pipefail

input=$(cat)
path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")
[ -z "$path" ] && exit 0
[ -f "$path" ] || exit 0

case "$path" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.jsonc)
    if command -v biome >/dev/null 2>&1; then
      biome format --write "$path" >/dev/null 2>&1 || true
    elif command -v pnpm >/dev/null 2>&1; then
      pnpm exec biome format --write "$path" >/dev/null 2>&1 || true
    elif command -v npx >/dev/null 2>&1; then
      npx --no-install @biomejs/biome format --write "$path" >/dev/null 2>&1 || true
    fi
    ;;
  *.go)
    command -v gofmt >/dev/null 2>&1 && gofmt -w "$path" >/dev/null 2>&1 || true
    ;;
esac
exit 0
