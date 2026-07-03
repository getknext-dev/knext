# knext threat model (STRIDE-lite)

> Closes the explicit `.claude/rules/security.md` requirement: *"Maintain a short threat model in
> `docs/security/`."* Companion to the mutating-endpoint audit (`mutating-endpoints.md`). Scope is
> knext's **real** components today — not a generic web-app checklist. Keep current when a trust
> boundary changes.

Last reviewed: 2026-06-27.

## Scope & assets
knext is the scale-to-zero Next.js adapter for Knative. The assets worth protecting:

- **Cluster state** — `NextApp` (and future `BackendService`) CRs and the Knative Services /
  NetworkPolicies the operator reconciles from them. The operator is the **single source of truth**
  (ADR-0001); corrupting it corrupts every deploy.
- **The published images** — `ghcr.io/getknext-dev/file-manager` (app/gateway) and
  `…/kn-next-operator`, plus their base images. These are signed and run in customer clusters.
- **Secrets** — `CACHE_INVALIDATE_TOKEN`, the gateway↔backend shared token, `DATABASE_URL`,
  registry creds. Live only in K8s Secrets / env (security.md).
- **The ISR / data cache** — Redis-backed (`cache-handler.js`); poisoning it serves wrong content.

## Trust boundaries (the four reviewed paths)
1. **Operator reconcile path** — kube-apiserver → `nextapp_controller.go` Reconcile → Knative /
   NetworkPolicy objects.
2. **Gateway↔backend calls** — the Next.js gateway → cluster-local `BackendService` (h2c, no public
   ingress; ADR-0004). *Design-now/build-later, but in scope for the threat surface.*
3. **The cache-invalidate endpoint** — `apps/file-manager/src/app/api/cache/invalidate/route.ts`
   (`POST`) and `DELETE /api/cache/events`.
4. **The supply chain** — base image → buildkit build → SBOM/Trivy/cosign → GHCR → cluster pull.

---

## 1. Operator reconcile path

| STRIDE | Threat (concrete) | Mitigation in repo | Residual / action |
|---|---|---|---|
| **S**poof | A workload forges a `NextApp` to make the operator stand up a Service it shouldn't. | RBAC on the CRD; operator runs with a least-privilege ServiceAccount, `AutomountServiceAccountToken: false`. | Document the minimal Role in the bundle. |
| **T**amper | Untrusted CR sets a mutable / `:latest` image, drifting the CVE surface. | `nextapp_controller.go` **rejects non-digest refs**; `hack/check-no-latest.sh` + the new `scripts/check-base-images-pinned.sh` keep manifests + base images pinned. | — |
| **R**epudiate | No record of what the reconciler changed. | Reconcile emits K8s Events + `status.Conditions`. | Conditions population is partial (CLAUDE.md §9) — finish it. |
| **I**nfo disclosure | Secret values echoed into CR `status` / logs. | Operator reads secrets by reference, never inlines them; never logs values. | Lint guard `block-secrets.sh`. |
| **D**oS | A flood of CRs / requeues starves the controller. | Single-threaded workqueue with backoff; Knative scales the data plane to zero. | Consider a reconcile-rate alert. |
| **E**lev. of priv. | Operator over-broad RBAC lets a compromised CR escalate. | Namespaced, least-privilege Role; no cluster-admin. | Periodic RBAC review. |

## 2. Gateway ↔ backend calls

| STRIDE | Threat | Mitigation | Residual / action |
|---|---|---|---|
| **S**poof | A pod impersonates the gateway to call a backend directly. | Backends are `networking.knative.dev/visibility: cluster-local` (no public ingress); calls carry a **shared signed token** (ADR-0004 / security.md). | Upgrade shared token → **mTLS via mesh** (tracked). |
| **T**amper | In-cluster MITM rewrites an h2c request. | Default-on internal-only `NetworkPolicy` from the CR (`spec.security.networkPolicy`) limits who can reach the backend. | mTLS closes the plaintext-h2c gap. |
| **R**epudiate | No attribution for a backend mutation. | Gateway is the only authenticated caller; per-request logging. | — |
| **I**nfo disclosure | Backend exposed publicly leaks data. | cluster-local visibility enforced by the operator. | — |
| **D**oS | Gateway floods a scaled-to-zero backend on cold start. | Knative concurrency limits + revision autoscaling. | — |
| **E**lev. of priv. | Implicit pod-to-pod trust. | **No implicit trust** — token required; NetworkPolicy default-deny. | — |

## 3. Cache-invalidate endpoint

| STRIDE | Threat | Mitigation | Residual / action |
|---|---|---|---|
| **S**poof / **E**lev. | Unauthenticated caller invalidates / clears the cache. | **Bearer `CACHE_INVALIDATE_TOKEN`, fail-closed** (`isAuthorized`); no `GET` variant so the token can't leak via URL/prefetch (#78). See `mutating-endpoints.md`. | — |
| **T**amper | Cache poisoning via crafted `revalidateTag`. | Token-gated; only declared tags revalidated. | — |
| **R**epudiate | No audit of who invalidated. | Request logging (pino). | Add caller identity to the log line. |
| **I**nfo disclosure | Token in logs/URLs. | Token in header only, never logged; `block-secrets.sh`. | — |
| **D**oS | Repeated invalidation thrashes Redis/origin. | Token-gated (not anonymous); reverse proxy rate-limits (security.md runtime hardening). | Confirm proxy limits in deploy guide. |

## 4. Supply chain

| STRIDE | Threat | Mitigation | Residual / action |
|---|---|---|---|
| **T**amper | Upstream re-pushes a base tag, changing the bytes we sign. | **All Dockerfile `FROM` lines digest-pinned** (`@sha256:`), enforced by `scripts/check-base-images-pinned.sh` (CI `base-image-pin-guard`). | Refresh digests on intentional bumps. |
| **T**amper | A malicious published image is deployed. | **cosign keyless sign + verify** on main for *both* the operator (`operator-supply-chain.yml`) and now the app (`supply-chain.yml` + `apps/file-manager/hack/cosign-verify.sh`); SBOM attestation. | Clients should `cosign verify` before deploy. |
| **I**nfo disclosure | Vulnerable deps shipped silently. | **syft SBOM** per image; **Trivy fails the build on HIGH/CRITICAL** on main (`--ignore-unfixed`) — and **both images are scanned BEFORE they are pushed** (`supply-chain.yml` + `operator-supply-chain.yml`: build local → SBOM → Trivy gate → push → sign; guarded by `tests/supply-chain-workflow.test.ts` + `tests/operator-supply-chain-workflow.test.ts`), so a scan-failed image is never pullable at a stable tag and never signed — and a scan-failed operator run never refreshes the `operator-latest` release's `install.yaml`. The Trivy/syft actions themselves are **SHA-pinned** in both workflows. Builder pinned to a patched Go release (`check-trivy-baseimage.bats.sh`). | — |
| **R**epudiate | Can't prove which source built an image. | **cosign SBOM attestation + keyless signature** for both images. | The buildkit provenance manifest was dropped for BOTH images when their flows moved to scan-before-push (the local `docker` exporter can't carry a provenance manifest list); restore it via an OCI-layout build + `crane` push if buildkit provenance is required. |
| **Reproducibility** | Two builds of the same commit differ, weakening provenance. | **Not yet fully reproducible** — `SOURCE_DATE_EPOCH` (commit time) is now passed to the app build as a best-effort input, but pnpm/npm install ordering and native `sharp` prebuilts still vary. We deliberately do **not** claim reproducible builds. | Enable buildkit `rewrite-timestamp` + a lockfile-pinned, vendored install before claiming it. |

---

## Out of scope (and why)
- **Global edge / WAF / DDoS at the CDN layer** — architectural edge knext does not own
  (CLAUDE.md §8); upstream-gated.
- **App business-logic vulns** in customer code — knext secures the *platform* surface, not the
  tenant's application logic.
- **Cross-zone data sovereignty** — covered by `scs-zones.md` + `protect-zone-data-sovereignty.sh`,
  not re-litigated here.
