#!/bin/sh
set -eu
#
# scripts/generate-musl-native-lockfile.sh — adds a new committed,
# `npm ci`-compatible lockfile pin to scripts/musl-native-lockfiles/, the
# corpus scripts/e2e-native-rebuild-musl.sh consults for reproducible npm
# resolution under musl (#1257 round 7).
#
# REAL-NETWORK, CONTRIBUTOR-RUN, NOT CI-RUN. This talks to the real npm
# registry (`npm install --package-lock-only`) to resolve a name@version's
# full transitive dependency tree — CI never runs this; it only consumes
# the lockfiles this script commits. Referenced from
# scripts/e2e-native-rebuild-musl.sh's header comment (#1257 round 7,
# techdebt-3 fix — that comment cited this file before it existed).
#
# `--force` is required, not optional: this is typically run on a
# non-linux/non-musl contributor host (e.g. macOS), and npm's local-platform
# EBADPLATFORM check would otherwise refuse to resolve a linux-musl-only
# optional dependency (e.g. `@img/sharp-linuxmusl-x64`) at all. `--force`
# bypasses that HOST-platform check; it does not weaken the resulting
# lockfile's own integrity hashes, which is the property that actually
# makes `npm ci` reproducible downstream.
#
# Usage: scripts/generate-musl-native-lockfile.sh <name> <version> [--force]
#   <name>      an npm package name, e.g. @img/sharp-linuxmusl-x64
#   <version>   an exact version, e.g. 0.34.5 (no range — this pins ONE
#               resolved tree, not a moving target)
#   --force     overwrite an existing committed lockfile dir for this
#               name@version (without it, an existing dir is left alone —
#               regenerating a pin silently is exactly the kind of drift
#               this corpus exists to prevent).

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=scripts/lib/musl-lockfile-lookup.sh
. "${SCRIPT_DIR}/lib/musl-lockfile-lookup.sh"

usage() {
  echo "usage: $0 <name> <version> [--force]" >&2
  exit 2
}

NAME="${1:-}"
VERSION="${2:-}"
FORCE=0
if [ "${3:-}" = "--force" ]; then
  FORCE=1
fi

if [ -z "${NAME}" ] || [ -z "${VERSION}" ]; then
  usage
fi

KEY="$(lockfile_key "${NAME}")-${VERSION}"
TARGET_DIR="${SCRIPT_DIR}/musl-native-lockfiles/${KEY}"

if [ -d "${TARGET_DIR}" ] && [ "${FORCE}" -ne 1 ]; then
  echo "generate-musl-native-lockfile: ${TARGET_DIR} already exists — pass --force to regenerate it deliberately" >&2
  exit 1
fi

SCRATCH="$(mktemp -d)"
trap 'rm -rf "${SCRATCH}"' EXIT

cat >"${SCRATCH}/package.json" <<EOF
{
  "dependencies": {
    "${NAME}": "^${VERSION}"
  }
}
EOF

echo "generate-musl-native-lockfile: resolving ${NAME}@${VERSION} against the real npm registry (network required)..." >&2
(cd "${SCRATCH}" && npm install --package-lock-only --force)

mkdir -p "${TARGET_DIR}"
cp "${SCRATCH}/package.json" "${TARGET_DIR}/package.json"
cp "${SCRATCH}/package-lock.json" "${TARGET_DIR}/package-lock.json"

echo "generate-musl-native-lockfile: wrote ${TARGET_DIR}/{package.json,package-lock.json} — commit both, plus any .gitignore negation this directory already needs." >&2
