# A knext Go zone function: a static, CGO-free binary on distroless, run as
# a non-root user.
#
# Both base images are DIGEST-PINNED so the bytes of the image are fixed; the
# tag is kept in the comment above each FROM (Docker rejects a trailing
# comment on a FROM line). Refresh the tag and digest together:
#   docker buildx imagetools inspect golang:1.26.10
#   docker buildx imagetools inspect gcr.io/distroless/static:nonroot
# The Go point release must match the `go` line in go.mod: Trivy and
# govulncheck read the standard library version compiled into the binary.

# golang:1.26.10
FROM golang:1.26.10@sha256:24a707af49702fa44f02785475d02fb752f6982d3e9c0afb7696e1f0204e7ce9 AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
ENV GOTOOLCHAIN=local
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/function .

# gcr.io/distroless/static:nonroot
FROM gcr.io/distroless/static:nonroot@sha256:18f4cc26c9ffa7f20a359298be7deadac5c607c8e03a02b8119f1a5fc2f82c99
COPY --from=build /out/function /function
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/function"]
