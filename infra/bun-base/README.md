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
| apt.llvm.org signing key | fingerprint `6084 F3CF 814B 57C1 CF12  EFD5 15CF 4D18 AF4F 7421` (`LLVM_SIGNER_FPR`), exactly one primary key, `signed-by` scoped to the LLVM source only |
| LLVM `clang/lld/llvm-23` | exact package version (`LLVM_PKG_VERSION`) |
| bootstrap Bun `1.4.2` zip | sha256 in `fetch-pins.sha256`, cross-checked against the release's `SHASUMS256.txt` |
| `rustup-init` | version `1.29.1` + sha256 in `fetch-pins.sha256`; no `curl sh.rustup.rs \| sh` |
| `apk-tools-static` | `APK_TOOLS_STATIC_VERSION` + sha256 in `fetch-pins.sha256` |
| prebuilt WebKit/JSC (per target) | sha256 in `fetch-pins.sha256`; version read from the source at the pinned SHA, so an upstream WebKit bump fails closed until re-pinned |
| Alpine sysroot packages | apk signature verification against the Alpine keys checked in under `keys/<arch>/` (from the digest-pinned `alpine:3.23` image; fingerprints in `keys/SHA256SUMS`) — no `--allow-untrusted` |
| Bun source | full commit SHA (`UPSTREAM_SHA`) |

apt.llvm.org and the Alpine CDN keep only the latest build, so when either rotates, the build **fails
closed** with a message naming the pin. Bump it: read the new version from the repository index,
record its sha256 from a fetch you verified, and commit.

**Prebuilt WebKit/JSC is pinned:** the prebuilt WebKit/JSC tarballs — one tarball per target in `fetch-pins.sha256`, named with the first 16 hex of the WebKit version read from the source — seeded into Bun's own
prefetch cache; the build fails unless its log shows it consumed exactly that cached file).

**Still not pinned** — every fetch in the build that has no sha256 pin, each with the reason. This block
is generated from `unpinned-fetches.json` (`node infra/bun-base/unpinned.mjs --write`), the same list
`tests/bun-base-supply-chain.test.ts` enforces. That test **parses** `build.sh` and `prefix.sh` with a
real bash parser (`mvdan-sh`, the parser behind `shfmt`) and walks the syntax tree against an
**allowlist**; anything it cannot parse or does not model fails CI rather than being skipped:

- every command name must be a literal word on the allowlist; network-capable commands (`curl`, `wget`,
  `git fetch`, `apt-get`, `rustup`, `apk.static`, `bun`) are accepted only in the exact argument shapes
  this script uses. Wrappers such as `timeout`, `env` or `xargs` are stripped before the check; a `curl`
  with a second output option (any spelling of `-o`/`-O`/`-fsSLo`/`-fsSLO`) is red outright — curl
  writes to the *first* one, so a scanner that read the *last* one disagreed with the interpreter
  about which file was actually verified (#1469 F1);
- each network command must run in the script's top-level flow (not in a branch, function, condition
  or `$( )`) and be followed, in the same statement list and before the next fetch, by its verifier —
  for a download, `pin` of the same file in the directory it was written to; for the build, the
  consumption `grep` plus the `tee` inside the build's own pipeline — or be listed below;
- only `pin()` and `lap()` may be defined, once, with the reviewed bodies; `prefix.sh` may define no
  function and fetch nothing;
- variables are assigned only from a fixed list, and `PATH`, `HOME`, `WS`, `SRC`, `OUT`, `LD`, `IFS`
  and `BUN_BUILD_PREFETCH_DIR` only as their one reviewed line — **including via `read`, not only
  `=`/`export`/`local`/`declare`**: `read` itself is checked against a fixed allowed shape (the one
  reviewed `IFS=: read -r _ apkarch root <<<"$pair"`), because `read -r PATH <<<…` or
  `read -r HOME <<<…` binds those names without ever writing an `=` assignment (#1469 F2); every
  redirection reads or writes a reviewed path, so no spelling of `/dev/tcp` gets through;
- **every variable has exactly one binding site.** The test finds binding sites by scanning: `=`
  (plain, prefix, `export`, `local`), `for NAME in`, and the names that `read`, `mapfile`/`readarray`,
  `printf -v`, `getopts` and `wait -p` bind. It reds any name bound twice, except `line` (pin()'s
  `local` plus its assignment), `have_patches` (a `no`/`yes` flag) and `wkarch` (one per `case` arm),
  each only at its exact reviewed sites. Because the verifiers are matched by their text, their
  operands are pinned too: `UPSTREAM_SHA`, `PREFIX`, `fpr`, `HEAD_SHA`, `headshort`, `wk`, `wkshort`,
  `wkurl`, `wkfile` and `wkkey` each have one reviewed derivation, and the committed pins
  (`LLVM_SIGNER_FPR` and the versions) must be static text. Without this, `LLVM_SIGNER_FPR="$fpr"`
  after the key download, or `UPSTREAM_SHA` rebound around its `rev-parse` check, left every check
  textually intact while making it compare a value with itself (#1469 round 11);
- **no arithmetic, array, subscript or slice, anywhere.** Bash evaluates `$(( ))`, `(( ))`, `let`,
  `for (( ))`, array subscripts, `${x:offset:length}`, `declare -i`, `[[ -eq ]]`/`[ -eq ]` and `-v`
  arithmetically, and that evaluator can assign variables and run command substitutions. Earlier
  versions tried to judge which uses were safe and kept missing a context, so the scripts now use none
  of them (`cut -c` instead of slices, a `case` and plain loops instead of arrays, a wall-clock stamp
  instead of lap arithmetic) and the test bans every one of them, together with `${!…}`, `:=`/`@`
  expansions, array assignments and any `declare`/`typeset`/`readonly` or flagged `export`/`local`;
- the bans are found by a **generic** walk that reads every field of every syntax node rather than the
  fields a visitor knows about, and every command, redirection, assignment, function, declaration and
  `$( )` that walk finds must also have been reached by the rule checks above (the counts are
  compared), so no part of the syntax tree can hold code the rules never saw;
- each entry below matches exactly its stated number of calls, and its `match` regex is rendered here,
  so widening one is a visible change.

<!-- unpinned-fetches:begin (generated by unpinned.mjs — do not edit) -->
- **The Ubuntu archive packages (apt-get update / install of the build tools).** (`build.sh`) — Signed by the keyring in the digest-pinned ubuntu:24.04 image, but not version-pinned: the archive serves whatever security update is current, and there is no immutable snapshot source wired in yet. The package NAME set is pinned by the guard. Matches `^apt-get (update|install)\b` (4 calls).
- **The Rust toolchain and musl targets that rustup pulls for rust-toolchain.toml.** (`build.sh`) — rustup checks each component against the channel manifest from the same origin (static.rust-lang.org); the toolchain version comes from the source tree at the pinned SHA, but the component bytes are not sha256-pinned here. Matches `^\S*rustup(-init)?\s` (3 calls).
- **The Alpine musl sysroot packages (musl-dev, g++, libstdc++-dev, linux-headers).** (`build.sh`) — The index and every package are verified against the checked-in Alpine keys (no --allow-untrusted), but the package versions are whatever v3.23/main serves that day; they are not individually pinned. Matches `^\S*apk\.static\s.*\sadd\b` (1 call).
- **npm packages installed by bun install --frozen-lockfile inside the Bun source tree.** (`build.sh`) — Integrity comes from the source tree's own lockfile at the pinned SHA, not from a pin held here. Matches `^bun install\b` (1 call).
- **Bun's dependency source tarballs (github.com/<repo>/archive/<commit>.tar.gz, fetched by scripts/build/fetch-cli.ts).** (`bun scripts/build.ts`) — Addressed by a commit hash pinned in Bun's own source, but the tarball bytes are never hashed, and GitHub does not promise byte-stable archives, so a sha256 pin would rot. This script cannot prefetch them without first knowing every URL, which only a build run reveals.
- **Cargo crates for Bun's Rust code.** (`bun scripts/build.ts`) — Resolved by cargo from the source tree's Cargo.lock (the build passes --locked, which pins versions and registry checksums), not re-checked by this script; git dependencies are pinned by commit.
<!-- unpinned-fetches:end -->

**Known limits of that test.** It reasons about the script's text, not about runtime values: a verifier
counts because it sits where it must run, and the scan does not evaluate what a variable such as
`$TARGETS` holds. What it does guarantee about values is their provenance: each verifier operand is
bound once, by its reviewed derivation, so no check can be made to compare a value with itself. It trusts the tools of the digest-pinned build image (`sha256sum`, `grep`, `curl`), and
it trusts `pin()` only because its body is compared with the reviewed version — changing `pin()`, or
adding a command shape, means changing the test in the same PR.

## Secret-scan hygiene

CI runs gitleaks over the **full git history of every branch**, fail-closed, and history is never
rewritten. So a public constant that merely *looks* like a credential will turn every open PR's
secret scan red, and the only fix is an allowlist entry. This happened once: a 40-hex key
fingerprint written as `NAME=<hex>` matched `generic-api-key`. Write constants so they cannot match:

- **Key fingerprints:** write them grouped, the way `gpg --fingerprint` prints them
  (`'6084 F3CF … 7421'`), and compare after stripping spaces (`${VAR// /}`).
- **sha256 pins:** put them in `fetch-pins.sha256` as `sha256sum` lines (`<hex>  <file>`), one per
  file, and verify them with `pin <file>` in `build.sh`. Never write `NAME=<hex>`.
- **Anything else 32+ hex or base64 characters long:** keep it out of `NAME=value` shapes, or run
  `node scripts/secret-scan.mjs` before pushing.

`tests/bun-base-supply-chain.test.ts` fails on any `NAME=<32+ hex>` assignment in `build.sh`.

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
