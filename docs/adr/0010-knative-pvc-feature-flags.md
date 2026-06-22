# ADR-0010: Operator-managed Knative PVC feature flags via a declarative bundle ConfigMap

- Status: Accepted
- Date: 2026-06-22
- Deciders: knext architect
- Related: ADR-0001 (operator = single source of truth), ADR-0009 (Kourier ingress-class — same
  bundle pattern), issue #59 (PVC feature flags for the bytecode-cache ksvc),
  `docs/MATURITY_PLAN.md` (Tier-A correctness)

## Context

The bytecode-cache ksvc (emitted by the operator when `spec.enableBytecodeCache` is set) mounts a
**PersistentVolumeClaim** so the runtime can persist its `NODE_COMPILE_CACHE` across cold starts.
Knative Serving gates PVC-referencing PodSpecs behind two feature flags in the `config-features`
ConfigMap (namespace `knative-serving`), both **default-off**:

- `kubernetes.podspec-persistent-volume-claim` — allow a PVC volume at all.
- `kubernetes.podspec-persistent-volume-write` — allow a **writable** (non-`readOnly`) PVC mount.
  Required here because the cache mount must be writable.

The stage-4 kind integration test found that with these flags off, Knative's admission webhook
**denies** the ksvc and reconcile fails with no ksvc created. OKE already had the flags enabled
(the bytecode feature was validated live there), so the gap was a missing **install prerequisite**,
not a reconciler bug. Setting the flags by hand (`kubectl patch cm/config-features ...`) is the same
out-of-band, easy-to-forget mutation ADR-0009 eliminated for the ingress-class. We want them set
**declaratively** as part of the operator's installable bundle: one `kubectl apply` of `install.yaml`
yields a cluster where the bytecode-cache ksvc admits cleanly, no manual follow-up.

## Decision

1. **Ship a declarative `config-features` ConfigMap in the install bundle.**
   `config/knative/config-features.yaml` defines a `ConfigMap` named `config-features` in the
   `knative-serving` namespace with both PVC flags = `enabled`. It is wired into the bundle via
   `config/knative/kustomization.yaml` → `config/default` (`- ../knative`, already present).
2. **Apply with `kubectl apply --server-side`** so it **merges** into the `config-features` Knative
   Serving already owns (it holds many other feature keys) rather than clobbering it.
3. **Namespace/name immunity.** `config/default` applies `namespace: kn-next-operator-system` and
   `namePrefix: kn-next-operator-` to every resource, which would rewrite this ConfigMap to
   `kn-next-operator-config-features` in `kn-next-operator-system` — where Serving never reads it. A
   **separate** `transformers:` entry (`config/default/config_features_repin.yaml`, a builtin
   `PatchTransformer`) runs **after** the namespace/namePrefix transformers and re-pins both name
   (`config-features`) and namespace (`knative-serving`). A separate transformer is required because
   the existing `config_network_repin.yaml` targets `.*config-network`, which does **not** match
   `config-features`; we do not broaden that regex.

## Networking-layer independence (vs ADR-0009)

Unlike the ingress-class ConfigMap (#45 / ADR-0009), which is **kourier-only** and inert/wrong on an
istio cluster, the PVC feature flags are **networking-layer-independent**: they govern PodSpec
admission, not route programming. They are therefore safe and correct under **both** net-istio and
kourier, including the operator's istio-based local kind/e2e harness. There is no harness mismatch to
flag.

A `StorageClass` / volume provisioner is still a **separate cluster prerequisite** (a PVC needs
something to bind to). kind ships the `local-path` provisioner by default, so the bundle's flags plus
kind's default storage are sufficient for the integration test; production clusters must supply their
own StorageClass.

## Options considered

| Option | What | Pros | Cons | Verdict |
| --- | --- | --- | --- | --- |
| (a) `KnativeServing` CR | Set feature flags via the Knative Operator CR | Canonical Knative config surface | Pulls in the **whole Knative Operator**; the repo uses raw `serving-core` everywhere — a large, unwanted dependency | Rejected |
| (b) Go reconciler | A controller that writes `config-features` in `knative-serving` | Self-healing; drift correction | Needs **foreign-namespace ConfigMap RBAC**; runtime complexity for a one-shot config | Rejected (now) |
| (c) Declarative bundle ConfigMap | Ship `config-features` in `install.yaml` | Bundle-owned + declarative (ADR-0001-compliant); zero new RBAC, no API types, no runtime read/write; single `apply`; identical to the proven ADR-0009 pattern | One-shot — does not self-heal if a human later disables the flags | **Chosen** |

## Consequences

- The manual `kubectl patch cm/config-features` step is gone; `kubectl apply --server-side` of
  `install.yaml` enables the PVC flags so the bytecode-cache ksvc admits cleanly.
- No new RBAC, no new API types, no reconciler change. `make manifests` / `make generate` produce no
  diff; the operator already builds the PVC-mounting ksvc — this only supplies the cluster prereq.
- **Drift correction, not self-healing:** if an operator later disables a flag, the bundle does not
  re-assert it until the next `apply`. **Upgrade path:** promote to option (b) — a small reconciler
  with scoped `knative-serving` ConfigMap RBAC — if drift becomes a real operational problem. The
  declarative ConfigMap is forward-compatible with that.
- **StorageClass remains out of scope:** binding a PVC requires a provisioner. kind's default
  `local-path` covers CI; production clusters supply their own. This ADR only removes the
  feature-flag gate.

## Action items

- [x] `config/knative/config-features.yaml` + wire into `config/knative/kustomization.yaml`.
- [x] `config/default/config_features_repin.yaml` post-transform repin + wire into
      `config/default/kustomization.yaml`.
- [x] Tests: source-manifest assertion + rendered-bundle namespace-immunity assertion.
- [x] Docs: operator README prerequisite (`--server-side`, prereq for `enableBytecodeCache`);
      `docs/MATURITY_PLAN.md`.
