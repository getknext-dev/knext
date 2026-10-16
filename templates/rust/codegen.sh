#!/usr/bin/env bash
# Regenerate gen/ from proto/ with the pinned codegen plugins.
#
# The plugins are installed with `cargo install --locked` at the exact
# versions below into .codegen/ (git-ignored), so every machine and CI
# generates with the same plugin bytes. The connect-rust plugin's minor
# version must match the connectrpc runtime's in Cargo.lock; buffa's plugins
# match the buffa runtime's.
#
#   ./codegen.sh               # install the plugins if missing, buf generate
#   BUF="bun ../../packages/grpc/scripts/verified-buf.ts" ./codegen.sh
#                              # the same, with knext's checksum-verified buf (CI)
set -euo pipefail

PROTOC_GEN_BUFFA_VERSION=0.9.2
PROTOC_GEN_BUFFA_PACKAGING_VERSION=0.9.2
CONNECTRPC_CODEGEN_VERSION=0.9.0

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${HERE}/.codegen"

install() {
  local crate="$1" version="$2" bin="$3"
  local stamp="${ROOT}/${crate}-${version}.installed"
  if [ -x "${ROOT}/bin/${bin}" ] && [ -f "${stamp}" ]; then
    return
  fi
  cargo install --quiet --locked --force --root "${ROOT}" "${crate}@${version}"
  touch "${stamp}"
}

install protoc-gen-buffa "${PROTOC_GEN_BUFFA_VERSION}" protoc-gen-buffa
install protoc-gen-buffa-packaging "${PROTOC_GEN_BUFFA_PACKAGING_VERSION}" protoc-gen-buffa-packaging
install connectrpc-codegen "${CONNECTRPC_CODEGEN_VERSION}" protoc-gen-connect-rust

cd "${HERE}"
# shellcheck disable=SC2086 # BUF may be a command with arguments.
${BUF:-buf} generate
