# Launch post — draft

**DRAFT — not published.** Working draft for the v1.0 launch post. Publishing is a founder-only
step. Every claim below that depends on the v1.0 compat credential finishing is marked with a
`[FILL AT GA: ...]` placeholder — do not fill those in from anything other than real, linked
evidence at GA time.

---

## What knext is

knext is **the scale-to-zero Next.js adapter for Knative and Kubernetes**. It builds your existing
Next.js app with the official Next.js Deployment Adapter API, packages it as a container, and
deploys it as a Knative Service — so the app scales down to zero pods when idle and scales back up
on the next request, on whatever Kubernetes cluster you already run.

knext is **not a general-purpose PaaS**. It is not "Coolify for Kubernetes," and it does not try to
run arbitrary containers or arbitrary frameworks. It is a narrow, Next.js-specific deployment tool
— architecturally closer to an OpenNext-style adapter than to a platform-as-a-service.

## The credential

knext's north-star claim is **verified-adapter status**: open source, built on the official Next.js
Deployment Adapter API, and validated against the official Next.js compatibility test suite —
across four combinations of runtime and build system:

- Node runtime x Turbopack builder
- Node runtime x Webpack builder
- Bun runtime x Turbopack builder
- Bun runtime x Webpack builder

The v1.0 credential requires **14 consecutive nightly green runs of the official compatibility
suite for each of those four combinations**, against a frozen release reference, before it is
considered complete. This is not a one-time pass — it is a sustained, repeated, machine-verified
result.

- Compatibility matrix (live, evidence-gated status): <https://knext.dev/docs/compat-matrix>
- Official Next.js compatibility suite background: <https://knext.dev/docs/compat-suite>

**[FILL AT GA: 14/14 consecutive nightly runs completed for all four cells, the pinned Next.js
reference version, and direct links to the run history proving it. Do not state a completed
credential before this evidence exists.]**

## What it is not

Being honest about scope is part of the credential, not a caveat tacked on:

- **No global edge network or CDN.** knext deploys to the Kubernetes cluster(s) you run; it does
  not provide a global point-of-presence network.
- **No edge middleware or Partial Prerendering (PPR) support yet.** These are architecturally tied
  to a global edge runtime that knext does not have, and are also not yet standardized by the
  official Next.js adapter API knext builds on — this is partly gated on upstream Next.js, not
  solely a knext gap.
- **The compiled single-executable ("vinext") build target is experimental and is not part of the
  v1.0 compatibility credential.** The credential above covers the standard standalone build
  target only (Node/Bun x Turbopack/Webpack); the compiled executable target is under active
  development and evaluated separately.
- **NetworkPolicy-based pod isolation depends on your cluster's CNI.** knext's operator reconciles
  a default-on, internal-only NetworkPolicy per app, but enforcement requires a CNI with a
  NetworkPolicy controller (e.g. Calico, Cilium). Some common CNIs (including flannel, which some
  managed Kubernetes offerings run by default) do not enforce NetworkPolicy at all — on those
  clusters the policy is declarative only. Check what your cluster's CNI enforces before relying on
  this for isolation.

## Cold starts

knext's runtime is built around **scale-to-zero**: idle apps run zero pods and cost zero compute,
and the platform brings a pod back up on the next request. The build pipeline includes
optimizations aimed at reducing that wake-up latency, including bytecode compile caching so a
cold-starting process does not pay V8's JIT-compilation cost on every wake.

**[FILL AT GA: a real, reproducible cold-start figure from cluster measurement, if and when one
exists — the only cluster-level A/B run to date measured a tie between build targets, and no
number should be published without a fresh, dated, reproducible measurement backing it.]**

## Getting started

```sh
npx @getknext/core create my-app
cd my-app
npx @getknext/core deploy
```

Full quickstart: <https://knext.dev/docs>

## Feedback

File issues at <https://github.com/getknext-dev/knext/issues>.
