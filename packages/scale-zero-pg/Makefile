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
	# create-if-absent seed of the generation ledger (#1095) — the `generation` key is
	# intentionally NOT declared in deploy/57 (a declared key is not apply-safe), so seed
	# it out of band here. NEVER overwrites a live value; safe to run on every deploy.
	# MUST be `bash`, not `sh`: the script uses `set -o pipefail` (bash-only); under
	# dash (/bin/sh on Debian/Ubuntu) `sh` aborts with "Illegal option -o pipefail".
	bash deploy/seed-ledger.sh
