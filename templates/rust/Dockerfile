# A knext Rust zone function: a static musl binary on distroless, run as a
# non-root user.
#
# Both base images are DIGEST-PINNED so the bytes of the image are fixed; the
# tag is kept in the comment above each FROM (Docker rejects a trailing
# comment on a FROM line). Refresh the tag and digest together:
#   docker buildx imagetools inspect rust:1.99.1-alpine3.23
#   docker buildx imagetools inspect gcr.io/distroless/static:nonroot
# The Rust release must match the channel in rust-toolchain.toml.
#
# `cargo auditable` embeds the dependency list in the binary, so an image
# scanner (Trivy, syft) sees every crate compiled into it.

# rust:1.99.1-alpine3.23
FROM rust:1.99.1-alpine3.23@sha256:caf64f6f017c3ceb4233d589d916437e9671683dc2b571716cde61b7a9498e14 AS build
RUN apk add --no-cache musl-dev
RUN cargo install --locked --root /usr/local cargo-auditable@0.7.7
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src e2e && echo 'fn main() {}' > src/main.rs && touch src/lib.rs e2e/e2e.rs \
    && cargo fetch --locked
COPY gen gen
COPY src src
RUN cargo auditable build --release --locked --bin function \
    && cp target/release/function /function

# gcr.io/distroless/static:nonroot
FROM gcr.io/distroless/static:nonroot@sha256:e2e927ec666bae08560abb3c55d0659eceabb657f56b6782ab500a9fc7f555e3
COPY --from=build /function /function
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/function"]
