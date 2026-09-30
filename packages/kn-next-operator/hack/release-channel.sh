#!/usr/bin/env bash
# hack/release-channel.sh — determines the operator release channel for a
# given git ref (#1667).
#
# Tag-triggered, immutable `operator-vX.Y.Z` releases (including rc tags):
# `operator-latest` moves ONLY on stable (non-prerelease) tags; builds from
# `main` go to a rolling `operator-edge` channel instead. Kept as a standalone
# script (not inline workflow bash) so the tag-parsing/channel logic is
# directly unit-testable without executing the workflow.
#
# Usage:
#   release-channel.sh <ref> <ref_name>
#     ref:      e.g. refs/heads/main | refs/tags/operator-v1.2.3-rc.1
#     ref_name: e.g. main            | operator-v1.2.3-rc.1
#
# Prints GITHUB_OUTPUT-style `key=value` lines to stdout:
#   publish=true|false      — whether this ref should publish at all
#   release_tag=<tag>       — the GitHub Release tag to attach install.yaml to
#                             ("" when publish=false)
#   is_stable=true|false    — whether operator-latest should also be moved
#
# Exit codes:
#   0 — ref parsed (publish may still be false for a non-publishing ref)
#   1 — ref looks like an operator release tag but is not valid semver
#       (fail loud rather than silently guessing a channel)

set -euo pipefail

REF="${1:?usage: release-channel.sh <ref> <ref_name>}"
REF_NAME="${2:?usage: release-channel.sh <ref> <ref_name>}"

# Semver core + optional prerelease (e.g. 1.2.3 or 1.2.3-rc.1). Build
# metadata (+build) is intentionally not accepted — the tag pattern this
# repo uses (operator-vX.Y.Z[-prerelease]) never carries it.
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'

if [[ "${REF}" == refs/tags/operator-v* ]]; then
  VERSION="${REF_NAME#operator-v}"
  if [[ ! "${VERSION}" =~ ${SEMVER_RE} ]]; then
    echo "::error::ref ${REF_NAME} is not a valid operator release tag (expected operator-vX.Y.Z[-prerelease])" >&2
    exit 1
  fi
  if [[ "${VERSION}" == *-* ]]; then
    IS_STABLE=false
  else
    IS_STABLE=true
  fi
  echo "publish=true"
  echo "release_tag=${REF_NAME}"
  echo "is_stable=${IS_STABLE}"
elif [[ "${REF}" == "refs/heads/main" ]]; then
  echo "publish=true"
  echo "release_tag=operator-edge"
  echo "is_stable=false"
else
  echo "publish=false"
  echo "release_tag="
  echo "is_stable=false"
fi
