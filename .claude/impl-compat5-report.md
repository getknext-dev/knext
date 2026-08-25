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
this round re-derived it independently rather than agreeing with it, and additionally establishes
the zero-re-run figure from a second, independent source.

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

- `tests/` — **81 files / 1839 tests, exit 0**.
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
