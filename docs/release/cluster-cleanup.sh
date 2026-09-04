#!/usr/bin/env bash
#
# Cluster cleanup — HUMAN-RUN ONLY.
#
# `block-dangerous-bash.sh` human-gates cluster deletes because ADR-0001 makes the
# operator the single source of truth for cluster state. An agent wrote this file;
# an agent must not run it.
#
# READ BEFORE RUNNING. This removes eight Knative services and two NextApp CRs.
#
# KEEPS, deliberately:
#   default/file-manager      the reference app, wired to scale-to-zero Postgres
#                             (DATABASE_URL from the `filemanager-scalezeropg` Secret)
#   knext-docs/knext-docs     the docs site — not a test project
#
# REMOVES: leftovers from the A/B experiments recorded in
# docs/benchmarks/EXPERIMENTS.md. `fm-node` and `fm-vinext` are variants of the
# same app on the same DB Secret as `file-manager`, kept only to compare arms.
#
# Two NextApp CRs are deleted rather than their Services: the operator owns those,
# and deleting the Service alone would be reconciled straight back.
#
set -euo pipefail

CTX="${KNEXT_CONTEXT:-context-ckmva7v7zvq}"

echo "==> context: ${CTX}"
kubectl --context="${CTX}" get ksvc -A || true

read -r -p "Delete the 8 services + 2 CRs listed above (keeping file-manager and knext-docs)? [y/N] " ok
[ "${ok}" = "y" ] || { echo "aborted"; exit 0; }

# Operator-owned: delete the CR, let the operator remove the Service.
kubectl --context="${CTX}" delete nextapp pw sdd-drill -n knext-prewarm

# Hand-made Services with no NextApp owner — safe to delete directly.
kubectl --context="${CTX}" delete ksvc \
  css-bunexec fm-node fm-vinext \
  p1b-bunexec p1b-node p1b-node-cpu p1b-node-req \
  -n default

kubectl --context="${CTX}" delete ksvc sdd-twin -n knext-prewarm

echo "==> remaining:"
kubectl --context="${CTX}" get ksvc -A
