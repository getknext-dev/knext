<!--
DRAFT — NOT FOR SUBMISSION. Refs #1566 / #1565.

Do not open this as an issue on github.com/nextjs/adapters-wg until:
  1. The rc.2 credential window shows 14/14 on all four cells (node×turbopack, node×webpack,
     bun×turbopack, bun×webpack) — see docs/compat-matrix.md for the live status.
  2. The founder has sent it (per #1565: "the WG request must address nextjs/adapter-k8s ... up
     front" — the founder should read and approve the positioning table below before it goes out,
     since this is a governance ask, not a mechanical docs PR).

Model: nextjs/adapters-wg#2 ("Adapter submission: @solcreek/adapter-creek") is the one comparable
public submission from an unaffiliated author. It has had 0 replies since 2026-04-22. Per the
lessons research, do not gate anything on a reply — route this through a person (a WG meeting, or
an offer to collaborate with the adapter-k8s maintainers) in parallel with filing the issue.
-->

# Request: knext — Knative/Kubernetes adapter — Ecosystem Working Group participation

**Status: draft.** This is a template for the founder to review, edit, and send personally — not
ready to file as-is.

## What knext is

knext is an open-source Next.js deployment framework for **Knative-based Kubernetes clusters**. Its
default build target uses the official Next.js **Deployment Adapter API**
(`adapterPath` / `NEXT_ADAPTER_PATH`) — a plain `next build`, no forked runtime, no reverse-engineered
internals. A Go operator reconciles a custom resource (`NextApp`) that wraps a Knative Service, so
deployments get **scale-to-zero** (including to zero replicas when idle) on infrastructure the user
already controls.

knext is **not a general-purpose PaaS**. It does not manage compute for you, does not run a control
plane you don't own, and requires no vendor account: it targets any Knative-conformant cluster
(the project has run it on OKE, GKE, and EKS).

## How it differs from `nextjs/adapter-k8s`

We're aware `github.com/nextjs/adapter-k8s` already exists inside the `nextjs` org (WG minutes
2026-04-09 attribute it to Google, GKE-focused). We want to name the difference up front rather than
have it surface as a question later:

| | `nextjs/adapter-k8s` | knext |
|---|---|---|
| Target | GKE-managed infrastructure specifically ("GKE-only initially" per WG minutes) | Any Knative-conformant Kubernetes cluster (cluster-agnostic; OKE/GKE/EKS/kind proven) |
| Traffic/routing | Envoy Gateway, CLI-driven blue/green pool-server cutover | Knative Serving's own revision/traffic-splitting + KPA autoscaler |
| Scale-to-zero | Not described in the public README (grep-confirmed zero "Knative" mentions) | Core to the design — Knative's scale-to-zero is the reason the project exists |
| GitOps | Argo CD / Flux supported | Operator-reconciled CR is itself the desired-state source; GitOps tooling can apply the CR the same way |
| Maturity signal | 12 stars, active pushes, GKE-first | [FILL AT GA] compat-suite result, published independently |

We see these as **siblings, not rivals** — different infrastructure assumptions (managed GKE vs.
"bring your own Knative cluster"). We'd welcome guidance on whether the WG would rather see knext
collaborate with the `adapter-k8s` effort, or continue as a separate Knative-specific project; we
don't assume either answer.

## Evidence (fill only once real — do not submit with placeholders unresolved)

- Official Next.js compatibility test suite result: `[FILL AT GA]` (run ID), `[FILL AT GA]`
  (pass/fail counts across all 4 cells), `[FILL AT GA]` (Next.js ref tested against)
- Scheduled (not dispatch-only) run: `[FILL AT GA]` (link to the nightly/scheduled workflow with
  ≥ 7 consecutive green runs, per the lessons research recommendation — this is what
  `adapter-creek`'s submission lacked)
- Public results page: `[FILL AT GA]` (link, if published ahead of submission)
- License: Apache-2.0 (already true today, not a placeholder — `packages/kn-next/LICENSE`,
  `packages/lib/LICENSE`, `packages/db/LICENSE`)
- Repository: `[FILL AT GA — confirm public org URL at submission time]`

## What we're asking

1. To join the Ecosystem Working Group as a participating project, per the stated "join by request"
   process (`nextjs.org/ecosystem-working-group`).
2. Guidance on whether a second, Knative-specific Kubernetes adapter is welcome alongside
   `adapter-k8s`, or whether collaboration is preferred.
3. **We are not asking for verified-adapter status in this issue** — that's a separate, later
   conversation once org-hosting and long-term-maintenance questions have their own answer (see the
   positioning ADR, getknext-dev/knext#1565, kept internal).

## Named maintainer

`[FILL AT GA — founder name / handle, offered as the point of contact, per the lessons research:
"route the ask through a person"]`

---

*This request was drafted with AI assistance (Claude Code) and reviewed by a human before
submission.*
