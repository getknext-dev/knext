#!/bin/sh
# Print the gateway's live metrics JSON from inside the cluster.
set -eu
kubectl -n scale-zero-pg run metric-peek-$$ --image=curlimages/curl:8.11.1 \
  --restart=Never --rm -i --quiet --command -- \
  curl -s http://pggw:9090/metrics.json
