# knext Rust zone-function template (Beta)

A connect-rust server for a zone function: the service a Next.js zone calls over HTTP/2
cleartext (h2c), cluster-local, scaling to zero. User docs: the "Rust zone functions" page of
the knext docs.

**It fails closed.** Every RPC except `grpc.health.v1.Health/Check` needs
`Authorization: Bearer <token>`. With no JWKS mounted at `/var/run/knext/jwks/jwks.json`, every
other RPC is refused with `unauthenticated` — and, until zone-token verification lands
(`TODO(#2051)` in `src/auth.rs`), so is every RPC with a JWKS mounted.

## Layout

| Path | What |
|---|---|
| `proto/` | the contract (`example/v1`) and the knext options it imports — the source of truth |
| `gen/` | `buf generate` output (buffa messages, connect-rust stubs), committed; CI regenerates and fails on a diff |
| `codegen.sh` | installs the pinned codegen plugins into `.codegen/` and runs `buf generate` |
| `src/auth.rs` | the token check (a Tower layer, before the body is read) and the JWKS verifier seam |
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
```

CI: `.github/workflows/rust-template.yml` (tests, drift, cargo deny and audit; Connect
conformance; image SBOM + Trivy gate; the kind e2e). The workflow holds no write credential and
publishes no image.
