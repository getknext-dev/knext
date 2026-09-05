# ISSUES_FOUND

Review of `fix/compat-gate-honesty` (`27d62c7` + `d17abd6`) vs `origin/main`, worktree
`/Users/banna/alpheya/pocs/knext-wt/rel2`. Adversarial: I re-derived the evidence from the raw
artifacts myself rather than reading the report's table.

**The headline claim survives the attack.** I downloaded the `compat-run-ledger` artifact of every
scheduled `test-e2e-deploy.yml` run and graded them with my own script (no import of
`compat-window-audit.mjs`). Independently reproduced: 32 runs in 2026-07-28 → 08-24 (28 node
scheduled, 4 bun weeklies); lane read from the ledger's own `lane` key, which
`compat-run-ledger.mjs` derives from each shard artifact's `runtime`, never from cron timing; every
node night `778/0/0` on 16 shards except 08-03 (`30790778590`, 15 rows, 730/0/0); `runAttempt: 1`
on all 28 — **zero re-runs**; longest fingerprint-stable streak **7** (08-12 → 08-18), current
**2**. Every fingerprint prefix in `window-node-lane.md`'s table matches the artifacts. The bun
failure set matches too, including `edge-compiler-can-import-blob-assets` appearing **only** on
08-02 at ledger `runtimeVersion: 1.3.14` — so the "canary-only pre-release noise" correction is
factually earned. Tests 19/19, mutation prover 2/2 caught with no residue, six compat guard suites
290/290, biome clean, no workflow / manifest / `$knextQuarantines` change anywhere in the diff. The
DO-NOT-QUARANTINE calls are right: ADR-0007 §c is explicitly the *flaky*-quarantine ledger with a
"final post-retry failure" bar (§c.2) and a shrink-to-zero direction (§c.5); moving a deterministic
runtime gap into it would launder a known red, and the Bun row stays ❌ either way.

The issues below are what did not survive.

---

## 1. `fetchLedgers` silently drops runs, and a dropped night MERGES two streaks (script)

`scripts/compat-window-audit.mjs:317-354`. Three silent skips: the artifacts API call
(`catch { continue }`, :338), the download (`catch { /* skipped */ }`, :350), and `readDir`'s
parse/shape filter (:298-308). A run that vanishes is not disqualified — it is *absent*, and
`auditWindow` then joins the nights on either side.

Both halves demonstrated, not argued:

- **The trigger is real, and I hit it on the first pass.** `gh run download 32621148829 -n
  compat-run-ledger` failed transiently for me; the artifact exists and is not expired
  (`gh api …/runs/32621148829/artifacts` → `expired=false`). It downloaded fine on retry. Artifact
  expiry gives the same silence permanently — every run before 2026-07-28 already returns no
  artifact.
- **The effect is streak inflation.** Three nights on one fingerprint, middle one red:
  `auditWindow` reports `longest = 1` with it, `longest = 2` without it.

This is the #695 defect one level up, and this repo has already written the rule against it —
`compat-run-ledger.mjs:200-206`: *"the expected shard count is DECLARED … and NEVER inferred from
what arrived — inference is the bug, since fifteen arriving shards would 'declare' fifteen and
reconcile perfectly."* The audit infers its **night** set from what arrived. Exit-0 and outside CI
does not excuse it: `window-node-lane.md` now tells readers *"the numbers below are that script's
output"* and *"Reproduce with `node scripts/compat-window-audit.mjs --fetch`"*, and
`compat-matrix.md`'s Node row cites the script by name. The trust is placed; the hole is under it,
and it points toward a longer streak — the cardinal sin the brief names.

**Fix:** reconcile the fetched ledger set against the scheduled runs `gh run list` already
returned. A scheduled run of the audited lane with no usable ledger must appear in the table as a
disqualified night (`no-ledger` / `artifact-expired`), never as an absence. Failing closed here
costs nothing — the worst case is a reported streak shorter than reality.

## 2. "byte-identical" is falsified by the table three lines above it (W6 §8, report §2)

`docs/wayfinder/w6-compat-flakiness.md` §8.2 asserts *"Three consecutive weeklies are byte-identical
— 775 passed / 3 failed, shards 6 and 8, the same three files"*, and the §8 confidence block repeats
it: *"**High** on the bun lane's determinism in shard-and-file: three byte-identical consecutive
runs."* Its own table in the same section records `app-dir/app-static` as `timeout, 4 cases`
(08-09) / `timeout, 5 cases` (08-16) / `timeout, 4 cases` (08-23).

Confirmed against the ledgers: 08-09 and 08-23 are case-for-case identical; **08-16 is not** — it
carries a fifth failing case, `should cache correctly handle JSON body`, that neither of the others
has. The report's §2 row *"08-23 · identical to 08-16"* and *"The last three runs are
byte-identical"* are wrong for the same reason.

Two reasons this matters rather than being a wording nit. First, a document written to be the honest
evidence trail contradicts itself in the same section. Second, it is inconsistent in a direction: the
audit treats **one** appearance in four of `edge-compiler-can-import-blob-assets` as material enough
to overturn a matrix cell, then calls runs that differ by a whole failing case "byte-identical".
File-and-shard determinism is solidly established and is all the DO-NOT-QUARANTINE call needs — say
that, and drop "byte-identical".

`docs/compat-matrix.md` is fine here and should be the model: it says *"the same shape"*, enumerates
exactly what is identical (`775/3`, `failed=1` shard 6, `failed=2` shard 8, `runAttempt: 1`) and
writes *"timeout (4–5 cases)"*.

## 3. The restart arithmetic does not match the script it says produced it

- *"the harness fingerprint moved **9 times** in 27 nights"* (report §7, W6 §8.4,
  `window-node-lane.md`). It moved **10** times: 11 distinct fingerprints across the 27
  fingerprinted nights. 9 is the count of *streak restarts attributed to a fingerprint change*; the
  08-03 move (`55bd1c3c` → `43349a5f`) is booked to the lost shard instead.
- `window-node-lane.md`'s *"restarts across 27 nights | 10 — 9 by fingerprint change, 1 by a lost
  shard"* is not what the script prints either: run against the real ledgers it reports **8**
  `fingerprint-changed` restarts and **2** `night-disqualified` (07-28 pre-fingerprint, 08-03). The
  file states these numbers are the audit's output.
- *"31 runs (27 fingerprinted node nights, 1 pre-fingerprint node night, 4 bun weeklies)"* sums to
  **32**, and W6 §8's evidence list enumerates 32 run IDs.

Directionally neutral, but this is a measurement document whose authority is arithmetic.

## 4. The prescribed remedy is narrower than the measured cause

Both docs and the report land on *"a ~2-week freeze on anything that changes the packed `dist/**`
bytes."* I attributed all 10 fingerprint moves from the ledgers' own
`windowFingerprintComponents`: `packed` moved on 8 of them, `harness` on 6 — and **two moves were
`harness`-only with `packed` unchanged** (08-03 `30790778590`, 08-07 `31149348286`). A freeze scoped
to the packed closure would not have prevented either. The freeze has to cover the whole
`HARNESS_ROOTS` set — `.github/workflows/test-e2e-deploy.yml`, `scripts/e2e-*`,
`test/deploy-tests-manifest.*.json` — which is also why the merge-cadence framing is right: the
7-night stretch does line up exactly with the quiet week for both components.

## 5. Minor: `met` reads `longest`, `shortfall` reads `current` (`compat-window-audit.mjs:257-258`)

A completed 14-night window followed by reds prints `GATE MET`. That is arguably correct — the
credential is granted by a completed window and revoked by the matrix's own flip-back policy — but
the two fields answer different questions under one verdict line. Worth one comment saying which is
intended.

---

## Verified / not verified

Verified myself: the 32-run ledger set and every number derived from it (lane, attempt, shards,
counts, fingerprints, streaks, bun failure files + kinds + case names); ADR-0007 §c against the
quarantine calls; `RUN_ATTEMPT` plumbing (`test-e2e-deploy.yml:1584`) **and** its guard
(`tests/compat-shard-flake-attribution.test.ts` `REQUIRED_STEP_ENV_KEYS`), so the rerun rule does
not fail open; the diff touches no workflow, manifest or quarantine entry; 19/19 + 2/2 mutations +
290/290 guards + biome.

Not verified: the report's *"full `tests/` suite: 10 failures, all pre-existing and environmental"*
— I did not run the full suite or the pristine-`main` comparison it rests on. Items 1–5 above are
independent of it.

**Blocking: 1 and 2.** 3 and 4 are corrections to text that is presented as measurement; 5 is a
comment.

---

# Round 2

**APPROVE**

`fix/compat-gate-honesty` at `6574d5a` (fix commits `28607dd` + `6574d5a` on top of the round-1
`d17abd6`), worktree `/Users/banna/alpheya/pocs/knext-wt/rel2`. Adversarial again: I re-proved
finding 1 with **my own** script rather than the implementer's prover or tests, and re-ran the
audit live against the repo today instead of trusting the quoted blocks.

## 1 — dropped run / streak merge: **fixed, and proved in both directions**

I wrote an independent prover (imports only `auditWindow` / `fetchLedgers` / `readLedgerDir`,
no test-file or prover reuse). 13/13 pass, including the control that shows the old shape was
wrong:

- **The flattering half is closed.** Three consecutive greens on one fingerprint = streak 3.
  Replace the middle with an unobtainable ledger: **`longest = 1`**, three nights still graded, the
  night reported under `unresolvedNights`. The pre-fix shape — the night simply *absent* — still
  reports **2**, so the bridge was real and is now gone. Same protection holds on the bun lane.
- **The gap is explicit, not a hard-fail-only story.** Injecting each failure mode into a fake `gh`:
  6 runs in, 6 entries out, reasons `artifact-api-unreachable` / `artifact-download-failed` /
  `artifact-expired` / `no-ledger` / `ledger-unreadable` / real ledger. Nothing leaves as nothing.
- **The retry does not soften rule 5.** A permanently-failing read consumed all 3 attempts and was
  still recorded unresolved. The only exclusion left is `status !== completed` — time, not evidence.
- **`--dir` mode hard-fails.** `readLedgerDir` throws on unparseable JSON *and* on a shardless file;
  the CLI exits **1** with the exception reaching the operator, deliberately uncaught in `main`.
- The `lane: null` decision is the right one: an unresolved night's lane is exactly what was not
  read, so it restarts *every* lane. Fail-closed, worst case a shorter streak than reality.

Their prover independently: **5 caught, 0 undetected**, `{"declared":5,"run":5}`, exit 0, baseline-
green check first, exit-code-only verdicts, re-verified green after each restore, `git status` clean
(no residue). `tests/compat-window-audit.test.ts` **38/38**.

## 2 — "byte-identical": **fixed in all three places**

Gone from W6 §8.2, from §8's confidence block, and from `compat-matrix.md`'s node row (the stray
"byte-for-byte the same shape"). All three now claim determinism at **shard and file** and state the
08-16 exception by name (`should cache correctly handle JSON body`). The consistency argument is
recorded in the doc itself. Two surviving `byte-identical` hits in W6 (:21, :212) are **pre-existing
and unchanged by this diff**, both in sections explicitly frozen to their original window, and :212
is scoped to "shard/pass/fail shapes", which is true.

## 3 — restart arithmetic: **now emitted by the script, and it reproduces**

I re-ran `node scripts/compat-window-audit.mjs --fetch --limit 40` live (exit 0, 40 runs fetched,
zero transients this pass). Byte-compared the doc-quoted blocks against that output:

| quote | result |
|---|---|
| `window-node-lane.md:41-42` | **exact match** |
| `w6-compat-flakiness.md:495-496` | **exact match** |
| `w6-compat-flakiness.md:524-531` (8 attribution lines) | **exact match** |
| `window-node-lane.md:68-70` | matches, but see nit below |

`31 runs` → `32` everywhere (28 node + 4 bun; my own count of the raw ledgers: 28 node, 4 bun, 8
unresolved). `9 moves` → `10 moves / 11 distinct`. `9 by fingerprint change, 1 by lost shard` →
`8 fingerprint-changed, 2 night-disqualified`, which is what the instrument prints. The 36-vs-28
denominator is explained in both docs rather than papered over.

## 4 — remedy: **widened, and my own attribution reproduces theirs exactly**

I recomputed the component attribution from the raw ledger JSON with my own code, not the script:
**10 moves, `harness` 5 / `packed` 8**, single-component moves `30790778590` (harness),
`31149348286` (harness), and five `packed`-only — identical to the script's output, line for line.
Their pushback on my round-1 "harness on 6" is **correct**: `30333571518` carries
`windowFingerprintComponents: null`, so a move measured against it attributes a change against
nothing. My 6 was the artifact; 5 is right. The two harness-only moves — the load-bearing part —
are unaffected. Every statement of the remedy (`window-node-lane.md:75`, W6 §8.4,
`compat-matrix.md`'s node row, report §7) now names the whole frozen set incl. `HARNESS_ROOTS`.

## 5 — met / shortfall: **kept, documented, and made unmisreadable**

The divergence is now a comment on the return value stating which question each field answers.
Executed the state I was worried about (14 nights, then a fingerprint move):

```
GATE MET — a window of 14 qualifying nights completed (1 → 14). The CURRENT streak is 2 / 14; re-earning it from here needs 12 more.
```

Guarded by `tests/compat-window-audit.test.ts:293`. It can no longer be read as "green right now".

## The claims about what was NOT done

Verified from the diff, not the report: `git diff --name-only origin/main..HEAD` touches **no**
`.github/workflows/**`, **no** `deploy-tests-manifest*`, **no** quarantine file, and
`$knextQuarantines` appears **zero** times in the non-markdown diff body. The DO-NOT-QUARANTINE
calls stand, now resting on a correctly-stated determinism claim.

## Headline numbers — unchanged, re-derived from today's live fetch

Longest **7 / 14** (`31565302791` → `32097443183`, `8698abc6`), current **2 / 14**
(`32616853402` → `32688792926`, `c188961e`), **26 of 27** fingerprinted nights at `778/0/0`
(the 27th, `30790778590`, is the 15-of-16 short ledger), `runAttempt: 1` on all 28 node ledgers —
**zero re-runs**. `GATE NOT MET — 12 more`. The fixes changed trustworthiness, not values, which is
what was asked.

Also green: `biome check --diagnostic-level=error` on all three changed source files; the six
sibling guard suites **288/288** (none of those six files is touched by this round's diff, so the
290→288 delta is a round-1 counting difference, not a removal).

## Two nits, neither blocking, neither in a flattering direction

- `window-node-lane.md:67-71` fences the attribution as script output but includes only 3 of the 8
  lines, dropping the five `packed ONLY` rows with no ellipsis — in a round whose own commit
  `6574d5a` is titled *"a block presented as verbatim output must be verbatim"*. The omission
  strengthens nothing and the header line (`harness 5, packed 8`) is kept, so it is a consistency
  nit; W6 quotes all eight.
- `window-node-lane.md:32` reads *"the 27th executed no test"*, but that night recorded 730 passed —
  it was one **shard** that ran no test. Line 155 states it correctly. **Pre-existing**, unchanged
  by this round (confirmed against the diff).

## Not verified

Unchanged from round 1 and untouched by these fixes: the report's *"full `tests/` suite: 10
failures, all pre-existing and environmental"*. I did not run the full suite or the pristine-`main`
comparison. Findings 1–5 are independent of it.
