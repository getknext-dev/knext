# Vendored: connectrpc-health 0.9.0

- Source: crate `connectrpc-health` 0.9.0 from crates.io, published from
  https://github.com/connectrpc/connect-rust (Apache-2.0; the LICENSE here is copied from that
  repository because the crates.io tarball ships none).
- Single change: in `Cargo.toml`, the `connectrpc` dependency sets `default-features = false`
  (features stay `["server"]`), so the crate no longer turns on connectrpc's default features,
  which compile zstd into the release binary. Everything else is byte-for-byte upstream.
- Wired by `[patch.crates-io]` in `../../Cargo.toml`.
- Retirement: delete this directory and the `[patch.crates-io]` table once upstream publishes
  a connectrpc-health release whose connectrpc edge has default features off. Upstream
  issue: https://github.com/connectrpc/connect-rust/issues/337 (fix PR:
  https://github.com/connectrpc/connect-rust/pull/338).
