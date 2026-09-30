#!/usr/bin/env bash
# operator upgrade-under-load e2e orchestrator (#1668, #1671).
#
# Drives the whole scenario on an ALREADY-BOOTSTRAPPED kind cluster (kind +
# cert-manager + Knative Serving + Kourier — the workflow reuses the exact
# scripts/kind-manifests/ steps operator-e2e-nightly.yml already uses; this
# script does not reinvent cluster bootstrap):
#
#   1. install the 0.4.x operator + CRD (built from the kn-next@0.4.3 git tag's
#      packages/kn-next-operator source, in its own git worktree — there is no
#      separately-tagged operator release to download; operator-latest is a
#      ROLLING release repointed to current main on every publish, so it can
#      never stand in for "the operator as it was at 0.4.3". Building from the
#      0.4.3-tagged commit is the honest stand-in: it is the operator source
#      that genuinely existed when 0.4.3 shipped.)
#   2. scaffold + deploy a NextApp with the published 0.4.3 CLI (npm), against
#      a real, public, digest-pinned, servable image (--image, so the harness
#      never needs a full `next build`/docker build/push in CI)
#   3. start a light continuous-traffic driver against the app
#   4. upgrade the operator + CRD to THIS tree's build (operator first)
#   5. assert: NextApp CUMULATIVE not-Ready bound (sum of every flap in the
#      window, not the single longest one — see ready-flap.mjs), request-error
#      budget, spec unchanged
#   6. install the current CLI (this tree's built dist) and redeploy the SAME
#      app directory, following the 0.4.x -> 1.0 upgrade guide's steps
#      (apps/docs/content/docs/upgrading.mdx): the un-renamed config fails
#      with the one documented actionable error, then the rename + redeploy
#      succeeds.
#
# BREAK_CRD_UPGRADE=1 deliberately drops a known field from the new CRD before
# applying it in step 4, which must make step 5's assertions fail — this is
# the mutation-proof for this e2e's own guard, run manually/locally (see the
# PR description), never in the scheduled/dispatch CI run.
#
# All state lives under $WORKDIR (default: a mktemp dir) so re-runs don't
# collide.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OPERATOR_DIR="$ROOT/packages/kn-next-operator"

: "${KIND_CLUSTER:=kn-next-operator-upgrade-e2e}"
: "${OLD_CLI_VERSION:=0.4.3}"
: "${OLD_OPERATOR_TAG:=kn-next@0.4.3}"
: "${NEW_CLI_VERSION:=}" # empty => install this tree's built dist directly
: "${APP_IMAGE:=ghcr.io/knative/helloworld-go@sha256:c2b7412fbea6f1ef24a0cac60698e88df7ae3c4278e42d0cb34fe7d4b2641bba}"
: "${TRAFFIC_INTERVAL_MS:=500}"
: "${READY_BOUND_SECONDS:=90}"     # CUMULATIVE not-Ready time across the window (sum of every
                                    # flap, not the single longest one — see ready-flap.mjs)
: "${ERROR_BUDGET:=0.02}"          # <=2% request errors across the whole window
: "${BREAK_CRD_UPGRADE:=0}"        # mutation-proof switch; must never be 1 in CI
: "${WORKDIR:=$(mktemp -d /tmp/knext-upgrade-e2e.XXXXXX)}"
: "${APP_NAMESPACE:=upgrade-e2e-app}"
: "${APP_NAME:=upgrade-e2e-app}"

log() { echo "[upgrade-e2e] $*" >&2; }

mkdir -p "$WORKDIR"
log "workdir: $WORKDIR"

# ---------------------------------------------------------------------------
# Phase 1: build + install the 0.4.x operator + CRD
# ---------------------------------------------------------------------------
phase1_old_operator() {
  log "phase 1: build + install the operator as of ${OLD_OPERATOR_TAG}"
  local wt="$WORKDIR/old-operator-src"
  rm -rf "$wt"
  git -C "$ROOT" worktree add --detach "$wt" "$OLD_OPERATOR_TAG"

  local img="registry.invalid/kn-next-operator:upgrade-e2e-old"
  make -C "$wt/packages/kn-next-operator" docker-build IMG="$img"
  kind load docker-image "$img" --name "$KIND_CLUSTER"
  make -C "$wt/packages/kn-next-operator" install
  make -C "$wt/packages/kn-next-operator" deploy IMG="$img"
  kubectl -n kn-next-operator-system rollout status deployment/kn-next-operator-controller-manager \
    --timeout=180s

  git -C "$ROOT" worktree remove "$wt" --force
}

# ---------------------------------------------------------------------------
# Phase 2: scaffold + deploy with the published 0.4.3 CLI
# ---------------------------------------------------------------------------
phase2_old_cli_deploy() {
  log "phase 2: scaffold + deploy with @getknext/core@${OLD_CLI_VERSION}"
  local bin="$WORKDIR/old-cli"
  mkdir -p "$bin"
  npm install --prefix "$bin" "@getknext/core@${OLD_CLI_VERSION}" "kn-next@${OLD_CLI_VERSION}"
  OLD_KNEXT="$bin/node_modules/.bin/kn-next"

  local app="$WORKDIR/app"
  rm -rf "$app"
  mkdir -p "$app"
  # Written by hand rather than via `kn-next create`: this e2e cares about
  # the DEPLOYED shape (the config, under the 0.4.x filename, driving a real
  # `deploy --image`), not the scaffold's exact template contents, and
  # `create`'s flag surface at 0.4.3 is not something this tree can read (it
  # is a different, published version of the CLI). 0.4.3 reads the
  # pre-rename config filename.
  cat > "$app/kn-next.config.ts" <<EOF
const config = {
  name: "${APP_NAME}",
  registry: "registry.invalid/${APP_NAME}",
};
export default config;
EOF
  # `deploy` computes its Docker build context by walking up for a lockfile
  # even under --image (requireBuildContext), so the app dir needs one even
  # though nothing in it is actually installed or built.
  cat > "$app/package.json" <<EOF
{ "name": "${APP_NAME}", "private": true }
EOF
  echo '{"name":"'"${APP_NAME}"'","lockfileVersion":3,"requires":true,"packages":{}}' \
    > "$app/package-lock.json"

  kubectl create namespace "$APP_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
  (
    cd "$app"
    "$OLD_KNEXT" deploy --image "$APP_IMAGE" --namespace "$APP_NAMESPACE"
  )
  kubectl -n "$APP_NAMESPACE" wait --for=condition=Ready "nextapp/$APP_NAME" --timeout=180s

  echo "$app" > "$WORKDIR/app-dir"
}

# ---------------------------------------------------------------------------
# Phase 3: traffic driver
# ---------------------------------------------------------------------------
# ROUND 3 (#1668/#1671): the first live run port-forwarded `svc/<app>`
# directly and got 100% connection failures. CONFIRMED CAUSE: a Knative
# ksvc's own Service is an ExternalName pointing at the shared Kourier
# internal gateway, which `kubectl port-forward` cannot target (no backing
# pod IP behind an ExternalName Service — port-forward needs a Service with
# real endpoints/selectors). The proven pattern already in this repo
# (`.github/workflows/standalone-self-contained-operator-e2e.yml`, step
# "Reach the cluster (kourier-internal port-forward) and hit /api/health")
# is: port-forward `svc/kourier-internal` in `kourier-system` ONCE, then send
# every request with a `Host:` header naming the app's real route host
# (`kubectl get nextapp -o jsonpath='{.status.url}'`, scheme stripped) — the
# same header-based routing Kourier itself uses. Reused verbatim here rather
# than reinvented.
: "${TRAFFIC_LOCAL_PORT:=18080}"

start_port_forward() {
  kubectl -n kourier-system port-forward svc/kourier-internal \
    "${TRAFFIC_LOCAL_PORT}:80" >"$WORKDIR/port-forward.log" 2>&1 &
  echo $! > "$WORKDIR/port-forward.pid"
  # Wait for the tunnel to actually accept connections (same /dev/tcp probe
  # the proven in-repo step uses) rather than a fixed sleep — a fixed sleep
  # either races a slow tunnel or wastes time on a fast one, and neither
  # tells you WHY a still-closed port failed.
  local ready=0
  for _ in $(seq 1 30); do
    if (exec 3<>"/dev/tcp/127.0.0.1/${TRAFFIC_LOCAL_PORT}") 2>/dev/null; then
      exec 3>&- 3<&-
      ready=1
      break
    fi
    sleep 1
  done
  if [[ "$ready" != "1" ]]; then
    log "FAILED: kourier-internal port-forward never accepted a connection on 127.0.0.1:${TRAFFIC_LOCAL_PORT}"
    log "port-forward.log:"
    cat "$WORKDIR/port-forward.log" >&2 || true
    return 1
  fi
}

stop_port_forward() {
  local pid
  pid="$(cat "$WORKDIR/port-forward.pid" 2>/dev/null || true)"
  if [[ -n "$pid" ]]; then
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}

# The route Kourier's Host-header routing needs, resolved ONCE from the
# NextApp's own status (the same source the proven in-repo step reads),
# scheme stripped.
resolve_app_host() {
  local raw
  raw="$(kubectl -n "$APP_NAMESPACE" get "nextapp/$APP_NAME" \
    -o jsonpath='{.status.url}' 2>/dev/null || true)"
  if [[ -z "$raw" ]]; then
    log "FAILED: nextapp/$APP_NAME status.url is empty — cannot resolve the Host header for traffic"
    kubectl -n "$APP_NAMESPACE" get "nextapp/$APP_NAME" -o yaml >&2 || true
    return 1
  fi
  echo "$raw" | sed -E 's#^https?://##'
}

start_traffic() {
  log "phase 3: starting the traffic driver"
  start_port_forward
  local host
  host="$(resolve_app_host)"
  echo "$host" > "$WORKDIR/app-host"
  local url
  url="$(app_url)"
  node "$ROOT/scripts/upgrade-e2e/traffic-monitor.mjs" "$url" "$WORKDIR/attempts.jsonl" \
    "$TRAFFIC_INTERVAL_MS" "$host" &
  echo $! > "$WORKDIR/traffic.pid"
}

stop_traffic() {
  local pid
  pid="$(cat "$WORKDIR/traffic.pid" 2>/dev/null || true)"
  if [[ -n "$pid" ]]; then
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  stop_port_forward
}

app_url() {
  # Loopback end of the kourier-internal port-forward started in
  # start_traffic — the Host header (resolve_app_host) is what actually
  # routes this to the right ksvc, same as production Kourier ingress.
  echo "http://127.0.0.1:${TRAFFIC_LOCAL_PORT}"
}

# ---------------------------------------------------------------------------
# Ready-condition sampler (runs as a background loop alongside traffic)
# ---------------------------------------------------------------------------
start_ready_sampler() {
  (
    while true; do
      local status
      status="$(kubectl -n "$APP_NAMESPACE" get "nextapp/$APP_NAME" \
        -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo Unknown)"
      status="${status:-Unknown}"
      node -e "console.log(JSON.stringify({ts: Date.now(), status: process.argv[1]}))" "$status" \
        >> "$WORKDIR/ready-samples.jsonl"
      sleep 2
    done
  ) &
  echo $! > "$WORKDIR/sampler.pid"
}

stop_ready_sampler() {
  local pid
  pid="$(cat "$WORKDIR/sampler.pid" 2>/dev/null || true)"
  if [[ -n "$pid" ]]; then
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}

# ---------------------------------------------------------------------------
# Phase 4: upgrade the operator + CRD to THIS tree (operator first)
# ---------------------------------------------------------------------------
phase4_upgrade_operator() {
  log "phase 4: upgrade operator + CRD to the current build (operator first)"

  kubectl -n "$APP_NAMESPACE" get "nextapp/$APP_NAME" -o json \
    | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(JSON.stringify(d.spec))" \
    > "$WORKDIR/spec-before.json"

  local img="registry.invalid/kn-next-operator:upgrade-e2e-new"
  make -C "$OPERATOR_DIR" docker-build IMG="$img"
  kind load docker-image "$img" --name "$KIND_CLUSTER"
  make -C "$OPERATOR_DIR" manifests
  make -C "$OPERATOR_DIR" generate

  if [[ "$BREAK_CRD_UPGRADE" == "1" ]]; then
    log "BREAK_CRD_UPGRADE=1: deliberately dropping a known CRD field (mutation-proof run, never CI)"
    node "$ROOT/scripts/upgrade-e2e/break-crd.mjs" \
      "$OPERATOR_DIR/config/crd/bases/apps.kn-next.dev_nextapps.yaml"
  fi

  make -C "$OPERATOR_DIR" install
  make -C "$OPERATOR_DIR" deploy IMG="$img"
  kubectl -n kn-next-operator-system rollout status deployment/kn-next-operator-controller-manager \
    --timeout=180s

  kubectl -n "$APP_NAMESPACE" get "nextapp/$APP_NAME" -o json \
    | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(JSON.stringify(d.spec))" \
    > "$WORKDIR/spec-after.json"
}

# On traffic failure, dump everything needed to diagnose a Kourier
# routing/Host-header problem without a re-run: a live curl through a FRESH
# tunnel using the SAME Host this run used (both "/" and the app's health
# path — the run's own tunnel is already closed by the time this runs, since
# stop_traffic/stop_port_forward happen before phase5_assert), the first few
# raw attempts, and the cluster's routing objects + gateway logs.
diagnose_traffic_failure() {
  log "diagnostics: traffic failure — dumping routing state"
  local host
  host="$(cat "$WORKDIR/app-host" 2>/dev/null || true)"

  local diag_port=18099
  kubectl -n kourier-system port-forward svc/kourier-internal \
    "${diag_port}:80" >"$WORKDIR/diag-port-forward.log" 2>&1 &
  local diag_pid=$!
  for _ in $(seq 1 15); do
    if (exec 3<>"/dev/tcp/127.0.0.1/${diag_port}") 2>/dev/null; then
      exec 3>&- 3<&-
      break
    fi
    sleep 1
  done

  log "diagnostics: curl -sv -H \"Host: $host\" http://127.0.0.1:${diag_port}/"
  curl -sv -H "Host: ${host}" "http://127.0.0.1:${diag_port}/" 2>&1 | tail -60 || true
  log "diagnostics: curl -sv -H \"Host: $host\" http://127.0.0.1:${diag_port}/api/health"
  curl -sv -H "Host: ${host}" "http://127.0.0.1:${diag_port}/api/health" 2>&1 | tail -60 || true

  kill -TERM "$diag_pid" 2>/dev/null || true
  wait "$diag_pid" 2>/dev/null || true

  log "diagnostics: first 5 lines of attempts.jsonl"
  head -n 5 "$WORKDIR/attempts.jsonl" 2>/dev/null || true

  log "diagnostics: kubectl get ksvc,route,kingress -A -o wide"
  kubectl get ksvc,route,kingress -A -o wide 2>&1 || true

  log "diagnostics: kourier gateway pod logs (last 30 lines each)"
  for p in $(kubectl -n kourier-system get pods -o name 2>/dev/null); do
    log "diagnostics: $p"
    kubectl -n kourier-system logs "$p" --all-containers --tail=30 2>&1 || true
  done
}

# ---------------------------------------------------------------------------
# Phase 5: assertions
# ---------------------------------------------------------------------------
phase5_assert() {
  log "phase 5: assertions"
  local status=0

  node "$ROOT/scripts/upgrade-e2e/ready-flap.mjs" "$WORKDIR/ready-samples.jsonl" "$READY_BOUND_SECONDS" \
    || status=1

  local error_budget_rc=0
  node "$ROOT/scripts/upgrade-e2e/error-budget.mjs" "$WORKDIR/attempts.jsonl" "$ERROR_BUDGET" \
    || error_budget_rc=1
  if [[ "$error_budget_rc" != "0" ]]; then
    status=1
    diagnose_traffic_failure
  fi

  # selfContained: a structural-schema `default: false` field (#1522) the
  # 0.4.3-era CR never set; a newer CRD's default can materialize onto the
  # existing CR on the next apply/reconcile. See cr-diff.mjs's docblock for
  # why this is the ONE tolerated case, not a general "ignore new fields"
  # policy.
  node "$ROOT/scripts/upgrade-e2e/cr-diff.mjs" "$WORKDIR/spec-before.json" "$WORKDIR/spec-after.json" \
    "selfContained" \
    || status=1

  return "$status"
}

# ---------------------------------------------------------------------------
# Phase 6: upgrade the CLI, exercise the config-rename guide, redeploy
# ---------------------------------------------------------------------------
phase6_new_cli_redeploy() {
  log "phase 6: upgrade the CLI and redeploy following the upgrade guide"
  local app
  app="$(cat "$WORKDIR/app-dir")"

  local new_knext
  if [[ -n "$NEW_CLI_VERSION" ]]; then
    local bin="$WORKDIR/new-cli"
    mkdir -p "$bin"
    npm install --prefix "$bin" "@getknext/core@${NEW_CLI_VERSION}" "kn-next@${NEW_CLI_VERSION}"
    new_knext="$bin/node_modules/.bin/kn-next"
  else
    # Build this tree's own CLI, same pattern the existing e2e_cli/e2e_rollback
    # suites use (utils.BuildCLI: `bun run --filter @getknext/core build`).
    (cd "$ROOT" && bun run --filter @getknext/core build)
    new_knext="$ROOT/packages/kn-next/dist/cli/kn-next.js"
  fi

  # Guide step 1: deploying with the OLD config filename must fail with the
  # ONE documented actionable rename error, not a silent fallback.
  local out
  set +e
  out="$(cd "$app" && node "$new_knext" deploy --image "$APP_IMAGE" --namespace "$APP_NAMESPACE" 2>&1)"
  local rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then
    log "FAIL: deploy under the old config filename unexpectedly succeeded"
    return 1
  fi
  if ! grep -q "knext.config.ts" <<<"$out" || ! grep -q "kn-next.config.ts" <<<"$out"; then
    log "FAIL: legacy-config error did not name both the old and new filenames as documented"
    echo "$out" >&2
    return 1
  fi
  log "guide step 1 confirmed: un-renamed config fails with the documented error"

  # Guide step 2: the documented fix.
  mv "$app/kn-next.config.ts" "$app/knext.config.ts"

  # Guide step 3: redeploy succeeds.
  (cd "$app" && node "$new_knext" deploy --image "$APP_IMAGE" --namespace "$APP_NAMESPACE")
  kubectl -n "$APP_NAMESPACE" wait --for=condition=Ready "nextapp/$APP_NAME" --timeout=180s
  log "guide steps confirmed: renamed config redeploys successfully under the new CLI"
}

# ---------------------------------------------------------------------------
main() {
  phase1_old_operator
  phase2_old_cli_deploy
  start_traffic
  start_ready_sampler
  # Let a few traffic/ready samples land before the upgrade starts, so the
  # "before" window is represented in both logs.
  sleep 5

  set +e
  phase4_upgrade_operator
  upgrade_rc=$?
  set -e

  # Give the post-upgrade state a moment to settle before sampling stops.
  sleep 10
  stop_traffic
  stop_ready_sampler

  if [[ $upgrade_rc -ne 0 ]]; then
    log "operator upgrade itself failed (rc=$upgrade_rc); assertions will also fail on empty/short traces"
  fi

  assert_rc=0
  phase5_assert || assert_rc=$?

  redeploy_rc=0
  phase6_new_cli_redeploy || redeploy_rc=$?

  if [[ $upgrade_rc -ne 0 || $assert_rc -ne 0 || $redeploy_rc -ne 0 ]]; then
    log "FAILED (upgrade_rc=$upgrade_rc assert_rc=$assert_rc redeploy_rc=$redeploy_rc)"
    exit 1
  fi
  log "PASSED"
}

main "$@"
