# Runbook — first operator-image publish (bootstrap)

> Issue #117. This is the **maintainer** step that converts the committed
> all-zeros bootstrap placeholder digest into a real, signed, digest-pinned
> operator image and bundle. It is a **human action on `main`** — it cannot be
> done from a feature branch, because the supply-chain workflow publishes only on
> push to `main` (keyless cosign signing needs the `main` OIDC identity, and we
> do not sign throwaway PR images).

## What currently ships (pre-publish)

- `config/manager/kustomization.yaml` and the rendered `dist/install.yaml` pin the
  operator image to a **deliberately-fake all-zeros placeholder digest**:
  `ghcr.io/getknext-dev/kn-next-operator:v0.1.0@sha256:0000…0000`.
- The placeholder is intentional: `hack/check-no-latest.sh` (per-PR) accepts it
  (it rejects `:latest` / bare tags, not unreachable digests), so the bundle stays
  digest-pinned and guard-clean before the image exists.
- The operator image is **not yet published** at
  `ghcr.io/getknext-dev/kn-next-operator`.

## The first publish (one-time, on `main`)

1. **Confirm org/CI permissions** (founder/CI-config gate). The
   `operator-image-supply-chain` job in
   [`.github/workflows/operator-supply-chain.yml`](../../../.github/workflows/operator-supply-chain.yml)
   already requests:
   - `packages: write` — push to GHCR with the built-in `GITHUB_TOKEN`;
   - `id-token: write` — cosign keyless signing via Sigstore/Fulcio OIDC;
   - `contents: write` — create/update the `operator-latest` Release that carries
     `install.yaml`.

   In the GitHub org settings ensure Actions are allowed to write packages and that
   the `GITHUB_TOKEN` default permissions are not lowered below the job's request.
   No extra repo secrets are required.

2. **Merge a change under `packages/kn-next-operator/**` to `main`** (this PR
   qualifies). On that push the workflow:
   - builds + pushes `ghcr.io/getknext-dev/kn-next-operator:<sha>` **by digest**;
   - generates an SBOM (syft, SPDX-JSON) and Trivy-scans it (fails on HIGH/CRITICAL);
   - `cosign sign` + `cosign attest` (keyless) the **exact pushed digest**;
   - **`cosign verify`** the signature it just produced
     (`hack/cosign-verify.sh`, parameterized by the pushed digest);
   - rewrites `config/manager/kustomization.yaml` and re-renders
     `dist/install.yaml` with the **real** `@sha256:` digest;
   - runs **`hack/check-published-digest.sh`** — fails the run if the all-zeros
     placeholder somehow survived the re-pin (so a placeholder can never ship);
   - publishes `dist/install.yaml` as the `operator-latest` GitHub Release asset,
     so `releases/latest/download/install.yaml` resolves.

3. **Commit the real digest back to the repo.** The workflow re-pins
   `dist/install.yaml` for the Release asset, but the **committed**
   `config/manager/kustomization.yaml` still carries the placeholder. After the
   first successful publish, read the real digest and commit it:

   ```sh
   docker pull ghcr.io/getknext-dev/kn-next-operator:<sha>
   docker inspect --format='{{index .RepoDigests 0}}' \
     ghcr.io/getknext-dev/kn-next-operator:<sha>
   # → ghcr.io/getknext-dev/kn-next-operator@sha256:<real>
   ```

   Edit `config/manager/kustomization.yaml` so the single combined `newTag:` line
   reads `newTag: v0.1.0@sha256:<real>` (keep the combined form — do **not** run
   `kustomize edit set image`, which splits it into bare `newTag:`/`digest:` fields
   that `hack/check-no-latest.sh` rejects). Then `make build-installer` and commit.

## Verify (anyone, post-publish)

```sh
# 1) Signature — keyless identity pinned to this repo's CI:
bash packages/kn-next-operator/hack/cosign-verify.sh \
  ghcr.io/getknext-dev/kn-next-operator@sha256:<real>

# 2) The published bundle pins a real (non-zero) digest, no :latest:
bash packages/kn-next-operator/hack/check-published-digest.sh \
  packages/kn-next-operator/dist/install.yaml

# 3) Clean-cluster install (cert-manager + Knative Serving + Kourier present):
kubectl apply --server-side -f \
  https://github.com/getknext-dev/knext/releases/latest/download/install.yaml
kubectl wait --for=condition=Available --timeout=300s \
  -n kn-next-operator-system deployment/kn-next-operator-controller-manager

# 4) A digest-pinned NextApp reconciles to Ready (the image MUST be @sha256:-pinned;
#    the webhook rejects :latest / tag-only refs):
kubectl apply -f - <<'EOF'
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: smoke-app
  namespace: default
spec:
  image: "ghcr.io/getknext-dev/file-manager@sha256:<real-app-digest>"
  scaling: { minScale: 0, maxScale: 1 }
EOF
kubectl get nextapp smoke-app -o \
  jsonpath='{.status.conditions[?(@.type=="Ready")].status}{"\n"}{.status.url}'
```

## Automated coverage (so this stays honest)

- **Bundle correctness** (per-PR, no cluster): `internal/install/*_test.go` asserts
  `dist/install.yaml` carries the CRD(s) + RBAC + manager Deployment, is
  digest-pinned, never `:latest`, and that the namespace transformer does not
  rewrite the Knative ConfigMaps. Gated by `make test` with `KNEXT_REQUIRE_BUNDLE=1`.
- **Published-context guard** (release only): `hack/check-published-digest.sh`,
  wired into `operator-supply-chain.yml` after the re-pin.
- **cosign verify** (release only): `hack/cosign-verify.sh`, wired into
  `operator-supply-chain.yml` after `cosign sign`.
- **Install-bundle live e2e** (kind, own workflow): `test/e2e/install_bundle_test.go`
  (`e2e_bundle` tag) builds the operator image **locally**, loads it into kind,
  applies `dist/install.yaml` with the manager image overridden to the local image,
  waits for Available, and asserts a digest-pinned NextApp reaches Ready — run by
  [`.github/workflows/operator-bundle-e2e.yml`](../../../.github/workflows/operator-bundle-e2e.yml)
  and `make test-e2e-bundle`. It never depends on the placeholder image existing,
  so it verifies the client path **before** the first publish.

## What is deferred to the maintainer

The single irreversible bootstrap — pushing the **first** real signed image to
GHCR and committing its digest — is a human `main` action (step 2–3 above). It
cannot be done from this branch. Everything else (bundle guards, cosign-verify
wiring, the local-image bundle e2e) is implemented and verifiable now.
