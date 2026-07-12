# Build the manager binary.
#
# Pin the builder to a specific patched Go point release (NOT a floating
# `golang:1.25`). The operator runtime image is distroless/static + this
# CGO-disabled binary, so the only fixable HIGH/CRITICAL surface Trivy scans
# (`--ignore-unfixed`) is the Go stdlib version baked into the binary's
# build-info. A floating minor tag can resolve to an unpatched 1.25.x and leak
# a fixable Go-stdlib CVE, failing operator-supply-chain.yml's
# `trivy image --severity HIGH,CRITICAL --exit-code 1` gate on main and blocking
# the whole bundle publish (refs #117). 1.25.12 is the latest patched 1.25 line
# (fixes CVE-2026-39822, os.Root symlink following, HIGH).
# Bump this in lockstep with hack/check-trivy-baseimage.bats.sh (MIN_PATCH).
#
# DIGEST-PINNED in addition to the patched point release: the tag fixes the Go
# stdlib version Trivy reads from the binary; the @sha256 digest fixes the exact
# base bytes so an unreviewed upstream re-push of the same tag cannot change the
# image we build + sign. The tag is kept in this comment block (Docker rejects
# trailing/inline comments on a FROM line); refresh the digest and this comment
# together when bumping. Resolve with:
#   docker buildx imagetools inspect golang:1.25.12
# Enforced by scripts/check-base-images-pinned.sh (CI: base-image-pin-guard).
FROM golang:1.25.12@sha256:d7912cedddfa15b2900a8dfb7187df0af5ec2cb424a371139b5b352fd3e6b740 AS builder
ARG TARGETOS
ARG TARGETARCH

WORKDIR /workspace
# Copy the Go Modules manifests
COPY go.mod go.mod
COPY go.sum go.sum
# cache deps before building and copying source so that we don't need to re-download as much
# and so that source changes don't invalidate our downloaded layer
RUN go mod download

# Copy the Go source (relies on .dockerignore to filter)
COPY . .

# Build
# the GOARCH has no default value to allow the binary to be built according to the host where the command
# was called. For example, if we call make docker-build in a local env which has the Apple Silicon M1 SO
# the docker BUILDPLATFORM arg will be linux/arm64 when for Apple x86 it will be linux/amd64. Therefore,
# by leaving it empty we can ensure that the container and binary shipped on it will have the same platform.
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} go build -a -o manager cmd/main.go

# Use distroless as minimal base image to package the manager binary
# Refer to https://github.com/GoogleContainerTools/distroless for more details
# DIGEST-PINNED (not the floating :nonroot tag) so the runtime base bytes of the
# image we sign are immutable. Keep the tag in the trailing comment; refresh with:
#   docker buildx imagetools inspect gcr.io/distroless/static:nonroot
# Enforced by scripts/check-base-images-pinned.sh (CI: base-image-pin-guard).
FROM gcr.io/distroless/static:nonroot@sha256:963fa6c544fe5ce420f1f54fb88b6fb01479f054c8056d0f74cc2c6000df5240
WORKDIR /
COPY --from=builder /workspace/manager .
USER 65532:65532

ENTRYPOINT ["/manager"]
