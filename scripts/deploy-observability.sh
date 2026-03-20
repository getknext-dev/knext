#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy kn-next Observability Stack
# One-command setup for Prometheus + Grafana in your Kubernetes cluster.
#
# Usage:
#   ./scripts/deploy-observability.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; PURPLE='\033[0;35m'; NC='\033[0m'; BOLD='\033[1m'

echo -e "${PURPLE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}${CYAN}  kn-next Observability Stack Deployment${NC}"
echo -e "${PURPLE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# ─── Step 1: Create ConfigMaps from dashboard JSON files ─────────────────────
echo -e "\n${YELLOW}[1/4] Creating Grafana dashboard ConfigMaps...${NC}"

kubectl create configmap grafana-dashboard-loadtesting \
  --from-file=grafana-loadtesting-dashboard.json="${PROJECT_ROOT}/docs/grafana/grafana-loadtesting-dashboard.json" \
  -n monitoring --dry-run=client -o yaml | kubectl apply -f -

kubectl create configmap grafana-dashboard-bytecode \
  --from-file=grafana-bytecode-dashboard.json="${PROJECT_ROOT}/docs/grafana/grafana-bytecode-dashboard.json" \
  -n monitoring --dry-run=client -o yaml | kubectl apply -f -

kubectl create configmap grafana-dashboard-coldstart \
  --from-file=grafana-coldstart-dashboard.json="${PROJECT_ROOT}/docs/grafana/grafana-coldstart-dashboard.json" \
  -n monitoring --dry-run=client -o yaml | kubectl apply -f -

echo -e "${GREEN}  ✓ Dashboard ConfigMaps created${NC}"

# ─── Step 2: Deploy the observability stack ──────────────────────────────────
echo -e "\n${YELLOW}[2/4] Deploying Prometheus + Grafana + kube-state-metrics...${NC}"

kubectl apply -f "${PROJECT_ROOT}/k8s/observability-stack.yaml"

echo -e "${GREEN}  ✓ Stack deployed${NC}"

# ─── Step 3: Wait for pods ───────────────────────────────────────────────────
echo -e "\n${YELLOW}[3/4] Waiting for pods to be ready...${NC}"

kubectl wait --for=condition=Ready pod -l app=prometheus -n monitoring --timeout=120s
echo -e "${GREEN}  ✓ Prometheus ready${NC}"

kubectl wait --for=condition=Ready pod -l app=grafana -n monitoring --timeout=120s
echo -e "${GREEN}  ✓ Grafana ready${NC}"

kubectl wait --for=condition=Ready pod -l app=kube-state-metrics -n monitoring --timeout=120s
echo -e "${GREEN}  ✓ kube-state-metrics ready${NC}"

# ─── Step 4: Print access information ────────────────────────────────────────
echo -e "\n${YELLOW}[4/4] Access Information${NC}"

echo -e "${PURPLE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e ""
echo -e "  ${BOLD}Grafana:${NC}"
echo -e "    ${CYAN}kubectl port-forward -n monitoring svc/grafana 3001:3000${NC}"
echo -e "    URL:      ${GREEN}http://localhost:3001${NC}"
echo -e "    Login:    ${GREEN}admin / admin${NC}"
echo -e ""
echo -e "  ${BOLD}Prometheus:${NC}"
echo -e "    ${CYAN}kubectl port-forward -n monitoring svc/prometheus 9090:9090${NC}"
echo -e "    URL:      ${GREEN}http://localhost:9090${NC}"
echo -e ""
echo -e "  ${BOLD}Dashboards:${NC}"
echo -e "    ${GREEN}• Load Testing${NC}     — RPS, latency percentiles, error rates"
echo -e "    ${GREEN}• Bytecode Cache${NC}   — Cold/warm starts, cache metrics"
echo -e "    ${GREEN}• Cold Start${NC}       — Pod lifecycle, scaling events"
echo -e ""
echo -e "${PURPLE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e ""
echo -e "  ${BOLD}Quick start:${NC}"
echo -e "    1. Port-forward Grafana: ${CYAN}kubectl port-forward -n monitoring svc/grafana 3001:3000 &${NC}"
echo -e "    2. Open dashboards:      ${CYAN}open http://localhost:3001${NC}"
echo -e "    3. Run load tests:       ${CYAN}./scripts/load-test.sh${NC}"
echo -e "    4. Watch metrics live in Grafana while tests run!"
echo -e ""
