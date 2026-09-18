#!/bin/sh
# Print the gateway's live metrics JSON from inside the cluster.
set -eu
# F6: GET /metrics.json is bearer-authenticated (fail-closed); attach the shared
# fleet token the gateway mounts as GW_PEER_TOKEN (Secret pggw-peer-token, key
# `token`, ns scale-zero-pg — see deploy/gen-peer-token.sh + 10-gateway.yaml).
TOKEN=$(kubectl -n scale-zero-pg get secret pggw-peer-token -o jsonpath='{.data.token}' 2>/dev/null | base64 -d 2>/dev/null || true)
kubectl -n scale-zero-pg run metric-peek-$$ --image=curlimages/curl:8.11.1 \
  --restart=Never --rm -i --quiet --command -- \
  curl -s -H "Authorization: Bearer $TOKEN" http://pggw:9090/metrics.json
