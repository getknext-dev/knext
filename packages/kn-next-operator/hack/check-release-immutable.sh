#!/usr/bin/env bash
# hack/check-release-immutable.sh — enforces that operator-vX.Y.Z releases are
# actually immutable (#1667), not just documented as such.
#
# `softprops/action-gh-release` UPDATES an existing release for a given
# `tag_name` rather than refusing to touch one — so on its own, a re-pushed or
# force-moved `operator-vX.Y.Z` tag would silently overwrite a previously
# published install.yaml, exactly the "pin a version, get a different bundle"
# failure the whole point of tagged releases is meant to rule out. This runs
# BEFORE the publish step and fails loud if a release for the given tag
# already carries an install.yaml asset.
#
# Deliberately narrow: `operator-edge`/`operator-latest` are mutable BY
# DESIGN (a rolling channel and a stable-tracking pointer respectively) — the
# workflow only calls this for a real `operator-vX.Y.Z[-rc.N]` version tag
# (`steps.channel.outputs.is_version_tag == 'true'`).
#
# Usage:
#   check-release-immutable.sh <owner/repo> <tag>
# Requires: the `gh` CLI, authenticated via the GITHUB_TOKEN/GH_TOKEN env var.
#
# Exit codes:
#   0 — no release exists yet for this tag, or one exists but has not (yet)
#       had an install.yaml asset attached (e.g. a prior run died between
#       creating the release and attaching the asset) — safe to publish.
#   1 — a release for this tag ALREADY carries an install.yaml asset — refuse
#       to publish over it.
#   2 — the `gh` call itself failed for a reason OTHER than "no such release"
#       (rate limit, auth failure, network) — fail loud rather than silently
#       treating an unreachable API as "safe to publish" (same rule this repo
#       already applies to scripts/verify-action-pins.mjs).

set -euo pipefail

REPO="${1:?usage: check-release-immutable.sh <owner/repo> <tag>}"
TAG="${2:?usage: check-release-immutable.sh <owner/repo> <tag>}"

STDERR_FILE="$(mktemp)"
trap 'rm -f "${STDERR_FILE}"' EXIT

if ! JSON="$(gh release view "${TAG}" --repo "${REPO}" --json assets 2>"${STDERR_FILE}")"; then
  STDERR_TEXT="$(cat "${STDERR_FILE}")"
  # gh's own signal for "no release at this tag" — the one case where a
  # non-zero exit means "safe to publish", everything else must fail loud.
  if grep -qi 'release not found' "${STDERR_FILE}"; then
    echo "No existing release for tag ${TAG} — safe to publish."
    exit 0
  fi
  echo "::error::gh release view ${TAG} failed for a reason other than 'release not found': ${STDERR_TEXT}" >&2
  exit 2
fi

if echo "${JSON}" | jq -e '.assets[]? | select(.name == "install.yaml")' > /dev/null; then
  echo "::error::release ${TAG} already carries an install.yaml asset — operator-vX.Y.Z releases are immutable; publish under a NEW tag instead of overwriting this one" >&2
  exit 1
fi

echo "Release ${TAG} exists but has no install.yaml asset yet — safe to publish."
