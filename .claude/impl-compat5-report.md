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
the Bun row is already ❌. Not quarantining is correct: ADR-0007 §c.2's bar is a *flake* bar.
**Named but left out of round:** #710 is re-posted every Sunday for a permanent condition, i.e. an
alert that can never clear. Changing that changes alerting on the credential workflow — an
escalation, not a drive-by edit.

## C. #545 — verdict: **premise does not hold; all four ACs are met**

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
scan; the 86 this line previously carried was the pre-exclusion count, taken before this round
excluded the 11 tracked `scripts/mutation-prove-*.mjs` provers — 75 + 11 = 86); all **136** runs of
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
