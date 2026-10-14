#!/usr/bin/env bash
# Installs what `knext ffi build` / `cargo zigbuild` need on a GitHub Linux
# runner (x86_64 or aarch64), every download version-pinned and
# sha256-verified, and fails closed on a mismatch:
#   - rustup (only when the runner image has none), then the crate's pinned
#     toolchain from its rust-toolchain.toml, plus the musl targets asked for;
#   - zig, the musl sysroot and linker cargo-zigbuild drives;
#   - cargo-zigbuild, from its release binaries.
#
#   install-ffi-toolchain.sh <crate-dir> [<rust-target>...]
#
# The binary directories are appended to $GITHUB_PATH when it is set.
#
# These are the e2e lane's pins. The product's own pin table (what `knext ffi
# build` verifies on a developer machine) is ADR-0069 D16's and lives in
# @getknext/ffi; keep the two equal when either moves.
set -euo pipefail

ZIG_VERSION=0.17.0
CARGO_ZIGBUILD_VERSION=0.23.4
RUSTUP_VERSION=1.28.2

crate_dir="${1:?usage: install-ffi-toolchain.sh <crate-dir> [<rust-target>...]}"
shift
targets=("$@")

case "$(uname -m)" in
  x86_64)
    arch=x86_64
    zig_sha256=1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026
    zigbuild_sha256=6b69963040818ca1ef573d8135a95aa902e17cf7f873c32c6426642dadfe7f59
    rustup_sha256=20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c
    ;;
  aarch64 | arm64)
    arch=aarch64
    zig_sha256=9e8d11661d4ae3bd57702a3832781e23ad151dde5798e16a5ccd503f65234ff8
    zigbuild_sha256=25cf2cdc6cde848b33a761ff2cf46d1efe6ba7e1adfc4b6f3ee2d570cacb5419
    rustup_sha256=e3853c5a252fca15252d07cb23a1bdd9377a8c6f3efa01531109281ae47f841c
    ;;
  *)
    echo "install-ffi-toolchain: unsupported machine $(uname -m)" >&2
    exit 1
    ;;
esac

tools="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/knext-ffi-tools"
mkdir -p "${tools}/bin"
add_path() {
  export PATH="$1:${PATH}"
  if [ -n "${GITHUB_PATH:-}" ]; then echo "$1" >> "${GITHUB_PATH}"; fi
}

# fetch <url> <sha256> <out>: download, then verify; a mismatch fails the
# script here (set -e + pipefail), before anything is extracted or run.
fetch() {
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c -
}

# --- rustup (the runner images normally ship it) -------------------------------
if ! command -v rustup >/dev/null 2>&1; then
  fetch "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${arch}-unknown-linux-gnu/rustup-init" \
    "${rustup_sha256}" "${tools}/rustup-init"
  chmod +x "${tools}/rustup-init"
  "${tools}/rustup-init" -y --no-modify-path --profile minimal --default-toolchain none
  add_path "${HOME}/.cargo/bin"
fi

# --- the crate's pinned toolchain and the musl targets -------------------------
(
  cd "${crate_dir}"
  rustup toolchain install
  if [ "${#targets[@]}" -gt 0 ]; then rustup target add "${targets[@]}"; fi
  rustc -V
  cargo -V
)

# --- zig ----------------------------------------------------------------------
zig_name="zig-${arch}-linux-${ZIG_VERSION}"
fetch "https://ziglang.org/download/${ZIG_VERSION}/${zig_name}.tar.xz" "${zig_sha256}" "${tools}/zig.tar.xz"
tar -xJf "${tools}/zig.tar.xz" -C "${tools}"
add_path "${tools}/${zig_name}"
test "$(zig version)" = "${ZIG_VERSION}"

# --- cargo-zigbuild -----------------------------------------------------------
zb_name="cargo-zigbuild-${arch}-unknown-linux-gnu"
fetch "https://github.com/rust-cross/cargo-zigbuild/releases/download/v${CARGO_ZIGBUILD_VERSION}/${zb_name}.tar.xz" \
  "${zigbuild_sha256}" "${tools}/cargo-zigbuild.tar.xz"
mkdir -p "${tools}/zb"
tar -xJf "${tools}/cargo-zigbuild.tar.xz" -C "${tools}/zb"
install -m 0755 "$(find "${tools}/zb" -type f -name cargo-zigbuild | head -n1)" "${tools}/bin/cargo-zigbuild"
add_path "${tools}/bin"
# `cargo-zigbuild --version`, not `cargo zigbuild --version`: the subcommand
# form rejects --version ("unexpected argument", measured on 0.23.4).
test "$(cargo-zigbuild --version)" = "cargo-zigbuild ${CARGO_ZIGBUILD_VERSION}"
(cd "${crate_dir}" && cargo zigbuild --help >/dev/null)
echo "install-ffi-toolchain: zig ${ZIG_VERSION}, cargo-zigbuild ${CARGO_ZIGBUILD_VERSION}, targets: ${targets[*]:-none}"
