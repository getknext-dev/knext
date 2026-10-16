# knext Go zone-function template (Beta)

A connect-go v2 server for a zone function: the service a Next.js zone calls over HTTP/2
cleartext (h2c), cluster-local, scaling to zero. User docs: the "Go zone functions" page of the
knext docs.

**It fails closed.** Every RPC except `grpc.health.v1.Health/Check` needs
`Authorization: Bearer <token>`: the owning zone's Ed25519 identity token, verified against the
JWK Set mounted at `/var/run/knext/jwks/jwks.json` (re-read on change and at least every 10 s)
and held to `$KNEXT_TOKEN_ISSUER` (the zone), `$KNEXT_TOKEN_AUDIENCE` (this function), the RPC
called (`method`), a 60 s lifetime with 5 s of skew, and, for an `AUTH_USER` RPC, a non-empty
`sub`. Each RPC's `(knext.v1.auth)` option is read from the compiled contract. A key that is
non-canonical, off the curve or of small order is never trusted. With no JWKS mounted, a JWKS
holding private key material, the issuer or audience unset, or an RPC that states no option,
every RPC but the health check is refused with `unauthenticated`. Handlers take the user from `auth.CallerFrom(ctx)`,
never from the request.

The verifier is tested against the shared token vectors in
`packages/grpc/testdata/z7-token-vectors.json` (read from the repository; set
`KNEXT_Z7_VECTORS` to their path in a copy of the template outside it).

## Layout

| Path | What |
|---|---|
| `proto/` | the contract (`example/v1`) and the knext options it imports — the source of truth |
| `gen/` | `buf generate` output, committed; CI regenerates and fails on a diff |
| `internal/auth` | the token interceptor, the zone-token verifier (`token.go`), the JWKS reader (`jwks.go`) and the auth-option lookup |
| `internal/testvectors` | test-only loader for the shared token vectors |
| `internal/items` | the example service's handlers — replace with yours |
| `internal/rpc` | the connect server, interceptor chain (OTel, recovery, auth), health, h2c HTTP server |
| `main.go` | `$PORT` (default 8080), `SIGTERM` drain |
| `Dockerfile` | digest-pinned `golang` builder and distroless `static:nonroot` runtime |
| `e2e/` | kind e2e: the image as a cluster-local Knative Service (test harness only) |

`proto/example/v1/example.proto` is exactly what `knext add function example --lang go` writes,
and `proto/knext/v1/options.proto` is the copy `@getknext/grpc` ships; `tests/go-template-contract.test.ts`
holds both.

## Commands

```bash
buf generate                                   # after a proto change; commit gen/
go test -race ./...                            # unit + protocol matrix + fail-closed scan
go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...
docker build -t <image> .
e2e/kind-e2e.sh                                # kind + Knative: health served, everything else refused
node ../../scripts/mutation-prove-go-template-auth.mjs   # each way of opening the check reds a test
node ../../scripts/mutation-prove-2051-go-verifier.mjs   # each token check, removed, reds a test
```

CI: `.github/workflows/go-template.yml` (tests, drift, govulncheck; image SBOM + Trivy gate; the
kind e2e). The workflow holds no write credential and publishes no image.
