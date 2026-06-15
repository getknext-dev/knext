#!/usr/bin/env bash
# PreToolUse / Edit|Write — enforce SCS data sovereignty (scs-zones rule).
# A zone must NEVER read another zone's database. Legitimate own-DB access uses DATABASE_URL from
# a K8s Secret — not a hardcoded host. So a hardcoded CloudNativePG '*-rw' (primary) or '*-ro'
# (replica) host in a Postgres connection inside app/library SOURCE is the cross-zone-DB-read
# anti-pattern. Block it and point to Kafka events. Exit 2 blocks; exit 0 allows.
# Infra manifests (.yaml/.yml) legitimately DEFINE these services, so they are skipped.
set -uo pipefail

input=$(cat)
path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")
content=$(printf '%s' "$input" | jq -r '.tool_input.new_string // .tool_input.content // ""' 2>/dev/null || echo "")
[ -z "$content" ] && exit 0

# Only enforce on application / library source — not infra YAML (CNPG Cluster/Pooler defs) or docs.
case "$path" in
  *.yaml|*.yml|*.md|*.txt) exit 0 ;;
esac

deny() {
  echo "BLOCKED (data-sovereignty / scs-zones): $1
A zone must not connect to a '*-rw'/'*-ro' database host — that is a cross-zone DB read (or a
hardcoded own-DB host). Reach your OWN database via DATABASE_URL (K8s Secret/env); get another
zone's data via async Kafka domain events and a local copy. See the scs-zones skill + rule." >&2
  exit 2
}

# Postgres DSN to a -rw/-ro host, e.g. postgres://user:pass@catalog-rw.ns.svc...:5432/db
if printf '%s' "$content" | grep -qE 'postgres(ql)?://[^"'"'"' ]*-(rw|ro)([.:/]|\b)'; then
  deny "hardcoded Postgres DSN targeting a '-rw'/'-ro' host."
fi
# host/connectionString assignment to a *-rw/*-ro service literal
if printf '%s' "$content" | grep -qiE '(host|hostname|connectionstring|database_url)["'"'"' ]*[:=][^"'"'"']*["'"'"'][a-z0-9.-]*-(rw|ro)([.:"'"'"']|\b)'; then
  deny "a connection host pointing at a '-rw'/'-ro' service."
fi
exit 0
