# The vinext Stable bar and support policy (v2)

**Status: RATIFIED (2026-10-17, v2 Sprint 5 close design review, beside the Bun single-executable bar
[ADR-0070](../adr/0070-bun-single-exec-stable-bar.md); [architect](https://github.com/getknext-dev/knext/issues/2504#issuecomment-6229290082)).** Proposed 2026-10-16.
Ratifying the bar does not graduate anything.

**This document graduates nothing.** vinext is **Beta** today and stays Beta until every criterion
below is met by runs that exist. No sentence in the docs, release notes or matrix may say "Stable"
or "verified" for vinext before then. Design only: no compat run is dispatched, no workflow edited,
no user docs changed by this change.

It replaces the earlier proposal (the go/no-go bar of the runtime-axis decision, ADR-0054). That
proposal's open question, the credential cadence, is now settled by a founder decision and is not
re-opened here (see [Resolved](#resolved-since-the-first-proposal)).

## Scope

The vinext build target (`build: 'vinext'`): the vinext app compiled to the Bun single executable
(`runtime: 'bun'`) and the vinext app on the Node server with a baked V8 compile cache
(`runtime: 'node'`). It is ESM Next.js apps only (ADR-0051). The two runtimes are **separate cells**
and graduate separately (see C1). The default build is untouched by graduation: it stays the Next
standalone output in disk mode (`architecture.md` §4; ADR-0054).

## What already exists (guard it, do not rebuild)

`.github/workflows/compat-vinext.yml` and `tests/compat-vinext-lane.test.ts`:

- **Same denominator as the default cells.** The lane runs `test/deploy-tests-manifest.knext.json`
  at the same 16 shards; the lane test asserts the manifest and shard total equal the default lane's.
  The denominator is **derived from the manifest, never typed into a claim.** (The lane's current
  evidence reads "of 1099 files"; an older draft of this bar quoted 778, which was the denominator
  of an earlier manifest.)
- **One variable changes:** the artifact. Each fixture is built by `vite build` and compiled with
  `dist/adapters/vinext-compile.js`; the binary (or the Node server) is booted, not a dev server.
- **Red on fail, no escape hatch.** No `continue-on-error`. A shard exits non-zero on `failed>0`,
  `notRun>0`, a missing summary or a truncated shard; the ledger reds when summaries disagree with
  `COMPAT_SHARD_TOTAL`. A stale ledger entry (a quarantined file that now passes) reds the lane.
- **Lane-attributable.** Every summary carries `builder:vinext`, `runtime`, and the observed
  `bun --version`.
- **Two ledgers, both bounded.** The per-file quarantine ledger (`test/compat-vinext-ledger.json`:
  at most 15 files, 30-day expiry) and the structural-gap ledger
  (`test/compat-vinext-structural-gaps.json`: files that fail only because vinext does not implement
  the Next.js 16.3 client-router architecture; vinext lanes only; **cap 41, only ever lowered**,
  raised only by an ADR-0007 amendment; review by 2027-01-08; guard
  `tests/compat-vinext-structural-gaps.test.ts`).

## The bar: criteria V-C1 to V-C7

A vinext cell is Stable only when **every** criterion holds, each backed by a scheduled or per-PR
**red-on-fail** check. A criterion met by a one-off measurement or by review does not count.

| # | Criterion | Check | State on 2026-10-16 |
|---|---|---|---|
| **V-C1** | **The credential: 14 consecutive green, independent runs per cell**, under ADR-0056 Amendment 5, unchanged. The cells are `bun-vinext` and `node-vinext`; each graduates on its own run count. See "What counts as a run" below. | `scripts/compat-window-audit.mjs` (lists the cell once `wired: true`) and `scripts/compat-run-ledger.mjs`. To build: a credential-mode cron on `compat-vinext.yml` that uses `compat-credential-ref.mjs` (today it is weekly and dispatch only), and the `node-vinext` cell (#1260). | **Not met.** No counted vinext run exists. Latest measured number (dispatch, not countable): 1016 passed / 36 failed / 47 quarantined of 1099 on Next.js v16.3.6, Bun 1.4.2, vinext 1.1.0 plus bundled patches. |
| **V-C2** | **Pass threshold per run:** on every one of the 16 shards `failed = 0`, `notRun = 0`, nothing truncated, with only the two bounded ledgers applied and no entry stale. The pass count must be at least that of the same vinext version run uncompiled (compile plus bytecode adds no regression; gaps that uncompiled vinext also has are upstream's). | The lane's per-shard gate and ledger checks (exist). The uncompiled-baseline comparison is recorded in the run evidence; no automated check yet. | **Not met.** 36 files still fail. |
| **V-C3** | **Disclosed gap, bounded.** The structural-gap ledger stays at or below its cap, every entry is attributed upstream, and the quarterly review is held. The Stable claim is worded only as **"Stable on the official suite minus N disclosed known-gap files"**, with N read from the ledger. The words "same bar", "verified", or an unqualified "compatible" never describe vinext. | The ledger guard (exists). A docs guard that derives N from the ledger and reds on "same bar" wording for vinext: **to build** with the promotion PR. | **Partly met** (ledger and guard exist; N is 41; wording guard not built). |
| **V-C4** | **Support policy holds** (next section): Bun at least 1.4.2, one pinned vinext version in lockstep, and the normalizer registered with a retirement probe. | `tests/vinext-pin-lockstep.test.ts` (exists); `tests/upstream-retirement/` registry, probe and marker scan (exist). The Bun floor is **to tighten**: the build and the lane still enforce 1.4.0 (ADR-0048 floor). | **Partly met.** |
| **V-C5** | **Supply chain.** The vinext image has an SBOM, a HIGH/CRITICAL scan that also covers the pre-compile JS closure, and a cosign signature with an SBOM attestation. Cells are compiled with stock released Bun only; the knext-patched toolchain is opt-in and outside the Stable promise (ADR-0070 C6). | `supply-chain.yml` closure gate (`scripts/precompile-closure-audit.mjs --app`), image SBOM, Trivy and cosign: exist. A stock-Bun assertion on credential and release builds: **to build** (ADR-0070, #2444). | **Mostly met.** The stock-Bun assertion is missing. |
| **V-C6** | **Cold-start claim policy.** vinext is a tie with the default image on cluster cold start wherever it has been measured (3401 ms against 3610 ms). Stable permits stating the measured numbers and the tie. A "faster" claim needs the separated A/B of ADR-0060 Decision 7 and ADR-0070 C5. | `apps/docs/boot-claim-hygiene.test.ts`, `docs/compat/retracted-figures.json` (exist); the comparative-claim guard (ADR-0070, #2447). | **Met as a constraint** (no speed claim is made); the guard is separate work. |
| **V-C7** | **Rollback and opt-out.** A user can leave vinext by config alone (`build: 'turbopack'`, or `runtime: 'node'`) and redeploy, and a traffic split between a vinext revision and a default revision serves on both. | Cross-shape rollback kind e2e (ADR-0070, #2445). | **Not met.** |

Graduation is **per runtime**: `bun-vinext` may be Stable while `node-vinext` is Beta, and the docs
for each say which. Node stays an option throughout (founder, 2026-10-02): a Stable vinext x Bun
never removes or hides the Node arm.

### What counts as a run

A run counts toward V-C1 only if **all** of these hold (ADR-0056 Amendment 5 and Decisions D1 to D11,
restated, not changed):

1. It is **scheduled**, not a dispatch, and runs on the **frozen credential ref** (the rc tag named in
   `.github/compat-credential-ref*.json`, resolved to its commit SHA and checked out by SHA).
2. It started **at least 2 hours after** the previous counted run of the same cell.
3. It uses **fresh caches** (no warm reuse that could mask flakiness) and a **separate runner**.
4. It is the **full suite**: 16 of 16 shards, same manifest and shard total as the default lane, no
   `notRun`, nothing truncated, and green by V-C2.
5. Its summaries carry `builder:vinext`, the cell's `runtime`, and `bun --version` of at least 1.4.2.
6. It is **independent of the fingerprint moving**: a change to shipped bytes, the harness, the
   lane workflow or the pinned vinext version restarts the cell's count at zero (ADR-0056 D3).

14 such runs in a row, with no red, no missing slot and no fingerprint move, is the credential.
There is no smaller N for a new lane, no M-of-N tolerance and no "two dispatched runs" substitute
(the options an earlier draft weighed; the founder rule rejects all three). At about three counted
runs a cell a day, expect four to five days per cell once nothing is red.

## Support policy

**Bun.** At least **1.4.2**, stock released Bun. Below that, the compiled binary boots about twice as
slowly and is not a supported artifact. *Gap to close with the implementation:* both enforcement
points still read **1.4.0** (the build refuses below it, `vinext-build.ts`; the compat lane checks
the same ADR-0048 floor, `compat-vinext.yml`), while every lane run and the matrix evidence use
1.4.2. Raising both to 1.4.2 is a CLI behaviour change and edits a fingerprinted workflow, so it is
separate trigger-class work, done between windows with the credential cron. A Bun release newer than 1.4.2 is supported once the lane has run on it
green; a Bun major or minor bump is a credential-restarting change like any other shipped-bytes change.

**vinext version.** knext supports **exactly the vinext version it pins**, an exact version (not a
range) held in lockstep across the core package, the reference app, the docs app, the scaffold and
zone templates and the compat install script (`tests/vinext-pin-lockstep.test.ts` scans every
manifest and lockfile). Today that pin is 1.3.0 with a bundled patch set (and the React family at 19.3.1 and `@vitejs/plugin-rsc` at 0.5.38, which 1.3.0 requires for App Router builds). Other vinext versions are
unsupported even when they happen to work. A **bump is credentialed** as follows:

1. It lands on the integration line **between credential windows** or on a new rc, because it moves
   the fingerprint and restarts the cell's count.
2. It carries **one full 16-shard measurement** on the new pin, recorded in the matrix, showing no net
   regression against the previous number (the 1.1.0 re-pin is the precedent: it dropped five
   patches the release shipped, re-ported five, and lowered the structural-gap cap from 49 to 41).
   The 1.3.0 re-pin is NOT a precedent for this rule: its measurement (docs/compat-matrix.md) showed
   net +6 files but not zero regression (2 files and 15 cases newly red, tracked as issues), and the
   lane needed `nextjsRef` v16.4.0 on this line because the default ref cannot install here.
3. Every bundled patch is re-evaluated: dropped if the release ships it, re-ported otherwise, and
   each remaining patch keeps a registered retirement path.
4. The structural-gap ledger is pruned for entries that went stale (a passing file reds the lane).
5. A minor or major vinext bump after a cell has started its 14 runs is deferred until the window
   completes or is deliberately abandoned; it is never slipped in mid-window.

**The normalizer knext owns.** Cloudflare declined to make vinext normalise an app-set `s-maxage`
(closed as not planned, with the maintainers calling the switch a harness-only flag with no
guarantee). knext therefore **owns** the Cache-Control normalisation for the vinext artifact: the
`bun-serve-cache-control` shim normalises every response, not only the ones vinext computes. It is
part of the Stable promise, so it carries: (a) a registered entry in
`tests/upstream-retirement/registry.ts` with a repro **probe** that turns red only when upstream
normalises every probed response shape, (b) the marker scan that fails the build if a shim exists
with no registry entry, and (c) the known blind spot written into the entry (the Pages-router
handler is not probed), so a red probe is confirmed against the Pages path before the shim is
deleted. Retirement is by that probe, never by a version number. The tracked retirement work is #1437.

**ESM only.** The vinext target supports ESM Next.js apps (ADR-0051). A vinext release that lifts
that boundary does not widen the support claim by itself; the compat lane must show it.

## Resolved since the first proposal

- **Cadence.** The first proposal weighed a nightly, a smaller-N weekly window, and an M-of-N window
  for a weekly lane. The founder rule (2026-10-08, ADR-0056 Amendment 5) settles it for every cell:
  14 consecutive green independent **runs**, not nights, not weeks. The vinext lane therefore needs a
  credential-mode cron (V-C1), not a weaker window. This also answers the earlier question about
  unifying the window rule with the node lane: it is one rule.
- **Threshold.** The first proposal's "node-parity 778/0" is replaced by V-C2 (zero failed and zero
  notRun after the bounded ledgers) plus V-C3's disclosed-gap wording, because the founder accepted a
  separately capped structural-gap ledger for the client-router architecture (ADR-0007 amendment,
  2026-10-09).
- **Decision-bar tier.** The first proposal's "number plus a credible path" tier was an input to a
  go/no-go that ADR-0054 has since settled (vinext stays a selectable option). It is retired.

## What Stable would and would not permit

**Permits:** listing vinext under Stable per runtime, with the wording in V-C3, once its cell has 14
of 14; its own row in the compatibility matrix with its own credential status; semver protection for
`build: 'vinext'`.

**Does not permit:** becoming the default build (it stays opt-in); any "faster" claim (V-C6); the
word "verified"; any claim on the 1.x lines, where vinext stays Beta in every release.

## Ratification checklist (sprint-close design review)

- [ ] V-C1 to V-C7 as the exit criteria: accept / revise.
- [ ] Per-runtime graduation (`bun-vinext` and `node-vinext` separately): accept / revise.
- [ ] Support policy: Bun at least 1.4.2; exact-pin vinext with the bump procedure; knext-owned
      normalizer with a retirement probe: accept / revise.
- [ ] That the bar needs **no** smaller N or M-of-N window (founder rule applies unchanged).
- [ ] That no stability wording changes until the cells have run (the docs sentence "stays Beta in
      every release; it is not on the path to Stable" is rewritten by the v2 promotion PR, not here).

## Work this bar implies (none of it done by the ratification PR)

| Work | Issue | Criterion |
|---|---|---|
| Credential-mode cron on `compat-vinext.yml`; both vinext cells wired in the window audit | the vinext credential task | V-C1 |
| vinext x node workflow with bytecode liveness grading | #1260 | V-C1 |
| Fix the remaining 36 failing files (knext-attributable ones first) | the vinext fixes task | V-C2 |
| Docs guard: N derived from the ledger, red on "same bar" | with the promotion PR | V-C3 |
| Raise the Bun floor from 1.4.0 to 1.4.2 in the build and in the lane | with the credential cron | V-C4 |
| Stock-Bun assertion on credential and release builds | #2444 | V-C5 |
| Cross-shape rollback e2e | #2445 | V-C7 |
| Closure scan for the self-contained standalone executable (the vinext closure scan already exists) | #1525 | V-C5, ADR-0070 C6 |
