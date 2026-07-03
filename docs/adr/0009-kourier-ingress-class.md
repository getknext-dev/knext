# ADR-0009: Operator-managed Kourier ingress-class via a declarative bundle ConfigMap

- Status: Accepted
- Date: 2026-06-22
- Deciders: knext architect
- Related: ADR-0001 (operator = single source of truth), issue #45 (Kourier ingress-class),
  `.claude/skills/knative-kubernetes/SKILL.md`, `docs/MATURITY_PLAN.md` (networking layer)

## Context

During OKE validation, knext apps were unreachable through the ingress and the symptom was
diagnosed as **"Kourier broken on k8s 1.34."** That diagnosis was **wrong**. The real cause:
Knative Serving's `config-network` ConfigMap (namespace `knative-serving`) left `ingress-class`
**unset**, so Serving never programmed routes against the installed Kourier ingress. The workaround
was a manual, undocumented, easy-to-forget step:

```sh
kubectl patch cm/config-network -n knative-serving --type merge \
  -p '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'
```

This violates ADR-0001 in spirit: a hand-run `kubectl patch` is out-of-band cluster mutation that
the install bundle does not own. We want the ingress-class set **declaratively** as part of the
operator's installable bundle, so a single `kubectl apply` of `install.yaml` produces a working
ingress with no manual follow-up.

A secondary defect: the correct ingress-class is the full controller-qualified form
`kourier.ingress.networking.knative.dev`. Some internal docs carried a short `kourier.knative.dev`
form, which does **not** match Kourier's ingress class and leaves routes unprogrammed. That drift is
corrected alongside this ADR.

## Decision

1. **Ship a declarative `config-network` ConfigMap in the install bundle.**
   `config/knative/config-network.yaml` defines a `ConfigMap` named `config-network` in the
   `knative-serving` namespace with `data.ingress-class: kourier.ingress.networking.knative.dev`. It
   is wired into the bundle via `config/knative/kustomization.yaml` → `config/default` (`- ../knative`).
2. **Apply with `kubectl apply --server-side`** so the ConfigMap **merges** into the one Knative
   Serving already owns (it holds other networking keys) rather than clobbering it. Documented in the
   operator README.
3. **Namespace/name immunity.** `config/default` applies `namespace: kn-next-operator-system` and
   `namePrefix: kn-next-operator-` to every resource, which would rewrite this ConfigMap to
   `kn-next-operator-config-network` in `kn-next-operator-system` — where Serving would never read it.
   A `transformers:` entry (`config/default/config_network_repin.yaml`, a builtin `PatchTransformer`)
   runs **after** the built-in namespace/namePrefix transformers and re-pins both the name
   (`config-network`) and namespace (`knative-serving`). A test asserts the rendered bundle keeps the
   correct namespace.

## Options considered

| Option | What | Pros | Cons | Verdict |
| --- | --- | --- | --- | --- |
| (a) `KnativeServing` CR | Install the Knative Operator and set network config via its CR | Canonical Knative config surface | Pulls in the **whole Knative Operator**; the repo uses raw `serving-core` everywhere — a large, unwanted dependency | Rejected |
| (b) Go reconciler | A controller that writes `config-network` in `knative-serving` | Self-healing; drift correction | Needs **foreign-namespace ConfigMap RBAC** (write into `knative-serving`); runtime complexity for a one-shot config | Rejected (now) |
| (c) Declarative bundle ConfigMap | Ship `config-network` in `install.yaml` | Bundle-owned + declarative (ADR-0001-compliant); zero new RBAC, no API types, no runtime read/write; single `apply` | One-shot — does not self-heal if a human later un-sets the key | **Chosen** |

## Consequences

- The manual `kubectl patch` step is gone; `kubectl apply --server-side` of `install.yaml` yields a
  working ingress-class.
- No new RBAC, no new API types, no runtime read/write. `make manifests` / `make generate` produce
  no diff.
- **Drift correction, not self-healing:** if an operator later edits `config-network` and removes the
  key, the bundle does not re-assert it until the next `apply`. **Upgrade path:** if drift becomes a
  real operational problem, promote to option (b) — a small reconciler with scoped
  `knative-serving` ConfigMap RBAC. The declarative ConfigMap is forward-compatible with that.
- **Harness mismatch (flagged, not silently flipped):** the operator's local kind/e2e harness and
  Knative install scripts target **net-istio** in places, while this config is **kourier-only**. We do
  not flip the harness to net-kourier as part of this change — that is a separate, deliberate decision
  with its own validation. Until then, this ConfigMap is correct for the **kourier** production path
  (OKE) and inert/wrong for an istio-based dev cluster. Anyone standing up a kourier dev cluster gets
  the right value; anyone on istio must not apply the kourier ingress-class. Track aligning the
  harness to net-kourier as follow-up.

## Resolution / update (2026-06-27, PR #146)

The open follow-up — that **Istio/Contour-default clusters must NOT apply the Kourier
ingress-class**, and that swapping it was a manual, hand-run patch — is **RESOLVED**.

PR #146 ships a **build-time `INGRESS_CLASS` override** so the ingress-class is selected
declaratively at bundle-render time instead of being hand-patched per cluster:

- `packages/kn-next-operator/hack/set-ingress-class.sh` rewrites the `config-network`
  ConfigMap's `ingress-class` value in a rendered `install.yaml`.
- `make build-installer INGRESS_CLASS=istio.ingress.networking.knative.dev` (or
  `contour.ingress.networking.knative.dev`) bakes the cluster-appropriate class into the
  bundle; with no `INGRESS_CLASS` set, the **Kourier default is preserved** (a no-op), so the
  production OKE/kourier path is unchanged.
- `docs/operator/multi-cloud-portability.md` documents the per-cloud ingress-class
  prerequisite (Kourier vs Istio vs Contour) and the exact override invocation.

This closes the "anyone on istio must not apply the kourier ingress-class" caveat in the
Consequences above: portability is now a declarative build-time choice, not an out-of-band
manual step — keeping ADR-0001 (no out-of-band cluster mutation). The ADR's **Status remains
Accepted**; option (c) (declarative bundle ConfigMap) is unchanged, now with a portable default.

## Field finding / update (2026-07-03, issue #208)

The mismatch recurred **in the field** during the scale-zero-pg integration on OKE cluster
`knext2` (getknext-dev/scale-zero-pg#34), and the failure mode is worth recording:

- **Ground truth re-verified at source:** net-kourier's reconciler filters KIngresses on
  `config.KourierIngressClassName = "kourier.ingress.networking.knative.dev"`
  (`net-kourier/pkg/reconciler/ingress/config/config.go`). Anything else — including the
  short `kourier.knative.dev` form — is **silently skipped**: the KIngress is never
  reconciled, routes never program, and no error is surfaced anywhere. The knext bundle,
  released `install.yaml`, and `make build-installer` default all already emit the correct
  full form (this ADR + PR #146); the repo contains **no** occurrence of the short form
  except warnings against it.
- **Where the wrong value came from:** the cluster's **`KnativeServing` CR** (Knative
  Operator install) carried `kourier.knative.dev`. This exposes a gap in option (c): on
  Knative-Operator-managed clusters the Operator **owns and continuously reconciles**
  `config-network` from the CR, so the bundle's declarative ConfigMap value is
  overwritten. The bundle cannot win that fight declaratively — the class must be fixed
  in the CR. Documented in `docs/operator/multi-cloud-portability.md` and the operator
  README.
- **Loud failure added (the durable fix):** the silent skip is the real killer — Knative
  reports only `IngressNotConfigured / "Ingress has not yet been reconciled."` (Unknown,
  forever), which reads as "wait longer". The NextApp reconciler now detects when a child
  ksvc's `RoutesReady`/`Ready` condition has sat in `IngressNotConfigured` past a
  2-minute stall window and surfaces it as `Ready=False` with reason
  **`IngressNotProgrammed`**, plus a Warning event, with a message naming the class
  net-kourier actually serves and pointing at `config-network` / the `KnativeServing` CR.
  Deliberately proportionate: no ingress-controller discovery — just a bounded, named
  alarm on the exact pending state Knative emits.
- The second half of #208 (private GHCR operator image blocking third-party installs) is
  tracked separately in **#198** — not addressed here.

## Action items

- [x] `config/knative/config-network.yaml` + `config/knative/kustomization.yaml`.
- [x] Wire `- ../knative` into `config/default/kustomization.yaml` with a post-transform repin so the
      rendered ConfigMap stays `config-network` in `knative-serving`.
- [x] Tests: source-manifest assertion + rendered-bundle namespace-immunity assertion.
- [x] Docs: operator README prerequisite + `--server-side`; `docs/MATURITY_PLAN.md` root-cause fix;
      skill ingress-class drift fix.
- [x] Follow-up (RESOLVED, PR #146): build-time `INGRESS_CLASS` override
      (`hack/set-ingress-class.sh` + `make build-installer INGRESS_CLASS=...`, default Kourier)
      lets Istio/Contour-default clusters render a portable bundle without a hand-run patch;
      documented in `docs/operator/multi-cloud-portability.md`. Re-evaluate option (b) (a
      self-healing reconciler) only if config drift is observed in practice.
