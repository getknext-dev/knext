# knext Maturity Plan (detailed exit criteria)

> **Canonical roadmap + strategy now live in `ROADMAP.md` and `CLAUDE.md`.** This file is the
> detailed, phase-level exit-criteria companion; its Phases map to the ROADMAP Tiers (see the
> mapping table at the bottom of `ROADMAP.md`). Architect discipline: `.claude/rules/architecture.md`.
> North star: a **verified** Next.js-on-Knative deployment adapter (open source + official compat
> suite + Next.js-docs listing) — a narrow adapter, not a general PaaS.
>
> Reconciliation note (2026-06): the **official-adapter migration merged to `main` (PR #29)** —
> Phase 0 is largely complete; the deprecated Vinext/Nitro runtime is being retired.

## What "mature" means (definition of done)
1. **Correctness** — passes the official Next.js adapter compatibility suite; RSC/ISR/streaming
   parity verified, gated in CI.
2. **Single control plane** — the operator is the only writer of cluster state (ADR-0001).
3. **Security/supply-chain** — SBOM, image scanning (Trivy/Grype), cosign signing, no
   unauthenticated mutating endpoints, distroless runtime.
4. **Completeness** — image optimization story, multi-cloud deploy guides, RWX bytecode cache.
5. **Quality** — meaningful test coverage incl. an e2e deploy on a real cluster; clean-state CI.
6. **Releasable** — npm publishing, semver, docs-as-built, examples.

## Blockers in current code (must clear)
- **Dual cluster writers** — `deploy.ts` `kubectl apply` bypasses the operator → violates
  ADR-0001.
- **Duplicate/dead packages** — `packages/cli` (Go) vs `packages/kn-next/src/cli` (TS), and
  `admin`/`knext` vs `kn-next` naming drift; ambiguous ownership.
- **Stale docs** — `VINEXT_MIGRATION_PLAN.md`, vinext mentions in `ARCHITECTURE.md`.
- **No compat-suite gate** — correctness is unverified.
- **Image optimization dropped** — `sharp` removed (no `next/image` optimization) — a parity gap.
- **Networking layer** — Kourier appeared to "fail to program ingress on k8s 1.34" during OKE
  validation, but the real root cause was an **unset `ingress-class`** in Knative Serving's
  `config-network` ConfigMap, so Serving never wired routes to the installed Kourier ingress.
  Now codified declaratively: the operator install bundle ships a `config-network` ConfigMap
  setting `ingress-class: kourier.ingress.networking.knative.dev` (issue #45, ADR-0009),
  replacing the manual `kubectl patch`.
- **Bytecode-cache PVC feature flags** — the bytecode-cache ksvc mounts a writable PVC, which
  Knative Serving gates behind two default-off `config-features` flags
  (`kubernetes.podspec-persistent-volume-claim` + `...-write`); without them the admission webhook
  denies the ksvc. Previously a manual cluster step; now **bundle-owned**: the operator install
  bundle ships a `config-features` ConfigMap enabling both flags (issue #59, ADR-0010). These flags
  are networking-layer-independent (safe under net-istio and kourier); a StorageClass/provisioner
  is still a separate prerequisite (kind ships `local-path`).

## Phases (sequential; each gated by exit criteria)

### Phase 0 — Reconcile reality (now)
Establish the missing source-of-truth: `.claude/rules/architecture.md`, this plan, `docs/adr/`
(ADR-0001), retire/mark vinext docs, confirm adapter migration on main (PR #29 merged ✓).
**Exit:** strategy is in-repo; stale docs flagged; package/CLI audit ticket opened.

### Phase 1 — Correctness (the north star)
Wire the **official Next.js adapter compatibility suite** into CI; run on every PR. Fix parity
gaps (cache/ISR/RSC/streaming, route types). **Exit:** compat suite green in CI; documented
matrix of supported/unsupported features.

### Phase 2 — Control-plane consolidation (ADR-0001)
Refactor the CLI to **build → push → apply `NextApp` CR only**; remove direct `kubectl apply`.
Resolve Go-cli vs TS-cli duplication; delete dead packages. **Exit:** operator is sole writer;
one CLI; `--dry-run` prints the CR; e2e deploy via CR on a real cluster.

### Phase 3 — Security & supply chain
SBOM (syft), scan (Trivy/Grype, zero HIGH/CRITICAL), cosign signing + attestation,
no-unauth-endpoint audit (operator webhooks + app routes), reproducible build notes.
**Exit:** signed images, clean scans, security review pack in `docs/security/`.

### Phase 4 — Completeness & UX
Image-optimization decision (sidecar optimizer vs CDN-resize vs re-add `sharp`); RWX bytecode
cache (FSS/EFS/Filestore/Azure Files per cloud); supported ingress ADR; multi-cloud guides
(AWS/GKE/AKS/OpenShift/OKE — partially drafted); docs-as-built. **Exit:** guides verified;
image story shipped; ingress path supported on ≥2 clouds.

### Phase 5 — Release
npm publishing (`@knext/*`), semver, changesets, versioned docs site, runnable examples.
**Exit:** `npm i` works; tagged release; docs published.

### Phase 6 — Optional: polyglot gRPC business-logic layer (post-maturity)
See `docs/design/grpc-layer.md` + ADR-0002/0003/0004. **Deliberately sequenced last** — it is a
scope expansion beyond the narrow-adapter north star and must not precede core maturity. Ship as
an **optional, separately-versioned module** (`@knext/grpc` + `BackendService` CRD). **Exit
(when undertaken):** one proto → Go + TS service + generated Next.js gateway glue, deployed as a
cluster-local scale-to-zero Knative service, behind the gateway.

## Scope-fit recommendation (summary)
Build **Phases 0–5 first**. Do **not** build the gRPC layer now — design it (done), but gate it
behind core maturity and treat it as opt-in. Rationale in ADR-0002 §Scope fit.
