#!/usr/bin/env bash
#
# provenance.sh — the read side of benchmark admissibility (S8 / #551).
#
# run.sh writes a `## PROVENANCE` block into every results file and an
# append-only row into `results/INDEX.tsv`. This script is what turns those into
# something a reviewer can act on:
#
#   extract <results-file>        the write-up block to paste into a Run section
#                                 (fails if the run never recorded its endpoint)
#   medians <results-file>        the http_req_duration medians — and ONLY those
#   audit   [<results-dir>]       durability audit: indexed runs whose file is
#                                 gone, and runs that started and never ended
#   verify-writeup <doc> [minrun] every Run section at/after <minrun> must carry
#                                 endpoint + digest + sitting
#
# Why each exists, in one line: the endpoint of a published run once had to be
# recovered from a DIFFERENT run's results file; `iteration_duration` runs ~10 ms
# longer than `http_req_duration` and quoting it inflates every figure; and Run
# 26 lost 25 of its 26 per-sample results files with nothing to say so.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# prov_get <file> <key> — value of a key inside the PROVENANCE block, "" if absent.
prov_get() {
  awk -v key="$2" '
    /^## PROVENANCE/ { inblock = 1; next }
    /^## END PROVENANCE/ { inblock = 0 }
    inblock {
      line = $0
      sub(/^[ \t]+/, "", line)
      eq = index(line, "=")
      if (eq > 0 && substr(line, 1, eq - 1) == key) { print substr(line, eq + 1); exit }
    }' "$1"
}

cmd_extract() {
  local f="${1:-}"
  [ -n "$f" ] && [ -f "$f" ] || { echo "extract: no such results file: ${f:-<missing arg>}" >&2; return 2; }
  if ! grep -q '^## PROVENANCE' "$f"; then
    echo "extract: '${f}' has NO provenance block — it predates the provenance harness or was not produced by run.sh." >&2
    echo "         Such a run cannot be written up: nothing in it records which application, at which endpoint, was measured." >&2
    return 1
  fi
  local endpoint digest sitting appid buildcmd runid svc peer same
  endpoint=$(prov_get "$f" endpoint)
  digest=$(prov_get "$f" app-image-digest)
  sitting=$(prov_get "$f" sitting)
  appid=$(prov_get "$f" app-id)
  buildcmd=$(prov_get "$f" build-command)
  runid=$(prov_get "$f" run-id)
  svc=$(prov_get "$f" service)
  peer=$(prov_get "$f" peer)
  same=$(prov_get "$f" arms-same-app)
  if [ -z "$endpoint" ]; then
    echo "extract: '${f}' records no endpoint — inadmissible, and the exact defect that made Run 25/26's endpoint unrecoverable." >&2
    return 1
  fi
  # Deliberately NOT silent about unresolved values: printing "unresolved: ..."
  # into the write-up is the point. A blank would read as "nothing to report".
  cat <<EOF
- endpoint: \`${endpoint}\`
- service: \`${svc}\` (peer arm: \`${peer:-none}\`)
- app-image-digest: \`${digest}\`
- app-id: \`${appid}\`
- build-command: \`${buildcmd}\`
- arms-same-app: ${same}
- sitting: \`${sitting}\`
- latency metric: \`http_req_duration\` (never \`iteration_duration\`, which runs ~10 ms longer)
- run-id: \`${runid}\`
- results file: \`${f}\`
EOF
}

cmd_medians() {
  local f="${1:-}"
  [ -n "$f" ] && [ -f "$f" ] || { echo "medians: no such results file: ${f:-<missing arg>}" >&2; return 2; }
  # Anchored on the METRIC NAME at the start of the field, so `iteration_duration`
  # can never be matched — not by accident and not by a widened pattern later.
  local lines
  lines=$(grep -E '^[[:space:]]*http_req_duration[^[:alnum:]_]' "$f")
  if [ -z "$lines" ]; then
    echo "medians: '${f}' contains no http_req_duration line." >&2
    echo "         There is therefore NO latency figure for this run. iteration_duration is not a substitute:" >&2
    echo "         it includes per-iteration overhead (~10 ms here) and quoting it inflates every number." >&2
    return 1
  fi
  printf '%s\n' "$lines" | sed -E 's/.*(med=[^ ]+).*/\1/' | sed 's/^med=/http_req_duration median: /'
}

cmd_audit() {
  local dir="${1:-${SCRIPT_DIR}/results}"
  local index="${dir}/INDEX.tsv"
  local problems=0
  if [ ! -f "$index" ]; then
    echo "audit: no index at ${index} — no run in this directory can be shown to have kept its file." >&2
    return 1
  fi

  # Pass 1: per run-id, did it finish, and does its file still exist?
  local ids id rows last_status file
  ids=$(awk -F'\t' 'NF >= 8 { print $2 }' "$index" | awk '!seen[$0]++')
  for id in $ids; do
    rows=$(awk -F'\t' -v id="$id" 'NF >= 8 && $2 == id' "$index")
    last_status=$(printf '%s\n' "$rows" | tail -n 1 | awk -F'\t' '{ print $8 }')
    file=$(printf '%s\n' "$rows" | tail -n 1 | awk -F'\t' '{ print $7 }')
    if [ "$last_status" = "STARTED" ]; then
      echo "PROBLEM ${id}: STARTED and never ended — the run was killed mid-flight; treat its file as partial."
      problems=$((problems + 1))
    fi
    if [ ! -f "$file" ]; then
      echo "PROBLEM ${id}: indexed results file is MISSING: ${file}"
      problems=$((problems + 1))
    elif ! grep -q '^## PROVENANCE' "$file"; then
      echo "PROBLEM ${id}: results file has no provenance block: ${file}"
      problems=$((problems + 1))
    fi
  done

  # Pass 2: files present but never indexed. Reported, not failed — the results
  # directory carries pre-provenance runs, and retro-failing them would only
  # teach people to delete history.
  local f base
  for f in "${dir}"/*.txt; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    grep -qF "$base" "$index" || echo "note: ${base} is not in the index (pre-provenance run, or written with --out outside this harness)"
  done

  if [ "$problems" -gt 0 ]; then
    echo "audit: ${problems} problem(s) — this results directory has lost or truncated runs." >&2
    return 1
  fi
  echo "audit: OK — every indexed run finished and kept its results file."
}

cmd_verify_writeup() {
  local doc="${1:-}" minrun="${2:-27}"
  [ -n "$doc" ] && [ -f "$doc" ] || { echo "verify-writeup: no such document: ${doc:-<missing arg>}" >&2; return 2; }
  awk -v minrun="$minrun" '
    function flush_section() {
      if (run != "" && run + 0 >= minrun + 0) {
        missing = ""
        if (!seen_endpoint) missing = missing " endpoint"
        if (!seen_digest)   missing = missing " app-image-digest"
        if (!seen_sitting)  missing = missing " sitting"
        if (missing != "") {
          printf "PROBLEM Run %s: the write-up omits:%s — paste the block from `provenance.sh extract <results-file>`.\n", run, missing
          problems++
        }
      }
    }
    /^## Run [0-9]+/ {
      flush_section()
      run = $3
      seen_endpoint = 0; seen_digest = 0; seen_sitting = 0
      next
    }
    /endpoint:/          { seen_endpoint = 1 }
    /app-image-digest:/  { seen_digest = 1 }
    /sitting:/           { seen_sitting = 1 }
    END {
      flush_section()
      if (problems > 0) {
        printf "verify-writeup: %d Run section(s) at or after Run %s lack their provenance.\n", problems, minrun
        exit 1
      }
      printf "verify-writeup: OK — every Run section from Run %s on carries endpoint, image digest and sitting.\n", minrun
    }' "$doc"
}

case "${1:-}" in
  extract)        shift; cmd_extract "$@" ;;
  medians)        shift; cmd_medians "$@" ;;
  audit)          shift; cmd_audit "$@" ;;
  verify-writeup) shift; cmd_verify_writeup "$@" ;;
  -h|--help|"")   usage ;;
  *) echo "unknown subcommand: $1" >&2; usage >&2; exit 2 ;;
esac
