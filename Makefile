.PHONY: help install-knative install-observability deploy-infra deploy-app clean

help:
	@echo "Available commands:"
	@echo "  make install-knative      - Install Knative on local cluster"
	@echo "  make install-observability - Install Prometheus, Grafana, Jaeger, Loki"
	@echo "  make deploy-infra         - Deploy Cerbos, MinIO, PostgreSQL"
	@echo "  make deploy-app           - Build and deploy File Manager app"
	@echo "  make port-forward         - Port-forward all dashboards"
	@echo "  make clean                - Clean up all resources"

install-knative:
	@echo "Installing Knative..."
	kubectl apply -f https://github.com/knative/serving/releases/download/knative-v1.12.0/serving-crds.yaml
	kubectl apply -f https://github.com/knative/serving/releases/download/knative-v1.12.0/serving-core.yaml
	kubectl apply -l knative.dev/crd-install=true -f https://github.com/knative/net-istio/releases/download/knative-v1.12.0/istio.yaml
	kubectl apply -f https://github.com/knative/net-istio/releases/download/knative-v1.12.0/istio.yaml
	kubectl apply -f https://github.com/knative/net-istio/releases/download/knative-v1.12.0/net-istio.yaml
	kubectl apply -f https://github.com/knative/serving/releases/download/knative-v1.12.0/serving-default-domain.yaml
	@echo "Waiting for Knative to be ready..."
	kubectl wait --for=condition=Ready pods --all -n knative-serving --timeout=300s

install-observability:
	@echo "Installing observability stack..."
	kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -
	kubectl create namespace observability --dry-run=client -o yaml | kubectl apply -f -
	helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
	helm repo add grafana https://grafana.github.io/helm-charts
	helm repo update
	helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
		--namespace monitoring \
		--set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false
	helm upgrade --install loki grafana/loki-stack \
		--namespace monitoring \
		--set grafana.enabled=false \
		--set prometheus.enabled=false \
		--set promtail.enabled=true
	kubectl apply -f https://github.com/jaegertracing/jaeger-operator/releases/download/v1.51.0/jaeger-operator.yaml -n observability
	@echo "Observability stack installed!"

deploy-infra:
	@echo "Deploying infrastructure..."
	kubectl apply -f packages/framework/infrastructure/cerbos/
	kubectl apply -k "github.com/minio/operator?ref=v5.0.11"
	sleep 10
	kubectl apply -f packages/framework/infrastructure/minio/
	helm upgrade --install postgres oci://registry-1.docker.io/bitnamicharts/postgresql \
		--namespace default \
		--set auth.username=neondb_owner \
		--set auth.password=password \
		--set auth.database=neondb
	@echo "Infrastructure deployed!"

deploy-app:
	@echo "Deploying File Manager app..."
	cd apps/file-manager && npx bun run ../../packages/kn-next/src/cli/deploy.ts

port-forward:
	@echo "Starting port-forwards..."
	@echo "Grafana: http://localhost:3000 (admin/prom-operator)"
	@echo "Prometheus: http://localhost:9090"
	@echo "Jaeger: http://localhost:16686"
	@echo ""
	kubectl port-forward -n monitoring svc/prometheus-grafana 3000:80 & \
	kubectl port-forward -n monitoring svc/prometheus-kube-prometheus-prometheus 9090:9090 & \
	kubectl port-forward -n observability svc/jaeger-query 16686:16686 &
	@echo "Port-forwards started in background. Press Ctrl+C to stop."

# Local build-output cleanup only.
#
# This target used to `kubectl delete -f ./apps/file-manager/.output/{knative-service,
# knative-image-cache,postgres,redis,observability}.yaml`. Nothing generates those
# files any more: ADR-0001 consolidation removed the CLI's raw-manifest emission, so
# every cluster write now goes through the NextApp CR. The deletes were silently
# no-ops (`--ignore-not-found=true` hid that), which is worse than absent — it read
# as "this tears the deployment down" while tearing nothing down.
#
# Deleting a knext deployment now means deleting the CR that owns it:
#   kubectl delete nextapp <name>
# The operator reconciles the owned Knative/infra objects away. Do NOT reintroduce
# raw `kubectl delete -f` of generated manifests here.
clean:
	@echo "Removing local build output..."
	rm -rf ./apps/file-manager/.output
	@echo "Done. To remove a deployment: kubectl delete nextapp <name>"
