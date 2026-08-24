# Public-release readiness — the honest blocker list

> Goal (set 2026-08-24): **make sure everything is ready for public release.** This file is the
> single place that answers "can we announce this?" — measured, not asserted, and re-checked at
> the close of every loop iteration alongside the debt/perf/ergonomics ledgers.
>
> Companion ledgers: `docs/debt/tech-debt-ledger.md`, `docs/benchmarks/cold-start-ledger.md`,
> `docs/ux/ergonomics-ledger.md`.

## Verdict: NOT READY — 2 hard blockers, both outside anything an agent can do

**Blocker 3 was cleared by measurement on 2026-08-25 (#846).** The two that remain are not
engineering work at all — they are one org-admin click and one `npm publish`:

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

### ~~Blocker 3 — the compat claim's own gates are red or flaky~~ — CLEARED 2026-08-25

**The premise was two-thirds wrong, and the measurement says so.** Diagnosed from the
`compat-run-ledger` artifact of *every* scheduled run (2026-07-28 → 08-24) and independently
re-derived by an adversarial reviewer from the raw artifacts:

- **#545's "shard-level flaky" claim is FALSE for the credential lane.** 28 fingerprinted node
  nights, 26 of 27 at `778/0/0`, `runAttempt: 1` throughout — **zero re-runs, zero nights lost to
  a test failure**. The gate is not flaky.
- **#710's bun-lane red is TRUE and honest.** Deterministic Bun ≤1.3.14 gaps reproducing 4/4 runs,
  already marked ❌ in the matrix. Explicitly **not** quarantined: ADR-0007 §c.2's bar is a *flake*
  bar, and quarantining a permanent gap launders it into apparent green.
- **What actually blocks the 14-night v1.0 gate is harness-fingerprint churn** — 9 restarts in 27
  nights, longest stable streak 7 — because a fingerprint change restarts the window. That is a
  tractable, named engineering problem, not an unreachable flake bar.

Landed as #846, with five defects found in the supporting machinery by review — the important one
flattering us: the audit silently dropped runs, and a dropped night **merged two streaks**,
overstating stability. Fixed and mutation-proved in both directions. #545 and #710 carry the
corrected findings; #670 remains in the blocker-1 family (it needs a publicly-pullable image).

### ~~Blocker 3 (original text, retained for provenance)~~
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
5. [x] Agent: compat flake hunt (#545) and the bun-lane weekly red (#710) — the last honesty gate.
       **Discharged 2026-08-25** — findings, run IDs and test names in
       [`compat-honesty-gate.md`](compat-honesty-gate.md). Neither issue blocks the release claim:
       the node credential lane took **zero** re-runs across all 32 scheduled runs in the window
       (asserted twice — the ledger's `runAttempt` *and* the API's `run_attempt`), and the bun
       weekly is deterministically red on three documented upstream-Bun files while its matrix row
       is already ❌. One real defect was found and fixed on the way: `ci.yml` and `compat-smoke.mjs`
       both deflected readers to a scheduled workflow named `compat-suite-full`, which does not
       exist — now guarded by `tests/compat-lane-pointer-resolution.test.ts` (5/5 mutation-proved).
       **Residual, tracked not blocking:** #545 should be closed against its own criteria; the
       14-night gate's real obstruction — harness-fingerprint churn, 10 window restarts in 27
       nights — is now filed as #850; #710 is a permanently-unclearable weekly alert and needs a
       disposition.
6. [ ] Agent: ergonomics row 8 — measure the REAL `npx kn-next` journey post-publish.
7. [ ] Then: announce.
