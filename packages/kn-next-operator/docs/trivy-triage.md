# Operator image Trivy triage (refs #117)

`operator-supply-chain.yml` runs, on the built operator image:

```
trivy image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1
```

On `main` this step is **enforcing** (fails the run), and every publishing step
(cosign sign/verify, `build-installer` + digest re-pin, Release-asset upload) is
gated `if: ref == main` **after** Trivy. So a single un-ignored HIGH/CRITICAL
finding blocks the whole bundle publish and leaves `dist/install.yaml` pinned to
the all-zeros placeholder digest — a clean-cluster `kubectl apply -f
dist/install.yaml` would then `ImagePullBackOff`.

## Finding class

The scanned image is `gcr.io/distroless/static:nonroot` + a single
`CGO_ENABLED=0` Go `manager` binary. With `--ignore-unfixed`:

- **distroless/static base** — contributes no *fixable* HIGH/CRITICAL findings.
  It carries only `ca-certificates`, `tzdata`, `base-files` and the static
  tmp/passwd layout; nothing with a pending fixed-version. Not the cause.
- **The Go `manager` binary** — Trivy reads the binary's embedded build-info and
  flags (a) the **Go stdlib version** it was compiled with and (b) any
  vulnerable module dependencies. This is the only fixable surface.

The module graph is already on patched releases (`golang.org/x/net v0.49.0`,
`x/text v0.33.0`, `x/oauth2 v0.32.0`, `k8s.io/* v0.35.0`, etc.). The actual
exposure was the **builder tag**: the Dockerfile used a floating
`FROM golang:1.25`, which is not pinned to a patched point release. A
floating/stale-cached `1.25.x` bakes an unpatched Go stdlib into the binary, and
Trivy then reports fixed-version Go stdlib CVEs (the `stdlib` package, e.g. the
`net/http`, `crypto/*`, `archive/tar` classes patched across the 1.25.x line) as
HIGH/CRITICAL.

## Remediation (preferred path — base-image upgrade, no ignore)

Pin the builder to the latest patched Go point release:

```diff
- FROM golang:1.25 AS builder
+ FROM golang:1.25.11 AS builder
```

`1.25.11` is the latest patched release on the 1.25 line (per the Go release
list / module proxy version list). This upgrades the stdlib baked into the
binary to the fully-patched version, clearing the fixable Go-stdlib HIGH/CRITICAL
findings **without** weakening the gate:

- fail-on stays `HIGH,CRITICAL`;
- no `.trivyignore`, no blanket ignore, no severity downgrade;
- `--ignore-unfixed` is unchanged (it was already the policy).

When a newer Go stdlib CVE lands, bump the pin (and `MIN_PATCH` in
`hack/check-trivy-baseimage.bats.sh`) to the next patched release. No CVE here is
genuinely unfixable, so **no `.trivyignore` entry is warranted**.

## Verification

- **Offline guard (every PR):** `make check-baseimage-pin`
  (`hack/check-trivy-baseimage.bats.sh`) asserts the builder is pinned to a
  patched Go point release and rejects a floating `golang:1.25`. Wired into the
  `no-latest-guard` CI job.
- **End-to-end (the real test):** `make trivy-scan IMG=<locally-built-tag>` runs
  the identical Trivy invocation as the workflow and must report 0 un-ignored
  HIGH/CRITICAL. This needs a built image, a Docker daemon, and the ~98MB Trivy
  DB, so it is not run in every sandbox; the authoritative green is the
  `operator-supply-chain.yml` Trivy step on the next `main` run.

## Scope

This PR **unblocks** the publish; it does not itself publish. Publishing still
requires a push to `main` (which runs the gated cosign sign/verify +
`build-installer` digest re-pin + Release-asset upload) and GHCR/OIDC auth that
agents do not hold. See `docs/RUNBOOK-first-publish.md`.
