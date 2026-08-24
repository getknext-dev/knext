# Public-release readiness — the honest blocker list

> Goal (set 2026-08-24): **make sure everything is ready for public release.** This file is the
> single place that answers "can we announce this?" — measured, not asserted, and re-checked at
> the close of every loop iteration alongside the debt/perf/ergonomics ledgers.
>
> Companion ledgers: `docs/debt/tech-debt-ledger.md`, `docs/benchmarks/cold-start-ledger.md`,
> `docs/ux/ergonomics-ledger.md`.

## Verdict: NOT READY — 2 hard blockers, both one human click

**Blocker 3 was cleared by measurement on 2026-08-25 (#846). Blocker 2's premise was wrong and
was corrected the same day** — the missing piece was never an `npm login`, it was an un-clicked
GitHub deployment approval, and the engineering half of it is now fixed. What remains of both
blockers is **two clicks by the repo owner**, not engineering work:

A stranger cannot complete the documented path today. Everything the repo controls is in good
shape; what blocks release is publication and packaging state.

### Blocker 1 — the operator image is not publicly pullable (#198, #707)
`ghcr.io/getknext-dev/kn-next-operator` is **private** (`gh api … --jq .visibility` → `private`).
Consequences, all live and nightly-alarmed: the documented `kubectl apply install.yaml` quickstart
fails for every outside user; the **Anonymous-install nightly has been red for 4+ consecutive
nights** at "Walk the documented install path with no credentials"; the new first-cluster docs page
ships with an in-page caveat because its operator step cannot succeed.
**Action: org-admin visibility flip. Human-only. Nothing else can proceed past it.**

### Blocker 2 — nothing is published to npm — **PREMISE CORRECTED 2026-08-25**

The symptom is real: `npm view kn-next` → 404, and the live `@getknext/*` versions
(`core@0.3.0`, `lib@0.2.0`, `db@0.2.1`) predate every improvement of the last month. So the measured
ergonomics wins (guided first contact, honest help, optional storage, placeholder preflight, routed
`validate`, the `kn-next` alias package) reach **no real user**. That much stands.

**The stated cause did not.** This row previously read *"`npm publish` the four packages (needs npm
auth). Human-only."* Measured:

- **npm auth was never missing.** `NPM_TOKEN` is an **environment** secret on `npm-publish` (set
  2026-07-25) — not a repo secret, which is why a plain `gh secret list` does not show it. The
  publish lane has worked before: #523 published `core@0.3.0` on 2026-07-26, #268 before it.
- **The lane simply never ran again.** Of the last 100 `release.yml` runs, **99 `cancelled`, 1
  `pending`, zero successes** — and every cancelled run has **zero jobs**, i.e. it was killed in the
  queue before starting.
- **Cause:** run `30207128316` (2026-07-26) has its publish job **parked in `waiting`** on the
  `npm-publish` environment's `required_reviewers` rule. Nobody clicked it. `release.yml` had a
  *workflow-level* concurrency group, so that one parked run held the group forever; GitHub keeps at
  most one *pending* run per group, so each new push to `main` cancelled the previous one. No
  Version PR has opened since #523.
- The job that parked was also the job that opens the Version PR — an entirely reversible action
  that should never have waited on a human.

**Fixed in-repo:** `release.yml` is now three jobs. `version-pr` opens the Version PR with no
environment and no credential; `publish-preflight` decides whether anything is genuinely unpublished
and exposes it as a job output; `release` — the only job holding the token — stays behind the
`npm-publish` approval and is *skipped entirely* unless there is something to publish, so it can no
longer park on a routine commit. Concurrency moved to two per-job groups that cannot block each
other. Guarded by `tests/release-lane-liveness.test.ts` and mutation-proved.

**What is left, and it is genuinely human — two clicks, in this order:**

1. **Merge the "Version Packages" PR** that the next push to `main` will open. (It does not exist
   yet; the lane has been unable to open one since 2026-07-26.)
2. **Approve the `npm-publish` deployment** on the run that follows that merge:
   <https://github.com/getknext-dev/knext/deployments> — or the "Review deployments" button on the
   run itself. Only `AhmedElBanna80` can.

**Also human, and a trap worth naming:** the parked run
<https://github.com/getknext-dev/knext/actions/runs/30207128316> is still `waiting`. **Do not
approve it.** It would publish from `c0ed9b75` — the tree as it stood on 2026-07-26, a month of work
behind. Cancel it instead.

**Not established, and not claimed:** whether the token is still *valid*. It is *present* and was
set 2026-07-25; a token can be present and expired, and answering it requires running a job inside
the `npm-publish` environment, which is itself behind the approval above. The publish job now runs
`npm whoami` and fails loudly on a rejected token rather than discovering it mid-publish — so the
first approved run answers the question either way.

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
2. [ ] **Human (two clicks, not a publish):** merge the "Version Packages" PR the fixed lane opens,
       then approve the `npm-publish` deployment on the run that follows. Cancel the stale parked
       run 30207128316 rather than approving it. → makes every ergonomics win real for users.
3. [ ] Agent: re-run the anonymous-install path and the first-cluster page end-to-end; remove the
       page's caveat with a live re-verification; close #198/#707.
4. [ ] Agent: set `vars.SCALE_TEST_IMAGE` from the publish lane (#670); confirm the e2e_scale
       nightly greens.
5. [ ] Agent: compat flake hunt (#545) and the bun-lane weekly red (#710) — the last honesty gate.
6. [ ] Agent: ergonomics row 8 — measure the REAL `npx kn-next` journey post-publish.
7. [ ] Then: announce.
