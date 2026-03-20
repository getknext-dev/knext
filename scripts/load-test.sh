#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# kn-next Load Testing Suite
# Comprehensive load testing for Knative-hosted Next.js applications.
# Uses only curl + awk + sort — zero external dependencies.
#
# Usage:
#   ./scripts/load-test.sh [BASE_URL] [TEST_NAME]
#
# Examples:
#   ./scripts/load-test.sh                                        # all tests, default URL
#   ./scripts/load-test.sh http://my-app.default.svc.cluster.local
#   ./scripts/load-test.sh http://my-app.default.svc.cluster.local cold-start
#
# Available tests: cold-start, warm, spike, soak, endpoints, ramp-up, all
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────
BASE_URL="${1:-http://file-manager.default.136.111.227.195.sslip.io}"
TEST_FILTER="${2:-all}"
RESULTS_DIR="./load-test-results"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
REPORT_FILE="${RESULTS_DIR}/report_${TIMESTAMP}.txt"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; PURPLE='\033[0;35m'; NC='\033[0m'; BOLD='\033[1m'

# ─── Helpers ─────────────────────────────────────────────────────────────────
mkdir -p "$RESULTS_DIR"

banner() {
  echo ""
  echo -e "${PURPLE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}${CYAN}  $1${NC}"
  echo -e "${PURPLE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

print_stat() {
  printf "  ${YELLOW}%-20s${NC} %s\n" "$1" "$2"
}

# Runs N requests at P concurrency, collects latency stats
# Usage: run_load <total_requests> <concurrency> <endpoint> <output_file>
run_load() {
  local total=$1 concurrency=$2 endpoint=$3 output=$4
  local url="${BASE_URL}${endpoint}"
  local start_time end_time

  start_time=$(date +%s.%N)

  seq 1 "$total" | xargs -n1 -P"$concurrency" -I {} \
    curl -s -o /dev/null -w "%{http_code} %{time_total} %{time_starttransfer}\n" "$url" \
    > "$output" 2>/dev/null

  end_time=$(date +%s.%N)

  # Calculate wall-clock duration
  echo "WALL_TIME $(echo "$end_time - $start_time" | bc)" >> "$output"
}

# Parse results and print statistics
# Usage: analyze_results <output_file> <test_label>
analyze_results() {
  local output=$1 label=$2

  echo -e "\n  ${BOLD}${GREEN}── $label ──${NC}"

  # Extract timing data (exclude the WALL_TIME line)
  local data_file="${output}.data"
  grep -v "^WALL_TIME" "$output" > "$data_file" 2>/dev/null || true

  local total_reqs status_2xx status_4xx status_5xx
  total_reqs=$(wc -l < "$data_file" | tr -d ' ')
  status_2xx=$(awk '$1 ~ /^2/ {c++} END {print c+0}' "$data_file")
  status_4xx=$(awk '$1 ~ /^4/ {c++} END {print c+0}' "$data_file")
  status_5xx=$(awk '$1 ~ /^5/ {c++} END {print c+0}' "$data_file")

  # Latency stats (time_total = column 2)
  local stats
  stats=$(awk '!/^WALL_TIME/ {
    sum += $2; n++;
    if (n == 1 || $2 < min) min = $2;
    if (n == 1 || $2 > max) max = $2;
    vals[n] = $2;
  } END {
    if (n == 0) { print "0 0 0 0 0 0 0 0"; exit }
    avg = sum / n;

    # Sort for percentiles
    for (i = 1; i <= n; i++)
      for (j = i+1; j <= n; j++)
        if (vals[i] > vals[j]) { t = vals[i]; vals[i] = vals[j]; vals[j] = t; }

    p50 = vals[int(n * 0.50) + 1];
    p95 = vals[int(n * 0.95) + 1];
    p99 = vals[int(n * 0.99) + 1];

    printf "%.4f %.4f %.4f %.4f %.4f %.4f %d %.4f\n", avg, min, max, p50, p95, p99, n, sum;
  }' "$data_file")

  local avg min_val max_val p50 p95 p99 count total_time
  read -r avg min_val max_val p50 p95 p99 count total_time <<< "$stats"

  # TTFB stats (time_starttransfer = column 3)
  local ttfb_stats
  ttfb_stats=$(awk '!/^WALL_TIME/ {
    sum += $3; n++;
    vals[n] = $3;
  } END {
    if (n == 0) { print "0 0 0"; exit }
    for (i = 1; i <= n; i++)
      for (j = i+1; j <= n; j++)
        if (vals[i] > vals[j]) { t = vals[i]; vals[i] = vals[j]; vals[j] = t; }
    printf "%.4f %.4f %.4f\n", sum/n, vals[int(n*0.50)+1], vals[int(n*0.95)+1];
  }' "$data_file")

  local ttfb_avg ttfb_p50 ttfb_p95
  read -r ttfb_avg ttfb_p50 ttfb_p95 <<< "$ttfb_stats"

  # Wall-clock time and RPS
  local wall_time rps
  wall_time=$(grep "^WALL_TIME" "$output" | awk '{print $2}')
  if [ -n "$wall_time" ] && [ "$(echo "$wall_time > 0" | bc)" -eq 1 ]; then
    rps=$(echo "scale=2; $count / $wall_time" | bc)
  else
    rps="N/A"
  fi

  local error_count error_rate
  error_count=$((status_4xx + status_5xx))
  if [ "$count" -gt 0 ]; then
    error_rate=$(echo "scale=2; $error_count * 100 / $count" | bc)
  else
    error_rate="0"
  fi

  print_stat "Total Requests:" "$count"
  print_stat "Wall-Clock Time:" "${wall_time}s"
  print_stat "Requests/sec:" "$rps"
  print_stat "Avg Latency:" "${avg}s"
  print_stat "Min Latency:" "${min_val}s"
  print_stat "Max Latency:" "${max_val}s"
  print_stat "P50 Latency:" "${p50}s"
  print_stat "P95 Latency:" "${p95}s"
  print_stat "P99 Latency:" "${p99}s"
  print_stat "TTFB (avg):" "${ttfb_avg}s"
  print_stat "TTFB (p50):" "${ttfb_p50}s"
  print_stat "TTFB (p95):" "${ttfb_p95}s"
  print_stat "2xx Responses:" "$status_2xx"
  print_stat "4xx Responses:" "$status_4xx"
  print_stat "5xx Responses:" "$status_5xx"
  print_stat "Error Rate:" "${error_rate}%"

  # Append to report
  {
    echo "=== $label ==="
    echo "Total Requests: $count"
    echo "Wall-Clock Time: ${wall_time}s"
    echo "Requests/sec: $rps"
    echo "Avg Latency: ${avg}s | Min: ${min_val}s | Max: ${max_val}s"
    echo "P50: ${p50}s | P95: ${p95}s | P99: ${p99}s"
    echo "TTFB avg: ${ttfb_avg}s | P50: ${ttfb_p50}s | P95: ${ttfb_p95}s"
    echo "2xx: $status_2xx | 4xx: $status_4xx | 5xx: $status_5xx | Error Rate: ${error_rate}%"
    echo ""
  } >> "$REPORT_FILE"

  rm -f "$data_file"
}

# ─── Test Scenarios ──────────────────────────────────────────────────────────

test_cold_start() {
  banner "🧊 Test 1: Cold Start (Scale-to-Zero → First Response)"

  echo -e "  ${YELLOW}Waiting 90s for scale-to-zero...${NC}"
  echo -e "  ${YELLOW}(Knative default scale-down is 60-90s after last request)${NC}"
  sleep 90

  echo -e "  ${YELLOW}Sending first request to trigger cold start...${NC}"

  local output="${RESULTS_DIR}/cold_start_${TIMESTAMP}.txt"
  local start_time ttfb total_time status

  start_time=$(date +%s.%N)
  read -r status total_time ttfb <<< $(curl -s -o /dev/null \
    -w "%{http_code} %{time_total} %{time_starttransfer}" \
    "${BASE_URL}/audit")
  local end_time=$(date +%s.%N)

  echo -e "\n  ${BOLD}${GREEN}── Cold Start Results ──${NC}"
  print_stat "HTTP Status:" "$status"
  print_stat "TTFB:" "${ttfb}s"
  print_stat "Total Time:" "${total_time}s"

  # Follow-up warm request for comparison
  read -r status total_time ttfb <<< $(curl -s -o /dev/null \
    -w "%{http_code} %{time_total} %{time_starttransfer}" \
    "${BASE_URL}/audit")

  echo -e "\n  ${BOLD}${GREEN}── Follow-up Warm Request ──${NC}"
  print_stat "HTTP Status:" "$status"
  print_stat "TTFB:" "${ttfb}s"
  print_stat "Total Time:" "${total_time}s"

  {
    echo "=== Cold Start ==="
    echo "Cold TTFB: ${ttfb}s | Total: ${total_time}s | Status: $status"
    echo ""
  } >> "$REPORT_FILE"
}

test_warm_throughput() {
  banner "🔥 Test 2: Warm Throughput (10K requests @ 100 concurrency)"

  echo -e "  ${YELLOW}Warming up with 100 requests...${NC}"
  seq 1 100 | xargs -n1 -P50 -I {} curl -s -o /dev/null "${BASE_URL}/audit" 2>/dev/null
  sleep 2

  echo -e "  ${YELLOW}Running 10,000 requests @ 100 concurrency...${NC}"
  local output="${RESULTS_DIR}/warm_${TIMESTAMP}.txt"
  run_load 10000 100 "/audit" "$output"
  analyze_results "$output" "Warm Throughput (10K @ 100 concurrency)"
}

test_spike() {
  banner "⚡ Test 3: Spike / Burst (1K requests @ 500 concurrency)"

  echo -e "  ${YELLOW}Sending 1,000 requests at 500 concurrency (spike)...${NC}"
  local output="${RESULTS_DIR}/spike_${TIMESTAMP}.txt"
  run_load 1000 500 "/audit" "$output"
  analyze_results "$output" "Spike Burst (1K @ 500 concurrency)"
}

test_soak() {
  banner "🕐 Test 4: Soak Test (5 min sustained moderate load)"

  echo -e "  ${YELLOW}Running sustained load: 50 req/s for 5 minutes (~15K requests)...${NC}"
  local output="${RESULTS_DIR}/soak_${TIMESTAMP}.txt"
  local end_time=$(($(date +%s) + 300))
  local count=0

  > "$output"  # truncate
  local wall_start=$(date +%s.%N)

  while [ "$(date +%s)" -lt "$end_time" ]; do
    # Fire 50 requests in parallel, then sleep ~1s to approximate 50 req/s
    seq 1 50 | xargs -n1 -P50 -I {} \
      curl -s -o /dev/null -w "%{http_code} %{time_total} %{time_starttransfer}\n" \
      "${BASE_URL}/audit" >> "$output" 2>/dev/null
    count=$((count + 50))
    sleep 1
  done

  local wall_end=$(date +%s.%N)
  echo "WALL_TIME $(echo "$wall_end - $wall_start" | bc)" >> "$output"

  analyze_results "$output" "Soak Test (5 min @ ~50 req/s, total: $count)"
}

test_endpoints() {
  banner "🎯 Test 5: Per-Endpoint Comparison (2K requests each)"

  local endpoints=("/" "/audit" "/dashboard" "/cache")

  for ep in "${endpoints[@]}"; do
    echo -e "  ${YELLOW}Testing endpoint: ${ep}${NC}"
    local safe_name=$(echo "$ep" | tr '/' '_' | sed 's/^_/root/')
    local output="${RESULTS_DIR}/endpoint_${safe_name}_${TIMESTAMP}.txt"
    run_load 2000 50 "$ep" "$output"
    analyze_results "$output" "Endpoint: ${ep} (2K @ 50)"
  done
}

test_ramp_up() {
  banner "📈 Test 6: Ramp-Up (Gradually Increasing Concurrency)"

  local concurrencies=(10 25 50 100 200)

  for conc in "${concurrencies[@]}"; do
    echo -e "  ${YELLOW}Concurrency: ${conc} (2K requests)...${NC}"
    local output="${RESULTS_DIR}/ramp_${conc}_${TIMESTAMP}.txt"
    run_load 2000 "$conc" "/audit" "$output"
    analyze_results "$output" "Ramp-Up: ${conc} concurrency (2K requests)"
    sleep 2  # Brief pause between levels
  done
}

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
  banner "kn-next Load Testing Suite"
  echo -e "  ${BOLD}Target:${NC}  $BASE_URL"
  echo -e "  ${BOLD}Test:${NC}    $TEST_FILTER"
  echo -e "  ${BOLD}Time:${NC}    $(date)"
  echo -e "  ${BOLD}Report:${NC}  $REPORT_FILE"

  # Write report header
  {
    echo "kn-next Load Test Report"
    echo "========================"
    echo "Target: $BASE_URL"
    echo "Date: $(date)"
    echo "Filter: $TEST_FILTER"
    echo ""
  } > "$REPORT_FILE"

  # Verify target is reachable
  echo -e "\n  ${YELLOW}Verifying target is reachable...${NC}"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$BASE_URL" 2>/dev/null || echo "000")
  if [ "$status" = "000" ]; then
    echo -e "  ${RED}ERROR: Cannot reach ${BASE_URL}${NC}"
    echo -e "  ${RED}Make sure the service is deployed and accessible.${NC}"
    exit 1
  fi
  echo -e "  ${GREEN}✓ Target reachable (HTTP $status)${NC}"

  # Run selected tests
  case "$TEST_FILTER" in
    cold-start)  test_cold_start ;;
    warm)        test_warm_throughput ;;
    spike)       test_spike ;;
    soak)        test_soak ;;
    endpoints)   test_endpoints ;;
    ramp-up)     test_ramp_up ;;
    all)
      test_warm_throughput
      test_spike
      test_endpoints
      test_ramp_up
      # cold-start and soak are opt-in (they take a long time)
      echo ""
      echo -e "  ${YELLOW}Note: 'cold-start' and 'soak' tests are skipped in 'all' mode.${NC}"
      echo -e "  ${YELLOW}Run them individually:${NC}"
      echo -e "  ${YELLOW}  ./scripts/load-test.sh $BASE_URL cold-start${NC}"
      echo -e "  ${YELLOW}  ./scripts/load-test.sh $BASE_URL soak${NC}"
      ;;
    *)
      echo -e "  ${RED}Unknown test: $TEST_FILTER${NC}"
      echo -e "  Available: cold-start, warm, spike, soak, endpoints, ramp-up, all"
      exit 1
      ;;
  esac

  banner "📊 Summary"
  echo -e "  ${GREEN}Results saved to: ${REPORT_FILE}${NC}"
  echo -e "  ${GREEN}Raw data in: ${RESULTS_DIR}/${NC}"
  echo ""
  cat "$REPORT_FILE"
}

main "$@"
