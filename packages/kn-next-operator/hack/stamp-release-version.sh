#!/usr/bin/env bash
# hack/stamp-release-version.sh — write an operator release version into the
# bundle sources (#1947).
#
# A client needs to read the installed operator's version back from the
# cluster (`knext doctor`), and the bundle needs to say which version it is.
# Two places carry it, and BOTH are stamped here, only for an
# `operator-vX.Y.Z[-pre]` tag publish:
#
#   1. config/manager/kustomization.yaml — the image tag in the single
#      combined `newTag: vX.Y.Z@sha256:<digest>` value (the digest is kept; the
#      release workflow pins the real one afterwards, and the workflow also
#      `crane tag`s the pushed digest so the tag in the bundle is TRUE).
#   2. config/manager/manager.yaml — the `app.kubernetes.io/version` label on
#      the manager Deployment and its pod template, committed as the sentinel
#      `unreleased` so an edge / source build never claims a version.
#
# FAILS LOUD, changing nothing, if either anchor is missing or ambiguous: a
# silent no-op would publish a bundle that claims a version it does not carry
# (the same failure class the digest re-pin guards against).
#
# Usage: stamp-release-version.sh <X.Y.Z[-prerelease]> [package-root]
#   package-root defaults to the operator package this script lives in.
#
# Portable on purpose (BSD and GNU sed): no `sed -i`.

set -euo pipefail

VERSION="${1:?usage: stamp-release-version.sh <X.Y.Z[-prerelease]> [package-root]}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="${2:-$(cd "${SCRIPT_DIR}/.." && pwd)}"

SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
if [[ ! "${VERSION}" =~ ${SEMVER_RE} ]]; then
  echo "::error::'${VERSION}' is not valid semver (expected X.Y.Z[-prerelease])" >&2
  exit 1
fi

KUST="${PKG_ROOT}/config/manager/kustomization.yaml"
MGR="${PKG_ROOT}/config/manager/manager.yaml"

# ── Validate every anchor BEFORE writing anything ────────────────────────────
TAG_ANCHORS="$(grep -cE '^[[:space:]]*newTag: v[^@[:space:]]+@sha256:[0-9a-f]{64}[[:space:]]*$' "${KUST}" || true)"
if [[ "${TAG_ANCHORS}" != "1" ]]; then
  echo "::error::${KUST}: expected exactly one 'newTag: vX.Y.Z@sha256:<digest>' line, found ${TAG_ANCHORS} — refusing to stamp (newTag anchor)" >&2
  exit 1
fi
LABEL_ANCHORS="$(grep -cE '^[[:space:]]*app\.kubernetes\.io/version: "?unreleased"?[[:space:]]*$' "${MGR}" || true)"
if [[ "${LABEL_ANCHORS}" != "2" ]]; then
  echo "::error::${MGR}: expected exactly two 'app.kubernetes.io/version: unreleased' labels (Deployment + pod template), found ${LABEL_ANCHORS} — refusing to stamp (app.kubernetes.io/version anchor)" >&2
  exit 1
fi

# ── Write ────────────────────────────────────────────────────────────────────
TMP_K="$(mktemp)"
TMP_M="$(mktemp)"
trap 'rm -f "${TMP_K}" "${TMP_M}"' EXIT

sed -E "s|^([[:space:]]*newTag: )v[^@[:space:]]+(@sha256:[0-9a-f]{64})|\\1v${VERSION}\\2|" "${KUST}" > "${TMP_K}"
sed -E "s|^([[:space:]]*app\\.kubernetes\\.io/version: )\"?unreleased\"?|\\1\"${VERSION}\"|" "${MGR}" > "${TMP_M}"

grep -q "newTag: v${VERSION}@sha256:" "${TMP_K}" || { echo "::error::tag stamp did not take effect" >&2; exit 1; }
[[ "$(grep -c "app.kubernetes.io/version: \"${VERSION}\"" "${TMP_M}")" == "2" ]] || { echo "::error::label stamp did not take effect" >&2; exit 1; }

cat "${TMP_K}" > "${KUST}"
cat "${TMP_M}" > "${MGR}"
echo "Stamped operator version ${VERSION} into ${KUST} and ${MGR}"
