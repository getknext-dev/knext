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

# VERSION must be an EXACT version, never a range. This pin exists so a
# generated lockfile resolves to exactly the version the corpus's directory
# name claims — a range (`^1.2.4`, `~1.2.4`, `1.2.x`, `*`, a dist-tag like
# `latest`) lets npm silently resolve a LATER, unreviewed release into a
# dir named after an earlier one (#1257 round-2 finding: `^1.2.4` resolved
# `1.3.3` live against the real registry). Reject anything that is not a
# bare dotted-numeric version (with an optional prerelease/build suffix)
# before ever touching the network.
case "${VERSION}" in
  *'^'* | *'~'* | *'*'* | *'<'* | *'>'* | *'='* | *' '*)
    echo "generate-musl-native-lockfile: '${VERSION}' is not an exact version — no ranges (^ ~ x * latest etc.) are accepted; pass a literal version like 1.2.4" >&2
    exit 2
    ;;
esac
# jev 0.94 follow-up finding: the previous `[0-9]*.[0-9]*.[0-9]* |
# [0-9]*.[0-9]* | [0-9]*` case-glob accepted a BARE or PARTIAL version too
# — "1" and "1.2" both matched their own alternative outright (neither is a
# real pinned MAJOR.MINOR.PATCH), and shell glob `*` is not anchored to
# non-dot characters, so even the strictest-looking alternative is looser
# than it reads (`[0-9]*.[0-9]*.[0-9]*` also happily matches "1.2.x+build"
# once `*` is allowed to swallow across segment boundaries). Require
# EXACTLY three dot-separated, ALL-DIGIT core segments instead — the only
# shape POSIX `case` can't fake past with a loose `*`.
#
# The core is everything before the first "-" (prerelease) OR "+" (build
# metadata) — semver's own suffix order is always
# <core>[-prerelease][+build] — so strip build first, then prerelease, to
# isolate just MAJOR.MINOR.PATCH. Stripping only "-" (as the previous x-range
# check below already did) missed a build-metadata suffix glued directly
# onto a wildcard segment: "1.2.x+build" has no "-", so its VERSION_CORE
# stayed "1.2.x+build" verbatim, and neither this check nor the old
# whole-segment ".x." check (looking for a literal ".x." substring, absent
# here since "x" is immediately followed by "+" not ".") ever caught it.
VERSION_CORE="${VERSION%%+*}"
VERSION_CORE="${VERSION_CORE%%-*}"
OLD_IFS="${IFS}"
IFS='.'
# shellcheck disable=SC2086 # intentional word-splitting on IFS='.'
set -- ${VERSION_CORE}
IFS="${OLD_IFS}"
if [ "$#" -ne 3 ]; then
  echo "generate-musl-native-lockfile: '${VERSION}' is not an exact version — need MAJOR.MINOR.PATCH (e.g. 1.2.4), not a bare or partial version like '1' or '1.2'" >&2
  exit 2
fi
for _seg in "$1" "$2" "$3"; do
  case "${_seg}" in
    '' | *[!0-9]*)
      echo "generate-musl-native-lockfile: '${VERSION}' is not an exact version — no ranges (^ ~ x * latest etc.) are accepted; pass a literal version like 1.2.4" >&2
      exit 2
      ;;
  esac
done

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
    "${NAME}": "${VERSION}"
  }
}
EOF

echo "generate-musl-native-lockfile: resolving ${NAME}@${VERSION} against the real npm registry (network required)..." >&2
(cd "${SCRATCH}" && npm install --package-lock-only --force)

# Defense in depth beyond the exact-spec pin above: verify the lockfile
# actually resolved to VERSION before writing anything into the committed
# corpus. An exact spec should always resolve to itself, but this catches
# any future npm/registry behavior change (e.g. deprecation redirects)
# rather than trusting the spec alone.
RESOLVED_VERSION="$(node -e '
const fs = require("fs");
const lock = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const pkg = lock.packages && lock.packages["node_modules/" + process.argv[2]];
if (!pkg || !pkg.version) { process.exit(1); }
process.stdout.write(pkg.version);
' "${SCRATCH}/package-lock.json" "${NAME}")" || {
  echo "generate-musl-native-lockfile: could not find a resolved version for ${NAME} in the generated lockfile — refusing to write anything" >&2
  exit 1
}

if [ "${RESOLVED_VERSION}" != "${VERSION}" ]; then
  echo "generate-musl-native-lockfile: resolved version '${RESOLVED_VERSION}' does not match requested '${VERSION}' — refusing to write a mismatched pin" >&2
  exit 1
fi

mkdir -p "${TARGET_DIR}"
cp "${SCRATCH}/package.json" "${TARGET_DIR}/package.json"
cp "${SCRATCH}/package-lock.json" "${TARGET_DIR}/package-lock.json"

echo "generate-musl-native-lockfile: wrote ${TARGET_DIR}/{package.json,package-lock.json} — commit both, plus any .gitignore negation this directory already needs." >&2
