# knext threat model (STRIDE-lite)

> Closes the explicit `.claude/rules/security.md` requirement: *"Maintain a short threat model in
> `docs/security/`."* Companion to the mutating-endpoint audit (`mutating-endpoints.md`). Scope is
> knext's **real** components today — not a generic web-app checklist. Keep current when a trust
> boundary changes.

Last reviewed: 2026-07-23 (added §5 metrics-scrape TLS posture — self-signed cert + `insecureSkipVerify`, #489).

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

## Trust boundaries (the five reviewed paths)
1. **Operator reconcile path** — kube-apiserver → `nextapp_controller.go` Reconcile → Knative /
   NetworkPolicy objects.
2. **Gateway↔backend calls** — the Next.js gateway → cluster-local `BackendService` (h2c, no public
   ingress; ADR-0004). *Design-now/build-later, but in scope for the threat surface.*
3. **The cache-invalidate endpoint** — `apps/file-manager/src/app/api/cache/invalidate/route.ts`
   (`POST`) and `DELETE /api/cache/events`.
4. **The supply chain** — base image → buildkit build → SBOM/Trivy/cosign → GHCR → cluster pull.
5. **The metrics scrape** — Prometheus → the operator's HTTPS metrics endpoint (self-signed cert
   by default; `config/prometheus/monitor.yaml`, `cmd/main.go`).

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
| **R**epudiate | Can't prove which source built an image. | **cosign SBOM attestation + keyless signature** for both images, plus **buildkit SLSA provenance (`mode=max`) restored for BOTH images**: each build exports an OCI layout (which, unlike the `docker` exporter used briefly after the scan-before-push fix, carries the attestation manifest), Trivy gates that exact layout, and a version+checksum-pinned `crane push` publishes it byte-for-byte; a post-push step **fails the run if the pushed index lacks the attestation manifest or the SLSA provenance predicate** (guarded by both workflow test files). | `mode=max` records build args — safe today (the only arg is the public `SOURCE_DATE_EPOCH`); never add a secret build-arg. |
| **Reproducibility** | Two builds of the same commit differ, weakening provenance. | **Not yet fully reproducible** — `SOURCE_DATE_EPOCH` (commit time) is now passed to the app build as a best-effort input, but pnpm/npm install ordering and native `sharp` prebuilts still vary. We deliberately do **not** claim reproducible builds. | Enable buildkit `rewrite-timestamp` + a lockfile-pinned, vendored install before claiming it. |

### Patching policy — `apk upgrade` on a digest-pinned base (#267)

Runner stages **MAY** run `apk upgrade --no-cache` against a digest-pinned base image
(precedent: the `apps/file-manager/Dockerfile` runner stage, added in #267). This is not a
pinning violation, and `scripts/check-base-images-pinned.sh` deliberately does not flag it —
its scope is `FROM` lines only (the base *input*), not packages resolved at build time.

- **The base digest pins provenance of the input.** `apk upgrade` pulls only fixes already
  published on the **same pinned alpine stable branch** — it cannot float the base to a
  different alpine release.
- **The trust anchor for what SHIPPED is the scanned + signed OUTPUT digest.** Both
  supply-chain workflows (`supply-chain.yml`, `operator-supply-chain.yml`) Trivy-gate the
  exact built image (fail on HIGH/CRITICAL) **before** any push, and cosign-sign the pushed
  digest on `main` — a scan-failed image is never pullable at a stable tag and never signed.
  PR builds are Trivy-scanned too (report-only — the gate enforces on `main`), and never
  pushed or signed.
- **Digests are still refreshed on intentional bumps.** The in-place upgrade only covers the
  window between a published apk fix and the next digest bump (e.g. c-ares 1.34.8-r0 for
  CVE-2026-33630); it is a complement to digest pinning, not a substitute.

## 5. Metrics scrape (Prometheus → operator)

The operator exposes controller-runtime metrics over HTTPS. By default the metrics server presents a
**self-signed certificate** (auto-generated by controller-runtime — `cmd/main.go`), so the shipped
`ServiceMonitor` scrapes with `insecureSkipVerify: true` (`config/prometheus/monitor.yaml`). The
endpoint requires authn/authz (`WithAuthenticationAndAuthorization` filter, `cmd/main.go:152`).

| STRIDE | Threat | Mitigation | Residual / action |
|---|---|---|---|
| **S**poof | A rogue in-cluster endpoint impersonates the metrics server. | Targets are label-selected on the operator's own Service; the scrape is cluster-local (no ingress). | `insecureSkipVerify` means the server's identity is **not** verified — an in-cluster MITM on the pod network could impersonate it. Closed by the cert-manager path below. |
| **I**nfo disclosure | The scrape's SA bearer token is harvested by a MITM. | Metrics are non-sensitive counters; the scrape stays on the cluster-local pod network. | The bearer token authenticates *Prometheus → endpoint*; with skip-verify it does **not** verify the endpoint back to Prometheus, so a MITM could capture the token. Enable cert-manager + `monitor_tls_patch.yaml` (references the `metrics-server-cert` secret) for verified TLS. |
| **T**amper | Scraped metrics altered in transit, corrupting dashboards/alerts. | HTTPS encrypts the channel against passive tampering. | Verified TLS (cert-manager patch) closes active MITM. |
| **D**oS | Anonymous scrapes exhaust the operator. | The endpoint requires **authn/authz** (`WithAuthenticationAndAuthorization`) — anonymous scrapes are rejected. | — |

**Decision:** `insecureSkipVerify: true` is accepted for the **default install** — the endpoint is
cluster-local and read-only, the scrape is authenticated, and metrics carry no secrets. The residual
in-cluster-MITM / token-harvest risk (the same trade-off as the upstream kubebuilder default) is
closed by enabling cert-manager and the `monitor_tls_patch.yaml` patch (see
`config/prometheus/kustomization.yaml`), which references the `metrics-server-cert` secret instead of
skipping verification.

---

## Out of scope (and why)
- **Global edge / WAF / DDoS at the CDN layer** — architectural edge knext does not own
  (CLAUDE.md §8); upstream-gated.
- **App business-logic vulns** in customer code — knext secures the *platform* surface, not the
  tenant's application logic.
- **Cross-zone data sovereignty** — covered by `scs-zones.md` + `protect-zone-data-sovereignty.sh`,
  not re-litigated here.
