#!/bin/sh
# Network-exposure contract + isolation verification.
#
# Implements two findings from docs/reviews/system-design-review.md #4
# (network exposure):
#   1. The external LoadBalancer must expose ONLY the Postgres wire port
#      (55432) — never the metrics port (9090). Metrics stay ClusterIP-internal.
#   2. A default-deny-ingress baseline plus per-component allow policies must
#      exist, with compute:55433 reachable ONLY from the gateway pods.
#
# The Service-level and object-level checks below are DETERMINISTIC and
# CNI-independent — they prove the manifests are correct regardless of whether
# the running CNI enforces NetworkPolicy.
#
# The runtime isolation checks are ENFORCEMENT-AWARE and enforcement-DETECTING.
# First an empirical cross-namespace probe decides whether this cluster's CNI
# enforces NetworkPolicy at all (a foreign-ns pod hitting the gateway's :9090 —
# a policy-denied path — either connects or is blocked). Then:
#   * enforcement detected  -> the denied data path (compute:55433 from a
#                              non-gateway pod) MUST be blocked, or the drill FAILS.
#   * enforcement absent     -> the objects are inert; the drill WARNS honestly
#                              and names the remediation, never faking a pass.
# Verified on OKE (context-ckmva7v7zvq): the default pod network here is
# kube-flannel (overlay) with NO NetworkPolicy controller, so the policies are
# admitted but inert and the drill WARNS. On a Calico/Cilium (or OCI VCN-native
# with network policy) cluster the same drill hard-asserts isolation.
set -eu
NS=scale-zero-pg
K="kubectl -n $NS"
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CLIENT_IMG=neondatabase/compute-node-v17:8464

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }
warn() { echo "WARN: $*" >&2; }

# --- 1. external LoadBalancer must NOT expose 9090 ------------------------------
# Any Service of type LoadBalancer selecting the gateway must carry only 55432.
LB_SVCS=$($K get svc -o jsonpath='{range .items[?(@.spec.type=="LoadBalancer")]}{.metadata.name}{" "}{end}' 2>/dev/null)
[ -n "$LB_SVCS" ] || fail "no LoadBalancer service found for the gateway front door"
for s in $LB_SVCS; do
  PORTS=$($K get svc "$s" -o jsonpath='{.spec.ports[*].port}')
  case " $PORTS " in
    *" 9090 "*) fail "LoadBalancer service '$s' still exposes 9090 externally (metrics leak): ports=[$PORTS]" ;;
  esac
  case " $PORTS " in
    *" 55432 "*) ok "LoadBalancer '$s' exposes 55432 only (no 9090): ports=[$PORTS]" ;;
  esac
done

# metrics must still be reachable INTERNALLY on a ClusterIP (Prometheus, peers,
# _metrics.sh all use pggw:9090).
INT_9090=$($K get svc -o jsonpath='{range .items[?(@.spec.type=="ClusterIP")]}{.metadata.name}={.spec.ports[*].port}{"\n"}{end}' | grep -E '(^| )9090|=9090| 9090|9090$' || true)
echo "$INT_9090" | grep -q 9090 || fail "metrics port 9090 not exposed on any ClusterIP service (Prometheus/_metrics.sh would break)"
ok "metrics 9090 reachable internally via ClusterIP"

# --- 2. NetworkPolicy objects must exist ---------------------------------------
for np in default-deny-ingress gateway-ingress compute-ingress pageserver-ingress \
          safekeeper-ingress minio-ingress storage-broker-ingress; do
  $K get networkpolicy "$np" >/dev/null 2>&1 || fail "NetworkPolicy '$np' missing"
done
ok "all 7 NetworkPolicies present (default-deny + 6 component allows)"

# --- 3. manifest contract: compute:55433 restricted to the gateway only --------
MF="$HERE/70-networkpolicy.yaml"
[ -f "$MF" ] || fail "manifest $MF not found"
grep -q 'name: default-deny-ingress' "$MF" || fail "70-networkpolicy.yaml missing default-deny-ingress"
# compute policy must name app=pggw as an allowed source and port 55433.
awk '/name: compute-ingress/{f=1} f' "$MF" | grep -q 'app: pggw' \
  || fail "compute-ingress does not restrict source to app=pggw"
awk '/name: compute-ingress/{f=1} f' "$MF" | grep -q '55433' \
  || fail "compute-ingress does not scope port 55433"
ok "manifest contract: compute:55433 ingress restricted to app=pggw"

# --- 4. positive path: front door still serves through the gateway (drill a) ----
DSN="postgres://cloud_admin:cloud_admin@pggw:55432/postgres?sslmode=disable"
P=netpol-probe-$$
$K run "$P" --image="$CLIENT_IMG" --image-pull-policy=IfNotPresent \
  --restart=Never --quiet --command -- psql "$DSN" -tA -c "select 1" >/dev/null 2>&1 || true
$K wait --for=jsonpath='{.status.phase}'=Succeeded pod/"$P" --timeout=150s >/dev/null 2>&1 || true
OUT=$($K logs "$P" 2>&1 | tail -1)
$K delete pod "$P" --ignore-not-found --wait=false >/dev/null 2>&1
[ "$OUT" = "1" ] || fail "client could NOT reach postgres through pggw:55432 under NetworkPolicy (got: $OUT)"
ok "front door open: client reached postgres via pggw:55432 under NetworkPolicy (drill a)"

# --- 5. enforcement DETECTION (deterministic, always runs) ---------------------
# Empirically decide whether THIS cluster's CNI enforces NetworkPolicy, without
# depending on compute being awake. The gateway-ingress policy restricts :9090
# (metrics) to IN-NAMESPACE pods only (`from: [{podSelector: {}}]`). A pod in a
# FOREIGN namespace that reaches the gateway pod's :9090 is therefore travelling
# a policy-DENIED path — if it connects, the CNI is not enforcing NetworkPolicy.
# The gateway is always running (never scaled to zero), so this needs no compute
# and gives a clean allow/deny signal on every run.
GWIP=$($K get pod -l app=pggw -o jsonpath='{.items[0].status.podIP}' 2>/dev/null || true)
ENFORCED=unknown
if [ -n "$GWIP" ]; then
  SCRATCH=netpol-scratch-$$
  kubectl create namespace "$SCRATCH" >/dev/null 2>&1 || true
  P=np-detect-$$
  kubectl -n "$SCRATCH" run "$P" --image=busybox:1.36 --image-pull-policy=IfNotPresent \
    --restart=Never --quiet --command -- \
    sh -c "nc -w 5 $GWIP 9090 </dev/null && echo REACHABLE || echo BLOCKED" >/dev/null 2>&1 || true
  kubectl -n "$SCRATCH" wait --for=jsonpath='{.status.phase}'=Succeeded pod/"$P" --timeout=90s >/dev/null 2>&1 || true
  DET=$(kubectl -n "$SCRATCH" logs "$P" 2>/dev/null | tail -1 || true)
  kubectl delete namespace "$SCRATCH" --wait=false >/dev/null 2>&1 || true
  case "$DET" in
    BLOCKED)   ENFORCED=yes; ok "enforcement DETECTED: a foreign-namespace pod could NOT reach gateway:9090 (policy-denied cross-ns path is blocked)" ;;
    REACHABLE) ENFORCED=no;  warn "enforcement ABSENT: a foreign-namespace pod reached gateway:9090 — a path the gateway-ingress policy restricts to in-namespace." ;;
    *)         warn "enforcement detection inconclusive (probe result: '${DET:-none}'); treating as NOT asserted." ;;
  esac
else
  warn "could not resolve a gateway pod IP; skipped enforcement detection."
fi

# --- 6. isolation ASSERTION (enforcement-aware) --------------------------------
# When enforcement is proven, the denied data path (compute:55433 from a
# non-gateway pod) MUST be blocked — a reachable path is a hard FAIL, not a warn.
# When enforcement is absent, the objects are inert here; warn honestly and point
# at the remediation instead of faking an isolation pass the cluster can't deliver.
if [ "$ENFORCED" = yes ]; then
  RUNNING=$($K get pods -l app=compute --field-selector=status.phase=Running --no-headers 2>/dev/null | grep -c . || true)
  if [ "${RUNNING:-0}" -ge 1 ]; then
    Q=netpol-iso-$$
    # psql connect straight at compute:55433 from a non-gateway (default SA) pod
    # in this namespace. Reachable => TCP open (auth may still fail, port answered).
    # Unreachable => connect timeout (isolation enforced).
    $K run "$Q" --image="$CLIENT_IMG" --image-pull-policy=IfNotPresent \
      --restart=Never --quiet --command -- \
      sh -c 'psql "postgres://cloud_admin:cloud_admin@compute:55433/postgres?sslmode=disable&connect_timeout=6" -tA -c "select 1" >/tmp/o 2>&1; echo "exit=$?"; cat /tmp/o' >/dev/null 2>&1 || true
    $K wait --for=jsonpath='{.status.phase}'=Succeeded pod/"$Q" --timeout=60s >/dev/null 2>&1 || true
    ISO=$($K logs "$Q" 2>&1)
    $K delete pod "$Q" --ignore-not-found --wait=false >/dev/null 2>&1
    if echo "$ISO" | grep -qiE 'timeout|timed out|no route|could not connect|Connection refused'; then
      ok "isolation ENFORCED and ASSERTED: non-gateway pod cannot reach compute:55433 (drill b)"
    else
      fail "CNI enforces NetworkPolicy yet compute:55433 was REACHABLE from a non-gateway pod — compute-ingress is not isolating the data path (got: $(echo "$ISO" | tail -1))"
    fi
  else
    ok "isolation ENFORCED (cross-ns detection); compute is at zero so the direct data-path probe was skipped — compute-ingress asserted by manifest contract (check 3)"
  fi
elif [ "$ENFORCED" = no ]; then
  warn "This cluster's CNI does NOT enforce NetworkPolicy — 70-networkpolicy.yaml is ADMITTED but INERT here."
  warn "  -> OKE's default pod network on this cluster is kube-flannel (overlay) with NO"
  warn "     NetworkPolicy controller; the policy objects exist but nothing evaluates them."
  warn "  -> The policies ARE declaratively correct and WILL isolate compute:55433 to the"
  warn "     gateway on any enforcing CNI. To enforce on OKE: deploy the Calico policy-only"
  warn "     add-on, or use OCI VCN-native pod networking with network policy enabled."
  warn "  -> Full posture + evidence: docs/operations.md 'Network isolation caveat'."
else
  warn "enforcement status unknown; isolation NOT asserted (see docs/operations.md 'Network isolation caveat')."
fi

echo "netpol verification: contract checks passed"
