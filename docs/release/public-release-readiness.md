# Public-release readiness — the honest blocker list

> Goal (set 2026-08-24): **make sure everything is ready for public release.** This file is the
> single place that answers "can we announce this?" — measured, not asserted, and re-checked at
> the close of every loop iteration alongside the debt/perf/ergonomics ledgers.
>
> Companion ledgers: `docs/debt/tech-debt-ledger.md`, `docs/benchmarks/cold-start-ledger.md`,
> `docs/ux/ergonomics-ledger.md`.

## Verdict: NOT READY — 2 blocker classes, one of them new

**Maintainer-only (unchanged): rotate a dead npm token, flip a package to public.**
**New (2026-08-27): ADR-0048 makes the vinext single executable the ONLY supported target, and the
release surface has not caught up with that decision.** See "ADR-0048 status" below.

> **Everything in this file is uncommitted.** `git commit` has been failing all session with
> `gpg: signing failed: Operation cancelled` — the passphrase cache expired and pinentry-mac opens
> on a tty nobody is watching. `commit.gpgsign=true` is global in `~/.gitconfig`. **Nothing merges
> until that is unlocked**, so every item below is blocked on it before it is blocked on anything
> else.

> **The line that used to sit here said "every engineering step is done and proven."** It was
> written before anyone walked the new user's path end to end, and walking it found
> [#857](https://github.com/getknext-dev/knext/issues/857): an app with a `pnpm-workspace.yaml`
> anywhere in its ancestry gets a Dockerfile, a `CMD` and an `npm start` that all point at a file
> that does not exist, with `next build` exiting 0 the whole way. This file's own history is the
> argument for deleting that sentence rather than qualifying it — some version of
> "the engineering is done" has appeared here at five separate points and been wrong every time.

The path here is worth stating, because each defect was invisible until the one in front of it was
fixed, and the audit was wrong about the cause twice:

1. **Blocker 3 was cleared by measurement** (#846) — the compat gate was never the flaky thing.
2. **Blocker 2's stated cause was wrong.** It was never a missing `npm login`. `release.yml` had a
   *workflow-level* concurrency group held by one run parked on an approval since 2026-07-26, which
   cancelled 99 of the last 100 runs in the queue with zero jobs (#849).
3. Behind that, `changesets/action@v2.1.0` required Changesets CLI v3 while the repo pinned v2, so
   the Version-PR job died on a compatibility check (#851).
4. Behind that, `can_approve_pull_request_reviews` is `false` at repo **and** org level, so the
   action can never open a Version PR here — #852 was opened by hand, as #523 and #268 were.
5. With all of that fixed, #852 merged, the deployment was approved, the publish job ran — **and the
   npm token turned out to be dead** (#853). Presence was never validity, and the gate added in
   #849 said so out loud instead of failing obscurely.

So the correction to make is to the shape of the claim, not just its content: *"the engineering is
done"* has been true-sounding at four separate points in this document's history and wrong each
time. It is stated again here only because the publish path has now been executed end to end and
stopped on a credential, which is a different kind of evidence than a passing test.

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

**Both of those clicks have now been done, and the answer arrived — 2026-08-25.**

1. **Two further defects surfaced first**, each invisible until the one before it was fixed.
   `changesets/action@v2.1.0` requires Changesets CLI v3 while the repo pinned `^2.31.0`, so the
   Version-PR job died on a compatibility check (#851). Behind that,
   `can_approve_pull_request_reviews` is **`false` at repo *and* organisation level**, so the action
   can never open a Version PR here at all — run `30179506243` failed identically on 2026-07-25
   under the old action, and **#523 and #268 were both opened by hand**. #852 was therefore opened by
   hand too, from the `changeset-release/main` branch the action still pushes correctly.
2. **#852 merged**, versioning `@getknext/core`, `@getknext/lib`, `@getknext/db` and `kn-next` to
   **0.3.1** as one changesets `fixed` group.
3. **The `npm-publish` deployment was approved** (deployment `6084837765`), and the publish job ran.

**The token is dead.** That was the one thing this row refused to claim either way, and the run
answered it:

> `NPM_TOKEN is PRESENT but the registry REJECTED it (npm whoami exited non-zero). Rotate the
> npm-publish environment secret; presence is not validity.`

That is the `npm whoami` gate above doing exactly its job — before it existed, this would have died
opaquely inside `changeset publish` and looked like a fifth mystery. Tracked as **#853**.

**What is left is one action, and it is genuinely human:** rotate the `NPM_TOKEN` secret **on the
`npm-publish` environment** — not the repo secret list. Mint a fresh automation token with publish
rights to `@getknext/*` and `kn-next`, replace the secret, and re-run `release.yml`; all four
publish together. Minting a token needs an interactive login with 2FA, so no agent can do it.

**The trap is gone:** the parked run `30207128316` has been cancelled. It would have published from
`c0ed9b75`, the tree as it stood on 2026-07-26.

**Worth fixing eventually, not blocking:** turning on *"Allow GitHub Actions to create and approve
pull requests"* at org and repo level would let the lane open its own Version PR instead of the
by-hand step above. Left alone deliberately — widening an organisation-wide Actions permission is
the maintainer's call, and the by-hand path works.

### ~~Blocker 3 — `create` bakes paths the build does not produce, in a pnpm workspace (#857)~~ — RESOLVED in #859

Found by rehearsing the stranger's journey rather than by a gate, which is why it survived this
long. Next's `dist/lib/find-root.js` looks up `pnpm-workspace.yaml` **before any lockfile, at any
level** — its own comment says so — while `packages/kn-next/src/cli/tracing-root.ts` excludes it,
on the stated grounds that "Next does not consult it", which is false for the pinned next
16.2.11. `create-scaffold.test.ts` then locks the divergence in with a **green** spec.

The predicate is **ancestry, not root**: an app whose own marker is a `package-lock.json` still
diverges if a workspace file sits above it, which is invisible from the app directory. knext's own
repo is a pnpm workspace, so this is a common layout.

**Consequence:** both `COPY --from=builder` lines, the `WORKDIR`, the `CMD`'s
`STANDALONE_SERVER_PATH` and the app's `npm start` all reference a path the build never wrote.
The image builds, the container starts, and there is nothing to run.

**Done in #859** — and *not* the way this line originally prescribed. It said to add
`pnpm-workspace.yaml` to the head of `LOCKFILES`, which is a **per-level** rule; Next searches
the **whole ancestry** for the workspace file before considering any lockfile, and finding one
does not end the walk. Both design gates blocked that shape, and a differential run of the
prescription against the real `find-root.js` diverged on 96 of 400 generated trees. The fix
shipped is a literal port of `findWorkRoot` plus Next's outward loop.

Recorded at this length because the line was an **instruction**: a future agent following it
would have implemented a regression with a document telling them it was the fix.

### What walking the journey established, beyond the defect

Measured, not assumed, and recorded so it is not re-derived:

- `kn-next create` exits 0 and its "next steps" guidance is genuinely good;
- the scaffold pins `@getknext/*` from the **CLI's own runtime version**, so there is no
  hardcoded-version drift to worry about;
- the scaffolded app's `npm install` fails today **only** with
  `ETARGET @getknext/core@^0.3.1` — that is blocker 2 showing through, not a defect, and it
  resolves the moment publishing does;
- **the scaffold builds clean** against locally packed tarballs — `next build` exits 0 and emits
  a standalone server. Nothing gated that before; the gate now exists.

### ~~Old blocker 3 — the compat claim's own gates are red or flaky~~ — CLEARED 2026-08-25

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

## Known gaps that are NOT release blockers

Recorded because closing #857 could otherwise read as "everything found is now fixed", and a
reader of this file is entitled to know what was found and deliberately left.

- **#860 — `create` bypasses the duplicate-root-marker warning.** `deploy`/`preview` route
  through `requireBuildContext`, which warns when the marker chain is ambiguous; `create` calls
  `findTracingRoot` directly and does not. So an ambiguous tree surfaces at `docker build`
  rather than at scaffold time, when it is cheap to fix. Not a blocker: the inferred root is
  still Next's root, so the image is correct — the user just loses the early warning.
- **#861 — `create` ignores `configuredTracingRoot` while `deploy` honours it.** Pinning
  `outputFileTracingRoot` therefore moves the deploy context while leaving the Dockerfile
  `create` already baked untouched, which reproduces #857's symptom by a different route.
  Measured repro in the issue. Not a blocker: it requires the user to pin the root, which
  nothing currently tells them to do — the one place that did was removed in #859.

Both are pre-existing, both were found by the gates and reviews on #859, and both were split
out rather than folded into a PR that was already three review rounds deep.

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
- **The new user's path is now gated end to end** (#855, #856): the `kn-next` alias — the package
  `npx kn-next` actually resolves to — is packed, installed and leak-checked with the rest; and
  the app `create` scaffolds is installed, built, and checked to emit a standalone server at the
  path its own generated Dockerfile names. Both gates were mutation-proved (22 declared, 22
  graded as expected), and both were written because rehearsing that path by hand found real
  defects nothing else covered.

## ADR-0048 status — the vinext single executable as the only target (2026-08-27)

**Decision:** founder-directed. `build: vinext` + `runtime: bun` (1.4.0+), compiled with
`bun build --compile --minify --bytecode`, is the ONLY supported target. turbopack and node are
retired. Full record: `docs/adr/0048-vinext-single-exec-as-the-only-target.md`.

**Why:** measured on an identical app, byte-identical responses, n=10 —

| variant | cold median | p95 | req/s |
|---|---|---|---|
| node + turbopack | 884 ms | 1029 | 630 |
| **vinext single-exec (bun 1.4.0)** | **61 ms** | **131** | **1103** |

**14.5× faster to first response and 1.75× the throughput.** Its p95 beats node's *best* sample by
6×, which for scale-to-zero is what a user feels. Bun 1.4.0 is a floor, not a preference: 1.3.5
halves the win (121 ms) and cannot serve a Next standalone tree at all.

**Done (knext side):** `AVAILABLE_BUILDERS` returns exactly `vinext`; turbopack rejected with a
migration message; `runtime: node` rejected against the measured artifact shape; Bun 1.4.0 floor
enforced in `cli/vinext-build.ts` (13 tests); `templates/app/Dockerfile.vinext.hbs` ships the
binary; 18 validator tests green; `apps/file-manager` ported and **building and serving the vinext
artifact** (HTTP 200).

**UPDATE 2026-08-28 — the reference app now builds, serves and caches correctly.**

`apps/file-manager` compiles to a single Bun executable and serves HTTP 200. Four blockers were
cleared in sequence, each hiding the next: nitro's `codeSplitting` (the `manualChunks` key was
wrong), Tailwind under Vite, a missing entry sibling, and ioredis reached through `@getknext/lib`'s
built `dist` — that last one invisible until the library was rebuilt.

**Measured, the reference app against itself** (same source, same route, n=6):

| arm | cold median | p95 | req/s |
|---|---|---|---|
| node + standalone | 2670 ms | 2780 | 127 |
| **vinext single-exec** | **753 ms** | **777** | **1092** |

**3.5x cold start, 8.6x throughput — and WITHOUT bytecode.** The win is larger on the real app than
on the sample ADR-0048 was justified with. node's standalone arm costs 2.67 seconds here.

**Next.js caching verified on the binary: 7/7.** Static segments byte-stable, `force-dynamic`
re-rendering, header-reading segments dynamic, time-based ISR serving its cached body inside the
window. This was worth checking precisely because a binary that silently served everything
dynamically would look healthy while having lost ISR.

**Bytecode is unavailable and is NOT a blocker.** `bun build --bytecode` emits CommonJS, and the
vinext/nitro *generated* bundle uses `import.meta` — a syntax error there. Not knext's code. The
numbers above are without it. Do not "fix" this by rewriting generated output.

**Not done, and these are what "only option" still needs:**

1. **`--bytecode` fails on file-manager** — `import.meta is only valid inside modules`. Compiling
   without it works, but bytecode is what buys the cold start, so the headline number is not yet
   reproduced on the reference app.
2. **`Cannot find module '@ioredis/commands'`** — a dynamic `require` that `--compile` cannot
   bundle. The binary boots and listens; the cache path 500s.
3. **Operator does not know the shape.** `nextapp_controller.go`'s only shape-aware branch
   hardcodes `bun run server.js` (a spawn) for an artifact whose execution is `in-process`.
4. **CRD enum still admits only `turbopack`** — deliberately. Widening it before item 3 would let a
   GitOps controller store a CR the operator mis-reconciles, with no condition and no refusal.
5. **No vinext coverage in the official compatibility suite.** `docs/compat-matrix.md` has zero
   vinext rows and the Bun axis is still ❌. **This is the largest strategic cost of ADR-0048** —
   verified-adapter status, the project's north star, is unreachable until a vinext-axis suite is
   green. Do not claim parity on the shipped path until it is.
6. **`examples/bun-exec` cannot be deleted yet.** Five tests bind to it and it is the reference
   artifact source. It goes once file-manager's binary is fully working.

**A correction on the record.** An earlier version of this analysis said the vinext path was blocked
by an unfixable upstream defect. That was wrong — nine attempts all used rollup's `manualChunks`,
which nitro-on-rolldown does not read; it keys off `output.codeSplitting`. The one-line fix now sits
in `apps/file-manager/vite.config.ts`. Full chain in `docs/benchmarks/EXPERIMENTS.md` E9–E10.

## Human pending tasks (nothing below can be done by an agent)

Ordered by what unblocks the most.

1. **Unlock GPG.** Blocks *every* commit, so it gates everything else in this file.
   `gpg --sign </dev/null >/dev/null` in a terminal you are watching, then re-run the commit.
   Consider raising `default-cache-ttl` in `~/.gnupg/gpg-agent.conf` — the 600 s default is why this
   recurs mid-session.
2. **Rotate `NPM_TOKEN`** on the **`npm-publish` environment** (not the repo secret list), then
   re-run `release.yml`. Minting it needs an interactive 2FA login. Issue #853. `kn-next` is E404 on
   npm until this happens.
3. **Flip `ghcr.io/getknext-dev/kn-next-operator` to public.** Re-measured 2026-08-26:
   `anonymous-token-denied … HTTP 401`. Unblocks #198/#707 and the anonymous-install nightly.
4. **Enable GitHub private vulnerability reporting** (Settings → Security). Currently `false`, and
   the new `SECURITY.md` links to it as the primary channel — that link 404s until it is on.
5. **Cluster cleanup.** Deleting cluster objects is human-gated by `block-dangerous-bash.sh`
   (ADR-0001: the operator is the single source of truth). Keep `default/file-manager` and
   `knext-docs`; remove the rest. The commands are recorded in `docs/release/cluster-cleanup.sh`
   next to this file — read it before running, it deletes eight services and two CRs.
6. **Amend `.claude/rules/architecture.md`.** ADR-0048 sets the official-adapter target aside, which
   contradicts *"never make anything but the node/official-adapter target the default."*
   `.claude/rules/` is not an agent's file to edit. Until amended, an accepted ADR contradicts a
   hard rule.
7. **Review the vite override change** (`package.json` → `pnpm.overrides`). The `<8` ceiling was
   lifted so vinext could resolve vite 8; the `>=7.3.5` floor — the actual #199 Trivy remediation —
   was kept. vite 8.2.2 carries zero advisories at any severity, and the workspace's only vite
   dependent is `apps/file-manager/vite.config.ts`.
8. **Decide three open PRs/issues** an agent reviewed but should not close:
   - **#748 and #742** — premises refuted by measurement (`ROADMAP.md` and its Phase↔Tier table both
     exist). #742 is closed with evidence; #748 should follow.
   - **#727** — adds two workflows pinning `actions/checkout@v4` and
     `anthropics/claude-code-action@v1` by version ref while `id-token: write` and an OAuth secret
     are in scope. `security.md` requires SHA pins there. Adopt with pins, or decline.
9. **The vinext upstream bug report is WITHDRAWN.** Do not file it. It was a wrong-key mistake on
   our side, not a vinext defect.

## Release checklist (in dependency order)

1. [ ] **Human:** flip ghcr package visibility to public → unblocks #198/#707, greens the
       anonymous-install nightly, lets #670's publish job exist, removes the first-cluster caveat.
2. [ ] **Human (one credential rotation):** the Version PR (#852) is merged, the `npm-publish`
       deployment was approved, and the publish job ran — it failed because the token is dead
       (#853). Rotate `NPM_TOKEN` **on the `npm-publish` environment**, not the repo secret list,
       then re-run `release.yml`; all four packages publish together as one `fixed` group.
       Minting the token needs an interactive login with 2FA. → makes every ergonomics win real
       for users. *(The stale parked run 30207128316 has been cancelled; nothing to do there.)*
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
7. [x] Agent: fix #857 (#859) — `create` bakes a standalone prefix Next does not use whenever a
       `pnpm-workspace.yaml` sits anywhere in the app's ancestry. Not gated on either human
       step, and the only item here that is a product defect rather than a publishing state.
8. [ ] Then: announce.
