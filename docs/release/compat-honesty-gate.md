# Compat honesty gate — release checklist step 5 (#545, #710)

**Date of measurement: 2026-08-25.** Everything below is re-derived from GitHub's API and the
retained `compat-run-ledger` artifacts, not from earlier reports in this repo. Where a prior
finding is corroborated that is said explicitly; where it is corrected, likewise.

**Verdict in one line:** neither #545 nor #710 blocks the public-release compat claim. The claim
is the Node lane's, the Node lane is not flaky, and the Bun lane's red is a documented, permanent,
already-❌ runtime gap. What *was* wrong is smaller and was fixed in this round: two CI files told
every reader the official suite runs in a workflow that does not exist.

---

## A. Where the full/weekly compat suite actually runs

It runs. `ci.yml` was pointing at the wrong name for it.

| | |
|---|---|
| Workflow file | `.github/workflows/test-e2e-deploy.yml` |
| Workflow name | `Compat suite (official Next.js deploy harness)` |
| GitHub workflow id | `300291864` |
| Node credential lane | `cron: '17 3 * * *'` — nightly |
| Bun runtime axis | `cron: '17 5 * * 0'` — weekly, Sunday |
| Lane selection | `KNEXT_RUNTIME: ${{ inputs.runtime \|\| (github.event.schedule == '17 5 * * 0' && 'bun') \|\| 'node' }}` |
| Shards | 16 (`COMPAT_SHARD_TOTAL`), 778 tests under the current ADR-0007 §d manifest |
| Most recent scheduled run at time of writing | `32688792926` — 2026-08-24T04:06:42Z, node lane, **success** |

**The defect the brief found is real, and it is a naming defect, not a missing lane.**
`.github/workflows/ci.yml:242` and `apps/file-manager/scripts/compat-smoke.mjs:9` both said the
official harness "is a separate scheduled job (A3-2, `compat-suite-full`)". Nothing in this repo is
called `compat-suite-full` — no workflow file, no workflow `name:`, no job id, no artifact. The
name originates in ADR-0007, which introduces it *bound to the file that carries it*; the two
CI-side copies kept the name and dropped the binding.

That is not cosmetic on a project whose north star is honest status. A reader who greps
`.github/workflows/` for the name they were handed finds nothing, and the only conclusions
available are "the lane was deleted" or "the lane never existed" — both false, and a
release-readiness review reached exactly that one. A pointer that reads as evidence of absence is
worse than no pointer.

**Fixed and guarded in this round** (see *What changed* below). ADR-0007 itself is left alone: it
is a historical decision record and it is internally consistent.

---

## B. #710 — "Compat weekly RED (bun lane)"

### The failing shards and tests, named

Four Bun weeklies still have their per-shard `compat-run-ledger` artifact. All four are red, on
the same two shards, on the same three files.

| run | date | lane | `run_attempt` | red shards | passed/failed |
|---|---|---|---|---|---|
| `30738274907` | 2026-08-02 | bun | 1 | 6, 8, 16 | 774 / 4 |
| `31297820716` | 2026-08-09 | bun | 1 | 6, 8 | 775 / 3 |
| `31929677335` | 2026-08-16 | bun | 1 | 6, 8 | 775 / 3 |
| `32621148829` | 2026-08-23 | bun | 1 | 6, 8 | 775 / 3 |

Job-level attribution reaches two runs further back than the artifacts do. `30193384289`
(2026-07-26) and `29678368535` (2026-07-19) each failed exactly two jobs — `Deploy tests
(shard 6/16)` and `Deploy tests (shard 8/16)` — on the same failing step, `Fail shard on red
results (revocation teeth)`. So the shard set is **6 of 6** bun weeklies with retrievable data.

The files, union across the four ledgers:

- shard 6 — `test/e2e/app-dir/app-static/app-static.test.ts` — **this is a union, and only the
  first three recur on all four runs.** 2026-08-02 carries three of the five; 08-09 and 08-23
  carry four; 08-16 carries all five.
  - `should handle dynamicParams: false correctly` *(all four)*
  - `should handle partial-gen-params with layout dynamicParams = false correctly` *(all four)*
  - `should handle partial-gen-params with page dynamicParams = false correctly` *(all four)*
  - `should not cache correctly with POST method request init` *(not on 2026-08-02)*
  - `should cache correctly handle JSON body` *(2026-08-16 only)*
- shard 8 — `test/e2e/app-dir/parallel-routes-root-param-dynamic-child/parallel-routes-root-param-dynamic-child.test.ts`
  - `should render a 404 for /es/gsp/stories/dynamic-123 (both locale and slug not allowed)`
  - `should render a 404 for /es/gsp/stories/static-123 (locale not in generateStaticParams)`
- shard 8 — `test/e2e/middleware-fetches-with-any-http-method/index.test.ts`
  - `passes the method on a direct fetch request`
  - `passes the method when providing a Request object`
- shard 16 — `test/e2e/edge-compiler-can-import-blob-assets/index.test.ts` *(2026-08-02 only)*
  - `allows to fetch a remote URL`, `allows to fetch a remote URL with a path and basename`

### Real incompatibility, or infrastructure flake?

**Real runtime incompatibility.** Four independent discriminators, each measured:

1. **It is deterministic.** Same two shards and same three files on 4 of 4 ledgered runs, and the
   same two shards on 6 of 6 at job level. A re-run has never turned it green — because there has
   never been a re-run: `runAttempt: 1` in every ledger, `run_attempt: 1` from the API on every
   scheduled run in the window.
2. **The Node lane is green on identical infrastructure.** Same 16-shard split, same runner class,
   same pinned `v16.2.0`, same harness — `failed: 0` on **28 of 28** ledgered nights in the same
   window, at the full **778 / 0 / 0 on 27 of 28**. The 28th (`30790778590`, 2026-08-03) lost
   shard 16/16 to a runner disconnect and recorded 15 shards / 730 passed / 0 failed — the
   infrastructure-loss case described in discriminator 3 below, not a test failure.
   Infrastructure that could fail shard 6 would not politely restrict itself to the lane that
   swaps the serving runtime.
3. **The bun reds are complete-but-red; infrastructure loss is absence.** This is a *structural*
   distinction in the ledger data, and it is stated that way deliberately — the obvious version of
   this argument ("`kind: timeout` at exactly `timeoutMs: 60000` is a per-*case* hang") does **not**
   hold, because the reported `kind` alternates run to run for the same file (see the limit note
   below). The structural reading survives that alternation. On every bun red the shard reported a
   **complete accounting**: `expectedTotal` met exactly by `passed + failed` (shard 6/16 = 48 + 1 =
   49; shard 8/16 = 47 + 2 = 49), `truncated: false`, `notRun: 0`, `status: "reported"` — the shard
   ran its whole set and some cases came back red. The contrasting signature is on file: run
   `30790778590` (node, 2026-08-03) lost shard 16/16 to a runner disconnect and produced **no
   shard entry at all** — 15 entries where every other night has 16, and **zero** failed tests.
   Infrastructure loss removes a shard from the record; this fills the record in and marks it red.
4. **It is already root-caused, and not to knext.** `docs/compat/upstream-bun-sandbox-fetch-bug.md`
   names the phase from in-realm instrumentation of a red shard: the edge-sandbox outbound `fetch()`
   *resolves* with status 200, the socket dies mid-body, and the **body** promise never settles
   under Bun's node-compat sockets (Node rejects with "terminated"). A 25-line, next-free repro
   discriminates deterministically on Bun 1.3.5 / 1.3.14 / 1.4.0-canary. It is **not** Bun-version
   gated away.

**One honest limit on the determinism claim.** It holds at *shard and file*, not case for case.
Within a file the reported `kind` alternates run to run — `app-static` reports `assertion` on 08-02
and `timeout` on 08-09/16/23, `parallel-routes-root-param-dynamic-child` does the reverse — and
08-16 carries a fifth `app-static` case the others do not. This corroborates the existing note in
`docs/compat-matrix.md`; it was re-derived here from the raw ledgers rather than read across.

### Consequence

**#710 is CI hygiene, not a release blocker.** The published compat claim is the **Node** row, and
that row states in terms that it does not extend to Bun; the Bun runtime-axis row is already ❌ and
cites the absence of any green bun run. Nothing public rests on this lane. Not quarantining these
three files is also the right call and should stay — but the support is ADR-0007 §(c)'s **scope**,
not its evidence bar. §c.2 ("at least one FINAL post-retry failure, observed") is a *floor*: it
exists to stop pre-emptive quarantines of wobble that retries would have cleared, and a
deterministic red clears that floor trivially rather than being excluded by it. What actually
governs is that §(c) is the **flake**-quarantine ledger — §c.1 admits per-case entries only and
forbids file-level exclusion outside §(d)'s single named runtime-prefetch family, whose entries
carry upstream provenance and **expire on the first `NEXTJS_REF` containing the upstream fix**.
A permanent, upstream-owned runtime gap is not flake and has no expiry to pin, so it fits neither
tier. Quarantining it anyway would launder a known gap into apparent green.

**But #710 has a structural problem worth naming.** The workflow re-posts the same alert body onto
it every Sunday, for a condition that is documented, permanent, upstream-owned, and deliberately
unquarantined. An alert that cannot clear is an alert people stop reading — the same pathology
#545 raises about a flaky gate, running in the other direction. The disposition options are (a)
suppress the weekly alert while the documented upstream gap is open, with the suppression dated and
expiring, or (b) leave it and accept the noise. Either is defensible; drifting into (b) by default
is not. **Out of round** — it changes alerting behaviour on the credential workflow and belongs
with the escalation that decides whether the Bun row is a v1.0 concern at all.

---

## C. #545 — "Compat suite is flaky at shard level"

Measured over the 32 scheduled runs from 2026-07-28 to 2026-08-24 that still have a retained
`compat-run-ledger` artifact (28 node, 4 bun).

| question the issue asks | measured answer |
|---|---|
| distinct tests that flake on the node lane | **0** — every one of the 28 node nights recorded `failed: 0` in every shard that reported: 27 nights across all 16 shards, and 08-03 across the 15 it recorded |
| runs that went red-then-green on re-run, no code change | **0** |
| re-runs of this workflow in the window, at all | **0** |
| node-lane reds in the window | **1**, and it is not a test failure (below) |
| bun-lane flake | none — deterministic, see §B |

The zero-re-runs figure is the load-bearing one, so it is worth being precise about how well it is
supported: **it rests on one source, read two ways — not on two independent sources.** The GitHub
API's `run_attempt` is `1` on all 32 scheduled runs in the window (and on all 72 scheduled runs of
this workflow ever, with zero above 1); the ledger's own `runAttempt` is `1` on all 32 as well, but
that field is not independent evidence — `test-e2e-deploy.yml` sets `RUN_ATTEMPT: ${{ github.run_attempt }}`
and `scripts/compat-run-ledger.mjs` writes it straight through, so it is the same GitHub-maintained
counter arriving by a second transport.

The ledger reading is also strictly **weaker**, and the corroboration therefore runs one way only:
an attempt-1 artifact reports `1` whatever happens afterwards, so it could not detect a later
re-run that the API would. **The API reading is authoritative; the ledger corroborates it at write
time.** On that basis the "re-run until green" vector this issue is built on has not operated a
single time.

The one node red — `30790778590`, 2026-08-03 — is **CI-infrastructure loss, not a compat failure**:
its ledger records `failed: 0`, and shard 16/16 uploaded no summary at all.

### #545's own acceptance criteria

| AC | state |
|---|---|
| per-shard outcomes recorded and queryable, lane-labelled | **met** — the `compat-run-ledger` artifact per run, plus `scripts/compat-window-audit.mjs`; both were the instruments for this measurement |
| failing-shard set characterised stable or rotating, with evidence | **met** — *stable*: shards 6+8, 4/4 ledgered, 6/6 at job level |
| if stable, family identified and fixed or quarantined with upstream ref | **not met as written, deliberately** — the AC offers "fixed **or** quarantined"; this round did neither. The family is identified, root-caused and documented (`docs/compat/upstream-bun-sandbox-fetch-bug.md`) with upstream provenance, and quarantining was **declined on purpose**: ADR-0007 §(c) is the *flake*-quarantine ledger (§c.1 — per-case only, file-level forbidden outside §(d)'s one named family, which expires on the ref bump that carries its upstream fix), and a permanent runtime gap is not flake. Laundering it into apparent green is the failure this whole document argues against. |
| node lane sustains a green streak long enough for the v1.0 gate | **not met as written, deliberately reported as such** — the AC's bar is the roadmap's **14 consecutive** nights; the longest observed is **7** (2026-08-12 → 08-18) and the gate is **not** reachable today. What *is* met is the narrower flake question this issue actually turns on: `failed: 0` on 28 of 28 ledgered nights, at the full 778/0/0 on 27 of 28. The streak shortfall is not flake — it is fingerprint churn, which is exactly why **#850** exists. |

**Recommendation: close #545 against its own criteria.** Its premise — that shard-level flake makes
the v1.0 gate unreachable — does not survive measurement, and the correction is already on the
issue from the prior round. The residual is real but is a *different* defect: the 14-night window
restarts on **harness-fingerprint churn** (**10 restarts** across the 27 fingerprinted nights,
longest stable streak 7 of the required 14), which no amount of flake-fixing addresses. It had
**no issue of its own** when this was written; **filed as #850**, with the restart causes
measured (27 fingerprinted nights, 11 distinct fingerprints, 10 restarts, longest streak 7 of 14 —
and **5 of the 10 restarts moved the packed `@getknext/*` tarball bytes only**). That is the honest
successor to #545 and the thing actually standing between this project and the v1.0 compat gate.

---

## What changed in this round

- `tests/compat-lane-pointer-resolution.test.ts` — new guard, three claims, all scanned:
  1. the scheduled lane **exists** — the workflow, both crons, and the lane-selection expression
     that makes the weekly cron reach the Bun axis (without this, deleting the lane outright would
     leave the other two claims vacuously green);
  2. every `compat-suite-*` identifier in the workflow/script surface **denotes something** — a
     real workflow, job, artifact or tracked file. Matched by *shape*, so a future invented lane
     name is caught too. No allowlist: an allowlist would have had to name `compat-suite-full` to
     go green, which is the defect;
  3. every sentence that deflects a reader to the official harness **names the workflow**. A
     disclaimer owes no destination; a deflection does.
- `scripts/mutation-prove-compat-lane-pointer.mjs` — 5 mutations, **all 5 red the guard**: the
  original stale pointer reinstated verbatim; a deflection naming nowhere; the weekly Bun cron
  deleted; the nightly Node cron deleted; the lane-selection expression pointed at the wrong cron.
  Every verdict branches on the runner's **exit code**; every mutation goes through the
  byte-snapshot harness, which aborts unless its anchor occurs exactly once.
- `.github/workflows/ci.yml` and `apps/file-manager/scripts/compat-smoke.mjs` — both now name the
  workflow file, its display name, and both cron times.

## SCANNED vs ENUMERATED, and what could not be established

**SCANNED** — the `compat-suite-*` identifier check and the deflection check (**75** tracked
CI/script files — 20 workflows + 55 scripts — plus `docs/compat-matrix.md`, so **76** in the shape
scan; re-derived by running the guard's own `shapeScanFiles()`, and note this is *below* the 86 an
earlier draft carried. 86 was the **pre-exclusion** count, taken before this round excluded the
`scripts/mutation-prove-*.mjs` provers: there were 11 provers at that point and 75 + 11 = 86. The
corpus now holds 12, this round having added one, and the shape-scan figure is unchanged at 75/76
*because* provers are excluded — which is the exclusion doing its job, and the reason this count is
stated as a formula rather than a number to be copied forward); the run history (all **136** runs of workflow
`300291864` as at 2026-08-25, then all **72** scheduled ones — 135/71 when the measurement was
first taken, one nightly having landed since); `run_attempt` across every scheduled run; per-shard totals
across every retained ledger.

**ENUMERATED** — the six Bun-lane runs pulled for job-level failure attribution
(`32621148829`, `31929677335`, `31297820716`, `30738274907`, `30193384289`, `29678368535`), chosen
as the Sunday reds; and the four ledger artifacts that survive of those six. The failing-file set
therefore rests on 4 runs, corroborated at shard level over 6.

**NOT ESTABLISHED.** Anything before 2026-07-28. Of the 72 scheduled runs, **39 have no retained
`compat-run-ledger`** — expired, or predating the ledger. The retention boundary is sharp and was
re-checked: every scheduled run from 2026-07-28 onward has a ledger, every run before it has none,
so the 32 in-window runs are *every* run in the window rather than a surviving subset — the
measurement below is not survivorship-filtered. Those nights can be read at job level at
best and are unfalsifiable in either direction on failing-test detail. This is the same retention
limit the 2026-08-04 comment on #545 recorded when the 08-03 log expired mid-investigation; it has
not been closed and it is not closed here.

**Also not established:** whether the Bun-lane red would clear on a Bun stable ≥ 1.4. The canary
evidence says *partially* (`parallel-routes-root-param-dynamic-child` cleared, `app-static` did
not, and a new file went red), and the pinned lane version is deliberately `1.3.14`. Re-baselining
on a new Bun stable is a dispatch away but is a deliberate pin bump, not a measurement to slip into
this round.
