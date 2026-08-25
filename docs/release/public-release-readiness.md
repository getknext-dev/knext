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

- **#545's "shard-level flaky" claim is FALSE for the credential lane.** In the window declared
  above (2026-07-28 → 08-24): **28** in-window node nights, **`failed: 0` on all 28**, at the full
  `778/0/0` on **27 of 28** — the 28th (`30790778590`, 08-03) lost shard 16/16 to a runner
  disconnect and recorded 15 shards / 730 passed / 0 failed, which is infrastructure loss, not a
  test failure. Of those 28 nights **27 are fingerprinted**: the 2026-07-28 ledger carries no
  `windowFingerprint` key at all. `runAttempt: 1` throughout — **zero re-runs, zero nights lost to
  a test failure**. The gate is not flaky.
  *(`docs/compat-matrix.md` states the same record in the **07-29**-opened frame, where it reads
  "26 of the 27 nights". Both framings are correct; they differ only in whether the unfingerprinted
  07-28 night opens the window. This file uses the 07-28 frame it declares above.)*
- **#710's bun-lane red is TRUE and honest.** Deterministic Bun ≤1.3.14 gaps reproducing 4/4 runs,
  already marked ❌ in the matrix. Explicitly **not** quarantined — on ADR-0007 §(c)'s *scope*, not
  its evidence bar: §(c) is the **flake**-quarantine ledger (§c.1 per-case only, file-level
  confined to §(d)'s one named family, which expires on the upstream-fix ref bump), and a
  permanent upstream runtime gap is neither flake nor expirable. Quarantining it launders a known
  gap into apparent green. (§c.2's "one FINAL post-retry failure" is a *floor* against pre-emptive
  quarantines; a deterministic red clears it trivially, so it is not what excludes this.)
- **What actually blocks the 14-night v1.0 gate is harness-fingerprint churn** — **10 restarts**
  across the 27 fingerprinted nights, longest stable streak 7 — because a fingerprint change
  restarts the window. That is a
  tractable, named engineering problem, not an unreachable flake bar.

Landed as #846, with five defects found in the supporting machinery by review — the important one
flattering us: the audit silently dropped runs, and a dropped night **merged two streaks**,
overstating stability. Fixed and mutation-proved in both directions. #545 and #710 carry the
corrected findings; #670 remains in the blocker-1 family (it needs a publicly-pullable image).

> **How that claim is kept true, and what it does not cover.** "The issues carry the corrected
> findings" is load-bearing, and it was **false for three review rounds** — corrections landed in
> this repo while the issues went on publishing the retracted figures. It is now checked rather
> than asserted: [`docs/compat/retracted-figures.json`](../compat/retracted-figures.json) records
> every retracted figure with its corrected value, and
> [`retracted-figure-resolution-nightly.yml`](../../.github/workflows/retracted-figure-resolution-nightly.yml)
> resolves each one against every issue these documents cite, failing if any still stands
> uncorrected — and failing, too, if it cannot read them, because a checker that goes green when it
> cannot see its subject is worse than none.
>
> **The limit, stated here rather than only in the ledger:** that check can only test figures
> someone recorded as retracted. A retraction whose author never adds a ledger entry is not caught,
> and no scan can catch it, because nothing in the tree marks the old value as wrong. The gate
> narrows the failure mode; it does not eliminate it.

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
       (from the GitHub API's `run_attempt`, which is authoritative — `1` on all 32, and on all 72
       scheduled runs of this workflow, with none above 1. The ledger's own `runAttempt` agrees,
       but is **not** independent corroboration: the workflow sets it from `github.run_attempt`
       and the ledger script writes it through unchanged, so it is the same counter by a second
       transport, and strictly weaker — an attempt-1 artifact reports `1` whatever happens
       afterwards), and the bun
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
