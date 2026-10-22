# A knext Go zone function: a static, CGO-free binary on distroless, run as
# a non-root user.
#
# Both base images are DIGEST-PINNED so the bytes of the image are fixed; the
# tag is kept in the comment above each FROM (Docker rejects a trailing
# comment on a FROM line). Refresh the tag and digest together:
#   docker buildx imagetools inspect golang:1.26.9
#   docker buildx imagetools inspect gcr.io/distroless/static:nonroot
# The Go point release must match the `go` line in go.mod: Trivy and
# govulncheck read the standard library version compiled into the binary.

# golang:1.26.9
FROM golang:1.26.9@sha256:37cfcca63222ec499bec5e8ad7aad52dbf7529db36d5812b8eae2f0621aa92d6 AS build
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
FROM gcr.io/distroless/static:nonroot@sha256:d62067879de890a1def9da0e7766b7d20810a5e5555cef8506b752437d7a3e88
COPY --from=build /out/function /function
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/function"]
