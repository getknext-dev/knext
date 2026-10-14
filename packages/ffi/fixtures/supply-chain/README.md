# Supply-chain fixtures (real tool output)

Used by `supply-chain.test.ts` and `ffi-build.test.ts` so the supply-chain gates
are tested against what the pinned tools really print, without Rust, zig or the
network. All were produced on macOS arm64 with the pinned versions from
`src/supply-chain.ts` (cargo-zigbuild 0.23.4, cargo-deny 0.20.2,
cargo-auditable 0.7.7, cargo-cyclonedx 0.5.9, zig 0.15.2) and rustc 1.97.1.

| File | What it is |
|---|---|
| `cargo-deny-advisory.jsonl` | `cargo deny --format json check` stderr for a cdylib depending on `smallvec = "=1.6.0"` (RUSTSEC-2021-0003), under a `deny.toml` with the template's tables and values (without its comments). Exit 1. |
| `cargo-deny-ignored.jsonl` | `cargo deny --format json -L info --locked check advisories` stderr for the same crate with `ignore = [{ id = "RUSTSEC-2021-0003", … }]` in `deny.toml`: the advisory becomes a `note`, exit 0. Absolute paths rewritten to `/build/app/rust`. |
| `cargo-cyclonedx-zone.cdx.json` | `cargo cyclonedx --format json --spec-version 1.5 --target x86_64-unknown-linux-musl` for a zero-dependency cdylib named `zone` 0.3.1. Paths rewritten to `/build/app/rust`; whitespace reformatted by biome. |
| `libaudit_musl_x64.so`, `libaudit_musl_arm64.so` | `../elf/libmusl_<arch>.so` with a `.dep-v0` section added: the section bytes cargo-auditable wrote into `libzone.so` (crate `zone` 0.3.1, root, no dependencies) when built with `cargo auditable zigbuild --release --target <arch>-unknown-linux-musl`. A real cross-built library is ~280 KB; the payload is 86 bytes. |

Rebuild the `.dep-v0` libraries (binutils only knows its own machine, so one
container per arch):

```sh
# 1. In a crate named zone 0.3.1 with crate-type = ["cdylib"]:
CARGO_ZIGBUILD_ZIG_COMMAND=/path/to/zig-0.15.2/zig RUSTFLAGS="-C target-feature=-crt-static" \
  cargo auditable zigbuild --release --target <arch>-unknown-linux-musl
# 2. Copy the section onto the small fixture:
docker run --rm --platform linux/<amd64|arm64> -v "$PWD:/w" -w /w alpine:3.20 sh -c '
  apk add --no-cache binutils &&
  objcopy --dump-section .dep-v0=dep.bin libzone.so &&
  objcopy --add-section .dep-v0=dep.bin --set-section-flags .dep-v0=noload,readonly \
    libmusl_<arch>.so libaudit_musl_<arch>.so'
```
