# knext Rust zone-function template (Beta)

A connect-rust server for a zone function: the service a Next.js zone calls over HTTP/2
cleartext (h2c), cluster-local, scaling to zero. User docs: the "Rust zone functions" page of
the knext docs.

**It fails closed.** Every RPC except `grpc.health.v1.Health/Check` needs
`Authorization: Bearer <token>`: the owning zone's Ed25519 identity token, verified
(`ed25519-dalek` `verify_strict`) against the JWK Set mounted at
`/var/run/knext/jwks/jwks.json` (re-read on change and at least every 10 s) and held to
`$KNEXT_TOKEN_ISSUER` (the zone), `$KNEXT_TOKEN_AUDIENCE` (this function), the RPC called
(`method`), a 60 s lifetime with 5 s of skew, and, for an `AUTH_USER` RPC, a non-empty `sub`.
Each RPC's `(knext.v1.auth)` option is listed in `src/auth/policy.rs` (a test holds it to
`proto/`). A key that is non-canonical or of small order is never trusted. With no JWKS
mounted, a JWKS holding private key material, the issuer or audience unset, or an RPC not in the
table, every RPC but the health check is refused with `unauthenticated`. Handlers take the user from
`auth::Caller::of(&ctx)`, never from the request.

The verifier is tested against the shared token vectors in
`packages/grpc/testdata/z7-token-vectors.json` (read from the repository; set
`KNEXT_Z7_VECTORS` to their path in a copy of the template outside it).

## Layout

| Path | What |
|---|---|
| `proto/` | the contract (`example/v1`) and the knext options it imports — the source of truth |
| `gen/` | `buf generate` output (buffa messages, connect-rust stubs), committed; CI regenerates and fails on a diff |
| `codegen.sh` | installs the pinned codegen plugins into `.codegen/` and runs `buf generate` |
| `src/auth.rs`, `src/auth/` | the token check (a Tower layer, before the body is read), the zone-token verifier (`token.rs`), the JWKS reader (`jwks.rs`) and the auth-option table (`policy.rs`) |
| `src/items.rs` | the example service's handlers — replace with yours |
| `src/rpc/` | the server: limits, layers (OTel, panic recovery, body bounds, token), health, the h2c + HTTP/1.1 accept loop and its drain |
| `src/main.rs` | `$PORT` (default 8080), `SIGTERM` drain |
| `deny.toml` | the `cargo deny` policy |
| `Dockerfile` | digest-pinned `rust` alpine builder (`cargo auditable`) and distroless `static:nonroot` runtime |
| `e2e/` | kind e2e: the image as a cluster-local Knative Service (test harness only) |

`proto/example/v1/example.proto` is exactly what `knext add function example --lang rust` writes,
and `proto/knext/v1/options.proto` is the copy `@getknext/grpc` ships;
`tests/rust-template-contract.test.ts` holds both.

connect-rust is pre-1.0. The `connectrpc` 0.9 line is pinned in `Cargo.toml` and `Cargo.lock`,
and CI runs the Connect conformance suite against the locked version.

## Commands

```bash
./codegen.sh                                   # after a proto change; commit gen/
cargo test                                     # unit + protocol matrix + fail-closed scan + limits
cargo clippy --all-targets --all-features -- -D warnings
cargo deny check && cargo audit
docker build -t <image> .
e2e/kind-e2e.sh                                # kind + Knative: health served, everything else refused
node ../../scripts/mutation-prove-rust-template-auth.mjs   # each way of opening the check reds a test
node ../../scripts/mutation-prove-2051-rust-verifier.mjs   # each token check, removed, reds a test
```

`vendor/connectrpc-health` and the `[patch.crates-io]` entry in `Cargo.toml` exist only to keep zstd out of the release binary (this template accepts gzip only); delete both once the upstream crate publishes the same change (see `vendor/connectrpc-health/VENDORED.md`).

CI: `.github/workflows/rust-template.yml` (tests, drift, cargo deny and audit; Connect
conformance; image SBOM + Trivy gate; the kind e2e). The workflow holds no write credential and
publishes no image.
