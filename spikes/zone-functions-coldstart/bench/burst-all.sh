#!/usr/bin/env bash
# Run the transport robustness probe for every (gateway, fn) pair, twice.
# Usage: burst-all.sh <out.jsonl>   (env Z2_KUBECONFIG)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:?out.jsonl}"
for rep in 1 2; do
  for zone in zone-node zone-bun; do
    for fn in fn-go-h1 fn-go-h2 fn-rust-h1 fn-rust-h2; do
      bun "$HERE/burst.ts" "$zone" "$fn" 200 20 | tee -a "$OUT"
    done
  done
done
