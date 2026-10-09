# Next.js deployment-adapter listing — DRAFT (HELD: this is the VERIFIED-TIER path, not the
# unblocked one)

> **STATUS: HELD, and conditionally relevant.** This file drafts the **verified-adapter** tier
> entry — only applicable if `getknext-dev/knext` founder decision #1565 (open as of 2026-10-02,
> see `docs/release/nextjs-listing/NOTES.md`) resolves toward that tier rather than a plain
> platform-list link. The unblocked, no-governance-decision-needed path is the platform-list PR in
> `docs/release/nextjs-listing/` (patch + commands ready, not submitted). Do not treat this file as
> the primary GA deliverable.
>
> **2026-10-02 refresh:** `@getknext/core` has been published to npm since 2026-07-26 — the old
> "HELD on npm publish" framing above is stale, not current. The real remaining gate is the
> **14-consecutive-run compat credential** (14 consecutive green independent runs per cell, three
> scheduled runs per cell per day). The window restarted on `v1.0.0-rc.6` / Next.js `v16.3.8`; check
> the current count on getknext-dev/knext#1359. Do not submit until
> that gate closes, and re-verify every number below against the live matrix at submission time —
> none of it is current enough to copy as-is.

This is the draft of a deployment-adapter entry for the Next.js documentation's adapters listing,
parked here so it can be adapted quickly if the verified-tier path is chosen.

## Submission gate

- [x] **npm publish:** `@getknext/core` / `@getknext/lib` / `@getknext/db` are published; `npx knext`
      works for outside users.
- [ ] **Compat credential — 14/14 on all four cells:** in progress; the 14-run window restarted
      on `v1.0.0-rc.6` (node×turbopack, node×webpack, bun×turbopack, bun×webpack). **← the real
      remaining box.** Track via getknext-dev/knext#1359.
- [ ] **Governance decision (#1565):** whether to pursue the verified tier at all, which requires
      org-hosting under `github.com/nextjs` for the adapter package — a separate ask from the
      compat-suite evidence itself. **Not yet decided.**
- [ ] **Compatibility-matrix promotion:** re-confirm the "Official Next.js compatibility suite" row
      in [`docs/compat-matrix.md`](https://github.com/getknext-dev/knext/blob/main/docs/compat-matrix.md)
      is ✅ at submission time — it is evidence-gated and reverts on any red credential run, so it must be
      re-checked fresh, not assumed from this draft.

## Draft entry (submit-ready once the box above is checked)

**Name:** knext

**Category:** Self-hosted deployment adapter (Kubernetes / Knative)

**One-liner:** The scale-to-zero Next.js deployment adapter for Knative/Kubernetes — validated
against the official Next.js compatibility suite.

**Description:**

> knext runs Next.js on the official Next.js Deployment Adapter API with `output: 'standalone'`,
> targeting Knative on any Kubernetes cluster (GKE, EKS, AKS, OKE, bare-metal). It runs against the
> official Next.js compatibility test suite (Next.js v16.3.6, all four runtime×builder cells:
> node/bun × turbopack/webpack) on a scheduled basis, three runs per cell per day — `[FILL AT GA]` for the final
> consecutive-run count and pass/fail totals once the 14-run credential window closes; do not
> cite a count here before then. It provides true scale-to-zero (idle services drop to zero
> replicas and wake via the Knative activator), cached cold starts (`NODE_COMPILE_CACHE` on Node;
> opt-in per-file bytecode compilation on the Bun runtime), and a Go operator that is the single
> source of truth for cluster state — reconciling a `NextApp` custom resource, enforcing
> digest-pinned images, and reporting honest readiness conditions. Published images are
> vulnerability-scanned before push, SBOM-attested, cosign-signed, and carry SLSA provenance.
> Object storage via GCS, S3, or MinIO. Apache-2.0.

**Adapter wiring:** `adapterPath: '@getknext/core/adapter'` (top-level since Next.js 16.2;
`experimental.adapterPath` on 16.0.x–16.1.x) — the `NextAdapter` shape.

**Repo:** https://github.com/getknext-dev/knext

**Docs:** https://knext-platform.dev

**Compatibility note:** knext publishes an evidence-gated
[compatibility matrix](https://knext-platform.dev/docs/compat-matrix): every claim cites the CI run that
proves it, and the matrix row reverts on any unexplained red. Both runtimes (Node and Bun) and both
builders (Turbopack and Webpack) run against the suite — `[FILL AT GA]` for per-cell run IDs and
pass/fail counts once the 14-run credential window closes (tracked at
getknext-dev/knext#1359). Claims here are limited to what those four cells show; no vinext/compiled
claim is made.

## Honesty rules for this listing (still binding)

- Claims must match the live compat matrix at submission time — re-check the matrix the day of
  submission; a red credential run revokes the ✅ and re-holds this draft.
- Do not claim any officially recognized "verified adapter" *status/program membership* unless
  Next.js establishes such a program and knext is accepted — "validated against the official
  compatibility suite, N/N on every scheduled run" is the claim the evidence supports.
- The Bun lane stays out of the headline until its matrix row is ✅ under the same evidence
  contract.
