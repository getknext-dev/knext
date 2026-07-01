# Multi-stage build: static Go binary -> distroless.
FROM golang:1.26 AS build
WORKDIR /src

# Cache modules first.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /gateway ./cmd/gateway

FROM gcr.io/distroless/static:nonroot
COPY --from=build /gateway /gateway
# Postgres wire port + metrics/health port.
EXPOSE 55432 9090
USER nonroot:nonroot
ENTRYPOINT ["/gateway"]
