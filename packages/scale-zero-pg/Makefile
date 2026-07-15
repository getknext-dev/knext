# Scale-to-zero Postgres platform — dev entrypoints
.PHONY: help local-up local-down check gateway smoke deploy

help:
	@echo "Targets:"
	@echo "  local-up      docker compose up the Neon storage plane (local dev)"
	@echo "  local-down    tear the local storage plane down"
	@echo "  check         go vet the gateway"
	@echo "  smoke         run the gateway Go tests (proto/wake/metrics + e2e)"
	@echo "  gateway       run the wake-on-connect gateway locally"
	@echo "  deploy        kubectl apply the manifests in deploy/ (needs a cluster)"

local-up:
	cd local && docker compose up -d

local-down:
	cd local && docker compose down -v

check:
	cd gateway && go vet ./...

smoke:
	cd gateway && go test ./...

gateway:
	cd gateway && go run ./cmd/gateway

deploy:
	kubectl apply -f deploy/
