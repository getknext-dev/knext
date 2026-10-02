# knext-patched Bun toolchain (opt-in)

> **RETIREMENT — delete this directory** (with `packages/kn-next/src/cli/bun-toolchain.ts`, the
> `compile.bun` option, `.github/workflows/bun-patched-{release,e2e,drift-nightly}.yml`,
> `scripts/bun-patched-drift.mjs` and the
> `bun-patched-toolchain` registry entry) **once a stock Bun release ships oven-sh/bun#44059**
> (`--compile --include`). The `bun-patched-toolchain` probe in
> `tests/upstream-retirement/registry.ts` runs against the stock Bun on PATH and goes red on the
> first release that embeds through `--compile --include`; at that point the same `include` globs
> work with stock Bun.

`compile: { bun: 'knext-patched', include?: string[] }` in `knext.config.ts` (compiled vinext
executable only) makes `knext build` run the `bun build --compile` step with a release build of
**Bun 1.4.2 + oven-sh/bun#44059**,
downloaded from this repo's GitHub release and checked against the sha256 pinned in
`packages/kn-next/src/cli/bun-toolchain.ts` (fail closed — never a fallback to stock Bun). The
default is unchanged: the Bun on PATH, where `compile.include` embeds through extra entrypoints.
Opted in, `compile.include` is planned and checked by the SAME `planIncludes` (realpath root
containment, `..`/absolute patterns, secret-looking files, native addons, `node_modules` never
descended into) and the checked FILE LIST — never the raw globs — goes to Bun's native
`compile.include`, landing at the same `/$bunfs/root/<path>`; the build fails if a planned module
is not in the executable. User docs: `apps/docs/content/docs/
build-pipeline.mdx`, "Optional patched Bun toolchain".

Not to be confused with `infra/bun-base/`: that one is a **CI-only** patched base *executable*
(musl, a `main` commit, consumed through `KNEXT_BUN_BASE_EXE` inside GitHub Actions only). This
one is a user-facing, opt-in *compiler*: the shipped executable still runs on stock Bun's base for
its target (`bun-linux-*-musl`, which Bun downloads for a cross-target compile).

## Layout

| File | Purpose |
|---|---|
| `UPSTREAM` | `bun-v1.4.2 744846f8…` — the tag and the commit it must resolve to. |
| `patches/001-bun-44059-compile-include.patch` | The 17 non-merge commits of oven-sh/bun#44059 (`AhmedElBanna80/bun` `feat/compile-include`, head `903936e16a6b`), cherry-picked onto `bun-v1.4.2` **with no conflicts** and squashed; the commit list is in the patch header. `patches/SHA256SUMS` pins it. |
| `fetch-pins.sha256` | sha256 of every downloaded build input (bootstrap Bun zip, rustup-init, prebuilt WebKit per arch, gcc-13 focal debs per arch). |
| `sysroot.sh` | Step 1 (`ubuntu:20.04`): the glibc 2.31 + gcc-13 libstdc++ sysroot Bun's own release lanes link against. |
| `build.sh` | Step 2 (`ubuntu:24.04`): toolchain, `git am`, `bun scripts/build.ts --profile=release --abi=gnu --canary=off`, the WebKit prefetch proof, a glibc-symbol ceiling check (≤ 2.31), manifest. |
| `smoke.sh` | Step 3 (`ubuntu:20.04`, x64 only): runs the binary on glibc 2.31 and proves lazy `--include` from the executable, with stock 1.4.2 as the negative control. Re-run by the release workflow against the downloaded asset. |
| `cloudbuild.yaml` | One build per target (`_TARGET=x64` / `aarch64`), `E2_HIGHCPU_32`; syft SBOMs; sha256s; upload to `gs://gsw-mcp-bun-verify/bun-patched/<BUILD_ID>/`. |
| `RELEASE.sha256` | sha256 of each published binary — the release workflow refuses to sign anything else, and a unit test keeps it in lockstep with the pins knext embeds. |

## Releases

| Tag | Status |
|---|---|
| `bun-patched-1.4.2-knext.2` | **Current** (pinned by `bun-toolchain.ts`). Same x64 bytes as knext.1 plus the arm64 build, released through the gated workflow: pin check → x64 smoke + arm64 smoke on `ubuntu-24.04-arm` + the e2e on the verified draft binary → only then cosign + build-provenance attestations + publish. |
| `bun-patched-1.4.2-knext.1` | **Superseded by knext.2.** Its release run published BEFORE its e2e, and that e2e was red (the tag predates the e2e fix); x64 only, no attestation. Left in place (its bytes are identical to knext.2's x64 asset); no knext version pins it after this change. |

## Release procedure (a maintainer)

1. Cloud Build both targets (`gcloud builds submit --config deploy/bun-patched/cloudbuild.yaml
   --substitutions=_TARGET=x64`, then `_TARGET=aarch64`); outputs land in the private bucket.
2. Download the outputs with an authenticated `gcloud storage cp` (never make an object public) and
   create a DRAFT release `bun-patched-<ver>-knext.<n>` carrying both binaries, their SBOMs and
   manifests (`gh release create --draft`).
3. Commit their sha256s to `RELEASE.sha256` and to `PATCHED_BUN` in `bun-toolchain.ts` (tag,
   `baseUrl`, per-arch sha256) in one change — the unit tests keep them in lockstep.
4. Push the tag at that commit. `bun-patched-release.yml` runs every gate against the draft's
   bytes; a red gate leaves the release a draft and nothing is signed.
5. Ship a knext release: the pins are compiled into `@getknext/core`.

## Verifying a release by hand

```sh
TAG=bun-patched-1.4.2-knext.2
gh release download "$TAG" -R getknext-dev/knext
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity "https://github.com/getknext-dev/knext/.github/workflows/bun-patched-release.yml@refs/tags/$TAG" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS
sha256sum -c SHA256SUMS --ignore-missing
for f in bun-linux-x64 bun-linux-aarch64; do
  gh attestation verify "$f" -R getknext-dev/knext \
    --cert-identity "https://github.com/getknext-dev/knext/.github/workflows/bun-patched-release.yml@refs/tags/$TAG" \
    --source-ref "refs/tags/$TAG" --deny-self-hosted-runners
done
```

Both the signature and the attestations are made by the release workflow at the tag: they prove
that workflow checked the bytes against the committed pins, gated them and published them. They do
**not** attest the Cloud Build worker that compiled Bun (see Known limits).

## Drift

`bun-patched-drift-nightly.yml` (informational, not required) runs `scripts/bun-patched-drift.mjs`
nightly and goes red when a stock Bun newer than the pinned `bunVersion` has shipped — the patch has
to be refreshed (a 3-way apply), rebuilt, re-pinned and re-released. It also reports when
oven-sh/bun#44059 merges, the signal to retire this directory.

## Provenance of the knext.2 binaries (the x64 one is byte-identical to knext.1's)

| | |
|---|---|
| Upstream | `oven-sh/bun` tag `bun-v1.4.2` = `744846f844374847c902b5e7fd59b4342a51ef99` |
| Patch | `001-bun-44059-compile-include.patch` (sha256 in `patches/SHA256SUMS`) |
| Patched HEAD (Bun's `--revision`) | `cc97fa8340b1a113df377acba0d6b3d1b97d86e1` → `bun --revision` prints `1.4.2+cc97fa834` |
| Toolchain | clang/lld `21.1.8` (apt.llvm.org `1:21.1.8~++20251221032922+2078da43e25a-1~exp1~20251221153059.70`), rustc `1.99.0-nightly (9f36de775 2026-07-19)` (bun-v1.4.2's `rust-toolchain.toml`), bootstrap Bun 1.4.2, prebuilt WebKit `2e2aa2290fac856d6f451ceacb58f7f5b44dd057` (non-LTO, sha256-pinned) |
| Recipe | this directory as of commit `e5d94c69` (two later edits are cosmetic for the binary: the clone's remote is named `upstream`, and the build-info JSON records the WebKit version's first 16 hex) |
| linux-x64 | Cloud Build `67b747f8-4b26-4cd2-9796-3bce024ca7db` — sha256 `2f1bb84ad480fce9e618b8bf4b7eb4553d5a1179d2013c7d22cbe054ca271df3`, 75,109,864 bytes, highest glibc symbol `GLIBC_2.17`; smoke on ubuntu:20.04: startup `MAIN_START` only, on demand `PLUGIN_EVALUATED` + `RESULT plugin-ok`, stock 1.4.2 control `Cannot find module './plugins/p.js'` |

| linux-arm64 | Cloud Build `b35c5945-54c5-4926-80bb-eff254a0e4c4` — sha256 `aa931626fc2707aaf1911a99ee57d9de05ad3dc76bf3cc6e14b0497a5f6bb35a`, 78,212,872 bytes, same patched HEAD, highest glibc symbol `GLIBC_2.17`; cross-compiled on x64, published in knext.2 only through the arm64 smoke gate on `ubuntu-24.04-arm`. |

## Known limits

- **Signature scope.** The release workflow signs `SHA256SUMS` keyless with its own GitHub OIDC
  identity. That attests "this workflow, at this tag, checked these bytes against the committed
  pins and signed them" — not that the Cloud Build worker was honest. The worker ran as the
  project's default build service account (the dedicated least-privilege account described in
  `infra/bun-base/README.md` is not provisioned).
- **`knext build` checks the sha256, not the signature or the attestation.** No offline sigstore
  verifier ships in knext; the pinned sha256 is the binding check. The manual `cosign verify-blob`
  and `gh attestation verify` are above.
- **Not every fetch is pinned.** As in `infra/bun-base`: apt packages (Ubuntu archive, LLVM by
  version only), the Rust toolchain components, npm packages from the Bun tree's own lockfile,
  Bun's dependency source tarballs and cargo crates (by commit / `Cargo.lock`) are not sha256-pinned
  here. A rebuild is therefore reproducible only against that day's toolchain.
- **musl is not built on purpose.** On a musl build host compiling for the musl ship target, Bun
  would embed the compiler itself as the shipped runtime — this toolchain is for the compile step
  only. `knext build` refuses the opt-in on musl and macOS hosts with a clear error.
- **Native `--include` takes relative paths only.** knext passes the planned files `./`-relative to
  the compile cwd (the app root) and refuses to compile if the two differ. knext's own embed trees
  (self-contained mode) keep the extra-entrypoint path.
- **Native addons are refused.** An included `.node` compiles silently and then fails at runtime
  ("Cannot find module"), so `planIncludes` rejects it in both modes with a pointer to a static
  `require()`.
- **Slower, non-LTO compiler.** ~4–5% slower than stock on CPU-bound work (prebuilt non-LTO
  WebKit); it runs the compile step only, so the shipped executable is unaffected.
