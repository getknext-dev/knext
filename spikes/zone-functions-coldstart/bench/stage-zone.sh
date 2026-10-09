#!/usr/bin/env bash
# Stage the Z2 zone outside the repo (a real app is its own project dir; in
# place, Next's tracing root collapses onto the monorepo), install it with the
# packed @getknext/* tarballs, and run `kn-next deploy` for one runtime. That
# emits a digest-pinned NextApp CR the operator reconciles: the real product
# path. Mirrors .github/workflows/standalone-deploy-kind-e2e.yml.
#
# Usage: stage-zone.sh <node|bun> <app-name>
# Env:   Z2_KUBECONFIG (private kind kubeconfig), Z2_STAGE (scratch dir),
#        Z2_TARBALLS (dir with getknext-{lib,db,core}-*.tgz)
set -euo pipefail

RUNTIME="${1:?runtime node|bun}"
NAME="${2:?app name}"
export KUBECONFIG="${Z2_KUBECONFIG:?}"
[ "$(kubectl config current-context)" = "kind-knext-z2-coldstart" ] || { echo "refusing: wrong context" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
APP_DIR="${Z2_STAGE:?}/zone-$RUNTIME-$(date +%s)"   # always a fresh dir
TGZ="${Z2_TARBALLS:?}"

mkdir -p "$APP_DIR"
cp -R "$HERE/../zone/." "$APP_DIR/"
cd "$APP_DIR"
mkdir -p public

cat > knext.config.ts <<EOF
const config = {
  name: "${NAME}",
  runtime: "${RUNTIME}",
  registry: "localhost:5001",
  healthCheckPath: "/api/health",
  scaling: { minScale: 0, maxScale: 1, memoryRequest: "256Mi", memoryLimit: "512Mi" },
};
export default config;
EOF

# bun, not npm: identical resolution here, and npm was ~30x slower on this
# machine. All three tarballs in ONE add so core resolves lib/db locally.
bun install
bun add "$(ls "$TGZ"/getknext-lib-*.tgz)" "$(ls "$TGZ"/getknext-db-*.tgz)" "$(ls "$TGZ"/getknext-core-*.tgz)"
test -d node_modules/@getknext/core

# A docker-container buildx builder pushes from inside its own container, where
# localhost:5001 is not the registry; the docker-driver builder pushes from the
# daemon, where it is.
export BUILDX_BUILDER="${BUILDX_BUILDER:-orbstack}"
node "$REPO_ROOT/packages/kn-next/dist/cli/kn-next.js" deploy \
  --registry localhost:5001 --namespace z2 --tag "z2-$RUNTIME-$(date +%s)"
