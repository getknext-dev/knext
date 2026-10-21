# Multi-stage build: static Go binary -> distroless.
# golang:1.26.9 (digest-pinned; tests/golang-from-lockstep.test.ts keeps it equal to go.mod)
FROM golang:1.26.9@sha256:37cfcca63222ec499bec5e8ad7aad52dbf7529db36d5812b8eae2f0621aa92d6 AS build
WORKDIR /src

# Cache modules first.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /gateway ./cmd/gateway \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /alertsink ./cmd/alertsink \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /pswatcher ./cmd/pswatcher \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /appdb-operator ./cmd/appdb-operator \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /writer-autoscaler ./cmd/writer-autoscaler \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /zone-operator ./cmd/zone-operator

FROM gcr.io/distroless/static:nonroot
COPY --from=build /gateway /gateway
COPY --from=build /alertsink /alertsink
# pageserver auto-failover controller; the 58-pswatcher Deployment overrides
# ENTRYPOINT to /pswatcher (same image, distinct binary).
COPY --from=build /pswatcher /pswatcher
# AppDatabase CRD operator (ADR-0004, #96); the 83-appdb-operator Deployment
# overrides ENTRYPOINT to /appdb-operator (same image, distinct binary).
COPY --from=build /appdb-operator /appdb-operator
# Writer vertical-autoscaler (#103); the 85-writer-autoscaler Deployment overrides
# ENTRYPOINT to /writer-autoscaler (same image, distinct binary).
COPY --from=build /writer-autoscaler /writer-autoscaler
# Zone CRD operator (ADR-0007, #139 v2-2); the 87-zone-operator Deployment overrides
# ENTRYPOINT to /zone-operator (same image, distinct binary).
COPY --from=build /zone-operator /zone-operator
# Postgres wire port + metrics/health port.
EXPOSE 55432 9090
USER nonroot:nonroot
ENTRYPOINT ["/gateway"]
