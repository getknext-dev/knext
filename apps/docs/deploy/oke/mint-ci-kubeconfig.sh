#!/usr/bin/env bash
# Mint the docs deploy workflow's cluster credential and store it as the
# KNEXT_DOCS_KUBECONFIG_B64 secret of the `docs-oke` environment.
#
#   apps/docs/deploy/oke/mint-ci-kubeconfig.sh <admin-kube-context>
#
# Run by a cluster admin after `kubectl apply -f ci-rbac.yaml`. The admin
# context is used ONLY to read the API server address and the knext-deployer
# token; the kubeconfig it writes authenticates as knext-deployer and nothing
# else. Nothing sensitive is printed: the kubeconfig lives in a 0600 temp file
# that is piped straight into `gh secret set` and deleted on exit.
set -euo pipefail

ctx="${1:?usage: $0 <admin-kube-context>}"
ns=knext-docs
sa=knext-deployer
secret=knext-deployer-token
repo="${GH_REPO:-getknext-dev/knext}"

umask 077
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

server="$(kubectl --context "$ctx" config view --minify --raw -o jsonpath='{.clusters[0].cluster.server}')"
token="$(kubectl --context "$ctx" -n "$ns" get secret "$secret" -o jsonpath='{.data.token}' | base64 -d)"
ca="$(kubectl --context "$ctx" -n "$ns" get secret "$secret" -o jsonpath='{.data.ca\.crt}')"
[ -n "$server" ] && [ -n "$token" ] && [ -n "$ca" ] || {
  echo "missing server, token or CA — is ci-rbac.yaml applied and the token Secret populated?" >&2
  exit 1
}

cat > "$tmp/kubeconfig" <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: oke-cluster
    cluster:
      server: ${server}
      certificate-authority-data: ${ca}
users:
  - name: ${sa}
    user:
      token: ${token}
contexts:
  - name: ${sa}@oke-cluster
    context:
      cluster: oke-cluster
      user: ${sa}
      namespace: ${ns}
current-context: ${sa}@oke-cluster
EOF

# Prove the credential is the scoped one before storing it: it must be able to
# write NextApps in the namespace and must NOT be able to read Secrets.
KUBECONFIG="$tmp/kubeconfig" kubectl auth can-i patch nextapps.apps.kn-next.dev -n "$ns" >/dev/null
if KUBECONFIG="$tmp/kubeconfig" kubectl auth can-i get secrets -n "$ns" >/dev/null 2>&1; then
  echo "refusing: the minted credential can read Secrets — it is not the scoped one" >&2
  exit 1
fi

base64 < "$tmp/kubeconfig" | tr -d '\n' > "$tmp/kubeconfig.b64"
# Environment-scoped, not repository-scoped: the `docs-oke` environment only
# admits jobs running on `main`, so a pull request that edits the workflow
# still cannot read this secret.
gh secret set KNEXT_DOCS_KUBECONFIG_B64 --repo "$repo" --env docs-oke < "$tmp/kubeconfig.b64"
echo "KNEXT_DOCS_KUBECONFIG_B64 updated in environment docs-oke of $repo (credential: $sa in $ns)."
