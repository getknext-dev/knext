# Compat window — node lane

The v1.0 gate. **14 consecutive scheduled node-lane runs, every shard `failed:0`/`notRun:0`, zero
net new quarantine entries, and the harness fingerprint unchanged across all of them.**

This file is the record. Its numbers are now **computed** — `scripts/compat-window-audit.mjs` grades
the nights out of the run ledgers — but the file itself is still transcribed by hand; see
[What this log does not yet do](#what-this-log-does-not-yet-do), which is the honest limit and the
reason a follow-up exists.

## Status

**OPEN since 2026-07-29 — and it has never reached 14.** The clock started on the first scheduled
node-lane run after `scripts/compat-window-fingerprint.mjs` landed (#574, merged 2026-07-28) —
run `30427197358` — because that is the first run whose harness identity is recorded. The night
before it (`30333571518`, 2026-07-28) is all-green and still cannot count: a night with no recorded
fingerprint has no provable harness, and ADR-0039 makes the ledger fail on a missing one rather than
let it pass.

*Audited 2026-08-24 (public-release blocker 3), from the `compat-run-ledger` artifact of every
scheduled run in the window. Reproduce with `node scripts/compat-window-audit.mjs --fetch` — the
numbers below are that script's output, not an eyeball over a run list.*

| | |
|---|---|
| lane | node (`cron: 17 3 * * *`, nightly 03:17 UTC) |
| window opened | 2026-07-29, run `30427197358`, ref `v16.2.0` |
| **longest qualifying streak** | **7 / 14** — 2026-08-12 → 2026-08-18, fingerprint `sha256:8698abc6…` |
| **current qualifying streak** | **2 / 14** — 2026-08-23 → 2026-08-24, fingerprint `sha256:c188961e…` |
| streak restarts | **10** — **8** `fingerprint-changed`, **2** `night-disqualified` (2026-07-28 no recorded fingerprint, 2026-08-03 short ledger), over 28 graded nights |
| fingerprint moves | **10** across the 27 nights carrying one; **11** distinct fingerprints |
| nights that were all-green | **26 of 27** (the 27th executed no test — see 2026-08-03 below) |

Restarts and moves are **different counts and both are 10 by coincidence**, so do not equate them.
Two of the ten moves land on a night that was disqualified for another reason, and the audit books
those restarts to the rule that actually reset the count — hence 8 `fingerprint-changed`, not 10.
Both lines above are copied verbatim from the script's own summary block —
`node scripts/compat-window-audit.mjs --fetch --limit 40`, 2026-08-24:

```
streak restarts: 10 — 8 fingerprint-changed, 2 night-disqualified  (over 36 graded night(s))
fingerprint moves: 10 across 27 night(s) carrying one; 11 distinct fingerprint(s)
```

**36, not 28**, because `--limit 40` reaches back past the window: the 8 extra rows are scheduled
runs from before 2026-07-28, which predate the `compat-run-ledger` artifact and are therefore
reported as unresolved `no-ledger` nights rather than omitted. They are outside the window and
change none of its numbers. Narrow the limit and the denominator narrows with it; the streaks do
not move.

### Read this before concluding the suite is flaky

**The node lane is not what is stopping this gate.** Across the 27 nights of the open window,
**26 recorded `778 passed / 0 failed / 0 notRun` over all 16 shards**, and the 27th never executed a
test (a runner disconnect). **Not one night in the window was lost to a test failure.** No run was
ever re-attempted (`runAttempt: 1` on all 27), so no green here was bought by a re-run — the
re-run-until-green failure mode #545 warns about has not occurred on this lane.

**What stops the window is rule 1.** The fingerprint moved **10 times across the 27 nights that
recorded one**, because the frozen set includes both the packed `@getknext/*` closure and the
harness, and this repo merges to `main` most days. Every such merge restarts the count at zero
however green the lane is.

**A freeze on `dist/**` alone is not enough, and this is measured rather than assumed.** The ledger
records the fingerprint's two components separately, so the audit attributes every move:

```
  moves involving each frozen component: harness 5, packed 8
  30790778590: harness ONLY — no freeze of the other component(s) prevents this move
  31149348286: harness ONLY — no freeze of the other component(s) prevents this move
```

`packed` participated in 8 of the 10 moves — but **two moves were `harness`-only** (2026-08-03 and
2026-08-07), and a freeze scoped to the packed closure would have prevented neither. At the 2026-08
merge cadence, reaching 14 needs a **~2-week freeze across the whole frozen set** — the packed
closure *and* `HARNESS_ROOTS` (`.github/workflows/test-e2e-deploy.yml`, `scripts/e2e-*`,
`test/deploy-tests-manifest.*.json`). The gate is therefore a **scheduling** problem, not a
defect-fixing one — the opposite of what #545 assumed. That is a deliberate consequence of
ADR-0039's freeze scope, recorded here at its real size rather than left to be rediscovered a third
time.

## The rules this log enforces

Read [ADR-0039](../adr/0039-compat-window-freeze-scope.md) for what is frozen and why. The three
that decide whether a night counts:

1. **Fingerprint identical to the start fingerprint.** Any change inside the frozen set — the
   workflow, `scripts/e2e-*.sh`, the deploy manifest, or the packed `@getknext/*` closure **in
   full, including `dist/cli/**` and the shared chunks** — restarts the count at zero. There is no
   "that change didn't really matter" exception; a fingerprint you can argue with is not a
   fingerprint.
2. **Every shard `failed:0` and `notRun:0`.** A shard that enumerated no tests is not a pass —
   that is what the per-shard test-count floor exists to catch.
3. **Zero net new quarantine entries.** A quarantine added mid-window to make a night green
   converts the gate into a pass-count, which is the failure mode the whole ledger exists to
   prevent.

A night failing any of these **restarts the count**. It does not pause it.

**Rule 3 is subsumed by rule 1, and it is worth knowing why.** The frozen harness set
(`scripts/compat-window-fingerprint.mjs`, `HARNESS_ROOTS`) includes
`test/deploy-tests-manifest.*.json` — the file the quarantine ledger lives in. So a quarantine added
mid-window necessarily moves the harness digest and restarts the count under rule 1 anyway. Rule 3
is not separately computable from a run ledger, and does not need to be; it stays stated because it
names the *intent* the fingerprint enforces mechanically.

**Three rules the audit script applies that this list did not state**, all strictly stricter than
the above, added when the window was first audited end-to-end (2026-08-24):

- **A short ledger is not a green night.** Rule 2 read over the shards a ledger *contains* is
  satisfied vacuously by an *absent* shard — see 2026-08-03 below, and the note further down that
  calls this a soundness hole. The audit grades `shardsSeen`/`shardsExpected` and fails closed when
  they disagree, even if the ledger's own `complete` flag claims otherwise.
- **A re-attempted run is not a qualifying night**, whatever it concluded. #545's own words: "a
  shard that needed a retry is not the same as a shard that passed, and the matrix should not treat
  them as equal."
- **A night whose ledger cannot be obtained is disqualified, never absent.** If a scheduled run's
  `compat-run-ledger` has expired, was never uploaded, or fails to download, the audit records it as
  an **unresolved night** and prints it — it does not skip the run.

  This is the rule that most directly protects the number in the table above, and it exists because
  the *absence* of a night is not neutral: the streak-builder joins the nights on either side of a
  gap, so a run that merely failed to download reports a **longer** streak than reality. That is the
  one direction that flatters us. The trigger is measured, not hypothetical — `gh run download`
  failed transiently on run `32621148829` during the review of this very audit, on an artifact that
  existed and had not expired.

  It is the same rule `scripts/compat-run-ledger.mjs` already applies to *shards* — "the expected
  shard count is DECLARED … and NEVER inferred from what arrived" — applied one level up to
  *nights*: the run list is the denominator, not the set of artifacts that happened to download.

  It fails closed, with a consequence worth knowing: the lane of an unresolved night is unknowable
  (the lane is read from the ledger, which is the thing that could not be fetched), so an unresolved
  night restarts **every** lane's count. A bun weekly that fails to download will break the node
  streak. That is the safe direction and it is the one taken — the worst case is a reported streak
  shorter than the truth.

## Nights

Every scheduled node-lane night since the window opened, disqualified ones included — *"a window log
that only records successes is not evidence."* `counts` is the audit script's verdict; the quarantine
Δ column is dropped because rule 3 is subsumed by the fingerprint (see above), so a `Δ` would be a
second, weaker restatement of the fingerprint column.

The **streak** column is what actually matters: it resets to 1 whenever the fingerprint changes.

| date (UTC) | run | fingerprint | shards | passed/failed/notRun | counts | streak |
|---|---|---|---|---|---|---|
| 2026-07-28 | `30333571518` | *(none)* | 16 | 778/0/0 | **NO** — no recorded fingerprint (pre-#574) | — |
| 2026-07-29 | `30427197358` | `55bd1c3c` | 16 | 778/0/0 | yes | 1 |
| 2026-07-30 | `30518209404` | `55bd1c3c` | 16 | 778/0/0 | yes | 2 |
| 2026-07-31 | `30609544684` | `55bd1c3c` | 16 | 778/0/0 | yes | 3 |
| 2026-08-01 | `30687194887` | `55bd1c3c` | 16 | 778/0/0 | yes | 4 |
| 2026-08-02 | `30735484416` | `55bd1c3c` | 16 | 778/0/0 | yes | 5 |
| 2026-08-03 | `30790778590` | `43349a5f` | **15** | 730/0/0 | **NO** — short ledger: 15 of 16 shards recorded; shard 16/16 lost to a runner disconnect before it ran a test | 0 |
| 2026-08-04 | `30882760738` | `8d099f93` | 16 | 778/0/0 | yes | 1 |
| 2026-08-05 | `30979973943` | `c44d5e85` | 16 | 778/0/0 | yes | 1 |
| 2026-08-06 | `31076109243` | `c44d5e85` | 16 | 778/0/0 | yes | 2 |
| 2026-08-07 | `31149348286` | `37edc694` | 16 | 778/0/0 | yes | 1 |
| 2026-08-08 | `31239550517` | `37edc694` | 16 | 778/0/0 | yes | 2 |
| 2026-08-09 | `31294965728` | `37edc694` | 16 | 778/0/0 | yes | 3 |
| 2026-08-10 | `31356989667` | `37edc694` | 16 | 778/0/0 | yes | 4 |
| 2026-08-11 | `31459242158` | `37edc694` | 16 | 778/0/0 | yes | 5 |
| 2026-08-12 | `31565302791` | `8698abc6` | 16 | 778/0/0 | yes | 1 |
| 2026-08-13 | `31669242641` | `8698abc6` | 16 | 778/0/0 | yes | 2 |
| 2026-08-14 | `31771823777` | `8698abc6` | 16 | 778/0/0 | yes | 3 |
| 2026-08-15 | `31863085065` | `8698abc6` | 16 | 778/0/0 | yes | 4 |
| 2026-08-16 | `31925582335` | `8698abc6` | 16 | 778/0/0 | yes | 5 |
| 2026-08-17 | `31993151936` | `8698abc6` | 16 | 778/0/0 | yes | 6 |
| 2026-08-18 | `32097443183` | `8698abc6` | 16 | 778/0/0 | yes | **7 ← longest** |
| 2026-08-19 | `32214131442` | `9e4ad6fe` | 16 | 778/0/0 | yes | 1 |
| 2026-08-20 | `32330221781` | `2af54202` | 16 | 778/0/0 | yes | 1 |
| 2026-08-21 | `32445502038` | `94eacb13` | 16 | 778/0/0 | yes | 1 |
| 2026-08-22 | `32550380562` | `166fdded` | 16 | 778/0/0 | yes | 1 |
| 2026-08-23 | `32616853402` | `c188961e` | 16 | 778/0/0 | yes | 1 |
| 2026-08-24 | `32688792926` | `c188961e` | 16 | 778/0/0 | yes | 2 *(open)* |

Fingerprints are the first 8 hex of the run's `windowFingerprint`; compare the **full** value, never
a prefix, when grading a night by hand (see [How to record a night](#how-to-record-a-night)).

The **bun weekly does not appear** and must not: it is a different lane, so a red bun Sunday is not
a failed node night. Its reds — `31297820716` (08-09), `31929677335` (08-16), `32621148829` (08-23),
all `775 passed / 3 failed` on shards 6 and 8 — belong to the Bun runtime-axis row in
`docs/compat-matrix.md` and to #710.

## Suite provenance — recorded, not frozen

Each run also records the `vercel/next.js` checkout commit and the resolved `next` tarball digest
(`recorded.suite`, `frozen: false`). These are **outside** the fingerprint by design: `NEXTJS_REF`
is a git *tag* resolved fresh nightly, and that checkout supplies the compat suite itself — so a
retag would move what "green" means. Folding it into the digest would make a legitimate suite bump
indistinguishable from tampering; recording it means a bump is a **visible decision**.

If the recorded suite commit changes mid-window, that is not automatically a restart — it is a
question for whoever is policing the window, and it must be answered in this file rather than
noticed later.

## What this log does not yet do

Stated plainly because the gap is the reason this file is not self-certifying:

- **CI still does not compare tonight's fingerprint to last night's.** CI fails a run that records
  *no* fingerprint; it does not detect a *changed* one. `scripts/compat-window-audit.mjs --fetch`
  now does that comparison across the whole window on demand, so the number is no longer folklore —
  but it is a **report someone runs**, deliberately exit-0 and outside CI. Making it a job that
  fails would give someone a reason to want it green, which is how a scoreboard becomes a target;
  the window's teeth stay the workflow's own fail-on-red gate. Wiring it into the nightly as a
  *reporting* step (the ledger job reading the previous scheduled run's artifact) remains the filed
  follow-up.
- **Nothing keeps this table in sync with the audit.** The script computes; a human transcribes.
  A stale table here is not detectable from inside the repo — re-run the audit before quoting it.
- **Artifact retention bounds how far back the audit can see, and it says so rather than trimming
  the window silently.** Scheduled runs before 2026-07-28 predate the `compat-run-ledger` artifact
  entirely, so `--fetch --limit 40` reports each of them as an unresolved `no-ledger` night. Those
  rows are noise for *this* window — it opened later — but they are the honest form of the limit:
  the audit is telling you which runs it could not grade. Retention will eventually do the same to
  nights that *are* in the window, and when it does, the streak will read shorter, not longer.
- **`main` has no branch protection** (#555). A mid-window merge is therefore *detectable* but not
  *preventable*. That does not make a completed window's claim false — the fingerprint would change
  and the count would restart — but it does mean the window can be restarted an unbounded number of
  times by an unreviewed merge. This is a **schedulability** risk, not a correctness one, and
  branch protection is what makes "we'll just not count that merge" non-negotiable.

## How to record a night

**The short way, and the one to prefer:** `node scripts/compat-window-audit.mjs --fetch --limit 40`
grades every scheduled night in one pass and prints the streaks and what restarted each. Transcribe
its output into the table above. The long way below is what it automates — keep it, because a
transcription you cannot check by hand is not a record.

1. Open the scheduled run, download the `compat-window-fingerprint` artifact.
2. Compare its `fingerprint` to the start fingerprint above, **exactly** — not the component
   digests, and not by eye over a truncated prefix.
3. Read the run ledger — **`complete` and `missingShards` FIRST**, then per-shard `failed`/`notRun`
   and the quarantine delta. A ledger with `complete: false` is not a night you can grade: some
   shard produced no result at all. Until #695 that shard was simply *absent* from the ledger, so
   fifteen green rows read exactly like sixteen — run `30790778590` (2026-08-03) recorded a clean
   sheet for a night whose shard 16/16 had failed, and its job log has since expired. The ledger
   now carries `shardsExpected`/`shardsSeen`, gives every missing shard a `status: "missing"` row
   with null counts, and fails the ledger job rather than emit a short one.
4. Append a row. If the night does not count, append it anyway with `counts = NO` and the reason.
   **A window log that only records successes is not evidence.**

## Two operational rules established by measurement (2026-07-29)

### The start fingerprint MUST come from CI, never a local run

The digest covers built `dist/**` bytes, so it depends on the build that produced them.

Measured, because the alternative would have been fatal: a **rebuild with no source change** moved
the digest here (`20dbd49e…` → `4e3bec22…`). If that were non-determinism the window could never
reach 14 nights, since CI rebuilds every night. It is not — two further consecutive rebuilds were
**byte-identical** (`4e3bec22…`). The first delta was a stale `dist` from earlier local work.

So: **the build is deterministic, and the window design holds** — but a local `dist` of unknown
provenance yields a different digest than CI's. Take the start value, and every nightly comparison,
from the run's own `compat-window-fingerprint.json` artifact. Never from a laptop.

### The suite exercises a different `next` than the repo ships

`NEXTJS_REF` is **not** merely the checkout ref for the test suite. `test-e2e-deploy.yml:240` does
`NEXT_NPM_VERSION="${NEXTJS_REF#v}"` and `npm pack`s that published `next` into every fixture.

As of 2026-07-29 that is `next@16.2.0`, while the repo pins **`16.2.11`** (bumped for four HIGH
advisories). **So the gate every parity claim rests on validates a version users do not get.**

This is not a defect in the fingerprint — `NEXTJS_REF` lives inside the workflow and is therefore
inside the digest, so it cannot drift silently. It is a question about what "green" should mean, and
it wants an answer **before** 14 nights start counting toward a 1.0 claim:

- keep them independent deliberately (the suite pins the compatibility target, the repo pins what it
  ships), and say so in the compat matrix; or
- move `NEXTJS_REF` to track the shipped version, accepting that each move restarts the window.

Recorded here rather than decided: moving `NEXTJS_REF` changes what the gate means, which is a
design-gate call, and it is inside the frozen set.
