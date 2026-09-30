# README top-fold rewrite — draft

**DRAFT — not published, not applied.** This is a *proposed* rewrite of the first screen of
`README.md` (roughly its title through the "Why Knative?" section). **Do not edit `README.md`
itself from this task** — another open PR owns that file. This draft exists so the rewrite can be
reviewed and merged into `README.md` separately, once that PR lands.

Same honesty rules as the rest of this kit: no millisecond cold-start numbers, no superlatives, no
filled-in "14/14" claim ahead of the evidence.

---

```markdown
# knext: the scale-to-zero Next.js adapter for Knative

knext deploys an existing Next.js app to Kubernetes as a Knative Service, built on the **official
Next.js Deployment Adapter API** — so your app scales to zero when idle and scales back up on the
next request, on any Kubernetes cluster with Knative Serving installed.

knext is **not a general-purpose PaaS**. It does not run arbitrary containers or frameworks; it is
a focused, Next.js-specific deployment tool.

**The credential:** knext is validated against the official Next.js compatibility test suite,
across four runtime x build-system combinations (Node/Bun x Turbopack/Webpack). v1.0 requires 14
consecutive green nightly runs of that suite per combination, against a frozen release reference.
See the [compatibility matrix](https://knext.dev/docs/compat-matrix) for current, evidence-gated
status — [FILL AT GA: link the completed 14/14 run history here once it exists].

---

## Table of Contents

- [Why Knative?](#why-knative)
- [How It Works: Next.js Adapter](#how-it-works-nextjs-adapter)
- [Features](#features)
- [Quick Start](#quick-start)
- [Configuration Reference](#configuration-reference)
- [Caching & Adapters](#caching--adapters)
- [Multi-Cloud Deployment](#multi-cloud-deployment)
- [Architecture](#architecture)
- [File Manager Demo](#file-manager-demo)
- [Development](#development)

---

## Why Knative?

**Knative** is a Kubernetes-based platform that provides serverless capabilities without lock-in to
any specific cloud provider. Knative runs on **any Kubernetes cluster** (GKE, EKS, AKS, or
on-premise).

### Benefits

| Feature | Knative (via knext) |
|---------|----------------------|
| **Portability** | Any Kubernetes cluster (portable by design; validated end-to-end on multiple clouds — see the multi-cloud validation notes for current coverage) |
| **Scale-to-Zero** | Idle apps run zero pods; the platform brings a pod back up on the next request |
| **Cold starts** | Optimized for scale-to-zero — the build pipeline includes bytecode compile caching to remove V8 compilation work from a cold wake. End-to-end wake time is dominated by cluster scheduling and is environment-dependent; we do not publish a single number as a universal guarantee |
| **Container control** | Full Docker/OCI image access |
| **Networking** | Full Kubernetes networking; a default-on NetworkPolicy is reconciled per app, with enforcement depending on your cluster's CNI |
| **Cost model** | Per-pod-second, not per-invocation |

### Use cases

- Multi-cloud deployments requiring platform portability
- On-premise or air-gapped environments
- Hybrid architectures with existing Kubernetes workloads
- Cost optimization for spiky or low-traffic apps that don't need an always-on pod

### What knext does not do (yet)

- No global edge network or CDN — knext deploys to the cluster(s) you run.
- No edge middleware or Partial Prerendering (PPR) — partly gated on upstream Next.js, not solely a
  knext gap.
- The compiled single-executable ("vinext") build target is experimental and outside the v1.0
  compatibility credential's scope.

---

## How It Works: Next.js Adapter

knext integrates via the **official Next.js Adapter API** (`NextAdapter`), registered through the
top-level `adapterPath` config (Next.js 16.2+; `experimental.adapterPath` on 16.0.x–16.1.x). A
standard `next build` with `output: 'standalone'` produces a self-contained Node server; the
adapter hooks into the build to wire Knative-specific behavior — no custom compiler, no fork of
Next.js.

*(Continues into the existing "Build Pipeline" section below unchanged.)*
```
