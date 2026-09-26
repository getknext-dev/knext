# Patched Bun base executable (maintainers only)

A release build of Bun from a pinned `oven-sh/bun` commit plus our local patches, used **only in CI**
to verify upstream Bun fixes against knext's compile *before* Bun releases them.

## What this is NOT for

- **Not shipped to users.** No `@getknext/*` package, image, or release asset contains it. Users get
  knext-side shims on stock Bun (founder decision A, 2026-09-26). If that ever changes, it is a
  supply-chain decision that needs its own review, not a flag flip.
- **Not a config option.** The only consumer seam is the `KNEXT_BUN_BASE_EXE` environment variable
  read by `packages/kn-next/src/adapters/{vinext,standalone}-compile.mjs`. It is deliberately not a
  `kn-next.config.ts` key or CLI flag, and a guard test fails if one appears.
- **Not a fork.** Every patch here tracks an upstream PR and is deleted when that PR ships.

## Layout

| File | Purpose |
|---|---|
| `UPSTREAM_SHA` | The pinned `oven-sh/bun` commit (first non-comment line) and why it was chosen. |
| `patches/*.patch` | `git format-patch` output against `UPSTREAM_SHA`, applied in order with `git am`. |
| `prefix.sh` | Prints `<upstream-sha>-<patchset-hash>`, the artifact prefix. Shared by the build and the workflow. |
| `build.sh` | The Cloud Build step: toolchain, musl sysroots, clone, `git am`, release build, manifest. |
| `cloudbuild.yaml` | Build (`E2_HIGHCPU_32`, ~$0.064/build-minute), syft SBOM, sha256 files, upload. |
| `../../.github/workflows/bun-base-build.yml` | Submits the build, verifies, signs, smoke-tests, and stores the 7-day artifact. |

Artifacts land in `gs://gsw-mcp-bun-base/<upstream-sha>-<patchset-hash>/<BUILD_ID>/` (the bucket
deletes objects after 30 days): `bun-linux-{x64,aarch64}-musl` and a `.sha256` for each,
`bun-source.cdx.json` (CycloneDX SBOM of the patched source tree), `manifest.json`, `SHA256SUMS`, and
`SHA256SUMS.sigstore.json`, which the workflow adds.

## Adding a patch

1. Check out `oven-sh/bun` at the SHA in `UPSTREAM_SHA` and apply or cherry-pick the upstream change.
2. Commit it with a message that names **both** the upstream issue or PR and the F1 shim-registry id
   it retires:

   ```
   compile: resolve --compile-include entries from the exec dir

   Upstream: oven-sh/bun#44059
   knext-shim: standalone-include-flatten
   ```

3. `git format-patch -1 -o <knext>/infra/bun-base/patches/`, then rename the file to
   `<nnn>-<upstream-issue>-<slug>.patch`, e.g. `001-bun-44059-compile-include.patch`.
   `build.sh` refuses a patch with a bad filename or without either header line, and it does so
   before any paid build minutes are spent.
4. Dispatch **bun-base-build**. The prefix changes whenever any patch is added, renamed, or edited.

## Bumping the SHA

Choose a `main` commit whose Buildkite status and GitHub check-runs are all green. Put it in
`UPSTREAM_SHA` and update the comment that explains the choice. Rebase each patch onto the new
commit (`git am` has to apply cleanly). Delete any patch whose upstream PR is already in the new
SHA, and delete its knext shim in the same PR. The toolchain versions in `build.sh` (LLVM major,
Alpine release) follow `scripts/build/ci-images/spec.ts` at the pinned SHA, so check that file as
well.

## Consuming it in a lane

```sh
# after downloading the workflow artifact into ./bun-base
cosign verify-blob --bundle bun-base/SHA256SUMS.sigstore.json \
  --certificate-identity "https://github.com/getknext-dev/knext/.github/workflows/bun-base-build.yml@refs/heads/main" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com bun-base/SHA256SUMS
(cd bun-base && sha256sum -c SHA256SUMS)
chmod +x bun-base/bun-linux-x64-musl
KNEXT_BUN_BASE_EXE="$PWD/bun-base/bun-linux-x64-musl" kn-next build ...
```

The compile scripts check this themselves and exit 1 if the variable is set but its file is
missing, is not executable, lacks a sibling `.sha256`, or does not match it. They never fall back
to stock Bun without saying so. The binaries are musl builds, so the compile itself must target
`bun-linux-x64-musl` or `bun-linux-arm64-musl`.

## Signing, and what it attests

Cloud Build has no ambient OIDC identity that Fulcio accepts. This was measured, not assumed: its
metadata `identity` endpoint returns 404, and `gcloud auth print-identity-token` fails. So the
**workflow** signs `SHA256SUMS` keyless, with the GitHub OIDC token of
`bun-base-build.yml@refs/heads/main`. That signature attests "this workflow submitted Cloud Build
`<id>` from this commit and received exactly these bytes". It does not attest that the Cloud Build
worker is trustworthy. The trust root for the worker is the gsw-mcp project.

## Reproducibility

Two builds of the same `UPSTREAM_SHA` with an empty patchset were compared on x64. The result is in
the PR that introduced this pipeline (#1452) and in the table below. The toolchain is fetched at
build time rather than pinned by digest: apt.llvm.org LLVM, rustup nightly, and the Alpine CDN
sysroot. A match therefore shows reproducibility only against today's toolchain. It is not a
guarantee.

| Date | SHA | Builds | x64 sha256 match |
|---|---|---|---|
| 2026-09-26 | b12539ce | _see #1452_ | _see #1452_ |

The aarch64 binary is cross-compiled and checked only for format (`file`). Nothing executes it.

## Provisioning — FOUNDER ACTION REQUIRED (one-time GCP IAM; not done by an agent)

The workflow reads two repository **variables** (not secrets; neither value is sensitive):
`GCP_WIF_PROVIDER` and `GCP_BUN_BASE_SA`. Until both exist it fails closed at its first step. It never
falls back to a static key — `tests/bun-base-workflow-auth.test.ts` reds on `credentials_json`,
`GOOGLE_APPLICATION_CREDENTIALS` or any `secrets.*` in the workflow.

Least privilege: one dedicated service account, federated only for this workflow on `main`, with
`cloudbuild.builds.editor` (submit/describe), `actAs` on the default build SA (builds run as it),
and `storage.objectAdmin` on `gs://gsw-mcp-bun-base` only (the workflow stages its build source under
`_source/` there, so the shared `gs://gsw-mcp_cloudbuild` bucket is not needed).

```sh
P=gsw-mcp; N=596588086796; SA=bun-base-ci@$P.iam.gserviceaccount.com
gcloud iam workload-identity-pools create github --project $P --location global
gcloud iam workload-identity-pools providers create-oidc knext --project $P --location global \
  --workload-identity-pool github --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping 'google.subject=assertion.sub,attribute.repository=assertion.repository' \
  --attribute-condition "assertion.repository == 'getknext-dev/knext' && assertion.workflow_ref.startsWith('getknext-dev/knext/.github/workflows/bun-base-build.yml@refs/heads/main')"
gcloud iam service-accounts create bun-base-ci --project $P
gcloud iam service-accounts add-iam-policy-binding $SA --project $P --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$N/locations/global/workloadIdentityPools/github/attribute.repository/getknext-dev/knext"
gcloud projects add-iam-policy-binding $P --member serviceAccount:$SA --role roles/cloudbuild.builds.editor
gcloud iam service-accounts add-iam-policy-binding $N-compute@developer.gserviceaccount.com --project $P \
  --member serviceAccount:$SA --role roles/iam.serviceAccountUser
gcloud storage buckets add-iam-policy-binding gs://gsw-mcp-bun-base --member serviceAccount:$SA --role roles/storage.objectAdmin
gh variable set GCP_WIF_PROVIDER -R getknext-dev/knext \
  --body projects/$N/locations/global/workloadIdentityPools/github/providers/knext
gh variable set GCP_BUN_BASE_SA -R getknext-dev/knext --body $SA
```

The attribute condition pins the repository **and** this workflow on `main`, so a dispatch from any
other branch or workflow cannot mint a token that spends build minutes.
