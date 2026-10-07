# ADR-0065: AI model backends — one OpenAI-compatible binding contract, served in-cluster on `BackendService` or externally through a Secret

- **Status:** **Proposed (2026-10-07). Design only.** No code, CRD or CLI change lands with this
  ADR. Build is sequenced **after v1.0 GA and after the `BackendService` CRD (ADR-0004) exists**.
- **Date:** 2026-10-07
- **Trigger class:** ADR + (future) CRD + security (credential custody, a new in-cluster endpoint
  class, egress). Reviewed at the sprint-close design review per `.claude/rules/workflow.md`
  (2026-09-22 amendment: not a merge gate).
- **Origin:** founder request, 2026-10-07: "AI model backends" — locally deployed LLMs and
  jev-like calibrated decision/classifier APIs inside the cluster, **or** the same capability
  through an external provider API key (OpenAI, Anthropic, TypeSafe Jev, …).
  Framing decision, made before this ADR was drafted — jev: **design-only ADR now, build after
  v1.0 GA, on the BackendService path 0.98** / docs recipe only 0.02 / build operator support now
  0.00.
- **Relates to:** ADR-0001 (operator = single source of truth — **no exception added**), ADR-0002
  (polyglot business-logic layer, design-now/build-later), ADR-0003 (Connect + buf), ADR-0004
  (`BackendService` CRD — **this ADR extends it**), ADR-0012 (default-off, self-hostable, no SaaS
  lock-in by default), ADR-0019 (`spec.database.secretRef` — the typed-sugar-over-`envMap`
  precedent this ADR reuses), ADR-0044 (ingress hardening, CNI-conditional enforcement), ADR-0064
  (platform layer and image prewarm — the weight-caching lever).

## Context

### What exists today (verified against `main`, not against the ADRs)

- **`BackendService` exists only on paper.** `packages/kn-next-operator/api/v1alpha1/` contains
  `nextapp_types.go` and nothing else: no `backendservice_types.go`, no controller, no CRD
  manifest. ADR-0004 is `Proposed`. Every in-cluster part of this ADR therefore sits behind
  ADR-0004 being built first.
- **An external provider key can already be injected with zero CRD change.** `NextAppSpec` has
  `spec.secrets.envMap` (Secret key → env var through `secretKeyRef`) and `spec.env` (plain env).
  The config surface carries the same (`secrets.envMap` in `packages/kn-next/src/config.ts`,
  emitted by `cr-builder.ts`). ADR-0019 already proved the pattern of adding a **typed** field
  (`spec.database.secretRef`) as sugar over that same `envMap` machinery.
- **The operator's default NetworkPolicy is ingress-only** (`desiredIngressRules` in
  `nextapp_controller.go`); there is no egress policy. Enforcement is CNI-conditional, and the
  operator already detects whether the CNI enforces policy (`netpol_enforcement.go`). flannel — on
  OKE and OrbStack — enforces nothing.

### What the primary sources say (the facts this design must not contradict)

| Fact | Source |
|---|---|
| KServe's Knative mode "supports scale down to and from zero", but "for generative inference workloads that typically require GPU resources and have longer processing times, the Standard Kubernetes Deployment approach is recommended"; Knative mode is "recommended primarily for predictive inference workloads." | [KServe — Knative serverless installation](https://kserve.github.io/website/docs/admin-guide/serverless) |
| KServe's Hugging Face runtime serves OpenAI-compatible endpoints under an `/openai/v1/…` prefix (configurable via `KSERVE_OPENAI_ROUTE_PREFIX`), using a vLLM backend. | [KServe — generative runtime overview](https://kserve.github.io/website/docs/model-serving/generative-inference/overview) |
| KServe can package weights as OCI images ("Modelcars", **off by default**, `enableModelcar: true`); a `latest`/untagged image defaults to `Always` pull, "negating the benefits of local caching". `LocalModelCache` caches weights on node-local storage to shorten LLM pod start. | [KServe — OCI storage](https://kserve.github.io/website/docs/model-serving/storage/providers/oci), [KServe — Model Cache](https://kserve.github.io/website/docs/model-serving/generative-inference/modelcache/localmodel) |
| vLLM serves an OpenAI-compatible API (`/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, …). Its `--api-key` protects only the `/v1`, `/v2`, `/inference` and `/cohere` prefixes; `/invocations` (same inference capability), `/classify`, `/score`, `/rerank`, `/pooling` and others are **unauthenticated even with a key set**. The docs say not to rely on `--api-key` alone. | [vLLM — OpenAI-compatible server](https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/), [vLLM — Security](https://docs.vllm.ai/en/stable/usage/security/) |
| Ollama serves OpenAI-compatible endpoints under `/v1`; for a local server "the client requires an API key value, but Ollama ignores it." | [Ollama — OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) |
| Knative bounds: `autoscaling.knative.dev/min-scale`, `max-scale`, `initial-scale`, `scale-down-delay`. A slow-starting revision needs `serving.knative.dev/progress-deadline` (default 600 s) above its worst-case start. | [Knative — scale bounds](https://knative.dev/docs/serving/autoscaling/scale-bounds/), [Knative — Deployment resources](https://knative.dev/docs/serving/configuration/deployment/) |
| The Vercel AI SDK's `@ai-sdk/openai-compatible` (`createOpenAICompatible({ name, apiKey, baseURL, headers })`) targets any OpenAI-compatible server. | [AI SDK — OpenAI Compatible Providers](https://ai-sdk.dev/providers/openai-compatible-providers) |
| NetworkPolicy peers are `podSelector`, `namespaceSelector` or `ipBlock`; there is **no FQDN peer** in the core API. | [Kubernetes — Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/) |
| Safetensors stores tensors "safely (as opposed to pickle)". | [Hugging Face — Safetensors](https://huggingface.co/docs/safetensors/index) |

Three of those facts drive the design more than the rest. **The base URL path differs per server**
(`/v1`, `/openai/v1`), so the contract must carry a full base URL, not a host. **No common
in-cluster server authenticates every path**, so knext cannot delegate auth to the model server.
**Upstream itself does not recommend Knative scale-to-zero for GPU LLMs**, so knext must not
promise it.

### The scope collision, head-on

`CLAUDE.md` §1 and `architecture.md` §5: knext is the narrow scale-to-zero Next.js adapter, **not**
a PaaS, and "an ML platform" is the most expensive possible way to become one. The test this ADR
applies to every element: **does it exist because a Next.js app calls a model server-side?** If yes,
it is the gateway calling a backend — the same shape as ADR-0002's business-logic services and the
database binding in ADR-0019. If it exists to train, register, version, schedule or sell models, it
is out.

## Decision

### D1. Scope: what knext will and will NOT do

**knext will:** give a Next.js app **one server-side binding** to a model, whether the model runs
in the cluster or behind a provider's API; run **small, single-container model servers** as
cluster-local `BackendService`s with the same posture as any other backend; and enforce the
security invariants (auth on every path, Secret-only credentials, content logging off).

**knext will NOT:**

- **train or fine-tune** models, or run training jobs of any kind;
- run a **model registry**, version models, or track lineage/experiments;
- **manage a GPU fleet**: no GPU node pools, drivers, device plugins, MIG/time-slicing, or
  GPU quota. A `BackendService` may *request* an extended resource on nodes the user already runs
  (D5); provisioning them is the user's or the cloud's job;
- run **multi-tenant inference as a service** for third parties, metering, or billing;
- **create or own KServe objects** (`InferenceService`, `LocalModelCache`, …). A user who runs
  KServe binds to it by reference (D3);
- ship or claim to replicate **TypeSafe Jev** or any other vendor's model. knext defines how an app
  *reaches* a decision model, not the model;
- choose a **default provider**. Nothing defaults to a SaaS (ADR-0012's rule holds).

### D2. One app-side contract, two modes

The app reads **env only** — the same rule as every other knext binding. Per binding `<NAME>`
(DNS-1123 name, upper-cased, `-` → `_`, prefixed to avoid colliding with ADR-0004's
`<NAME>_SERVICE_URL`):

| Env var | Meaning | Comes from |
|---|---|---|
| `KNEXT_AI_<NAME>_BASE_URL` | Full API base URL **including the path prefix** (`…/v1`, `…/openai/v1`). Never carries credentials (no userinfo, no key in the query). | plain env |
| `KNEXT_AI_<NAME>_API_KEY` | Provider key (external mode) or the per-binding bearer token the auth sidecar checks (in-cluster mode). **Always** a `secretKeyRef`. | Kubernetes Secret |
| `KNEXT_AI_<NAME>_MODEL` | Model id to request. | plain env |
| `KNEXT_AI_<NAME>_PROTOCOL` | `openai` (default) or `decision` (D4). | plain env |

Per-binding names, not the vendor-standard `OPENAI_BASE_URL`/`OPENAI_API_KEY`, because one app may
bind several models (a chat model and a classifier) — jev: **namespaced 0.96** / vendor-standard
0.04 (conf 0.92).

The app uses **one server-only client** whichever mode is behind the env. The documented pattern
is the AI SDK provider pattern:

```ts
// lib/ai.ts
import 'server-only';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export const chat = createOpenAICompatible({
  name: 'chat',
  baseURL: process.env.KNEXT_AI_CHAT_BASE_URL!,
  apiKey: process.env.KNEXT_AI_CHAT_API_KEY!,
})(process.env.KNEXT_AI_CHAT_MODEL!);
```

A provider whose native API is not OpenAI-compatible is reached with that provider's own AI SDK
package, reading the **same** env vars. knext's contract is the env, not the SDK — knext does not
ship or wrap provider SDKs.

**Mode 1 — external.** The key lives in a Kubernetes Secret the user creates; the operator injects
it as `KNEXT_AI_<NAME>_API_KEY`. It is **never** in `kn-next.config.ts`, the CR's plain `env`, an
image, or a URL. Egress posture in D6.

**Mode 2 — in-cluster.** A model server runs as a **cluster-local `BackendService` with
`flavour: model`** (D3). The operator provisions a per-binding bearer token Secret, mounts it into
the backend's auth sidecar **and** injects it into the bound `NextApp`, and sets
`KNEXT_AI_<NAME>_BASE_URL` to the backend's cluster-local URL. A model server the user runs
themselves (KServe Standard mode, a vLLM Deployment) is bound by **reference** as an external
binding whose base URL is a `*.svc.cluster.local` address; knext then secures only what it owns
(the Secret, the env), and says so.

**Which mode first:** external — jev **external 0.69** / in-cluster 0.31 / both as equals 0.00
(conf 0.53, *medium*). The dissent is real and recorded: in-cluster is the self-hostable path that
ADR-0012's "no lock-in" instinct favours, and it is what keeps prompts inside the cluster. External
goes first anyway because it needs **no new CRD and no new cluster component** (D8), and "first
supported" is not "default provider" — D1 forbids a default provider.

### D3. CRD shape: a `model` flavour of `BackendService`, bound through `NextApp.spec.backends`

jev: **BackendService `model` flavour + one `spec.backends` binding list 0.90** / NextApp
`spec.ai` reference only 0.10 / separate `ModelBackend` CRD 0.00 (conf 0.85).

Sketch — **not built, not final**; field names settle when ADR-0004 is implemented:

```yaml
apiVersion: apps.kn-next.dev/v1alpha1
kind: BackendService
metadata: { name: classifier }
spec:
  flavour: model                 # default `grpc` keeps ADR-0004 unchanged
  protocol: openai               # openai | decision
  image: registry.example/model-server@sha256:<digest>   # digest-pinned; :latest rejected
  port: 8000                     # HTTP/1.1 behind the auth sidecar (not h2c)
  model:
    id: <model-id>
    weights:                     # optional; exactly one source
      image: registry.example/weights@sha256:<digest>     # OCI layer, pre-pullable
      # pvc: { claimName: weights, subPath: m1, sha256: <digest> }
  scaling: { minScale: 0, maxScale: 2 }
  resources:
    cpuRequest: "1"
    memoryRequest: 2Gi
    extended: { "nvidia.com/gpu": "1" }   # passthrough only (D5)
  placement: { nodeSelector: {}, tolerations: [] }
---
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
spec:
  backends:                      # ADR-0004's list, extended with an `external` variant
    - name: classify
      service: classifier        # in-cluster BackendService → env + token, operator-provisioned
    - name: chat
      external:
        baseURL: https://api.provider.example/v1
        model: <model-id>
        secretRef: { name: provider-key, key: api-key }   # same namespace only (ADR-0019)
```

What the operator does, and only the operator (ADR-0001 unchanged):

- `flavour: model` → a Knative Service with `networking.knative.dev/visibility: cluster-local`, the
  model server container, an **auth sidecar** that owns the only exposed port, the per-binding token
  Secret, and the ingress NetworkPolicy (D6).
- `spec.backends[].external` → the four env vars, the key through `secretKeyRef` — typed sugar over
  `envMap`, exactly the ADR-0019 shape, including "no namespace field": a `NextApp` can only bind a
  Secret in its own namespace.
- Status conditions (bound / token provisioned / backend ready) go through `computeStatusVerdict`
  (`architecture.md` §4), never new branches in `Reconcile`.

The CLI renders these fields into the CR and applies **only the CR**. It never reads, prints or
writes key material; it may print the `kubectl create secret` command for the user to run.

### D4. Calibrated decision models ("jev-like")

**What the contract means.** A decision model takes **typed questions** over a **state** and returns
**typed answers with probabilities**: yes/no → `P(yes)`; pick-one → a probability per option plus
the argmax; rubric score → a position on declared levels. *Calibrated* is a property of the model,
not of the wire format: among answers given probability *p*, about *p* of them are right. **knext
cannot certify calibration** and will not claim to; the contract carries the model id and version
so an app can pin the thresholds it tuned.

**One contract, either mode** — jev **one typed contract, external or small in-cluster CPU
classifier, knext ships contract + docs not a model 1.00** / external only 0.00 / in-cluster only
with a knext-trained model 0.00 (conf 1.00). The schema is a `.proto` (`knext.ai.decision.v1`),
because ADR-0002 makes proto the single source of truth for service contracts, and Connect
(ADR-0003) also speaks JSON over HTTP. An in-cluster classifier implements it directly; an
external decision API is reached through an app-side adapter to the same generated TS types. The
proto is drafted when ADR-0002's build starts, not here.

| | Small in-cluster CPU classifier | External decision API |
|---|---|---|
| Latency | No WAN hop; a scale-from-zero wake on the first call (**to measure**) | Network round trip to the provider (**to measure** per provider) |
| Data residency | State never leaves the cluster | State leaves the cluster — PII review required |
| Calibration | The user's responsibility to validate on their own data | The provider's claim; knext does not verify it |
| Cost shape | CPU while warm; zero when scaled to zero | Per-call pricing |
| Ops burden | Image, weights, upgrades, scanning | Key rotation, egress, provider outages |
| Scale-to-zero | Yes — CPU-only, fits the default | n/a |

### D5. Scale-to-zero realities

- **CPU-only small models** (classifiers, small embedders) **may scale to zero** like any knext
  app. Their wake cost is image pull + weight load + server start — **to measure** per model; no
  number is claimed here.
- **GPU LLMs default to `minScale ≥ 1`** — jev **minScale ≥ 1, scale-to-zero opt-in after
  measuring 0.96** / scale to zero by default 0.00 / no GPU LLMs at all 0.04 (conf 0.94). Weights
  in the gigabytes make the wake "tens of seconds to minutes" — an order of magnitude, **to
  measure** on real hardware before any number is published — and KServe itself recommends a
  Standard Deployment over Knative for generative GPU work. Scale-to-zero is an explicit opt-in
  that requires `serving.knative.dev/progress-deadline` above the measured start and a
  `scale-down-delay` to avoid flapping.
- **The calling app must survive the wake.** `spec.timeoutSeconds` and the client timeout must
  exceed the measured backend start; the doc will say so next to the measurement.
- **Weight caching options**, all **to measure** before one is recommended:
  1. **Weights as a digest-pinned OCI image layer** (the KServe Modelcar idea, without KServe) —
     reuses knext's digest pinning and the ADR-0064 image prewarm path;
  2. **A `ReadOnlyMany` PVC** with a declared sha256;
  3. **KServe `LocalModelCache`** — only when the user runs KServe; knext binds by reference.
- **GPU handling is passthrough only** — jev **passthrough 0.90** / forbid GPU requests 0.10 /
  knext-managed GPU nodes 0.00 (conf 0.85): `resources.extended` plus `nodeSelector`/`tolerations`.

### D6. Security

1. **No unauthenticated model endpoint.** An inference endpoint spends compute and leaks
   behaviour, so it gets the bar the "no unauthenticated mutating endpoints" rule sets. jev
   **auth sidecar on every path + NetworkPolicy 0.99** / NetworkPolicy only 0.01 / the server's
   own key 0.00 (conf 0.98):
   - the **operator-injected auth sidecar** owns the only exposed port and requires the
     per-binding bearer token on **every path** — because vLLM's `--api-key` leaves `/invocations`
     and others open and Ollama ignores keys;
   - `visibility: cluster-local` — no public route;
   - an ingress **NetworkPolicy** limited to the Knative/Kourier data path. It **cannot** name the
     calling app: cluster-local traffic arrives from the activator/gateway, not the caller's pod.
     So the token is the per-caller authN and the policy is L3 defence in depth. **On flannel
     (OKE, OrbStack) the policy is declarative only**; `doctor` reports that through the existing
     enforcement detection.
2. **Secrets in Kubernetes Secrets only.** Provider keys and binding tokens are `secretKeyRef`s.
   Slice A1's guard **rejects** a `*_API_KEY`/`*_TOKEN` name in plain `env`, and a base URL with
   userinfo or a key-shaped query parameter.
3. **Prompt and response content logging is OFF by default** — jev **off, opt-in per app with
   redaction guidance 1.00** (conf 1.00). knext's own telemetry records model id, latency, status
   and token counts, never content. Opting in is per app and documented as a PII decision.
4. **Egress for the external mode** — jev **document now; opt-in, CIDR-based egress policy later,
   never default-on 1.00** / default-on 0.00 / say nothing 0.00 (conf 1.00). A default-on egress
   policy would break every existing app's database, cache and storage traffic. Core
   NetworkPolicy has no FQDN peer and provider IPs move, so a CIDR allowlist is coarse; FQDN egress
   needs a CNI or mesh extension, which knext documents and does not ship. Same CNI caveat.
5. **Supply chain for model images and weights.**
   - Server and weight images: digest-pinned (`:latest` rejected, as for apps), scanned in the
     user's pipeline, signature verification documented.
   - Weights: a PVC source must declare a sha256 the operator records in status; **safetensors
     over pickle formats**, which can execute code when loaded. Weight provenance (where they came
     from, under what licence) is recorded by the user and surfaced, not verified, by knext.
6. **Out of scope, stated so it is not assumed:** prompt injection and tool-call safety are the
   app's responsibility. Treating model output as untrusted input belongs in the docs page.

### D7. Sequencing

Design now. Build **after v1.0 GA**, the external slice first because it needs no CRD change; the
in-cluster slices **after `BackendService` (ADR-0004)** is built and verified on its own. The first
slice — jev **env contract + `envMap`/`env` + docs page + guard, no CRD change 1.00** / typed
`NextApp` field first 0.00 / BackendService model flavour first 0.00 / an `@getknext/lib` SDK
wrapper 0.00 (conf 1.00) — is A1 below.

## Options considered

### CRD / API shape (the load-bearing choice)

| Option | Pros | Cons | jev |
|---|---|---|---|
| **A. `BackendService` `flavour: model` + `NextApp.spec.backends[]` with an `external` variant (chosen)** | One backend CRD, one controller, one binding list, one env contract; reuses ADR-0004's cluster-local + token design; the in-cluster and external modes look the same to the app | Waits for ADR-0004; widens `BackendServiceSpec` (protocol, weights, extended resources); "backend" naming for an external provider is a slight stretch | **0.90** |
| B. A separate `ModelBackend` CRD | Room for model-specific fields | A second controller and CRD that duplicate `BackendService`; the natural home for every ML-platform feature D1 rules out — the scope-drift magnet | 0.00 |
| C. `NextApp.spec.ai` references only; knext never runs a model | Smallest; no new cluster component | In-cluster mode gets no knext-owned auth or policy — the vLLM/Ollama auth gaps land on every user; a second binding list beside ADR-0004's | 0.10 |

C's useful half survives inside A: binding a **user-run** server by reference is an `external`
entry with a cluster-local URL.

### Which mode ships first

| Option | Pros | Cons | jev |
|---|---|---|---|
| **External first (chosen)** | No CRD change, no new component; works on every cluster; shortest path to a useful docs page | Prompts leave the cluster; provider dependency | **0.69** |
| In-cluster first | Self-hostable, data stays in the cluster | Blocked on ADR-0004; GPU questions unanswered | 0.31 |
| Both as equals | — | Doubles the first slice | 0.00 |

### First slice

| Option | jev |
|---|---|
| **Env contract via existing `spec.secrets.envMap` + `spec.env`, docs page, guard; no CRD change (chosen)** | **1.00** |
| Typed `NextApp` binding field first (CRD change) | 0.00 |
| `BackendService` model flavour with vLLM first | 0.00 |
| An `@getknext/lib` helper wrapping provider SDKs | 0.00 |

### In-cluster serving approach

| Option | Pros | Cons | jev |
|---|---|---|---|
| **knext runs the server image as a cluster-local `BackendService`; KServe bound by reference (chosen)** | knext owns only what fits its model (one Knative Service, one image); no KServe dependency in the operator | A user who wants KServe features runs KServe | **0.67** |
| The operator creates and owns KServe `InferenceService`s | KServe runtimes, caching, autoscaling | A hard dependency on KServe CRDs and version skew; KServe's own guidance steers GPU LLMs off Knative; the ML-platform drift D1 forbids | 0.31 |
| Ollama as the default server | Easy local start | Ignores API keys; a default would be a product choice knext should not make | 0.02 |

## Failure modes

| Failure | Effect | Mitigation |
|---|---|---|
| Key placed in plain `env` or in the base URL | Key visible in the CR, `kubectl get`, GitOps diffs | A1 guard rejects it at config validation; docs show only `envMap` |
| Model server path left open behind the sidecar (port mis-wired) | Unauthenticated inference | Sidecar owns the only container port; kind drill hits every known unauthenticated vLLM path and requires 401 (A4) |
| NetworkPolicy not enforced (flannel) | No L3 defence in depth | Token still required; `doctor` reports non-enforcement; docs carry the caveat |
| GPU model scaled to zero | First request waits for a weight load, may hit the progress deadline or the client timeout | `minScale ≥ 1` default for GPU; scale-to-zero opt-in requires a measured start and matching deadlines |
| External provider outage or rate limit | App errors | App-level concern; docs recommend timeouts and fallbacks; knext adds no retry layer |
| Weights changed under a PVC | Silent model swap | Declared sha256 checked and recorded in status |
| CLI newer than the operator emits `spec.backends[].external` | Rejected by strict validation | Existing upgrade order (operator/CRD first) and the CRD-schema preflight |

## Consequences

- **Positive:** an app can call any OpenAI-compatible model, in or out of the cluster, with one
  server-only client and four env vars; the external slice needs no CRD change; the in-cluster path
  inherits ADR-0004's posture instead of inventing one; the "not an ML platform" line is written
  down with a test for each future proposal.
- **Negative:** in-cluster support waits for ADR-0004; `BackendServiceSpec` grows model-specific
  fields; the auth sidecar is a new knext-built (or knext-pinned) image to scan and sign; GPU
  claims stay "to measure" until someone pays for a GPU node.
- **Neutral:** nothing changes for apps that do not bind a model; the platform layer (ADR-0064) may
  later carry defaults (prewarm of weight images) without changing this contract.

## Action items (issue-ready; file after the sprint-close review accepts the design)

Each item is independently shippable. None starts before v1.0 GA.

| # | Item | Depends on | Exit criteria |
|---|---|---|---|
| **A1** | **Env contract + external-mode docs page + guard** (no CRD change) | v1.0 GA | Docs page "Call an AI model from your app" uses `createOpenAICompatible` with `KNEXT_AI_<NAME>_*` via `secrets.envMap` + `env`; config validation rejects a `*_API_KEY`/`*_TOKEN` key in plain `env` and a base URL with userinfo or a key-shaped query parameter (mutation-proved); a kind test binds an app to a stub OpenAI-compatible server and shows the key absent from `kubectl get nextapp -o yaml` |
| A2 | Egress posture doc + design note for an opt-in egress policy | A1 | Docs state the posture, the no-FQDN limit and the CNI caveat; the opt-in policy is filed as its own ADR-0044 amendment, not built here |
| A3 | `BackendService` CRD base (ADR-0004) | v1.0 GA | ADR-0004's own action items; verified on kind and OKE |
| A4 | `flavour: model`, CPU only: auth sidecar, per-binding token, cluster-local, NetworkPolicy, scale-to-zero | A3 | kind drill: every path of a vLLM CPU server (including `/invocations`) returns 401 without the token, 200 with it; the bound app works; scale-to-zero and the wake time measured and recorded |
| A5 | `NextApp.spec.backends[].external` typed binding + `doctor` check | A3 | Typed sugar over `envMap` (ADR-0019 shape, same-namespace only); status via `computeStatusVerdict`; CRD-schema preflight covers the new field |
| A6 | GPU passthrough + weights as an OCI image, measured | A4 + founder Q1 | `resources.extended` + placement; cold start measured on one GPU node; `minScale ≥ 1` stays the default unless the measurement says otherwise |
| A7 | `knext.ai.decision.v1` proto + a CPU classifier template | ADR-0002 build | Proto under `buf breaking`; the template passes a decision round trip in-cluster; docs make no calibration claim |

### Wayfinding questions for the founder

1. **GPU availability.** Is there budget/quota for one GPU node on OKE or EKS to measure A6? With
   none, GPU stays a documented passthrough with no published numbers.
2. **Which providers first** in the docs: a generic OpenAI-compatible example only, or named
   OpenAI / Anthropic / TypeSafe Jev pages? Naming vendors is a positioning choice under ADR-0012.
3. **TypeSafe Jev specifically:** may the docs name it as an example external decision API, given
   knext uses it internally?
4. **Data residency demand:** do target users need prompts to stay in the cluster? If yes, A4
   moves ahead of A5.
5. **Auth sidecar:** a knext-built minimal proxy (new image to sign and scan) or a pinned upstream
   proxy (e.g. Envoy)?
6. **Dogfood:** is there a real first use — a classifier in the reference file-manager app or
   docs-site search — to prove A4 on, rather than a synthetic demo?
