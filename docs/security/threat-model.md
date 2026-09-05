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

### The vinext build target: an image scan of a compiled binary is vacuous (ADR-0042 C6)

The opt-in vinext target is `bun build --compile --bytecode`: one executable with every JS
dependency inlined. syft and Trivy can read an image's Alpine package database out of it; they
cannot read anything out of the binary. So an image scan of a vinext image is green **because
there is nothing left in the image to scan** — the same vacuity ADR-0042 used to reject
`FROM scratch`, and full `resolve.noExternal` inlining completes it by deleting the last
externalised JS.

The mitigation is to scan the surface that still exists — the **pre-compile dependency closure**,
i.e. the resolved `node_modules` tree that feeds `vite build`:

- `scripts/precompile-closure-audit.mjs` generates a **CycloneDX SBOM (syft)** over the installed
  tree, verifies that the SBOM actually covers that tree, then runs **grype over that exact SBOM**
  and fails on **HIGH/CRITICAL** minus the dated + justified
  `security/precompile-closure-allowlist.json`.
- CI job `vinext-precompile-closure` runs it on every PR, uploads the SBOM as an artifact, and is
  `needs:`-before `bun-exec-alpine-image` — the only job that builds a vinext artifact today. No
  vinext image is published from CI yet; the ordering exists so the precondition holds the day one
  is, and `tests/precompile-closure-gate-ci.test.ts` *scans* **every `.github/workflows/*.yml`** for
  any job that builds the binary or its image — including one that compiles via the `bun run build`
  package-script alias for `./build.sh` — and requires a job running the closure audit in its
  transitive `needs` closure. It does **not** see a lane that compiles through a reusable workflow,
  a composite action or a shell wrapper; adding one means extending
  `tests/helpers/vinext-artifact-scan.ts` in the same change.

**What is still owed.** That scan guards **ordering only**. ADR-0042 C6 also requires the closure
SBOM to be **attached to the image as a cosign attestation** — the day a vinext publish lane ships,
the SBOM must be attached to the published image digest with cosign, because a `needs:` edge alone
would let an image publish with no SBOM bound to it. Today the SBOM is a per-run Actions artifact:
evidence of what was scanned, not provenance attached to an artifact.

**Scope.** The gate covers exactly one closure — the in-repo `examples/bun-exec`, which is the only
vinext application that exists today. A **user** application built on the vinext target has no
equivalent closure gate yet.

Two measured facts that shape the design, both of which make a naive setup **silently vacuous**:

- `syft scan dir:node_modules` with **default catalogers** yields **zero** npm components; the
  `+javascript-package-cataloger` selector is load-bearing.
- `trivy fs` over the example scans `bun.lock` and catalogues **60 npm packages**, where the same
  installed tree holds **210 packages** by the audit's own walker and yields **409 npm components**
  under syft (it counts nested copies and the `package.json` files inside published packages;
  `find -name package.json` returns 527). It missed a HIGH the tree carried. A lockfile is a claim
  about what should be installed; the installed tree is what the compiler swallows.

Hence the emptiness guard (`scripts/lib/precompile-closure.mjs`): floors on both the SBOM component
count and the on-disk package count (an empty tree has *perfect* coverage), a coverage ratio, and
named toolchain anchors. Mutation-proved by pointing it at an empty directory (exit 1) and at a
default-cataloger SBOM (0 components, red).

### `/app/native`: the one thing in a vinext image that is neither compiled in nor scanned

The closure audit above covers the JS the binary swallows. It does **not** cover `/app/native` —
sharp's `@img` addon plus libvips, ~18 MB of `.node` / `.so` that ships *beside* the executable
because a compiled binary cannot `dlopen` a path inside its own virtual filesystem. That tree is the
only remaining path from the install store to native-code privilege in the running pod, and an SBOM
would not close it anyway: a `.node` is an opaque blob, so an SBOM listing the *package* cannot tell
a swapped addon from the real one.

It is pinned instead, in two halves of deliberately different strength:

- **Provenance, at stage time.** `writeNativeIntegrityManifest`
  (`packages/kn-next/src/cli/native-integrity.ts`, called from `stageSharpNative` and from
  `apps/file-manager/Dockerfile` via `scripts/write-native-integrity.mjs`) requires every staged
  `@img` package to appear in `bun.lock` at exactly the version on disk. A missing entry or a
  version mismatch **fails the build** — an `@img` package the lockfile never resolved is the
  injected-dependency case, not a thing to skip. Stated precisely: bun records the integrity of the
  packed **tarball** and what ships is the **extracted tree**, so this pins *which package*, not
  *which bytes*.
- **Bytes, at load time.** The same step writes `native/.integrity.json` — sha256 per staged file —
  and the dlopen shim (`packages/kn-next/src/adapters/sharp-addon-dlopen.mjs`) re-hashes every
  native payload the manifest lists **before** calling `process.dlopen`. A mismatch, or a payload
  the manifest does not list, is fatal and names the file. libvips is covered too, not just the
  addon: the OS loader pulls it in transitively off a relative rpath, so it never passes through the
  shim and verifying only the dlopened file would leave the larger binary unpinned.

**Residual, stated rather than implied.** A manifest that is *absent* warns and loads — images built
before this landed have none, and failing closed on absence would turn a supply-chain fix into a
fleet outage. So an attacker who can strip a file from the image can also downgrade verification to
a warning. The template Dockerfile therefore fails the **build** when the manifest is missing, which
narrows the window to an image mutated after build; closing it fully needs the manifest bound to the
image digest by a signature, which is the same owed work as the closure SBOM attestation above.

That permissiveness is now a **dated exception with an off switch**, not an open-ended default.
Setting **`KNEXT_REQUIRE_NATIVE_INTEGRITY`** in the app's environment makes an absent manifest a
refusal — an operator who knows every image in their fleet postdates native-tree pinning can close
the downgrade path today, without waiting for the default to change. A *mismatch* stays fatal either
way.

The variable has three outcomes, and the third is the one to plan a rollout around:

| value | behaviour |
| --- | --- |
| `1`, `true`, `yes`, `on` (any case, surrounding whitespace ignored) | **fail closed** — an absent manifest refuses to `dlopen` |
| `0`, `false`, `no`, `off`, empty, or unset | the dated exception stands — an absent manifest warns and loads |
| anything else | **the process refuses to start** |

That last row is deliberate and worth stating plainly as an operational consequence: a value the
runtime cannot parse — `enabled`, `2`, a typo — is neither read as "on" nor as "off". Reading it as
"off" is the fail-open case an operator would never see (they would believe the fleet refuses an
unverifiable native tree while nothing had changed); reading it as "on" would brick a fleet on a
typo *silently*. So it throws, by name, listing the accepted values. On a pre-pinning image that
surfaces as a **crash loop on first `/_next/image` request** rather than a quiet misconfiguration —
loud, immediate, and fixed by correcting the variable. Set it from a reviewed manifest, not by hand
on a live workload. The check runs whether or not the image carries a manifest, so a bad value
cannot pass on one image and refuse on the next.

The exception's expiry and its re-raise condition live in
`scripts/lib/native-integrity-policy.mjs`, read by the shared dated-exemption reader; the clock reds
CI rather than the runtime, because a wall-clock branch inside the shim would brick running pods at
midnight on the expiry date — the same fleet outage the exception exists to avoid.

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

## 6. Request ingress to an app pod (ADR-0044)

Two paths reach a knext app, and they are bounded differently. **External**: LoadBalancer → Kourier
(Envoy) → activator/queue-proxy → app container — three HTTP parsers, `containerConcurrency`
enforced. **In-cluster**: a co-resident pod dialling the app pod directly. Until ADR-0044 the second
path was **unbounded** — the default NetworkPolicy carried no port restriction and an empty
same-namespace `PodSelector`, so a neighbour pod reached the app container's port directly, skipping
queue-proxy and with it the concurrency bound and the Go parser.

ADR-0044 Option E closed the *path*: the policy now admits only the queue-proxy ports
(8012/8013/8112) and metrics ports (9090/9464) from `knative-serving`/`kourier-system`, and metrics
ports only from the same namespace. **It does not cap bytes** — that is Option C, deferred on a
dated clock with a hard expiry at Tier-A exit or v1.0.

| STRIDE | Threat | Mitigation | Residual / action |
|---|---|---|---|
| **D**oS (vertical) | One request whose body a route handler buffers (`await req.json()`) exhausts the pod's memory. | `serverActions.bodySizeLimit` caps **Server Actions** at 1 MB; `spec.timeoutSeconds` (default 300s) bounds how long one request holds a slot. | **OPEN.** Route handlers have **no** body cap. With operator defaults (cc=20, memory 1Gi) one oversized body OOMKills one pod and takes up to **19 co-resident in-flight requests** with it. Scale-out does not help — the attack is vertical, not economic. Closed by ADR-0044 Option C. |
| **D**oS (drain bypass) | Repeated OOM degrades availability beyond the individual request. | — | **OPEN, and worse than it looks.** OOMKill is **SIGKILL**: it bypasses the SIGTERM path entirely, so in-flight drain, Next `after()`, and `registerDbPoolDrain` are all skipped. Leaked connections then eat the ADR-0028 `maxScale × poolMax ≤ 80` budget while the restarted pod opens a fresh pool, and each restart pays a full cold start. **No test exercises this path** — the drain gate only covers SIGTERM, so the connection-leak consequence is currently unobservable. |
| **D**oS (rate) | A client floods the app; KPA scales out and bills the tenant. | Bounded by `maxScale` (default 10) × pod memory — a worked ceiling, not an absence. | **OPEN.** No per-client rate limiting anywhere. Mitigate with a front proxy (see the user-facing recipe); note that proxy rate-limit counters are **per replica** unless the proxy shares state. |
| **E**levation / lateral | A co-resident pod (including another zone) reaches the app container directly, bypassing queue-proxy — and, per `scs-zones.md`, calls another zone synchronously when the contract permits only the browser and async events. | ADR-0044 Option E: port allowlist + same-namespace peer scoped to metrics only. Proved by the kind+Calico enforcement drill (direct dial refused, metrics survive, and the refusal disappears when the policy is deleted). | **CNI-conditional.** flannel — which OKE GA and OrbStack run — ships **no NetworkPolicy controller**, so on those clusters the object is declarative-only and enforces nothing. Enforcement requires Calico/Cilium. |
| **S**poof / **T**amper | Malformed HTTP reaches app code. | Three real parsers on the external path (Envoy, Go `net/http`, Node `llhttp`); Node's 16 KB header cap on both paths. | On the in-cluster path only `llhttp` stands in front of app code. |

**Cross-namespace metric scraping (#735).** The default policy admits only
`knative-serving`, `kourier-system` and the app's own namespace, while the operator ships a
`PodMonitor` with `namespaceSelector: any` — so on a policy-enforcing CNI the operator's own scrape
was denied, and the tests asserted *same-namespace* scraping and would have stayed green forever.
Closed by a third ingress rule admitting namespaces labelled `knext.dev/metrics-scrape=true` on the
**app metrics port only** (`9464` — deliberately narrower than the same-namespace rule, since the
shipped PodMonitor targets nothing else). A cluster that labels nothing keeps the prior posture
exactly, and a labelled namespace never reaches the serving ports.

**Residual, stated rather than implied:** this is **namespace RBAC, not a per-app privilege
boundary**. The label sits on a cluster-scoped Namespace, so the grantor is whoever holds
`update namespaces` — on a platform with self-service namespaces, a tenant can grant itself. Once
labelled, *every* pod in that namespace (not just Prometheus) can scrape `9464` on *every* knext app,
which in a shared cluster is cross-tenant metric disclosure. **What is actually exposed, enumerated
from the exporter rather than assumed** — and since ADR-0048 that exporter is the compiled
executable's own exposition (`templates/app/runtime-contract.mjs.hbs`), **not** the retired node
supervisor's prom-client registry (`adapters/metrics.ts`), which no longer serves this port:

<!-- The "9091" in this anchor id is HISTORICAL — the app metrics port moved to 9464 (#951:
     queue-proxy owns :9091 on a stock serving install). The id is pinned by
     observability-metric-contract.test.ts and scripts/mutation-prove-metric-contract.mjs;
     renaming it is a three-file change with no informational payoff. -->
<!-- metric-contract:9091-disclosure start -->

- **Six series, and no more.** `knext_bunexec_http_requests_total`,
  `knext_bunexec_http_request_duration_seconds`, `knext_bunexec_http_inflight_requests`,
  `knext_bunexec_startup_duration_seconds`, `knext_bunexec_process_resident_memory_bytes`,
  `knext_bunexec_process_uptime_seconds`. The list is pinned against the emitter by
  `observability-metric-contract.test.ts`, so it cannot drift from what the binary serves.
- **No route, path, query, payload — or even method — labels.** The request counter carries
  `status_class` alone, five fixed values; the duration histogram carries none. Individual status
  codes do not leak either. An earlier version of this section claimed route labels leak, and a
  later one claimed `app` and `method` labels; both were wrong, and overstating a risk erodes the
  document as surely as understating one.
- **Request volume and error ratio for the pod**, by status class only.
- **Restart and scale-to-zero timing**, from `knext_bunexec_process_uptime_seconds` and
  `knext_bunexec_startup_duration_seconds` — per-app traffic patterns can be inferred from these.
- **Resident memory**, a coarse load signal.

<!-- metric-contract:9091-disclosure end -->

**What is NOT on this port, contrary to earlier versions of this section:** cold-start, DB-wake and
deep-health series, and the `nodejs_*`/`process_*` families `collectDefaultMetrics` registers. Those
are prom-client metrics on an app's own `/api/metrics` route, which the shipped PodMonitor does not
scrape — an app that publishes that route publishes them itself, and that is the app's decision to
make, not this port's exposure.

`:9464` serves `GET /metrics` and nothing else — no pprof, health or debug endpoints — so the
exposure is bounded to the above. There is no `PodSelector` because the operator cannot know a user's
Prometheus labels. Operators needing workload-level identity **cannot** fix this by adding a policy alongside:
NetworkPolicies are additive, so a second policy unions its allow-rules with knext's rather than
narrowing them. The only lever is `spec.security.networkPolicy: false` — which disables knext's
policy entirely — followed by a bring-your-own policy that expresses the tighter grant.

**Two operability gaps, named rather than discovered later.** A *mistyped* label value fails
silently — scraping is simply denied, with nothing telling the operator why — and an app owner has
no signal that their app *is* being scraped from another namespace: no status condition, no event,
no metric. Both are observability gaps rather than isolation gaps, but they mean the grant's state
is invisible from both sides. **Revocation** works for new connections (asserted by the enforcement
drill's step 2e); established keep-alive connections can survive unlabelling until torn down,
because CNIs evaluate policy at connection setup and keep flows in conntrack.

**Decision (dated exception, opened 2026-08-15).** knext does **not** yet ship in-process payload or
rate protection. Options D+E close what can be closed without touching the runtime; the byte-cap
remainder is a **bounded, dated exception** in the shape of ADR-0015 — re-reviewed at every sprint
close, with a hard expiry at **Tier-A exit or v1.0**, whichever comes first. This is recorded as an
exception, not as compliance with `security.md`'s reverse-proxy requirement.

---

## Out of scope (and why)
- **Global edge / WAF / DDoS at the CDN layer** — architectural edge knext does not own
  (CLAUDE.md §8); upstream-gated.
- **App business-logic vulns** in customer code — knext secures the *platform* surface, not the
  tenant's application logic.
- **Cross-zone data sovereignty** — covered by `scs-zones.md` + `protect-zone-data-sovereignty.sh`,
  not re-litigated here.
