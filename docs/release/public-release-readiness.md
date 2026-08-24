# Public-release readiness — the honest blocker list

> Goal (set 2026-08-24): **make sure everything is ready for public release.** This file is the
> single place that answers "can we announce this?" — measured, not asserted, and re-checked at
> the close of every loop iteration alongside the debt/perf/ergonomics ledgers.
>
> Companion ledgers: `docs/debt/tech-debt-ledger.md`, `docs/benchmarks/cold-start-ledger.md`,
> `docs/ux/ergonomics-ledger.md`.

## Verdict: NOT READY — 3 hard blockers, all outside the CLI's code

A stranger cannot complete the documented path today. Everything the repo controls is in good
shape; what blocks release is publication and packaging state.

### Blocker 1 — the operator image is not publicly pullable (#198, #707)
`ghcr.io/getknext-dev/kn-next-operator` is **private** (`gh api … --jq .visibility` → `private`).
Consequences, all live and nightly-alarmed: the documented `kubectl apply install.yaml` quickstart
fails for every outside user; the **Anonymous-install nightly has been red for 4+ consecutive
nights** at "Walk the documented install path with no credentials"; the new first-cluster docs page
ships with an in-page caveat because its operator step cannot succeed.
**Action: org-admin visibility flip. Human-only. Nothing else can proceed past it.**

### Blocker 2 — nothing is published to npm (#53 lineage, ergonomics rows 1a/7)
`npm view kn-next` → 404; the `@getknext/*` trio's last publish predates every improvement of the
last week. So the measured ergonomics wins (guided first contact, honest help, optional storage,
placeholder preflight, routed `validate`, the `kn-next` alias package) reach **no real user** until
a publish happens. The install-smoke gate proves the packed tarballs install and run under plain
Node — the artifact is ready; the publish is not done.
**Action: `npm publish` for the four packages (needs npm auth). Human-only.**

### Blocker 3 — the compat claim's own gates are red or flaky (#710, #545, #670)
The project's north-star credibility claim is compat-suite-backed parity. Today: the **bun-lane
weekly is RED** (#710), the suite is **shard-level flaky** (#545 — "the v1.0 gate is unreachable
until it isn't"), and the **e2e_scale nightly fails closed** for want of a publicly-pullable
image (#670 — same family as blocker 1). A public release that cites compat parity while its own
gate is red would fail this project's central honesty rule.
**Action: in-repo work is possible here (flake hunt), but #670 clears with blocker 1.**

## Green — verified, not assumed

- **CI on main is green** across the per-PR gates and the nightlies except the two org-gated lanes
  above (mutation provers, action-pin resolution, operator image-pin resolution, NetworkPolicy
  enforcement drill all passing at audit time).
- **Supply chain**: SBOM + Trivy fail-on-HIGH per image, cosign keyless signing, actions pinned by
  SHA with a nightly tag↔SHA resolver **and** (new, this loop) a check that every input we pass
  still exists in the pinned action; base images digest-pinned with a lockstep patch-floor guard;
  Go builder on 1.25.13 (7 HIGH stdlib CVEs cleared); bun pinned everywhere with a scanning guard.
- **Operator image is multi-arch** (amd64+arm64) as of this week — Apple-Silicon local clusters
  work once blocker 1 clears.
- **Licence**: Apache-2.0 consistently (root + per-package + manifests + source headers).
- **Docs**: quickstart, first-cluster on-ramp (commands run live during authoring), CLI reference,
  five managed-cloud pages, runbook incl. the activator-fallback signature. No internal refs.
- **Measured performance**: product-path cold start 5723 → 3142 ms median (−45%) this week; the
  ledger carries per-row evidence and caveats.

## Release checklist (in dependency order)

1. [ ] **Human:** flip ghcr package visibility to public → unblocks #198/#707, greens the
       anonymous-install nightly, lets #670's publish job exist, removes the first-cluster caveat.
2. [ ] **Human:** `npm publish` the four packages → makes every ergonomics win real for users.
3. [ ] Agent: re-run the anonymous-install path and the first-cluster page end-to-end; remove the
       page's caveat with a live re-verification; close #198/#707.
4. [ ] Agent: set `vars.SCALE_TEST_IMAGE` from the publish lane (#670); confirm the e2e_scale
       nightly greens.
5. [ ] Agent: compat flake hunt (#545) and the bun-lane weekly red (#710) — the last honesty gate.
6. [ ] Agent: ergonomics row 8 — measure the REAL `npx kn-next` journey post-publish.
7. [ ] Then: announce.
