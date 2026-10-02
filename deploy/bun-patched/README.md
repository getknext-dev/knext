# knext-patched Bun toolchain (opt-in)

> **RETIREMENT — delete this directory** (with `packages/kn-next/src/cli/bun-toolchain.ts`, the
> `compile.bun` option, `.github/workflows/bun-patched-{release,e2e}.yml` and the
> `bun-patched-toolchain` registry entry) **once a stock Bun release ships oven-sh/bun#44059**
> (`--compile --include`). The `bun-patched-toolchain` probe in
> `tests/upstream-retirement/registry.ts` runs against the stock Bun on PATH and goes red on the
> first release that embeds through `--compile --include`; at that point the same `include` globs
> work with stock Bun.

`compile: { bun: 'knext-patched', include?: string[] }` in `knext.config.ts` makes `knext build`
run the `bun build --compile` step with a release build of **Bun 1.4.2 + oven-sh/bun#44059**,
downloaded from this repo's GitHub release and checked against the sha256 pinned in
`packages/kn-next/src/cli/bun-toolchain.ts` (fail closed — never a fallback to stock Bun). The
default (no `compile` block) is unchanged: the Bun on PATH. User docs: `apps/docs/content/docs/
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

## Provenance of `bun-patched-1.4.2-knext.1`

| | |
|---|---|
| Upstream | `oven-sh/bun` tag `bun-v1.4.2` = `744846f844374847c902b5e7fd59b4342a51ef99` |
| Patch | `001-bun-44059-compile-include.patch` (sha256 in `patches/SHA256SUMS`) |
| Patched HEAD (Bun's `--revision`) | `cc97fa8340b1a113df377acba0d6b3d1b97d86e1` → `bun --revision` prints `1.4.2+cc97fa834` |
| Toolchain | clang/lld `21.1.8` (apt.llvm.org `1:21.1.8~++20251221032922+2078da43e25a-1~exp1~20251221153059.70`), rustc `1.99.0-nightly (9f36de775 2026-07-19)` (bun-v1.4.2's `rust-toolchain.toml`), bootstrap Bun 1.4.2, prebuilt WebKit `2e2aa2290fac856d6f451ceacb58f7f5b44dd057` (non-LTO, sha256-pinned) |
| linux-x64 | Cloud Build `67b747f8-4b26-4cd2-9796-3bce024ca7db` — sha256 `2f1bb84ad480fce9e618b8bf4b7eb4553d5a1179d2013c7d22cbe054ca271df3`, 75,109,864 bytes, highest glibc symbol `GLIBC_2.17`; smoke on ubuntu:20.04: startup `MAIN_START` only, on demand `PLUGIN_EVALUATED` + `RESULT plugin-ok`, stock 1.4.2 control `Cannot find module './plugins/p.js'` |

## Known limits

- **Signature scope.** The release workflow signs `SHA256SUMS` keyless with its own GitHub OIDC
  identity. That attests "this workflow, at this tag, checked these bytes against the committed
  pins and signed them" — not that the Cloud Build worker was honest. The worker ran as the
  project's default build service account (the dedicated least-privilege account described in
  `infra/bun-base/README.md` is not provisioned).
- **`knext build` checks the sha256, not the signature.** No offline sigstore verifier ships in
  knext; the pinned sha256 is the binding check. The docs give the manual `cosign verify-blob`.
- **Not every fetch is pinned.** As in `infra/bun-base`: apt packages (Ubuntu archive, LLVM by
  version only), the Rust toolchain components, npm packages from the Bun tree's own lockfile,
  Bun's dependency source tarballs and cargo crates (by commit / `Cargo.lock`) are not sha256-pinned
  here. A rebuild is therefore reproducible only against that day's toolchain.
- **musl is not built on purpose.** On a musl build host compiling for the musl ship target, Bun
  would embed the compiler itself as the shipped runtime — this toolchain is for the compile step
  only. `knext build` refuses the opt-in on musl and macOS hosts with a clear error.
- **Embed-plan switch.** `compile-embed.mjs`'s own embed plan (self-contained standalone) passes
  absolute paths, which `--include` rejects, so that path keeps its extra-entrypoints shim; only
  user-declared (relative) `include` globs go through `compile.include`.
