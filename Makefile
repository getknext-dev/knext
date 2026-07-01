# Scale-to-zero Postgres platform — dev entrypoints
.PHONY: help local-up local-down check gateway provisioner smoke deploy

help:
	@echo "Targets:"
	@echo "  local-up      docker compose up the Neon storage plane (local dev)"
	@echo "  local-down    tear the local storage plane down"
	@echo "  check         node --check all service sources"
	@echo "  smoke         run offline smoke tests (proto parser + provisioner API)"
	@echo "  gateway       run the wake-on-connect gateway locally"
	@echo "  provisioner   run the provisioning API locally"
	@echo "  deploy        kubectl apply the manifests in deploy/ (needs a cluster)"

local-up:
	cd local && docker compose up -d

local-down:
	cd local && docker compose down -v

check:
	node --check gateway/src/*.js
	node --check provisioner/src/*.js

smoke: check
	node gateway/src/_smoke.js
	node provisioner/src/_smoke.js

gateway:
	node gateway/src/index.js

provisioner:
	node provisioner/src/index.js

deploy:
	kubectl apply -f deploy/
