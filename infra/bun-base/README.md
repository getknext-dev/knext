# Patched Bun base executable (maintainers only)

A release build of Bun from a pinned `oven-sh/bun` commit plus our local patches, used **only in CI**
to verify upstream Bun fixes against knext's compile *before* Bun releases them.

## What this is NOT for

- **Not shipped to users.** No `@getknext/*` package, image, or release asset contains the patched
  binary. Users get knext-side shims on stock Bun (founder decision A, 2026-09-26). If that ever
  changes, it is a supply-chain decision that needs its own review, not a flag flip.
- **Not a user option.** The only consumer seam is the `KNEXT_BUN_BASE_EXE` environment variable
  read by `packages/kn-next/src/adapters/{vinext,standalone}-compile.mjs`. It is deliberately not a
  `kn-next.config.ts` key or CLI flag, and a guard test fails if one appears. Those compile scripts
  are bundled into the published `@getknext/core`, so the variable *does* exist in what users
  install — which is why it is **refused unless `GITHUB_ACTIONS=true`**: anywhere else a set
  `KNEXT_BUN_BASE_EXE` fails the compile with a "CI-only" error. That is a guard against accidental
  use, not a security boundary (anyone can export `GITHUB_ACTIONS=true`, and whoever sets a build's
  environment already controls the build).
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
deletes objects after 30 days): `bun-linux-{x64,aarch64}-musl` and a `.sha256` for each, two
CycloneDX SBOMs — `bun-source.cdx.json` (the patched source tree) and `bun-artifacts.cdx.json` (the
built binaries, with each file's sha256; syft identifies little *inside* a Zig/C++ binary, so this one
mostly binds the SBOM to the exact bytes) — `manifest.json`, `SHA256SUMS`, and
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

## Consuming it in a lane (GitHub Actions only)

The seam is refused outside a GitHub Actions job (`GITHUB_ACTIONS=true`), so this recipe is for a
workflow step, not a laptop.

```sh
# in a GitHub Actions step, after downloading the workflow artifact into ./bun-base
cosign verify-blob --bundle bun-base/SHA256SUMS.sigstore.json \
  --certificate-identity "https://github.com/getknext-dev/knext/.github/workflows/bun-base-build.yml@refs/heads/main" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com bun-base/SHA256SUMS
(cd bun-base && sha256sum -c SHA256SUMS)
chmod +x bun-base/bun-linux-x64-musl
KNEXT_BUN_BASE_EXE="$PWD/bun-base/bun-linux-x64-musl" kn-next build ...
```

The compile scripts check this themselves and exit 1 if the variable is set outside GitHub Actions,
or its file is missing, is not executable, lacks a sibling `.sha256`, or does not match it. The
`.sha256` must be a single line (a bare digest, or `sha256sum` output naming this file) — pointing
it at a multi-line `SHA256SUMS` is refused. Symlinks are followed, not confined: the sha256 is what
binds the bytes, so point the variable only at the signature-verified download. They never fall back
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
build time (see "Toolchain pins" for what is and is not pinned). A match therefore shows
reproducibility only against that day's toolchain. It is not a guarantee. The row below predates the
pins and the dedicated build service account; it is re-run once provisioning is done.

| Date | SHA | Builds | x64 sha256 match |
|---|---|---|---|
| 2026-09-26 | b12539ce | `9a2d4c23`, `455d16b9` | **yes** — both `38f38e7649d71274ee94c2b9ab21aee1917d78d8af8c6686498340e696462ba9` (74,671,944 bytes, `cmp` 0 differing bytes) |

The SBOM and `manifest.json` differ between builds by design: they carry the build id and the SBOM's
serial number and timestamp. Only the binaries are compared.

The aarch64 binary is cross-compiled and checked only for format (`file`). Nothing executes it.

## Toolchain pins

`build.sh` checks each fetch against a value committed in the repo, not a digest served by the same
origin:

| Fetch | Pinned by |
|---|---|
| apt.llvm.org signing key | fingerprint `6084F3CF814B57C1CF12EFD515CF4D18AF4F7421`, exactly one primary key, `signed-by` scoped to the LLVM source only |
| LLVM `clang/lld/llvm-23` | exact package version (`LLVM_PKG_VERSION`) |
| bootstrap Bun `1.4.2` zip | sha256 (`BOOTSTRAP_BUN_ZIP_SHA256`), cross-checked against the release's `SHASUMS256.txt` |
| `rustup-init` | version `1.29.1` + sha256 (`RUSTUP_INIT_SHA256`); no `curl sh.rustup.rs \| sh` |
| `apk-tools-static` | version + sha256 (`APK_TOOLS_STATIC_*`) |
| Alpine sysroot packages | apk signature verification against the Alpine keys checked in under `keys/<arch>/` (from the digest-pinned `alpine:3.23` image; fingerprints in `keys/SHA256SUMS`) — no `--allow-untrusted` |
| Bun source | full commit SHA (`UPSTREAM_SHA`) |

apt.llvm.org and the Alpine CDN keep only the latest build, so when either rotates, the build **fails
closed** with a message naming the pin. Bump it: read the new version from the repository index,
record its sha256 from a fetch you verified, and commit.

**Still not pinned** — trusted via TLS and, where applicable, the upstream's own signed metadata:
the Ubuntu archive packages (signed by the keyring in the digest-pinned `ubuntu:24.04` image, but
not version-pinned); the Rust toolchain that `rustup toolchain install` pulls for `rust-toolchain.toml`
(rustup checks each component against the channel manifest from the same origin); the Alpine
repository contents beyond their signature (the index is signed, but the package versions are
whatever `v3.23/main` serves that day); and `bun install --frozen-lockfile` inside the Bun source
tree (integrity from Bun's own lockfile).

## Provisioning — FOUNDER ACTION REQUIRED (one-time GCP IAM; not done by an agent)

The workflow reads two repository **variables** (not secrets; neither value is sensitive):
`GCP_WIF_PROVIDER` and `GCP_BUN_BASE_SA`. Until both exist it fails closed at its first step. It never
falls back to a static key — `tests/bun-base-workflow-auth.test.ts` reds on `credentials_json`,
`GOOGLE_APPLICATION_CREDENTIALS` or any `secrets.*` in the workflow.

Least privilege, two service accounts, neither with any project-wide storage or Editor role:

- **`bun-base-build`** — the identity the Cloud Build *runs as* (`serviceAccount:` in
  `cloudbuild.yaml`; never the default `$N-compute@developer` SA, which holds project Editor).
  `roles/storage.objectCreator` + `roles/storage.objectViewer` on `gs://gsw-mcp-bun-base` only
  (read the staged source, write new artifact objects — no delete/overwrite, never `objectAdmin`),
  and `roles/logging.logWriter`.
- **`bun-base-ci`** — the identity GitHub Actions federates into. `roles/cloudbuild.builds.editor`
  (submit/describe), `roles/iam.serviceAccountUser` on **`bun-base-build` only** (so it can start
  builds as that SA and no other), and `objectCreator` + `objectViewer` on `gs://gsw-mcp-bun-base`
  only (stage source under `_source/`, download the artifacts, store the signature).

```sh
P=gsw-mcp; N=596588086796; B=gs://gsw-mcp-bun-base
CI=bun-base-ci@$P.iam.gserviceaccount.com; BUILD=bun-base-build@$P.iam.gserviceaccount.com
# federation
gcloud iam workload-identity-pools create github --project $P --location global
gcloud iam workload-identity-pools providers create-oidc knext --project $P --location global \
  --workload-identity-pool github --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping 'google.subject=assertion.sub,attribute.repository=assertion.repository' \
  --attribute-condition "assertion.repository == 'getknext-dev/knext' && assertion.workflow_ref.startsWith('getknext-dev/knext/.github/workflows/bun-base-build.yml@refs/heads/main')"
# the build's runtime identity
gcloud iam service-accounts create bun-base-build --project $P
gcloud projects add-iam-policy-binding $P --member serviceAccount:$BUILD --role roles/logging.logWriter
gcloud storage buckets add-iam-policy-binding $B --member serviceAccount:$BUILD --role roles/storage.objectCreator
gcloud storage buckets add-iam-policy-binding $B --member serviceAccount:$BUILD --role roles/storage.objectViewer
# the workflow's federated identity
gcloud iam service-accounts create bun-base-ci --project $P
gcloud iam service-accounts add-iam-policy-binding $CI --project $P --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$N/locations/global/workloadIdentityPools/github/attribute.repository/getknext-dev/knext"
gcloud projects add-iam-policy-binding $P --member serviceAccount:$CI --role roles/cloudbuild.builds.editor
gcloud iam service-accounts add-iam-policy-binding $BUILD --project $P \
  --member serviceAccount:$CI --role roles/iam.serviceAccountUser
gcloud storage buckets add-iam-policy-binding $B --member serviceAccount:$CI --role roles/storage.objectCreator
gcloud storage buckets add-iam-policy-binding $B --member serviceAccount:$CI --role roles/storage.objectViewer
gh variable set GCP_WIF_PROVIDER -R getknext-dev/knext \
  --body projects/$N/locations/global/workloadIdentityPools/github/providers/knext
gh variable set GCP_BUN_BASE_SA -R getknext-dev/knext --body $CI
```

Not yet exercised under these exact grants (it needs the SAs above to exist): if `gcloud builds
submit` is refused bucket metadata on the staging bucket, add `roles/storage.legacyBucketReader` on
`$B` for `$CI` — bucket metadata read only, still no delete. The existing reproducibility evidence
(builds `9a2d4c23`, `455d16b9`) ran as the default compute SA before this was pinned; the first
dispatch after provisioning re-runs it under `bun-base-build`.

The attribute condition pins the repository **and** this workflow on `main`, so a dispatch from any
other branch or workflow cannot mint a token that spends build minutes.
