#!/usr/bin/env bash
# Run the Connect conformance suite against the connectrpc version this
# template locks. connect-rust is pre-1.0, so its pin is gated by the suite.
#
#   ./conformance.sh <connect-rust checkout> <connectconformance binary>
#
# The checkout must be the release commit of the connectrpc version in
# Cargo.lock (CI checks it out by SHA). Its own conformance server is built
# with the protocol stack this template ships: buffa, hyper, hyper-util and h2
# are held to the versions in this template's Cargo.lock. Then every server
# test runs, on every protocol (Connect, gRPC, gRPC-Web).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKOUT="$(cd "$1" && pwd)"
RUNNER="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"

# The version of package $1 in this template's Cargo.lock (exactly one).
locked() {
  local versions
  versions="$(awk -v name="$1" '$0 == "name = \"" name "\"" { getline; gsub(/"/, "", $3); print $3 }' "${HERE}/Cargo.lock")"
  if [ "$(printf '%s\n' "${versions}" | grep -c .)" != "1" ]; then
    echo "conformance.sh: Cargo.lock holds '${versions}' for $1, want exactly one version" >&2
    exit 2
  fi
  printf '%s\n' "${versions}"
}

want="$(locked connectrpc)"
have="$(awk '/^\[package\]/ { p = 1 } p && /^version = / { gsub(/"/, "", $3); print $3; exit }' "${CHECKOUT}/connectrpc/Cargo.toml")"
if [ "${want}" != "${have}" ]; then
  echo "conformance.sh: the checkout is connectrpc ${have}; Cargo.lock locks ${want}" >&2
  exit 2
fi
echo "connectrpc ${have} (locked ${want})"

cd "${CHECKOUT}"
# connect-rust commits no Cargo.lock: resolve one, then hold the protocol
# stack to the template's versions.
[ -f Cargo.lock ] || cargo generate-lockfile --quiet
for crate in buffa hyper hyper-util h2; do
  version="$(locked "${crate}")"
  cargo update --quiet -p "${crate}" --precise "${version}"
  echo "${crate} ${version}"
done
cargo build --release --locked -p connectrpc-conformance --bin conformance-server
RUST_LOG=warn "${RUNNER}" --mode server -- target/release/conformance-server
