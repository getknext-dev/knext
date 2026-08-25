# Report — release checklist step 5, the compat honesty gate (#545, #710)

**Worktree:** `/Users/banna/alpheya/pocs/knext-wt/compat5` · **Branch:** `fix/compat-honesty-gate`
· **Commit:** `56d4913` · **PR:** [#848](https://github.com/getknext-dev/knext/pull/848)
· **Date:** 2026-08-25

Findings doc: `docs/release/compat-honesty-gate.md`. Issue evidence posted to
[#710](https://github.com/getknext-dev/knext/issues/710#issuecomment-5402620077) and
[#545](https://github.com/getknext-dev/knext/issues/545#issuecomment-5402624775).

---

## A. Where the full/weekly compat suite actually runs

**It runs. The brief's premise was right about the NAME and wrong about the LANE.**

`.github/workflows/test-e2e-deploy.yml` — name `Compat suite (official Next.js deploy harness)`,
workflow id `300291864`, 16 shards (`COMPAT_SHARD_TOTAL`), 778 tests under the ADR-0007 §d
manifest. Two schedules: `17 3 * * *` (node credential lane, nightly) and `17 5 * * 0` (bun runtime
axis, weekly Sunday), selected by
`KNEXT_RUNTIME: ${{ inputs.runtime || (github.event.schedule == '17 5 * * 0' && 'bun') || 'node' }}`.
Most recent scheduled run at time of writing: `32688792926`, 2026-08-24T04:06:42Z, node, success.

**The defect:** `ci.yml:242` and `apps/file-manager/scripts/compat-smoke.mjs:9` both deflected the
reader to "a separate scheduled job (A3-2, `compat-suite-full`)". Nothing in this repo is called
`compat-suite-full` — no workflow file, no workflow `name:`, no job id, no artifact. ADR-0007
introduces the name *bound to the file*; the two CI-side copies kept the name and dropped the
binding. This is not an escalation — no ADR is contradicted, no lane is missing, no hard rule is
crossed. It is a stale pointer, and it is fixed and guarded here.

## B. #710 — verdict: **real Bun runtime incompatibility, not infrastructure flake**

Four bun weeklies retain a `compat-run-ledger`: `30738274907` (08-02, 774/4, shards 6+8+16),
`31297820716` (08-09, 775/3, shards 6+8), `31929677335` (08-16, 775/3), `32621148829` (08-23,
775/3). `run_attempt: 1` on all four. Job-level attribution reaches `30193384289` (07-26) and
`29678368535` (07-19) — same two shards, same failing step. Files: `app-dir/app-static`,
`app-dir/parallel-routes-root-param-dynamic-child`, `middleware-fetches-with-any-http-method`, plus
`edge-compiler-can-import-blob-assets` on 08-02 only. Named cases are in the findings doc.

Discriminators: deterministic across 4/4 ledgered and 6/6 job-level runs; node lane `failed: 0` on
28 of 28 ledgered nights on identical infra, at the full 778/0/0 on 27 of 28; the bun reds are
**complete-but-red** (`expectedTotal` met by `passed + failed`, `truncated: false`, `notRun: 0`,
`status: "reported"`) whereas runner loss is **absence** — `30790778590` produced no shard-16 entry
at all and *zero* failures; the mechanism is already root-caused upstream in
`docs/compat/upstream-bun-sandbox-fetch-bug.md` and persists on Bun 1.4.0-canary.

> **Corrected in the fix round (see below).** This paragraph previously read "`kind: timeout` at
> exactly 60000 ms is a per-*case* hang". That form does not hold: the reported `kind` alternates
> run to run for the same file, so the timeout constant cannot carry the argument. The shipped doc
> already retracted it; this report had kept the retracted form, which is why it is replaced above
> rather than annotated in place. The structural discriminator is stronger and survives the
> alternation.

**Not a release blocker** — the published claim is the Node row, which excludes Bun in terms, and
the Bun row is already ❌. Not quarantining is correct, on ADR-0007 §(c)'s **scope** rather than its
evidence bar: §(c) is the *flake*-quarantine ledger (§c.1 per-case only, file-level confined to
§(d)'s one named family, which expires on the upstream-fix ref bump), and a permanent upstream
runtime gap is neither. (§c.2's "one FINAL post-retry failure" is a *floor* against pre-emptive
quarantines; a deterministic red clears it trivially, so it is not what excludes this — corrected
in the fix round.)
**Named but left out of round:** #710 is re-posted every Sunday for a permanent condition, i.e. an
alert that can never clear. Changing that changes alerting on the credential workflow — an
escalation, not a drive-by edit.

## C. #545 — verdict: **premise does not hold; two ACs met, two not met as written**

> **Corrected in the fix round.** This heading previously read "all four ACs are met". Two are not
> met *as written* — the quarantine AC (the round neither fixed nor quarantined) and the 14-night
> streak AC (the longest is 7) — and are now recorded as deliberate, reasoned non-compliance with
> the #850 pointer rather than as met. The closure recommendation never rested on those two cells.

Over all 32 scheduled runs with retained ledgers (2026-07-28 → 08-24; 28 node, 4 bun):

- distinct node-lane tests that flake: **0** (all 28 nights `failed: 0` in every shard that
  reported; 27 nights reported all 16 shards at 778/0/0, and 08-03 reported 15 at 730/0/0)
- runs that went red-then-green on re-run with no code change: **0**
- re-runs of this workflow in the window at all: **0** — from **one source read two ways**, not two
  independent ones: the API's `run_attempt` is 1 on all 32 (and on all 72 scheduled runs ever, zero
  above 1), and the ledger's `runAttempt` is 1 on all 32 — but the workflow sets
  `RUN_ATTEMPT: ${{ github.run_attempt }}` and the ledger script writes it straight through, so it
  is the same counter by a second transport, and strictly weaker (an attempt-1 artifact says `1`
  regardless of what happens later). The API reading is authoritative; the ledger corroborates at
  write time
- the single node red (`30790778590`) is infrastructure loss: `failed: 0`, shard 16/16 uploaded no
  summary

Recommended: close #545 against its criteria. The real residual — **harness-fingerprint churn** —
is now **filed as #850**, measured independently here: 27 fingerprinted nights, 11 distinct
fingerprints, **10 window restarts**, longest stable streak **7** of the required 14, and **5 of
the 10 restarts moved the packed `@getknext/*` tarball bytes only**. Closing #545 without that
would have lost the only live problem on the ticket.

Deliberately **not** conflated with the prior round: that round cleared the *nightly* gate claim;
this round re-derived it independently rather than agreeing with it.

> **Corrected in fix round 2.** This paragraph used to end *"and additionally establishes the
> zero-re-run figure from a second, independent source"* — the same retracted B3 claim, surviving in
> a third place after round 1 struck it from the doc and round 2 struck it from the release record.
> There is no second source: the ledger's `runAttempt` is `github.run_attempt` written through. It is
> recorded here rather than silently deleted because three copies of one wrong sentence is the
> clearest evidence available that the defect class is real.

---

## What was fixed, and how it is proved

- `tests/compat-lane-pointer-resolution.test.ts` — three claims: the lane **exists** (workflow, both
  crons, and the lane-selection expression); every `compat-suite-*` identifier **denotes something**
  (shape-matched, no allowlist); every **deflection** to the harness names the workflow. Scan
  boundary asserted, not described.
- `scripts/mutation-prove-compat-lane-pointer.mjs` — 5 mutations, **5/5 red the guard**, verified
  twice (before and after the scan-set correction below). Every verdict branches on the runner's
  **exit code**; the byte-snapshot harness aborts unless the anchor occurs exactly once; residue
  checked clean after each run.
- `.github/workflows/ci.yml`, `apps/file-manager/scripts/compat-smoke.mjs` — both now name the
  workflow file, its display name and both cron times.

**A defect I introduced and caught:** the first version scanned `scripts/**`, which includes the
prover — a file that carries the stale pointer twice on purpose. It passed in isolation only
because the prover was still untracked; the full-suite run exposed it. Provers are now excluded,
with both halves asserted (the corpus must be non-empty *and* contain this guard's own prover), and
the hole that leaves is stated rather than hidden.

## SCANNED vs ENUMERATED

**SCANNED** — the `compat-suite-*` identifier check and the deflection check (**75** tracked
CI/script files — 20 workflows + 55 scripts — plus `docs/compat-matrix.md` = **76** in the shape
scan; the 86 this line previously carried was the pre-exclusion count, taken when there were 11
tracked `scripts/mutation-prove-*.mjs` provers — 75 + 11 = 86. The corpus now holds 12; 75/76 is
unchanged because provers are excluded); all **136** runs of
workflow `300291864` as at 2026-08-25, filtered to the **72** scheduled ones (135/71 at first
measurement); `run_attempt` over every scheduled run; per-shard totals over every retained ledger.

**ENUMERATED** — the six bun-lane runs pulled for job-level attribution (`32621148829`,
`31929677335`, `31297820716`, `30738274907`, `30193384289`, `29678368535`), chosen as the Sunday
reds; and the four surviving ledgers among them. The failing-file set rests on 4 runs, corroborated
at shard level over 6.

## Could not be established

1. **Anything before 2026-07-28.** 39 of the 72 scheduled runs have no retained
   `compat-run-ledger` — expired or predating it. Readable at job level at best; unfalsifiable in
   either direction on failing-test detail. Same retention limit the 2026-08-04 comment on #545 hit.
2. **Whether the bun red clears on Bun stable ≥ 1.4.** Canary evidence says *partially*, the lane
   pin is deliberately `1.3.14`, and re-baselining is a deliberate pin bump, not a measurement to
   slip into this round.
3. **A fully clean local full-suite green.** The first full run showed 15 failing root specs. Each
   was identified rather than assumed pre-existing, and each cause was then *removed* and the
   result re-measured:
   - 3 specs (`mutation-residue-scan`, `compat-window-fingerprint`, +1) fail because
     `commit.gpgsign = true` on this machine breaks their fixture `git commit`. Disabling signing
     turned exactly those green.
   - 10 specs fail because `packages/{kn-next,db}/dist` were absent — `pnpm build` aborts on
     `apps/spike-bun-bytecode` ("Couldn't find any `pages` or `app` directory"), unrelated to this
     diff. Building just the three publishable packages turned all 10 green.
   - 1 was mine and is fixed (the prover self-scan, above).
   - **Final state: 309 passed / 2 failed / 3 skipped of 314.** The 2 are
     `examples/bun-exec/test/{runtime-contract,sigterm-hardcap-e2e}.test.ts`, failing on
     `Cannot find module 'srvx/bun'` — the example's own dependencies are not installed in this
     worktree. Both corresponding CI jobs (`bun-exec SIGTERM hardcap (real sockets)`,
     `bun-exec runs from a clean alpine`) **pass on the PR**.
   `tsc --noEmit`, biome, the mutation-prover lane audit and every compat guard are green locally;
   `Lint & Test` and `Typecheck (root tests/)` are green on the PR.

## Discipline log

- Exit codes, never output greps, for every pass/fail verdict in the prover.
- Mutation-proved with a script that asserts each anchor occurs exactly once; no `perl`.
- Both halves asserted on every new invariant, including the scan's own non-vacuity.
- Ages/timestamps compared in UTC throughout (GitHub returns UTC; run days-of-week were computed
  with `getUTCDay`, which is what separates the Sunday bun runs from the nightly node ones).
- No push to `main`, no force-push, no history rewrite.

**One incident worth recording.** A `git stash push` intended to baseline the failing specs saved
nothing (the tree was already committed and clean), and the following `git stash pop` therefore
popped an **unrelated pre-existing stash** from another branch, conflicting 40 files. Nothing was
lost — a conflicted pop retains its entry — and the tree was restored with `git checkout HEAD -- .`
with all four pre-existing stashes verified still present. **Lesson: never pair `stash push` with
`stash pop` without checking that the push actually created an entry.** A clean tree makes the pop
a load-bearing operation on someone else's work.

---

# Fix round — adversarial review of PR #848 (`ISSUES_FOUND`, four blocking)

The review's headline is that the argument survives, the guard is real (7/7 mutations red it,
including two the reviewer wrote), and the survivorship attack **fails** — but three published
figures were wrong or self-contradictory and the tip commit shipped machine-generated cache.

**Every figure restated below was re-derived from the GitHub API and the raw `compat-run-ledger`
artifacts, not copied from the review or from the previous draft.** That is the point of the PR:
if the numbers are not trustworthy, nothing else in it is. The re-derivation pulled all 136 runs of
workflow `300291864`, downloaded every retained ledger, and recomputed shard totals, `run_attempt`,
lane attribution, per-case failure sets and `windowFingerprint` churn from scratch.

## What the re-derivation found

| claim under review | independently re-derived | verdict |
|---|---|---|
| 778/0/0 on 28 of 28 node nights | `failed: 0` on **28 of 28**; full **778/0/0 on 27 of 28** | review correct, doc was wrong |
| 08-03 (`30790778590`) shape | **15 shards / 730 passed / 0 failed**, `16/16` absent | review correct |
| re-runs in the window | `run_attempt == 1` on **all 72** scheduled runs, zero above 1 | conclusion holds |
| ledger `runAttempt` independence | `RUN_ATTEMPT: ${{ github.run_attempt }}` → written through at `compat-run-ledger.mjs:517` | **one source, two transports** |
| fingerprint churn | 27 fingerprinted nights, **11** distinct, **10** restarts, streak **7** (08-12 → 08-18) | 10, not 9 |
| survivorship of the denominator | 32 in-window scheduled runs, **32** with a ledger, **0** missing; boundary sharp at 07-28 | denominator is clean |
| shape-scan corpus | 20 workflows + 55 scripts = **75**, +`compat-matrix.md` = **76** | 86 was pre-exclusion |

## B1 — 978 lines of Vite SSR transform cache, committed under a docs message

Six files under a random 21-char root directory, added by `8a805bb` whose message declared only
*"docs: link the fingerprint-churn successor issue (#850)"*. Untracked, deleted, and stopped from
returning by **two independent layers**:

1. a documented `.gitignore` **shape** rule (21 nanoid chars at the root + `client/`), verified in a
   throwaway repo to ignore the cache dir **and** to leave a legitimate `packages/client/` alone —
   both halves, because a rule that ignores everything would also have "passed";
2. `tests/no-committed-transform-cache.test.ts`, which matches on **content**, so the output is
   caught under any name and at any depth. The name-based layer can only ever be best effort; this
   one is the general net.

The guard **scans itself** — the marker is assembled at runtime and never written verbatim anywhere
in the file, so there is no self-exclusion hole and no allowlist entry for the guard. Both halves
are asserted: the corpus must be non-empty and must contain this very file, and the marker must be
absent. Two defects in my own first draft were caught before commit: the binary check tested for a
space rather than a NUL (which would have filtered out nearly every file and made the scan vacuous),
and three occurrences of the marker in the doc-comment and one assertion would have made the guard
flag itself.

## B2 / B3 / B4 — the three figures

- **B2.** `docs/release/compat-honesty-gate.md` discriminator 2 and the #545 AC table both claimed
  778/0/0 on 28 of 28, while `:150` in the same document described the 08-03 shortfall and
  `docs/compat-matrix.md:49` already published the correct shape. Both sites now state
  `failed: 0` on 28 of 28, at the full 778/0/0 on **27 of 28**, naming the run and its cause.
- **B3.** "asserted twice, independently" is now retracted in terms. The workflow sets
  `RUN_ATTEMPT` from `github.run_attempt` and the ledger writes it straight through, so the two
  readings are one GitHub counter — and the ledger one is strictly **weaker**, since an attempt-1
  artifact reports `1` whatever happens afterwards. The doc now says the API reading is
  authoritative and the ledger corroborates it at write time. The conclusion is unchanged.
- **B4.** "9 restarts in 27 nights" contradicted "10 restarts" three lines later. Ten is right; the
  same correction was applied to `docs/release/public-release-readiness.md:46`, which carried the
  same stale nine.

## Non-blocking, all addressed

- **N1** — two of #545's ACs were marked **met** that are not met as written. The quarantine AC
  offers "fixed *or* quarantined" and the round did neither; the streak AC's bar is 14 consecutive
  and the longest is 7. Both now read *"not met as written, deliberately"* with the reason and the
  #850 pointer. The closure recommendation is unaffected — it never rested on those two cells.
- **N2** — the ADR-0007 §c.2 citation read the rule backwards. §c.2 is an **evidence floor** ("one
  FINAL post-retry failure, observed") that a deterministic red clears trivially; it does not
  exclude anything here. The support is §(c)'s **scope** — §c.1 admits per-case entries only, with
  file-level confined to §(d)'s one named family, whose entries expire on the upstream-fix ref bump.
  A permanent upstream gap is neither flake nor expirable. Corrected in both documents.
- **N3** — "86 tracked CI/script files" was the pre-exclusion count. Re-derived by running the
  guard's own `shapeScanFiles()`: 75 CI/script files + `docs/compat-matrix.md` = 76. It is now
  stated as a formula rather than a number to copy forward, which is what let the old one rot.
- **N4** — the `app-static` list is a union and only the first three cases recur on all four runs;
  08-02 carries three of five. Now labelled per case.
- **N5** — the committed impl report stated the #710 discriminator in the form the shipped doc had
  already retracted. Replaced, with the retraction recorded in place rather than silently dropped.

## The #710 discriminator now leads with the structural reading

The review is right that `kind: timeout` at 60000 ms cannot carry the argument — I reproduced the
alternation from the raw ledgers (`app-static` is `assertion` on 08-02 and `timeout` on 08-09/16/23;
`parallel-routes-root-param-dynamic-child` is the exact reverse). Discriminator 3 now leads with
what the data shows without interpretation: every bun red is **complete-but-red** — `expectedTotal`
met exactly by `passed + failed` (shard 6/16 = 48+1 = 49, shard 8/16 = 47+2 = 49), `truncated:
false`, `notRun: 0`, `status: "reported"` — whereas infrastructure loss is **absence**, and
`30790778590` produced no shard-16 entry at all. That survives the alternation that sinks the
timeout-constant version.

## Mutation proof of the new guard

The proof is **committed** (`scripts/mutation-prove-committed-transform-cache.mjs`) rather than left
in a scratchpad where nobody could re-run it. Declared 6 / ran 6, exit 0.

It was in fact run through two separately-written harnesses — a scratchpad one first (8 checks) and
the committed one (6) — but **that is not two independent confirmations and is not claimed as one**,
which is the exact error B3 corrects above. The two harnesses share their author, their mutation
design and their subject; the second is a conforming rewrite of the first against this repo's prover
contract, not a check on it. What the second run genuinely adds is **reproducibility by someone
else**, and that is the only claim made for it.

| mutation | expectation | result |
|---|---|---|
| M1 the exact defect from `8a805bb`, reinstated and tracked | RED | RED |
| M2 the same content under an unrelated path and name | RED | RED |
| M3 a nanoid-shaped cache dir carrying **no** marker | RED | RED |
| M4 the corpus emptied, so the scan reaches zero files | RED | RED |
| M5 the marker written verbatim into the guard's own source | RED | RED |
| **M6 NEGATIVE CONTROL** — the `.gitignore` rule deleted | **GREEN** | **GREEN** |

**M2 is the one that matters**: a name-based guard sails through it, and the "cannot come back"
claim would be false. **M6 is what separates a guard from a tripwire** — the two layers must be
independent, so removing the ignore rule must *not* red the guard. A prover with no negative control
cannot tell the difference.

**STEP 0 proves the harness can see red first.** A deliberately failing canary spec must exit `1`
or the prover aborts before planting anything — a runner that always exits 0 would certify all six
mutations while nothing ran at all. This is the same failure mode that once certified 14 decorative
mutations green in this repo via an ANSI-defeated output grep, which is why **every verdict here
branches on the exit code and no output is parsed**.

Anchored edits go through `scripts/lib/mutation-harness.mjs`, which refuses unless the anchor occurs
**exactly once** and restores by content-addressed bytes; `.gitignore` needed an explicit
`commentPrefix` because the harness refuses to plant an *unmarked* mutation rather than leave
residue no scan could find. No `perl`. The tree is asserted clean between every mutation, the guard
is verified restored byte-identically by sha256, and the closing residue scan for the marker must
come back empty (`git grep` exit 1).

## Verification

- `tests/` — **81 files / 1840 tests, exit 0**.
  - **Disclosed, not buried:** one earlier full-suite run had
    `tests/blocking-gate-helper.test.ts > "exactly ONE tracked file declares the option"` fail on a
    **5000 ms timeout** — not an assertion. Isolated per the "identify before merge" rule rather
    than waved through as pre-existing: the file is green in isolation (86 tests, ~4.2 s of test
    time against a 5 s per-test cap, so it sits close to the cap by construction) and the full suite
    is green on re-run. This round adds 2 tracked files to a scan of ~1500, i.e. ~0.1 %, which does
    not plausibly account for it; the cause is parallel load, the same class the local-noise note
    above records for `tests/mutation-residue-scan.test.ts`. **The marginal timeout is real and is
    not fixed here** — it will fail again under load, and it belongs to whoever owns that guard.
- `tests/no-committed-transform-cache.test.ts` — 7 tests, exit 0.
- `scripts/mutation-prove-committed-transform-cache.mjs` — 6/6, `{"declared":6,"run":6}`, exit 0.
- `scripts/mutation-prove-compat-lane-pointer.mjs` (the PR's existing prover) — re-run, **5/5 red**,
  exit 0, tree clean; nothing in this round regressed it.
- `biome check` on the new guard — exit 0.
- `git status --porcelain` clean after every proof.

## Discipline log (this round)

- Every load-bearing figure **re-derived from raw artifacts**, never copied — including the ones the
  review had already computed, and including the ones that turned out to agree.
- Exit codes for every verdict; no output greps anywhere in the prover.
- Both halves asserted on the new guard *and* on the gitignore rule (it must ignore the cache dir
  **and** leave `packages/client/` alone).
- The prover count moved 11 → 12 by adding this round's prover, so the N3 figure was **re-derived
  after** the change rather than published and left to rot — 75/76 is unchanged precisely because
  provers are excluded.
- No push to `main`, no force-push, no history rewrite.

**One incident worth recording.** A `rm -rf` in a scratchpad command was blocked by
`block-dangerous-bash.sh`. Per `.claude/rules/workflow.md`, a blocked command means **nothing in it
ran** — including the `mkdir` and `git init` before the offending clause — so the command was
re-established from a fresh directory rather than having its tail re-run against assumed state.

---

# Fix round 2 — adversarial review @ `3bda41b` (`ISSUES_FOUND`, two blocking)

Round 2's headline: the fix round was substantially real — every corrected figure re-derived
exactly, and the new guard survived every attack including two I never ran (`H1`/`H2`, each half
alone with the other deleted) — **but the fix was applied to one document and not the other.**

That is the finding worth generalising. The defect is not "two wrong sentences"; it is a
**correction landing on one of two copies**. So this round fixed the two reported instances and then
went looking for the rest of the class, mechanically rather than by eye.

Everything restated below was re-derived from the raw `compat-run-ledger` artifacts again. The
figures agreed with round 1 — which is exactly when copying them forward would have been
undetectable, and is the reason they were recomputed.

## R1 — the B3 retraction never reached the release record

`public-release-readiness.md` still published *"asserted twice — the ledger's `runAttempt` **and**
the API's `run_attempt`"* verbatim: the same two-independent-sources claim round 1 struck from
`compat-honesty-gate.md`. The review is right that this is the **more serious** of the two
placements — that file is the release record, the document a reader consults to decide whether the
claim is safe to publish, and the parenthetical was doing corroboration work the mechanism does not
support.

It now carries the same retraction: the API's `run_attempt` is authoritative (`1` on all 32
in-window runs and on all 72 scheduled runs, none above 1); the ledger's `runAttempt` agrees but is
**not** independent — the workflow sets it from `github.run_attempt` and the ledger script writes it
through unchanged — and is strictly weaker, since an attempt-1 artifact reports `1` whatever happens
afterwards.

## R2 — "28 fingerprinted node nights" was wrong three ways

Re-derived: **28** in-window node nights yield **27** fingerprinted, because the 2026-07-28 ledger
(`30333571518`) has no `windowFingerprint` key at all. The same file already said 27 ten lines
later, as do `compat-honesty-gate.md` and `docs/wayfinder/w6-compat-flakiness.md`.

The third problem is subtler and is the one worth recording: the sentence **declared one window and
reported another's numbers.** `26 of 27` is the **07-29**-opened frame; the file declares the
**07-28** frame two lines above. Both framings are correct — they differ only over whether the
unfingerprinted 07-28 night opens the window — so the fix states the 07-28 frame's numbers
(`failed: 0` on all 28, full `778/0/0` on 27 of 28) **and names the other framing explicitly**, so a
reader comparing the two documents reconciles them instead of finding a contradiction.

## The rest of the class — swept mechanically, two more found

A per-figure cross-document extractor
(`scratchpad/cross-doc-figures.mjs`) pulled every published instance of each load-bearing figure
across `public-release-readiness.md`, `compat-honesty-gate.md`, `compat-matrix.md`,
`w6-compat-flakiness.md` and `window-node-lane.md`, grouped by value, and flagged any figure whose
value differs across files. Most hits are the probe conflating genuinely different subjects (778
node vs 775/774 bun vs 788 pre-§d; 16 shards vs 08-03's 15). Two were real, and **neither was
reported**:

- **`compat-honesty-gate.md:157`** still said all 28 nights recorded `failed: 0` *"in all 16
  shards"*. 08-03 recorded **15**. This is the same shape as B2, **in the document B2 fixed**, in a
  table row the B2 edit happened not to touch — the class reproducing itself inside the fix.
- **The 08-03 run's shape disagreed across four documents.** `compat-matrix.md:49` said the night
  *"executed **zero** tests"* and `window-node-lane.md:54` said *"the 27th never executed a test"*.
  The ledger says the run executed **730** tests across the 15 shards it banked, all green. It is
  the **shard** that executed zero, not the run. Both corrected.
  `w6-compat-flakiness.md` was already precise — it scopes the phrase to the failed *job* and states
  the other 15 shards' 730 — and is deliberately **left alone**. Correcting prose that is already
  right is how a sweep introduces the defect it is hunting.

The two-source wording now appears in exactly two tracked places: the retraction itself, and this
report describing it. Verified by `git grep`, not by memory.

## N-a — the guard's two evasion axes, closed rather than documented

Review found, by running: a marker inside a **4.9 MB** file scanned GREEN (the guard skipped
anything over 4 MB), and a marker in a file carrying a **NUL byte** scanned GREEN (treated as
binary and skipped). No *stated* claim was false — the doc-comment said "text" file — and the
review's recommendation was one clause recording the axes as known.

**Closed instead.** "The general net" is this guard's whole reason to exist beside the name-shaped
`.gitignore` rule, and a net with a documented size cap is a net with a documented hole. The guard
now scans **bytes** in bounded 1 MB chunks, carrying a `marker.length - 1` overlap between chunks:
size buys nothing, "binary" stops being an exemption, and a marker straddling a chunk boundary
cannot slip through — that last one being a blind spot I would have introduced by fixing the first
two carelessly, since it depends on file offset and would pass on the same content most of the time.

**I did not take "hole closed" on trust.** A differential ran the OLD and NEW predicates against
identical planted files:

| planted file | OLD | NEW | verdict |
|---|---|---|---|
| plain text, small (**control**) | detected | detected | same |
| 4.9 MB, marker at the end | **missed** | detected | **hole closed** |
| carries a NUL byte | **missed** | detected | **hole closed** |
| marker straddling the 1 MB boundary | detected | detected | same (proves the overlap carry) |
| no marker (**negative control**) | clean | clean | same |

The control matters: it must be caught by **both**, or the comparison would be measuring a broken
new predicate rather than a fixed hole. This independently reproduces the review's N-a table.

The axes are now pinned three ways so they cannot regress into a skip: prover mutations **M7**
(oversized) and **M8** (NUL), plus a unit-level assertion in the guard's positive half.

## N-b — the reviewer's discarded datapoint

Round 2 disclosed that its scripted probe reported GREEN for a *space*-padded variant while a hand
reproduction of the same variant went RED, and **discarded the datapoint** rather than publish an
unreproducible result. That was the right call, and the differential above explains it: a
space-padded file is under the cap and carries no NUL, so **both** predicates detect it. The
scripted GREEN was a harness artifact, not a property of the guard. Recording the resolution because
the reviewer recorded the doubt.

## Mutation proof — now 8, still with the negative control

`scripts/mutation-prove-committed-transform-cache.mjs`, declared 8 / ran 8, exit 0.

| mutation | expected | got |
|---|---|---|
| M1 the exact `8a805bb` defect reinstated | RED | RED |
| M2 same content, unrelated path and depth | RED | RED |
| M3 nanoid-shaped dir carrying no marker | RED | RED |
| M4 corpus emptied | RED | RED |
| M5 marker verbatim in the guard's own source | RED | RED |
| **M6 negative control** — `.gitignore` rule deleted | **GREEN** | **GREEN** |
| **M7 (new)** marker inside a 4.9 MB file | RED | RED |
| **M8 (new)** marker in a file carrying a NUL byte | RED | RED |

STEP 0 still proves the harness sees red first via a failing canary before anything is planted.
Every verdict branches on the exit code; no output parsed. Anchors asserted exactly once; no
`perl`; restores byte-identical; tree asserted clean between every mutation; closing residue grep
empty.

## Verification

- `tests/` — **81 files / 1841 tests, exit 0**.
- `tests/no-committed-transform-cache.test.ts` — 8 tests, exit 0.
- `scripts/mutation-prove-committed-transform-cache.mjs` — 8/8, `{"declared":8,"run":8}`, exit 0.
- `tests/compat-matrix.test.ts` + `tests/compat-lane-ledger.test.ts` — 54 tests, exit 0 (the matrix
  guard still passes after the `compat-matrix.md` prose correction).
- Old-vs-new predicate differential — 2 holes closed, 0 unexpected, exit 0.
- `biome check` on both changed files — exit 0.

## Discipline log (round 2)

- Every figure **re-derived from the raw ledgers**, including the ones round 1 had already computed
  and that turned out to be right.
- The class was swept **mechanically**, by extracting and grouping published figures across five
  documents, because eyeballing is what let R1 and R2 through in the first place.
- A document that was already correct (`w6-compat-flakiness.md`) was **left alone** deliberately.
- "Hole closed" was **proved by differential**, not asserted, with a control on both sides.
- Exit codes for every verdict; no output greps.
- No push to `main`, no force-push, no history rewrite.

## Still open, and deliberately not fixed here

- **The `blocking-gate-helper.test.ts` 5 s marginal timeout** (recorded above) remains. It belongs
  to that guard's owner.
- **Round 2's wider suite run** (`npx vitest run`, 315 files) shows 4 failures outside `tests/`:
  local gpg-signing, a network-dependent fetch, and two bun e2e specs. None is touched by this
  branch's ten changed files. Not charged to this PR, and **not proved pre-existing against the
  merge base** — the review rested on the untouched-file check plus named causes, and so does this.

---

# Fix round 3 — adversarial review @ `2e0c9e3` (`ISSUES_FOUND`, one blocking)

Round 3's headline: **inside the repo the sweep is complete and the reviewer could not defeat it.**
Every tracked document agrees with every other and with the raw data; the guard caught the cache
under a third name at a third depth with `git check-ignore` demonstrably not firing; each half reds
alone with the other physically deleted. The mechanical sweep round 2 added was the right instinct
and it works.

**What defeats "fully swept" is the boundary.** The sweep covered tracked files. The retracted
claims also live on the GitHub issues both release documents point readers to — and
`compat-honesty-gate.md:190` asserts *"the correction is already on the issue from the prior round"*
while `public-release-readiness.md:64` asserts *"#545 and #710 carry the corrected findings"*. Those
assertions were false.

## The class has now reproduced far past the point where per-instance fixing is defensible

Tracking the single "asserted twice, independently" sentence:

| # | where it was found | which round |
|---|---|---|
| 1 | `docs/release/compat-honesty-gate.md` — retracted | round 1 (B3) |
| 2 | `docs/release/public-release-readiness.md` — still published | round 2 (R1) |
| 3 | `.claude/impl-compat5-report.md` — still published, found by my own sweep | round 2 (self-found, called "the THIRD copy") |
| 4 | **`#545` comment 5402624775 — still published, live** | round 3 (R3-1) |

**Four copies of one sentence, each found only after the previous round declared itself finished.**
And it is not the only figure with that history: "in all 16 shards" was found as a third copy in
`compat-honesty-gate.md:157` in round 2 and then found *again*, live on #545, in round 3.

That is the finding. Four rounds of "fix this instance" produced four more instances. **A
per-instance fix is the wrong shape for a defect that recurs**, and the argument for building a
check rather than sweeping again is not that sweeping is tiring — it is that sweeping has now
demonstrably failed four consecutive times, each time while being performed carefully by someone who
believed they were being thorough.

## What was actually live — 8 figures across 3 issues, not 4 across 2

Round 3 listed four figures on two issues. Re-deriving from the raw ledgers and fetching every
issue's body and comments found **eight across three**:

| issue | figure still published | corrected to |
|---|---|---|
| #545 c5402624775 | "asserted twice, independently" | one counter, two transports; API authoritative |
| #545 c5402624775 | "28 of 28 ledgered nights at 778/0/0" | `failed:0` 28 of 28; full `778/0/0` **27 of 28** |
| #545 c5402624775 | "in all 16 shards" | every shard that reported; 08-03 recorded **15** |
| #545 c5402624775 | "9 restarts in 27 nights" | **10** restarts |
| #710 c5402620077 | "778/0 on 28 of 28 ledgered nights" | **27 of 28** |
| #710 c5402620077 | `kind: timeout` at 60000 ms as the discriminator | the structural **complete-but-red** reading |
| #846 body | "28 fingerprinted node nights, 26 of 27" | **27** fingerprinted; frame mixed 07-28 with 07-29 |
| #846 body | "9 restarts in 27 nights" | **10** restarts |

The two #710 items were **not in round 3's list.** Corrections posted as comments quoting the wrong
figure and stating the right one with its derivation — never as silent edits to an existing body,
including on #846 where the body is mine and editing it would have been permitted:

- #545 → [comment 5411722309](https://github.com/getknext-dev/knext/issues/545#issuecomment-5411722309)
- #710 → [comment 5411725154](https://github.com/getknext-dev/knext/issues/710#issuecomment-5411725154)
- #846 → [comment 5411725555](https://github.com/getknext-dev/knext/pull/846#issuecomment-5411725555)

## The reviewer's question, answered in both directions

> *Is a check that FAILS on future divergence tractable here?*

**For the general form — a doc-vs-doc referee — no, and I did not build it.** Round 3 measured it
properly: precision never crosses ~50% at any subject-overlap threshold, because the corpus
legitimately states different numbers about vocabulary-adjacent subjects (778 node vs 775 bun; 16
shards vs 08-03's 15). A gate at that false-positive rate gets edited to green, which `security.md`
already names as the failure mode where editing the guard becomes the routine way to pass. That
measurement stands and the conclusion is accepted.

**For the boundary the reviewer called undefendable "by construction" — yes, for the subset that
actually matters.** The general question ("do two prose sources agree about a number") is
intractable. The question the defect class actually poses is different and exact: **does a figure
this repo has already RETRACTED still stand uncorrected on a cited issue?** No similarity threshold,
no judgement, no fuzzy matching.

| file | role |
|---|---|
| `docs/compat/retracted-figures.json` | the ledger — 6 figures, mirroring the `$knextQuarantines` pattern |
| `scripts/lib/retracted-figures.mjs` | pure decision logic, no I/O |
| `scripts/verify-retracted-figures.mjs` | resolution against the live issues |
| `tests/retracted-figures.test.ts` | 18 tests, offline, both halves |
| `.github/workflows/retracted-figure-resolution-nightly.yml` | the nightly |

Design decisions that matter:

- **Issues are SCANNED out of the citing documents, never enumerated** — `.claude/rules/workflow.md`:
  "an enumerated list of call sites is how the second one gets missed". The scan found 8 cited
  issues without anyone listing them.
- **A source discharges a figure only by quoting it AND stating the corrected value.** Quoting alone
  is republishing the error; asserting the right value alone does not reach a reader who landed on
  the comment carrying the wrong one — which is *exactly* how #545 came to have a correct comment 6
  sitting under an uncorrected comment 5 for a fortnight.
- **The rule keys off the claim, not a label**, so it cannot be satisfied by pasting a
  `## Correction` heading onto an empty comment. An earlier version of mine keyed off a heading and
  was wrong in both directions; the negative-control mutation pins this.
- **Same PR-time / run-time split as the action-pin pair**, for the reason `security.md` records:
  logic asserted offline at PR time, resolution never baked into a committed assertion. Issue text
  changes without any commit, so a committed snapshot would rot on the first comment.
- **An unreachable API is a FAILURE, never a pass.** A checker that goes green when it cannot see
  its subject reports "nothing is wrong" and "I could not look" identically.

**The residual is stated in the ledger, not hidden:** the ledger is written by whoever makes a
retraction, so a retraction whose author never adds an entry is not caught — and no scan can catch
that, because nothing in the tree marks the old value as wrong. What the gate guarantees is
narrower and still worth having.

## The gate earned its keep on its first run

Run against the live issues immediately after being written, it failed with three findings:

1. **A fifth instance nobody had looked at** — `28 fingerprinted node nights` in #545 comment
   **5401289209**. Round 3 examined comment 5402624775; this is a different, earlier comment. My own
   correction had not covered it either, because I had corrected what the review listed. Now
   corrected.
2. **A false positive from my normaliser** — a correcting comment quotes the wrong figure in a `>`
   blockquote, GitHub wraps the quoted line, and `at exactly\n>    timeoutMs: 60000` survived
   whitespace collapsing as `at exactly > timeoutms: 60000`. The correcting comment failed to match
   its own quote. Fixed by stripping blockquote and list markers in `normalize()`, pinned by a unit
   test and by mutation **M4**.
3. **A false positive from my correction rule** — #850's body reconciles *"a prior analysis put this
   at 9 restarts"* with its own 10, in plain prose, wearing no heading. Round 3 explicitly praised
   that comment as a model. My heading-based rule flagged it. Fixed by keying off the claim instead,
   pinned by mutation **M3** and a unit test named for the #850 shape.

Two of the three were defects in the check itself, found by running it against reality rather than
by inspecting it. Both were fixed **in the design** — not by loosening the gate, which would have
been the easy move and would have produced a gate that passes because it cannot see.

## Mutation proof — independent, 7 mutations

`scripts/mutation-prove-retracted-figures.mjs`:

| mutation | expected | why it matters |
|---|---|---|
| M1 ledger emptied | RED | a vacuous ledger passes everything |
| M2 correction detection widened to "quotes it" | RED | republishing would discharge |
| M3 correction detection narrowed to a heading | RED | #850's plain-prose reconciliation would be flagged |
| M4 blockquote stripping removed | RED | the live false negative, re-armed |
| M5 issue scanning neutered | RED | a gate that inspects nothing |
| M6 offence reporting suppressed | RED | finds offences, reports none |
| **NC negative control** — inert edit | **GREEN** | separates a guard from a tripwire |

**STEP 0 requires a red canary AND a green canary.** This is a direct lesson from round 3's own
disclosure: their first harness passed `--reporter=basic`, which vitest 4 rejects at startup, so
every invocation exited 1 including the baseline — and a **red-only canary cannot detect that**,
because a runner broken at startup is red for every input. Requiring the harness to demonstrate it
can tell red from green is what makes its discrimination observable. Same family as this project's
recorded incident where vitest ANSI broke a pass/fail grep and certified 14 decorative mutations
all-green.

M1's marker is embedded in a JSON **key** rather than a comment, because JSON has no comment syntax
and a `//` marker would have made the ledger unparseable — M1 would then have gone red for a syntax
error rather than for the vacuity it exists to prove. A mutation that reds for the wrong reason
proves nothing.

## Discipline log (round 3)

- Every figure re-derived from the raw ledgers again, including the ones rounds 1–2 computed and
  that were right.
- Exit codes for every verdict; **no test run was ever piped into `tail`** — each was redirected to
  its own log file and the exit status read directly. (Round 1 hit exactly that bug: `PIPESTATUS`
  under zsh returned empty and the exit code was unreadable.)
- Corrections posted as **comments quoting the wrong figure**, never as silent body edits — including
  on #846, where the body is mine and editing would have been permitted.
- The gate's two self-inflicted false positives were fixed in the design, not by relaxing it.
- No push to `main`, no force-push, no history rewrite.

---

## Mutation proof of the boundary gate — the actual result

Run after the commit landed and the tree was clean. **`::prover-summary:: {"declared":7,"run":7}`,
exit 0. All 7 behaved as required; 0 survived.** No mutation was skipped, and none was expected-away.

| # | mutation | expected | **actual** |
|---|---|---|---|
| 0a | red canary | RED | **RED** (exit 1) |
| 0b | green canary | GREEN | **GREEN** (exit 0) |
| B0 | unmutated gate | GREEN | **GREEN** |
| M1 | ledger emptied | RED | **RED** |
| M2 | correction detection widened — quoting alone discharges | RED | **RED** |
| M3 | correction detection narrowed to a heading | RED | **RED** |
| M4 | blockquote stripping removed | RED | **RED** |
| M5 | issue scanning neutered | RED | **RED** |
| M6 | offence reporting suppressed | RED | **RED** |
| NC | **negative control** — inert edit | GREEN | **GREEN** |

Each mutation reds on **its own subject**: M1 fails the ledger-is-real tests, M2 the
"quoting alone is republishing" test, M3 the #850 plain-prose reconciliation test, M4 the
blockquote-normalisation test, M5 the cited-issue scan tests, M6 the offence-reporting tests. A
mutation that red the suite for an unrelated reason would prove nothing, so this was checked rather
than assumed.

**STEP 0 discriminates.** The red canary exits 1 *and* the green canary exits 0 — the pair, not just
the red, because a runner broken at startup is red for every input and a red-only canary reports
PASS in that world. That is round 3's own disclosed near-miss, adopted here.

Post-proof state, verified independently of the prover's own assertions: `git diff --stat HEAD`
**empty** (core and ledger byte-identical), `git status --porcelain` shows only the two untracked
review files, `tests/mutation-prover-lane.test.ts` **52 passed**, exit 0.

> **CORRECTED IN ROUND 5 — this paragraph asserted `scripts/scan-mutation-residue.mjs` exit 0, and
> the commit carrying that sentence made it FALSE.** The scan was exit 0 when measured; the prose
> written to describe the fix then quoted the scanner's output *verbatim, marker and all*, and that
> quote is itself residue. So the tree the claim shipped on reds. See the round-5 section for the
> fix and for why the false assertion is treated as part of the defect rather than a typo.

### A defect I introduced, caught by the repo's own guard

The first proof run passed 7/7 — and then the residue scan failed against a **clean tree**. The
scanner named one tracked file and one line: `scripts/mutation-prove-retracted-figures.mjs:136`, the
JSON key planted by mutation M1. *(The offending line is deliberately **not** quoted here. Quoting
it verbatim is what turned this very paragraph into residue in round 5 — see below.)*

Not a false positive. M1 embeds the residue marker in a JSON **key** (JSON has no comment syntax, so
a `//` marker would make the ledger unparseable and M1 would red for a syntax error rather than for
the vacuity it exists to prove) — and I wrote that key as a **literal**. A tracked file containing
the literal marker *is* residue by definition, which is exactly why `mutation-harness.mjs` and
`scan-mutation-residue.mjs` both assemble the marker from parts rather than spelling it out.

Fixed by interpolating the harness's exported `MUTATION_MARKER`. **Not** by adding an allowlist
entry, which was the easy move and would have put a permanent hole in the residue scan — the same
"silent exemption" trap the transform-cache guard is built to avoid.

Worth recording for two reasons. First, the guard that caught it is one this project built after
nearly shipping the inverse of a fix twice, and it earned its keep again here. Second, it is the
same shape as the two false positives the boundary gate found in itself: **three of the defects in
this round's new machinery were found by running it, none by reading it.**

### Note on the commit

These commits are **unsigned** (`git -c commit.gpgsign=false`). The signing key's pinentry cannot
prompt from a non-interactive shell, so `commit.gpgsign=true` blocked four attempts with
`gpg: signing failed: Operation cancelled`. The founder committed the staged tree unsigned and
directed the same for the rest. Recorded because the branch's earlier commits *are* signed, so the
break in the middle is deliberate and explainable rather than an anomaly.

That same lock is also why `tests/mutation-residue-scan.test.ts` fails locally: its fixtures run
`git commit`, which inherits the global `commit.gpgsign=true` (18 `signing failed` lines in the
suite log). That is a local-environment failure, not a regression, and it is the same class round 3
recorded.

---

# Fix round 5 — adversarial review @ `f200aa0` (`ISSUES_FOUND`, one blocking)

Round 5's headline: the gate's core held where it was attacked hardest. The **critical** axis —
an unreachable API must FAIL — survived all eight blindness shapes the reviewer constructed,
including the two that matter most (`gh` exiting **0** with empty stdout, and `gh` exiting 0
returning `{}`), because a subprocess that *succeeds while returning nothing* is how a checker goes
green without seeing its subject. The 11→7-mutation result also re-derived independently against a
**different** mutation set (8 mutations + 2 controls, none copied), with per-subject re-runs.

What did not hold was the edges — which is where this defect class has landed every single time.

## 1. BLOCKING — the residue was in the report, and the report said otherwise

`scripts/scan-mutation-residue.mjs` exited **1** on the committed tree. The residue was
`.claude/impl-compat5-report.md:718`: the prose written to describe removing the literal marker
from the prover **quoted the scanner's output verbatim, marker and all**.

So the fix moved the literal one hop — into the document explaining the fix. That is the **sixth**
reproduction of this PR's own defect class, and the first where the *correction itself* was the
carrier.

**The false assertion is treated as part of the defect, not a typo.** The same commit's report
asserted `scan-mutation-residue.mjs` exit **0**. That was true when measured and the commit
carrying it is what falsified it — precisely `workflow.md`'s *"re-read your own claims against the
current tree before merging, not just your diff."* The paragraph now carries an explicit
CORRECTED-IN-ROUND-5 retraction rather than a silent edit, because a report that asserts a clean
scan while the scanner reds is worse than no report.

Scanner re-run, **branched on its exit code**: now **0**.

### It then happened a seventh time, inside the fix

The commit that fixed the report introduced residue in the *prover*: M10's replacement string wrote
`"<marker> widened"` as a literal and stripped it with `.replace()` at run time, so the tracked file
contained the marker twice. Scanner exit 1 again.

Two consecutive commits where the fix for this defect class became its next instance. **The lesson
is not "be more careful"** — that has now failed seven times. It is that the literal must never be
*typeable* in a tracked file, so every site interpolates the harness's `MUTATION_MARKER` and none
spells it out. Recorded rather than quietly amended, because the recurrence is the finding.

## 2. Criterion 3 — both structural holes closed

**4a — cross-repo citations were resolved against the WRONG repository.** `citedIssues` captured
only the *number* from a `github.com/OWNER/REPO/issues/N` URL and discarded owner and repo, so the
resolver fetched that number from the **default** repo: a confident verdict about an unrelated
same-repo issue while the real target went unscanned. That is worse than not supporting cross-repo
citations at all. It now returns `{owner, repo, number}`, understands the `owner/repo#N` shorthand
that the bare-`#` lookbehind had excluded, and each citation is fetched from the repo it **names**.

**4b — a cited PULL REQUEST was silently under-scanned.** #846 — the PR this work posted a
correction on — carries review bodies and inline review comments that `issues/N/comments` never
returns. Both are now read. The decision about *which* surfaces count moved into the pure core as
`assembleSources()`, because in the resolver it was I/O-bound and therefore untestable, and an
untestable branch is exactly what rots unnoticed. Five tests cover it, including a figure that
appears **only** in a review body.

**Also closed, from the same criterion:** `normalize()` now strips inline HTML tags, decodes
`&nbsp;`, removes zero-width characters and folds via NFKC. GitHub *renders* HTML in issue bodies,
so `churn was <b>9</b> restarts` reads identically to the plain form on screen while evading a text
match — a **carelessness** path, not only an adversarial one.

**Stated limits, not closed:** a figure spelled out in words ("nine restarts") and a
hyphenated line-break still evade. Both are contrived rather than careless, and closing them means
fuzzy matching, which is the thing round 3 measured at ~50% precision and correctly refused to
build. A *silent body edit* of an original comment is also undetectable — the failure message
forbids it but cannot enforce it.

## 3. Criterion 4 — the over-broad patterns, fixed in the design

Two ledger patterns broke the ledger's **own** stated rule (*"patterns must be specific to the WRONG
claim"*): bare `"asserted twice"` flags *"the flag is asserted twice in the reconciler for
idempotency"*, and bare `"9 restarts"` flags *"the bun lane saw 9 restarts in its own 27 nights"* —
the exact node-vs-bun vocabulary adjacency that is the documented reason the general fuzzy check was
**not** built.

Both tightened. And the rule is now **enforced rather than documented**: `$negativeCorpus` holds
legitimate sentences that no pattern may match, asserted by a test. It earned its keep immediately —
**it caught a third over-broad pattern nobody had reported** (`"28 fingerprinted nights"`, which
flags an unrelated two-window analysis).

**Tightening a pattern can blind a gate, so that was checked in three directions, not assumed:**

| half | result |
|---|---|
| A — all **9** original offending sentences still match | **caught, 9/9** |
| B — all **6** legitimate sentences stay unflagged | **clean, 6/6** |
| C — all **3** correction comments still discharge | **discharge, 9/9 figure-pairs** |

## 4. The remaining findings

- **The nightly had no red alert.** For a check whose entire subject is a defect class that survived
  three rounds *because nobody was looking*, a red visible only in the Actions tab is the
  predictable end state. It now carries the same idempotent pinned-issue job its sibling has.
- **`--paginate` silently rewrote comment text.** `out.replace(/\]\s*\[/g, ',')` is a textual edit
  over the whole payload *including inside JSON strings*: `see refs [a] [b] and note 9 restarts`
  parsed as `see refs [a,b] and note 9 restarts` — still valid JSON, quietly altered, able to break
  a pattern match (false green) or a correction's quote (false red). Replaced with `--slurp`.
- **Token scope.** `issues: read` is now declared explicitly rather than relied on implicitly.
- **The residual is now stated where the reader looks.** `public-release-readiness.md`'s
  load-bearing *"#545 and #710 carry the corrected findings"* sentence — which was **false for three
  rounds** — now points at the ledger and the nightly, and states the limit: the gate can only test
  figures someone recorded as retracted.

## 5. Mutation proof — 11 mutations, actual result

`::prover-summary:: {"declared":11,"run":11}`, **exit 0. 10 red, 1 negative control green, 0
survived.**

> **CORRECTED IN ROUND 6 — this result was true when measured and STOPPED being true, and this
> section went on asserting it.** Commit `60bae6d` ran biome over
> `docs/compat/retracted-figures.json` and collapsed the `patterns` array onto one line, which
> invalidated M10's anchor. From then on the prover **died at M10 and ran 9 of 11**: M10 and the
> **negative control never executed**, so the run below could not be reproduced from the tree that
> shipped it. Nine reds with no control is not a partial success — it is an unproven prover.
>
> The table below is retained as the record of the run it describes, **not** as a claim about the
> current tree. The current tree's result is in the round-6 section: the anchor is repointed, the
> prover is data-driven with a preflight and a completion guard, and it now runs 11/11 again. The
> false assertion is treated as part of the defect rather than a stale line, for the same reason
> round 5 treated its own: a report that claims a completed prover while the prover dies partway is
> worse than no report.

| # | mutation | expected | **actual** |
|---|---|---|---|
| 0a/0b | red canary / green canary | RED / GREEN | **RED / GREEN** |
| M1 | ledger emptied | RED | **RED** |
| M2 | correction widened — quoting alone discharges | RED | **RED** |
| M3 | correction narrowed to a heading | RED | **RED** |
| M4 | blockquote stripping removed | RED | **RED** |
| M5 | issue scanning neutered | RED | **RED** |
| M6 | offence reporting suppressed | RED | **RED** |
| **M7** | cross-repo citation loses owner/repo | RED | **RED** |
| **M8** | cited PR loses its review surfaces | RED | **RED** |
| **M9** | HTML-tag stripping removed | RED | **RED** |
| **M10** | ledger pattern widened to the over-broad form | RED | **RED** |
| NC | **negative control** — inert edit | GREEN | **GREEN** |

### The harness refused a false result mid-run, and that is worth recording

The first attempt aborted at M5: `anchor occurs 0 times (expected exactly 1)`. Rewriting
`citedIssues` for the cross-repo fix had invalidated **two** anchors — M5's and the negative
control's. Without the exactly-once contract, M5 would have planted nothing and reported RED, and NC
would have planted nothing and reported GREEN: **two false results in one run**, both looking
exactly like success. The harness refused instead. That is the contract this repo adopted after a
silently-failed `perl` substitution certified a green that proved nothing.

## 6. Verification

- `scripts/scan-mutation-residue.mjs` — **exit 0** (branched on exit code, not output).
- `scripts/mutation-prove-retracted-figures.mjs` — **exit 0**, `{"declared":11,"run":11}`.
- `tests/retracted-figures.test.ts` — **32 passed**, exit 0.
- `node scripts/verify-retracted-figures.mjs` against the live API — **exit 0**, 8 cited issues, 0
  uncorrected.
- `tsc --noEmit -p tsconfig.typecheck.json` — exit 0. `biome check` — exit 0.
- `git diff --stat HEAD` **empty**; `git status --porcelain` shows only the untracked review files.

**`tests/` is 1870 passed / 7 failed across 2 files, and both are the GPG lock**, not a regression:
`tests/mutation-residue-scan.test.ts` and `tests/compat-window-fingerprint.test.ts` both run
`git commit` in fixtures, which inherits the global `commit.gpgsign=true` (18 `signing failed` lines
in the suite log). Isolated and cause-named rather than waved through as pre-existing. Neither is
touched by this branch.

## 7. Discipline log (round 5)

- Every verdict branched on an **exit code**; no test output was grepped for pass/fail, and **no run
  was piped into `tail`** — each was redirected to its own log file and the status read directly.
- Pattern tightening was verified in **three directions** (still-catches / stays-clean /
  still-discharges) before being claimed, because narrowing a pattern is indistinguishable from
  blinding the gate if only one direction is checked.
- The PR-surface decision was **moved into the pure core** specifically so it could be mutated; an
  I/O-bound branch that cannot be tested is a branch that rots.
- Restores verified byte-identical, `git status --porcelain` checked before any claim of clean.
- Two defects in this round's own work were found by **running** the guards, not by reading them —
  consistent with every previous round.

---

# Fix round 6 — adversarial review @ `f936754` (`ISSUES_FOUND`, one blocking)

Five of six criteria PASSED, each proven by a run: the residue fix removed the residue **without
weakening the scanner**; the cross-repo and under-scanned-PR cases were reconstructed by the
reviewer and found fixed; both false-positived shapes verified in **both** directions; the
mutations re-derived independently with zero survivors; no regression; and the uncatchable case
confirmed stated rather than hidden.

One blocking defect remained, and it was the same class as the last one.

## 1. The prover died at M10 — WHY, not just that it did

`scripts/mutation-prove-retracted-figures.mjs` — the prover for this PR's flagship guard — exited 1
having run **9 of 11** declared mutations. M10 and the **negative control** never executed.

**The cause was not the mutation. It was the anchor's shape.** Commit `60bae6d`
(*"style(compat): biome-format the retracted-figures registry"*) reformatted the ledger and
collapsed

```json
"patterns": [
  "9 restarts in 27 nights",
  "churn: 9 restarts"
],
```

onto a single line. M10's anchor spanned two lines of that array **at a fixed indent**, so it
stopped existing. The byte-snapshot harness then refused to plant it — correctly, and exactly as
designed — and the straight-line script had no handler, so the process died there.

So the prover was broken by a **formatting commit that touched no logic**, and nothing failed until
someone ran it.

**Why the missing control is the serious half.** Nine reds with no negative control is not 82% of a
proof. Reds alone cannot establish that a prover distinguishes a guard from a tripwire — something
that reds at *any* edit reds at *every* edit and would score 9/9. Ruling that out is the control's
entire job, so the run proved nothing about the prover however many reds it collected.

**Specific fix:** M10 now anchors on the JSON string literal `"9 restarts in 27 nights"` — the one
thing a formatter will not rewrite. The quotes are load-bearing, not cosmetic: the bare form occurs
**twice**, since it is also in the `wrong` field, so an unquoted anchor would be ambiguous rather
than missing.

## 2. The report claimed a completed prover — treated as part of the bug

Section 5 above asserted `{"declared":11,"run":11}`, exit 0. That was true when measured, and
`60bae6d` made it false. The section now carries an explicit CORRECTED-IN-ROUND-6 retraction saying
so and pointing at the current result, rather than being quietly edited to match.

This is the third round in which a claim in this report was true at measurement and falsified by a
later commit. The pattern is worth naming: **claims about a tree go stale when the tree moves**, and
the only defence that has actually worked here is re-running and branching on the exit code before
restating anything.

## 3. The general fix — a partial run can no longer read as success

The specific anchor is repointed, but the next early death would have been just as quiet. Four
structural changes:

- **Mutations are DATA, not straight-line statements.** The plan can be inspected before it runs.
- **PREFLIGHT resolves every anchor before anything is planted.** A stale anchor is now a report
  listing *all* stale anchors at once, with the tree untouched — not a crash discovered one
  mutation at a time.
- **A COMPLETION GUARD compares executed against declared and asserts the control ran.** A shortfall
  exits non-zero and says exactly what never happened, printed *after* the `ok` lines where it will
  be read, rather than as a stack trace a reader can mistake for noise.
- **`try/finally` restores both snapshots unconditionally.** The straight-line version had no
  `finally`, so a crash mid-mutation left the mutation on disk.

### The guard against silent partial proofs is itself proven

Implementing that inline would have made it the one thing in this PR nobody could exercise — the
same untestable-branch problem that hid the under-scanned PR review surfaces. So it is lifted into
`scripts/lib/prover-completion.mjs` as two pure functions and proved like anything else:

- `tests/prover-completion.test.ts` — **11 tests**, both halves, including the exact M10 shape
  (9 executed of 11, died at M10, control never ran) asserted to **fail**.
- `scripts/mutation-prove-prover-completion.mjs` — **8 mutations, 7 red + 1 negative control**.

`assessCompletion` checks the control **independently of the count**, which matters: a plan can be
complete by count and contain no control at all, and a count check cannot see that. Mutation **C4**
pins the subtle wrong version — a check weakened to *"was a control declared"*, which would accept
exactly the M10 run.

The prover applies its own rule to itself: it preflights its own anchors and asserts its own
completion before reporting success.

### The preflight proved itself on its first run

Running the new completion-prover immediately produced:

```
ABORT before planting: 1 of 8 anchors do not resolve.
  C6: anchor occurs 0x (need exactly 1)
```

**C6 had been anchored on layout that biome had already reflowed** — the identical mistake as M10,
made again while fixing M10. The difference is the outcome: M10 died mid-run and silently dropped
the control; C6 was caught **before anything was planted**, with every stale anchor listed and the
tree untouched. Re-anchored on the predicate `(a) => a.count !== 1`, which a formatter will not
split.

That is the clearest evidence available that the general fix was the right one. The specific
mistake recurred within the hour; the structural change turned it from a silent partial proof into
a one-line report.

## 4. Verification — every claim branched on an exit code

| check | exit |
|---|---|
| `scripts/mutation-prove-retracted-figures.mjs` | **0** — `{"declared":11,"run":11}` |
| `scripts/mutation-prove-prover-completion.mjs` | **0** — `{"declared":8,"run":8}` |
| `scripts/scan-mutation-residue.mjs` | **0** |
| `scripts/verify-retracted-figures.mjs` (live API) | **0** |
| `tests/mutation-prover-lane.test.ts` | **0** |
| `tests/prover-completion.test.ts` | **0** — 11 tests |
| `biome check` on all changed files | **0** |
| `git diff --stat HEAD` | **empty** (byte-identical) |
| `git status --porcelain`, excluding untracked review files | **0 lines** |

**Declared equals executed on both provers**, which is the specific thing this round was about, and
it is read from the `::prover-summary::` line rather than assumed from a green exit.

## 5. Discipline log (round 6)

- Every verdict branched on an **exit code**; **no run was piped into `tail`** — each was redirected
  to its own log file and the status read directly.
- The M10 death was diagnosed to its **cause** (`60bae6d`'s reformat) rather than patched by
  re-anchoring and moving on, because the same anchor shape would have broken again — and did,
  within the hour, at C6.
- The false report claim was **retracted in place**, not edited to match.
- Restores verified byte-identical and `git status --porcelain` confirmed clean before any claim of
  cleanliness; `scan-mutation-residue.mjs` re-run and confirmed **exit 0**.
- The new guard was mutation-proved **independently**, with its own negative control, because a
  guard against unproven provers that is itself unproven is the same defect one level up.
