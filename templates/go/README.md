# knext Go zone-function template (Beta)

A connect-go v2 server for a zone function: the service a Next.js zone calls over HTTP/2
cleartext (h2c), cluster-local, scaling to zero. User docs: the "Go zone functions" page of the
knext docs.

**It fails closed.** Every RPC except `grpc.health.v1.Health/Check` needs
`Authorization: Bearer <token>`. With no JWKS mounted at `/var/run/knext/jwks/jwks.json`, every
other RPC is refused with `unauthenticated` — and, until zone-token verification lands
(`TODO(#2051)` in `internal/auth/auth.go`), so is every RPC with a JWKS mounted.

## Layout

| Path | What |
|---|---|
| `proto/` | the contract (`example/v1`) and the knext options it imports — the source of truth |
| `gen/` | `buf generate` output, committed; CI regenerates and fails on a diff |
| `internal/auth` | the token interceptor and the JWKS verifier seam |
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
```

CI: `.github/workflows/go-template.yml` (tests, drift, govulncheck; image SBOM + Trivy gate; the
kind e2e). The workflow holds no write credential and publishes no image.
