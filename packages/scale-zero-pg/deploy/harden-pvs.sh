#!/bin/sh
# Patch every PersistentVolume bound to a scale-zero-pg PVC to reclaim policy
# Retain. The default local-path StorageClass provisions PVs with reclaim
# policy Delete, so deleting a PVC (or `kubectl delete ns scale-zero-pg`) also
# deletes the underlying data — and the MinIO/pageserver/safekeeper volumes ARE
# the entire database history. Retain keeps the PV (Released) after a PVC delete
# so the data can be recovered/re-bound.
#
# Idempotent: re-patching an already-Retain PV is a no-op. Safe to run anytime.
# NOTE: newly created PVs (e.g. a scaled-up safekeeper) start as Delete again —
# re-run this after provisioning new claims, or set reclaimPolicy: Retain on a
# dedicated StorageClass for the long term.
set -eu
NS=scale-zero-pg

fail() { echo "FAIL: $*" >&2; exit 1; }
command -v kubectl >/dev/null || fail "kubectl not found"

PVS=$(kubectl get pv \
  -o jsonpath='{range .items[?(@.spec.claimRef.namespace=="'"$NS"'")]}{.metadata.name}{" "}{.spec.persistentVolumeReclaimPolicy}{"\n"}{end}')

[ -n "$PVS" ] || { echo "no PVs bound to $NS PVCs found"; exit 0; }

echo "$PVS" | while read -r pv policy; do
  [ -n "$pv" ] || continue
  if [ "$policy" = "Retain" ]; then
    echo "ok - $pv already Retain"
    continue
  fi
  kubectl patch pv "$pv" -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}' >/dev/null \
    && echo "ok - $pv: $policy -> Retain" \
    || fail "could not patch $pv"
done
echo "PV reclaim hardening done"
