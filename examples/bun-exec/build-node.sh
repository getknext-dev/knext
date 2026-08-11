#!/usr/bin/env bash
# The CONTROL arm of the ADR-0042 Phase 1 A/B: the same application, built by
# Next with turbopack and served on node.
#
#   ./build-node.sh                 build .next/standalone
#   ./build-node.sh --print-labels  print OCI labels and exit WITHOUT building
#
# WHY THIS FILE EXISTS. Until now only the bun arm had a committed recipe. The
# node arm — the CONTROL, the thing every measured delta is measured against —
# was built ad hoc and lived nowhere in the tree. That is not a tidiness
# complaint: ADR-0036 condition A1 asks that "same application on both arms" be
# ASSERTED, not inspected, and an assertion cannot be reconstructed for an arm
# whose build exists only in someone's shell history. Run 25/26 is what that
# costs — `p1b-node` and `p1b-bunexec` served different applications and nothing
# noticed, which invalidated the comparison after the fact.
#
# THE ARMS SHARE `app/`, AND THAT IS THE POINT. Both recipes build the same
# application directory; they differ only in the build target. `app-id.sh`
# computes one identity over those shared sources, so the two images can be
# PROVEN to be the same app by label comparison — which is exactly what
# `run.sh --app-id-label dev.knext.app.id` checks before it will measure
# anything.
#
# Build provenance (S8 / #551), same contract as build.sh:
#
#   LABELS=(); while IFS= read -r l; do LABELS+=(--label "$l"); done \
#     < <(./build-node.sh --print-labels)
#   docker build "${LABELS[@]}" -f Dockerfile.node -t <ref> .
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PRINT_LABELS=0
[ "${1:-}" = "--print-labels" ] && PRINT_LABELS=1

# THE build command. Executed from this array and stamped from this array; there
# is no second copy to fall out of step with it — the same discipline build.sh
# uses, and the reason `dev.knext.build.command` can be trusted as provenance
# rather than as a comment.
NODE_BUILD_CMD=(npx next build --turbopack)

# `output: 'standalone'` (next.config.ts) is what makes this arm a self-contained
# server directory rather than a `next start` wrapper — the closest node analogue
# to what `--compile` gives the bun arm, so the comparison is between two
# shippable artifacts rather than between an artifact and a dev server.
STANDALONE_REL="examples/bun-exec"

print_labels() {
  local node_version next_version
  node_version=$(node --version 2>/dev/null || echo unknown)
  next_version=$(node -p "require('next/package.json').version" 2>/dev/null || echo unknown)
  printf 'dev.knext.build.command=%s\n' "${NODE_BUILD_CMD[*]}"
  printf 'dev.knext.build.target=%s\n' "node-turbopack"
  printf 'dev.knext.build.node-version=%s\n' "$node_version"
  printf 'dev.knext.build.next-version=%s\n' "$next_version"
  printf 'dev.knext.app.id=%s\n' "$("$SCRIPT_DIR/app-id.sh")"
}

if [ "$PRINT_LABELS" = "1" ]; then print_labels; exit 0; fi

command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }

echo "==> ${NODE_BUILD_CMD[*]}"
"${NODE_BUILD_CMD[@]}"

OUT=".next/standalone/${STANDALONE_REL}/server.js"
[ -f "$OUT" ] || {
  echo "expected standalone server at '$OUT' but it is not there." >&2
  echo "next's standalone output nests under the workspace-relative path; if that changed," >&2
  echo "fix STANDALONE_REL rather than the Dockerfile, so the recipe and the image agree." >&2
  exit 1
}

echo "==> done: $OUT"
ls -l "$OUT"
echo "==> image labels (pass to the image build so the digest carries its own provenance):"
print_labels | sed 's/^/    /'
