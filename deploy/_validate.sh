#!/bin/sh
# Validation for deploy/ manifests: server-side dry-run against the current
# kube context, plus contract checks the YAML must satisfy. Run from repo root
# or deploy/. Exits non-zero on any failure.
set -eu
cd "$(dirname "$0")"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

command -v kubectl >/dev/null || fail "kubectl not found"

# 1. every manifest must dry-run apply cleanly (server-side validation)
for f in [0-9][0-9]-*.yaml; do
  [ -e "$f" ] || fail "no numbered manifests found in deploy/"
  kubectl apply --dry-run=server -f "$f" >/dev/null || fail "$f does not validate"
  ok "$f validates (server dry-run)"
done

# 2. contract: compute deployment must start at zero replicas
grep -q 'replicas: 0' 20-compute.yaml || fail "20-compute.yaml must set replicas: 0"
ok "compute starts at zero"

# 3. contract: gateway RBAC may scale deployments (scale subresource)
grep -q 'deployments/scale' 10-gateway.yaml || fail "gateway RBAC lacks deployments/scale"
ok "gateway RBAC includes deployments/scale"

# 4. contract: gateway runs in kubectl mode against the compute deployment
grep -q 'GW_COMPUTE_MODE' 10-gateway.yaml || fail "gateway env GW_COMPUTE_MODE missing"
ok "gateway wake mode configured"

# 5. contract: knext consumes the DB only via a DATABASE_URL secret
grep -q 'DATABASE_URL' 30-knext-secret.yaml || fail "knext secret lacks DATABASE_URL"
ok "knext DATABASE_URL secret present"

echo "deploy validation: all checks passed"
