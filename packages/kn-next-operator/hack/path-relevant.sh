#!/usr/bin/env bash
# hack/path-relevant.sh — restores push.paths-filter behavior for MAIN-BRANCH
# pushes to operator-supply-chain.yml (#1667), without applying that same
# filter to operator-vX.Y.Z TAG pushes.
#
# Why this can't just be `on.push.paths` in the workflow: GitHub evaluates a
# single `paths:` filter against EVERY ref the `push:` trigger matches
# (branches AND tags together) — there is no way, within one `on.push` block,
# to apply `paths` to `branches: [main]` while leaving `tags: ['operator-v*']`
# unfiltered. A tag push may legitimately repoint at a commit whose OWN diff
# does not touch these paths (or have zero new commits at all), so filtering
# tags by paths risks a release tag silently not triggering its publisher.
# This script is invoked from a small `changes` job that only runs for
# `main` pushes; tag pushes are treated as unconditionally relevant by the
# CALLER (see operator-supply-chain.yml), not by this script.
#
# Usage:
#   path-relevant.sh <before-sha> <after-sha> <repo-dir>
#     before-sha: github.event.before (all-zeros on a branch's first push)
#     after-sha:  github.sha
#     repo-dir:   a git checkout containing both commits
#
# Prints "true" or "false" to stdout (nothing else — the caller writes it
# straight to $GITHUB_OUTPUT).
#
# Exit codes:
#   0 — always (a diff that cannot be computed is a input/checkout problem,
#       not this script's decision to make; git itself will fail loud with
#       set -e if the SHAs are not present in repo-dir).

set -euo pipefail

BEFORE="${1:?usage: path-relevant.sh <before-sha> <after-sha> <repo-dir>}"
AFTER="${2:?usage: path-relevant.sh <before-sha> <after-sha> <repo-dir>}"
REPO_DIR="${3:?usage: path-relevant.sh <before-sha> <after-sha> <repo-dir>}"

# All-zeros `before` means there is no prior commit to diff against (a new
# branch's first push) — treat as relevant rather than silently skipping.
if [[ "${BEFORE}" =~ ^0+$ ]]; then
  echo "true"
  exit 0
fi

if git -C "${REPO_DIR}" diff --name-only "${BEFORE}" "${AFTER}" \
    | grep -qE '^(packages/kn-next-operator/|\.github/workflows/operator-supply-chain\.yml)'; then
  echo "true"
else
  echo "false"
fi
