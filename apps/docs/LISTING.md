# Next.js deployment-adapter listing — DRAFT (HELD on ONE gate: npm publish)

> **STATUS: HELD on a single box.** The verification gates have cleared. Do not submit until
> `@knext/core` is published to npm (`npx kn-next` must work for an outside user, or the listing
> points at a package nobody can install). The moment npm publish lands, this entry is
> submit-ready as written.

This is the draft of a deployment-adapter entry for the Next.js documentation's adapters listing,
parked here so it can be submitted the moment the last gate clears.

## Submission gate

- [x] **Official suite green nightly:** the official `vercel/next.js` deploy-test harness
      (v16.2.0, deploy mode, 16 shards) runs the full suite nightly and is green — 778 passed /
      0 failed, with a fail-on-red gate and pinned alert issues policing regressions.
- [x] **Compatibility-matrix promotion:** the "Official Next.js compatibility suite" row is ✅ in
      [`docs/compat-matrix.md`](https://github.com/getknext-dev/knext/blob/main/docs/compat-matrix.md),
      under an evidence contract enforced by a guard test (run-cited, revocable on any red nightly).
- [ ] **npm publish:** `@knext/core` is published so `npx kn-next` works for outside users.
      **← the one remaining box.**

## Draft entry (submit-ready once the box above is checked)

**Name:** knext

**Category:** Self-hosted deployment adapter (Kubernetes / Knative)

**One-liner:** The scale-to-zero Next.js deployment adapter for Knative/Kubernetes — validated
against the official Next.js compatibility suite.

**Description:**

> knext runs Next.js on the official Next.js Deployment Adapter API with `output: 'standalone'`,
> targeting Knative on any Kubernetes cluster (GKE, EKS, AKS, OKE, bare-metal). It is validated
> against the official Next.js compatibility suite (deploy mode, Next.js 16.2): the full suite
> runs nightly and currently passes 778/778 on Node. It provides true scale-to-zero (idle
> services drop to zero replicas and wake via the Knative activator), cached cold starts
> (`NODE_COMPILE_CACHE` on Node; opt-in per-file bytecode compilation on the Bun runtime,
> roughly halving process start), and a Go operator that is the single source of truth for
> cluster state — reconciling a `NextApp` custom resource, enforcing digest-pinned images, and
> reporting honest readiness conditions. Published images are vulnerability-scanned before push,
> SBOM-attested, cosign-signed, and carry SLSA provenance. Object storage via GCS, S3, or MinIO.
> Apache-2.0.

**Adapter wiring:** `adapterPath: '@knext/core/adapter'` (top-level since Next.js 16.2;
`experimental.adapterPath` on 16.0.x–16.1.x) — the `NextAdapter` shape.

**Repo:** https://github.com/getknext-dev/knext

**Docs:** https://knext.dev

**Compatibility note:** knext publishes an evidence-gated
[compatibility matrix](https://github.com/getknext-dev/knext/blob/main/docs/compat-matrix.md):
every claim cites the CI run that proves it, the full official suite re-verifies nightly, and the
matrix row reverts on any unexplained red. A second runtime lane (Bun) runs weekly, most recently observing 775/778,
with the 3 remaining failures isolated to reproducible Bun runtime bugs.

## Honesty rules for this listing (still binding)

- Claims must match the live compat matrix at submission time — re-check the matrix the day of
  submission; a red nightly revokes the ✅ and re-holds this draft.
- Do not claim any officially recognized "verified adapter" *status/program membership* unless
  Next.js establishes such a program and knext is accepted — "validated against the official
  compatibility suite, N/N nightly" is the claim the evidence supports.
- The Bun lane stays out of the headline until its matrix row is ✅ under the same evidence
  contract.
