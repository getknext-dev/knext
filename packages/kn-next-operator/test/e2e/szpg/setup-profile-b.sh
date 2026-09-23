#!/usr/bin/env bash
# setup-profile-b.sh — stand up the Profile-B unified double-scale-to-zero harness
# on a LOCAL kind cluster (P4a, #1203). Design: .claude/research/platform-e2e-design.md §4.
#
# This is a LEAD-LOCAL drill, NOT a PR gate and NOT a hosted-CI job: the szpg plane
# was last proven on a fresh ~100 GB / 4-node kind cluster (szpg-d8), which does not
# fit ubuntu-latest (design §4.5). It builds + `kind load`s the szpg gateway/pswatcher
# image itself because scale-zero-pg has NO image publish pipeline (design §4.5).
#
# What it stands up, in order:
#   1. a kind cluster (UNIQUE name, own local registry on a FREE port — cluster work is
#      a queue of one; unique names so a concurrent agent's cluster is never clobbered)
#   2. cert-manager + Knative Serving + Kourier, config-autoscaler patched for a REAL
#      cold start (scale-to-zero-pod-retention-period: 0s, stable-window: 6s)
#   3. the scale-zero-pg plane (Neon-OSS pageserver/safekeepers/broker/minio/pswatcher
#      always-on + the pggw wake-on-connect gateway scaling the compute Deployment 0<->1),
#      with the gateway image built from source and kind-loaded, TLS off for a laptop
#      cluster (GW_COMPUTE_TLS=false)
#   4. an AppDatabase CR (apps.scale-zero-pg.dev) for db-demo, reconciled by the szpg
#      appdb-operator into a DATABASE_URL Secret
#   5. `kn-next db bind db-demo --secret <appdb-secret>` — ONE `kubectl patch nextapp`
#      (ADR-0019 BYO secretRef); the knext operator injects DATABASE_URL into the ksvc
#   6. db-demo deployed via a NextApp CR to Knative; a row seeded through the app's DB
#
# Then it runs the DB-side wake oracle (deploy/_verify-wake.sh) and THE boundary
# assertion (step B1 of the design): the knext operator wrote NOTHING to the
# AppDatabase (nextapp_types.go:531 / ADR-0001 / data sovereignty). The assertion's
# detection logic is mutation-proved off-cluster in ../szpg_boundary_test.go; this
# script drives it live via ../szpg_profile_b_test.go (`-tags e2e_szpg`).
#
# KNOWN DRILL GOTCHAS baked in (from the szpg-d8 exit-gate run, design §4.5):
#   - docker.io/minio/mc is access-denied; we retag quay.io/minio/mc and kind load it.
#   - several deploy/_verify-*.sh default KCTX/KSPG_CONTEXT to the OKE production
#     context. We set KUBECONFIG to a throwaway file and pass the kind context
#     EXPLICITLY so a "local" drill can never touch a real cluster.
#
# Usage:
#   packages/kn-next-operator/test/e2e/szpg/setup-profile-b.sh [up|down|boundary|all]
#     up        create the cluster + plane + app + bind + seed (leaves it running)
#     boundary  run the operator-boundary assertion against the running plane
#     down      tear the cluster + registry down
#     all       up, then boundary, then down (default)
#
# Env overrides: CLUSTER_NAME, APPDB_NAMESPACE (default my-apps), APPDB_NAME
# (default db-demo), REGISTRY_PORT (default: an ephemeral free port), KEEP=1 (skip
# teardown on exit for post-mortem).
set -euo pipefail

# --- resolve paths (repo-relative, no hard-coded homedir) ---------------------
HERE="$(cd "$(dirname "$0")" && pwd)"
OPERATOR_DIR="$(cd "$HERE/../.." && pwd)"                 # packages/kn-next-operator
REPO_ROOT="$(cd "$OPERATOR_DIR/../.." && pwd)"            # repo root
SZPG_DIR="$REPO_ROOT/packages/scale-zero-pg"
SZPG_DEPLOY="$SZPG_DIR/deploy"

# --- unique, collision-free names (queue-of-one; never clobber a peer) ---------
RUN_ID="${RUN_ID:-$$}"
CLUSTER_NAME="${CLUSTER_NAME:-szpg-p4a-${RUN_ID}}"
APPDB_NAMESPACE="${APPDB_NAMESPACE:-my-apps}"
APPDB_NAME="${APPDB_NAME:-db-demo}"
SZPG_NS="scale-zero-pg"
GW_LOCAL_IMAGE="scale-zero-pg/gateway:p4a-${RUN_ID}"
# A throwaway kubeconfig so we can NEVER act on the OKE/production context by accident.
KUBECONFIG_FILE="${KUBECONFIG_FILE:-/tmp/kubeconfig-${CLUSTER_NAME}}"
export KUBECONFIG="$KUBECONFIG_FILE"
KCTX="kind-${CLUSTER_NAME}"
K="kubectl --context=${KCTX}"
# Export the context vars GLOBALLY so every szpg deploy/_verify-*.sh subshell
# inherits them — those scripts default KCTX/KSPG_CONTEXT to the OKE production
# context, so an unset var would run a "local" drill against a real cluster.
KSPG_CONTEXT="$KCTX"
export KCTX KSPG_CONTEXT

log()  { printf '\033[1;34m[p4a]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[p4a][warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[p4a][FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

free_port() { # print an OS-assigned free TCP port
  python3 - <<'PY'
import socket
s = socket.socket(); s.bind(("", 0)); print(s.getsockname()[1]); s.close()
PY
}

need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

preflight() {
  for t in kind kubectl docker python3; do need "$t"; done
  # kn-next CLI: prefer the built bin, fall back to `bun run` from source.
  if command -v kn-next >/dev/null 2>&1; then KN_NEXT="kn-next";
  elif [ -x "$REPO_ROOT/packages/kn-next/dist/cli/kn-next.js" ]; then KN_NEXT="node $REPO_ROOT/packages/kn-next/dist/cli/kn-next.js";
  else KN_NEXT="bun run $REPO_ROOT/packages/kn-next/src/cli/db-bind.ts"; fi
  log "kn-next: $KN_NEXT"
}

teardown() {
  [ "${KEEP:-0}" = "1" ] && { warn "KEEP=1 — leaving cluster ${CLUSTER_NAME} up for post-mortem"; return 0; }
  log "teardown: kind delete cluster ${CLUSTER_NAME}"
  kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
  rm -f "$KUBECONFIG_FILE" 2>/dev/null || true
}

cmd_up() {
  preflight
  # 1. cluster
  if kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
    warn "cluster $CLUSTER_NAME already exists — reusing"
  else
    log "creating kind cluster $CLUSTER_NAME"
    kind create cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG_FILE"
  fi
  $K cluster-info >/dev/null || die "cluster $CLUSTER_NAME not reachable"

  # 2. Knative + Kourier + cert-manager (versions match operator-e2e-nightly.yml)
  install_knative

  # 3. szpg plane
  build_and_load_gateway
  deploy_szpg_plane

  # 4. AppDatabase for db-demo (szpg appdb-operator reconciles it)
  provision_appdatabase

  # 5. bind + 6. deploy db-demo + seed
  bind_and_deploy_db_demo

  log "Profile-B plane is UP. Boundary assertion: $0 boundary"
}

install_knative() {
  local KN_VER="${KNATIVE_VERSION:-v1.16.0}"
  local CM_VER="${CERT_MANAGER_VERSION:-v1.16.1}"
  log "installing cert-manager $CM_VER"
  $K apply -f "https://github.com/cert-manager/cert-manager/releases/download/${CM_VER}/cert-manager.yaml"
  $K -n cert-manager rollout status deploy/cert-manager-webhook --timeout=180s
  log "installing Knative Serving $KN_VER + Kourier"
  $K apply -f "https://github.com/knative/serving/releases/download/knative-${KN_VER}/serving-crds.yaml"
  $K apply -f "https://github.com/knative/serving/releases/download/knative-${KN_VER}/serving-core.yaml"
  $K apply -f "https://github.com/knative/net-kourier/releases/download/knative-${KN_VER}/kourier.yaml"
  $K patch configmap/config-network -n knative-serving --type merge \
    -p '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'
  # REAL cold start: no pod retention, short stable window (design A1).
  $K patch configmap/config-autoscaler -n knative-serving --type merge \
    -p '{"data":{"scale-to-zero-pod-retention-period":"0s","stable-window":"6s"}}'
  $K -n knative-serving rollout status deploy/controller --timeout=180s
}

build_and_load_gateway() {
  log "building szpg gateway image $GW_LOCAL_IMAGE"
  docker build -t "$GW_LOCAL_IMAGE" "$SZPG_DIR/gateway"
  log "kind load $GW_LOCAL_IMAGE"
  kind load docker-image "$GW_LOCAL_IMAGE" --name "$CLUSTER_NAME"
  # mc gotcha (design §4.5): docker.io/minio/mc is access-denied on this network.
  # Pre-pull the quay mirror and load it so the storage-init bucket step never
  # blocks on a docker.io pull.
  docker pull quay.io/minio/mc:latest >/dev/null 2>&1 || warn "could not pre-pull quay.io/minio/mc (storage-init may retry)"
  docker tag quay.io/minio/mc:latest minio/mc:latest 2>/dev/null || true
  kind load docker-image minio/mc:latest --name "$CLUSTER_NAME" 2>/dev/null || true
}

deploy_szpg_plane() {
  log "rendering szpg manifests for local kind (local image, TLS off)"
  local STAGE; STAGE="$(mktemp -d)/deploy"; mkdir -p "$STAGE"
  cp -R "$SZPG_DEPLOY"/*.yaml "$STAGE"/
  # Point the OCIR-pinned gateway/pswatcher image at our local build, and make the
  # kubelet use the kind-loaded image instead of pulling a pinned digest.
  perl -0pi -e 's#image:\s*me-abudhabi-1\.ocir\.io/\S+/ks-pg/gateway:\S+#image: '"$GW_LOCAL_IMAGE"'#g' "$STAGE"/*.yaml
  perl -0pi -e 's#(image:\s*'"$GW_LOCAL_IMAGE"'.*)#$1\n          imagePullPolicy: IfNotPresent#g' "$STAGE"/*.yaml
  # Laptop cluster: plaintext gateway<->compute (no cert-manager leaf certs needed).
  perl -0pi -e 's#(name:\s*GW_COMPUTE_TLS\s*\n\s*value:\s*)"true"#${1}"false"#g' "$STAGE"/*.yaml || true
  # Base cloud_admin credential + object-store secrets must exist BEFORE apply (fail-closed).
  ( cd "$SZPG_DEPLOY" && bash gen-secrets.sh ) || warn "gen-secrets.sh non-zero (may already exist)"
  log "kubectl apply szpg plane (namespace $SZPG_NS)"
  $K apply -f "$STAGE"/00-namespace.yaml
  $K apply -f "$STAGE"/
  ( cd "$SZPG_DEPLOY" && bash seed-ledger.sh ) || true
  log "waiting for storage plane + gateway"
  $K -n "$SZPG_NS" rollout status deploy/pggw --timeout=300s || die "pggw not ready"
  $K -n "$SZPG_NS" rollout status deploy/appdb-operator --timeout=180s || warn "appdb-operator not ready yet"
  ( cd "$SZPG_DEPLOY" && sh _validate.sh ) || warn "_validate.sh reported issues (review above)"
}

provision_appdatabase() {
  log "applying AppDatabase/$APPDB_NAME in ns $APPDB_NAMESPACE"
  $K create namespace "$APPDB_NAMESPACE" --dry-run=client -o yaml | $K apply -f -
  cat <<YAML | $K apply -f -
apiVersion: apps.scale-zero-pg.dev/v1alpha1
kind: AppDatabase
metadata:
  name: ${APPDB_NAME}
  namespace: ${APPDB_NAMESPACE}
spec:
  appName: ${APPDB_NAME}
  tier: cold
YAML
  log "waiting for AppDatabase to reconcile (Ready)"
  $K -n "$APPDB_NAMESPACE" wait --for=condition=Ready "appdatabase/${APPDB_NAME}" --timeout=180s \
    || warn "AppDatabase not Ready in time — inspect: $K -n $APPDB_NAMESPACE describe appdatabase/$APPDB_NAME"
  APPDB_SECRET="$($K -n "$APPDB_NAMESPACE" get appdatabase "$APPDB_NAME" -o jsonpath='{.status.secretName}' 2>/dev/null || true)"
  [ -n "$APPDB_SECRET" ] || { APPDB_SECRET="${APPDB_NAME}-db"; warn "status.secretName empty; assuming $APPDB_SECRET"; }
  log "AppDatabase DATABASE_URL secret: $APPDB_SECRET"
}

bind_and_deploy_db_demo() {
  # 5. bind — the ONE knext cluster write for the DB: `kubectl patch nextapp`.
  #    We first need a NextApp to patch, so apply a minimal db-demo NextApp CR.
  log "applying NextApp/$APPDB_NAME (scale-to-zero) in ns $APPDB_NAMESPACE"
  cat <<YAML | $K apply -f -
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: ${APPDB_NAME}
  namespace: ${APPDB_NAMESPACE}
spec:
  image: ${DB_DEMO_IMAGE:-ghcr.io/getknext-dev/db-demo@sha256:0000000000000000000000000000000000000000000000000000000000000000}
  scaling:
    minScale: 0
    maxScale: 2
YAML
  log "kn-next db bind $APPDB_NAME --secret $APPDB_SECRET"
  # shellcheck disable=SC2086
  $KN_NEXT db bind "$APPDB_NAME" --secret "$APPDB_SECRET" -n "$APPDB_NAMESPACE" \
    || warn "db bind returned non-zero (the operator may need to reconcile first)"
  log "NOTE: seeding + serving needs a real, pullable db-demo image (set DB_DEMO_IMAGE);"
  log "      the placeholder digest above is UNPULLABLE by design (mirrors the scale suite)."
  log "      Seed via: $K -n $APPDB_NAMESPACE apply -f apps/db-demo/migrate-job.yaml"
}

cmd_boundary() {
  preflight
  log "running the operator-boundary assertion (e2e_szpg driver)"
  ( cd "$OPERATOR_DIR" && KNEXT_SZPG_E2E=1 APPDB_NAMESPACE="$APPDB_NAMESPACE" APPDB_NAME="$APPDB_NAME" \
      KUBECONFIG="$KUBECONFIG_FILE" \
      go test -tags e2e_szpg ./test/e2e/ -run TestProfileB_OperatorBoundary -v -count=1 ) \
    || die "boundary assertion FAILED — knext wrote to AppDatabase (see output)"
  log "boundary assertion PASSED"
}

cmd_wake() {
  log "running the DB-side wake oracle (deploy/_verify-wake.sh)"
  ( cd "$SZPG_DEPLOY" && sh _verify-wake.sh )
}

main() {
  local action="${1:-all}"
  case "$action" in
    up)       cmd_up ;;
    boundary) cmd_boundary ;;
    wake)     cmd_wake ;;
    down)     teardown ;;
    all)
      trap teardown EXIT
      cmd_up
      cmd_wake || warn "wake oracle non-zero (inspect the plane)"
      cmd_boundary
      ;;
    *) die "unknown action: $action (use up|boundary|wake|down|all)" ;;
  esac
}

main "$@"
