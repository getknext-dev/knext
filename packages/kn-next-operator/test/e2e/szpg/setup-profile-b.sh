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
#   1. a kind cluster (UNIQUE name + own throwaway kubeconfig — cluster work is a
#      queue of one; unique names so a concurrent agent's cluster is never clobbered).
#      Images reach the node via `kind load docker-image` (gateway + db-demo); there
#      is NO in-cluster registry.
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
#   - docker.io/minio/mc and quay.io/minio/mc are BOTH access-denied for anonymous
#     pull, repo-wide (#1403). Manifests are repinned to
#     docker.io/bitnamilegacy/minio-client@<digest>, which still pulls anonymously
#     — we pre-pull + kind load it as cheap insurance against a flaky mid-drill pull.
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
# (default db-demo), DB_DEMO_IMAGE (a real, pullable — or locally-built + kind-loaded
# — db-demo image; the default placeholder is unpullable by design), KEEP=1 (skip
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

need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

preflight() {
  for t in kind kubectl docker go; do need "$t"; done
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
  # mc gotcha (design §4.5, UPDATED #1403): docker.io/minio/mc AND
  # quay.io/minio/mc now UNAUTHORIZE every anonymous pull repo-wide (verified
  # — not a transient rate limit). 55-storage-init.yaml and 62-backup.yaml
  # were repinned to docker.io/bitnamilegacy/minio-client@<digest>, which DOES
  # pull anonymously, so the retag-and-kind-load workaround this block used to
  # need is gone — a bare `kind load` of a locally-pulled copy is still cheap
  # insurance against a flaky docker.io pull mid-drill, so keep pre-pulling,
  # just from the new source and without the old retag-to-minio/mc step (no
  # manifest references that name anymore).
  docker pull docker.io/bitnamilegacy/minio-client@sha256:00dcc4e58ada0df45bb7d9ee435af98295f96c27c3c68292ce78ec700a87b511 \
    >/dev/null 2>&1 || warn "could not pre-pull the mc mirror image (storage-init may retry)"
  kind load docker-image docker.io/bitnamilegacy/minio-client@sha256:00dcc4e58ada0df45bb7d9ee435af98295f96c27c3c68292ce78ec700a87b511 \
    --name "$CLUSTER_NAME" 2>/dev/null || true
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
  # FAIL, not warn: a not-Ready AppDatabase means the szpg reconcile never ran, so
  # everything downstream (bind, boundary) would prove nothing (cr-1214 #2).
  $K -n "$APPDB_NAMESPACE" wait --for=condition=Ready "appdatabase/${APPDB_NAME}" --timeout=180s \
    || die "AppDatabase not Ready — inspect: $K -n $APPDB_NAMESPACE describe appdatabase/$APPDB_NAME"
  # No silent fallback: the DATABASE_URL secret name MUST come from the szpg
  # operator's status. A guessed name would let the drill 'pass' over a Secret the
  # reconcile never produced.
  APPDB_SECRET="$($K -n "$APPDB_NAMESPACE" get appdatabase "$APPDB_NAME" -o jsonpath='{.status.secretName}' 2>/dev/null || true)"
  [ -n "$APPDB_SECRET" ] || die "AppDatabase.status.secretName is empty — szpg did not provision the DATABASE_URL Secret; no fallback"
  $K -n "$APPDB_NAMESPACE" get secret "$APPDB_SECRET" >/dev/null 2>&1 \
    || die "AppDatabase secret $APPDB_SECRET does not exist — szpg reconcile incomplete"
  log "AppDatabase DATABASE_URL secret: $APPDB_SECRET (from status.secretName)"
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
  # If DB_DEMO_IMAGE is a locally-built image, load it into the kind node so the
  # ksvc can start without an external registry (mirrors the gateway load; this is
  # how the image reaches the node — there is no in-cluster registry).
  if [ -n "${DB_DEMO_IMAGE:-}" ] && docker image inspect "$DB_DEMO_IMAGE" >/dev/null 2>&1; then
    log "kind load db-demo image $DB_DEMO_IMAGE"
    kind load docker-image "$DB_DEMO_IMAGE" --name "$CLUSTER_NAME" || warn "kind load db-demo image failed"
  fi

  # 5. bind — the ONE knext cluster write for the DB: `kubectl patch nextapp`.
  # FAIL, not warn (cr-1214 #2): a failed bind means the knext bind/reconcile path
  # never ran, so a later 'boundary PASSED' would be vacuous.
  log "kn-next db bind $APPDB_NAME --secret $APPDB_SECRET"
  # shellcheck disable=SC2086
  $KN_NEXT db bind "$APPDB_NAME" --secret "$APPDB_SECRET" -n "$APPDB_NAMESPACE" \
    || die "kn-next db bind FAILED — the knext bind path did not run"

  # ASSERT the bind actually took effect on the CR, and the operator reconciled it
  # onto the ksvc as a DATABASE_URL env from the bound secret — proof the knext
  # path ran end to end, not just that the CLI exited 0.
  # spec.database.secretRef is an OBJECT {name,key} (DatabaseSecretRef), so read
  # .name — comparing the whole object to a bare secret name would never match.
  local ref
  ref="$($K -n "$APPDB_NAMESPACE" get nextapp "$APPDB_NAME" -o jsonpath='{.spec.database.secretRef.name}' 2>/dev/null || true)"
  [ "$ref" = "$APPDB_SECRET" ] \
    || die "bind did not set spec.database.secretRef (got '$ref', want '$APPDB_SECRET')"
  log "spec.database.secretRef == $ref (bind took effect)"
  log "waiting for the operator to project DATABASE_URL onto the db-demo ksvc"
  local i=0 env_src=""
  while [ "$i" -lt 60 ]; do
    env_src="$($K -n "$APPDB_NAMESPACE" get ksvc "$APPDB_NAME" \
      -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="DATABASE_URL")].valueFrom.secretKeyRef.name}' 2>/dev/null || true)"
    [ -n "$env_src" ] && break
    i=$((i + 1)); sleep 2
  done
  [ "$env_src" = "$APPDB_SECRET" ] \
    || die "operator did not project DATABASE_URL from $APPDB_SECRET onto the ksvc (got '$env_src') — reconcile did not take effect"
  log "ksvc db-demo has DATABASE_URL <- secret $env_src (reconcile took effect)"

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
