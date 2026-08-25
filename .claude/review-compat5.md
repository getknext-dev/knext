# ISSUES_FOUND

Adversarial review of PR #848, `fix/compat-honesty-gate` @ `8a805bb`.

**Headline: the argument survives, the numbers mostly survive, and four statements do not.**
I re-derived every load-bearing figure from the GitHub API and the raw `compat-run-ledger`
artifacts rather than from the report's tables. The survivorship attack the brief flags **fails** —
the denominator is clean. The two-independent-sources claim **succeeds** — they are one source.
Three published figures are wrong or self-contradictory, and the tip commit ships 978 lines of
machine-generated cache into the repo root.

The guard is not decoration: **7/7** mutations red it, including two I wrote myself.

---

## BLOCKING

### B1 — `8a805bb` commits 978 lines of Vite SSR-transform cache to the repo root

`DlmvdBjTqJS8cyZMNX2T5/client/{22ff7f1…,770c3ed…,cab2ad2…,deaa5ac…,e2924c8…,f4be5e5…}` — six
machine-generated `__vite_ssr_*` transform-cache files, added by the tip commit, whose message
declares only *"docs: link the fingerprint-churn successor issue (#850)"*. They are not
gitignored (`git check-ignore` exits 1), nothing in the repo references the directory, and they
embed **mirrored copies of repo script source** — `scripts/scan-mutation-residue.mjs` plus the
`MUTATION_MARKER` / `assertAnchorOnce` / `UNCONVERTED_GUARD_TRIAGE` / `scanForResidue` modules.

This repo's own workflow rule says a stale duplicate later read as authoritative is a correctness
hazard, not tidiness. It also embeds this machine's pnpm store layout.

Reproduce:
```
git -C <wt> log --oneline --all -- DlmvdBjTqJS8cyZMNX2T5      # only 8a805bb
git -C <wt> check-ignore -v DlmvdBjTqJS8cyZMNX2T5/client/e2924c856f4e1566b0f1adbaff216b2f2456a8ab; echo $?   # 1
```
**Fix:** `git rm -r --cached DlmvdBjTqJS8cyZMNX2T5` and add an ignore rule; the commit message
already describes the intended one-file change.

### B2 — "778 passed / 0 failed on **28 of 28** ledgered nights" is false, and the doc contradicts it 58 lines later

`docs/release/compat-honesty-gate.md:92-93` (discriminator 2) and again `:160` (#545 AC table).

Run `30790778590` (2026-08-03, node, in-window, **ledgered**) recorded **15 shards, 730 passed**,
not 778 across 16 — the doc says exactly that itself at `:150-151`, and `docs/compat-matrix.md:49`
already publishes the correct shape: *"green on **26 of the 27 nights**"*.

Re-derived from the ledgers (28 in-window node runs): 27 at `778/0/0`, one at `730/0/0` with
shard 16/16 absent. `failed: 0` **is** 28 of 28; `778/0/0` is 27 of 28.

Reproduce — download every retained `compat-run-ledger` and sum:
```
gh api repos/getknext-dev/knext/actions/runs/30790778590/artifacts --jq '.artifacts[]|select(.name=="compat-run-ledger").id'
# unzip → .shards has 15 entries (1/16…15/16), sum(passed)=730, sum(failed)=0
```
**Fix (one line, twice):** "`failed: 0` on 28 of 28 ledgered nights, at the full 778/0/0 on 27 of
28 — the 28th lost shard 16/16 to a runner disconnect (below)."

### B3 — "asserted **twice, independently**" — the two sources are one source

`docs/release/compat-honesty-gate.md:145-147`.

`.github/workflows/test-e2e-deploy.yml:1584` sets `RUN_ATTEMPT: ${{ github.run_attempt }}`;
`scripts/compat-run-ledger.mjs:517` writes it straight through as `runAttempt`. The ledger field
**is** `github.run_attempt` — the same GitHub-maintained counter the REST API returns as
`run_attempt`. One fact, two transports.

It is worse than merely redundant: the ledger reading is strictly **weaker**. An attempt-1
artifact reports `1` whatever happened afterwards, so it cannot detect a re-run that the API
would. The corroboration runs one way only.

The conclusion is unaffected — I verified `run_attempt == 1` on **all 72** scheduled runs of
workflow `300291864`, with zero above 1 — but that rests on the API alone.

**Fix:** drop "independently"; say the API reading is authoritative and the ledger corroborates it
at write time.

### B4 — the residual restart count contradicts itself within three lines

`docs/release/compat-honesty-gate.md:165` says *"9 restarts in 27 nights"*; `:167` says
*"10 restarts"*.

Independently derived from `windowFingerprint` across every retained ledger, node lane only:
**27 fingerprinted nights, 11 distinct fingerprints, 10 restarts, longest streak 7**
(`sha256:8698a…`, 2026-08-12 → 08-18). Ten is right, and it is what `:167`, issue #850,
`docs/compat-matrix.md:49` ("10 observed moves") and `public-release-readiness.md` all say. `:165`
is the sole outlier — a leftover from the prior analysis that #850 explicitly reconciles.

**Fix:** `:165` "9 restarts" → "10 restarts".

---

## NON-BLOCKING (should fix before this is cited as the record)

**N1 — two of #545's acceptance criteria are marked "met" that are not met as written**
(`:159-160`). AC3 says *"fixed **or** quarantined with an upstream ref"*; the round did neither —
it documented and deliberately declined to quarantine. AC5 says *"sustains a green streak long
enough to make the v1.0 gate reachable — the roadmap's bar is 14 consecutive"*; the longest is 7
and the gate is unreachable, which is the entire reason #850 exists. The `:160` hedge
("met on the flake question") is honest, the word **met** in the same cell is not. The closure
recommendation survives either way — mark both *"not met as written, deliberately"* with the
one-line reason and the #850 pointer. This is the brief's "met-in-spirit" trap, and it is the one
place the doc walks into it.

**N2 — the ADR-0007 §c.2 citation reads the rule backwards** (`:118`). §c.2
(`docs/adr/0007-compat-suite.md:458-460`) is an *evidence floor*: "at least one FINAL post-retry
failure, observed — retry-then-passed wobble does NOT qualify." A deterministic red clears that
floor trivially; §c.2 does not exclude it. The support for "don't quarantine a permanent runtime
gap" is §(c)'s **scope** — it is the *flaky*-quarantine ledger — plus §(d)'s family bar. Right
call, wrong citation.

**N3 — "86 tracked CI/script files" is stale by exactly the exclusion this round added**
(`:195`; also `.claude/impl-compat5-report.md:97`). Re-derived from the guard's own
`shapeScanFiles()`: **75** CI/script files + `docs/compat-matrix.md` = **76**. There are exactly
**11** tracked `scripts/mutation-prove-*.mjs`, and 75 + 11 = 86 — the figure is the pre-`PROVER`
count, never updated after the self-scan fix. A count that cannot be reproduced is the finding.

**N4 — the `app-static` union list reads as recurrent** (`:68-73`). It flags the 08-16-only fifth
case but not that 08-02 carries only three of the other four. One clause.

**N5 — the impl report states the #710 discriminator in a form the shipped doc correctly retracts**
(`.claude/impl-compat5-report.md:41`: "`kind: timeout` at exactly 60000 ms is a per-*case* hang").
See below — the doc is fine, the report is not, and the report is committed.

---

## The #710 discriminator, attacked as instructed

**`kind: timeout` at 60000 ms does not do the work claimed for it, and it is not even stable.**
Pulled from the raw ledgers, the `kind` swaps run-to-run for the same file:

| run | `app-static` | `parallel-routes-root-param-dynamic-child` |
|---|---|---|
| 30738274907 (08-02) | `assertion` (3) | `timeout 60000` (7) |
| 31297820716 (08-09) | `timeout 60000` (4) | `assertion` (2) |
| 31929677335 (08-16) | `timeout 60000` (5) | `assertion` (2) |
| 32621148829 (08-23) | `timeout 60000` (4) | `assertion` (2) |

To the PR's credit this **is** disclosed, at `compat-honesty-gate.md:107-111`, and it reproduces
exactly. So the doc is honest; the committed impl report is not (N5).

**The discriminator that actually holds is structural, and it is stronger — lead with it.** On
every bun red the shard reported a *complete accounting*: `expectedTotal` met, `truncated: false`,
`status: "reported"`, 47–48 passed alongside the failures. `30790778590` produced **no shard-16
entry at all**. Infrastructure loss is *absence*; this is *complete-but-red*. That distinction is
in the data, needs no interpretation of a timeout constant, and survives the `kind` alternation
that sinks the stated version.

---

## Verified by RUNNING

**The survivorship attack fails — the denominator is clean.** 136 runs of workflow `300291864`
today (135 when written), 72 scheduled (71 when written). In 2026-07-28 → 08-24 there are
**exactly 32** scheduled runs — 28 node nightlies + 4 Sunday bun weeklies — and **all 32 retain a
ledger**. The retention boundary is sharp at 07-28: every scheduled run from 07-28 on has one,
every run before has none (39 of 72). So "0 flakes across 32" ranges over *every* run in the
window, not the survivors. The report's scoping is honest and its NOT-ESTABLISHED section states
the pre-07-28 gap correctly.

- `run_attempt == 1` on all 72 scheduled runs; `runAttempt == "1"` in all 33 ledgers.
- Node lane: 0 shards `failed > 0`, 0 `notRun`, 0 `truncated` across all 28 in-window nights.
- Bun: 4/4 red on shards 6+8 (+16 on 08-02 only), same three files, `runtimeVersion 1.3.14`.
- Job-level 6/6: `30193384289` and `29678368535` each failed exactly `Deploy tests (shard 6/16)`
  and `(shard 8/16)` on step `Fail shard on red results (revocation teeth)`.
- Fingerprints: 27 nights / 11 distinct / 10 restarts / streak 7. (07-28's ledger carries no
  `windowFingerprint` — that is what makes it 27 nights across 28 ledgers.)
- #850 is OPEN and states the claimed figures verbatim, including the 5-of-10 packed-only split,
  which reconciles with `compat-matrix.md`'s "8 of 10 packed, 5 harness, 2 harness-only".
- #710 is OPEN with automated comments on 08-16 and 08-23 — the weekly re-post claim holds.

**Guard bites — 7/7, independently proved.** My own harness
(`independent-mutation-prove.mjs`, written from scratch, not the PR's prover):

1. **Harness proves it sees red first** — a deliberately failing canary spec, exit `1`.
2. Baseline unmutated guard exit `0`.
3. M1 reinstate the `ci.yml` stale pointer → RED. M2 same in `compat-smoke.mjs` → RED.
   M3 weekly bun cron moved → RED. M4 nightly node cron moved → RED. M5 workflow display name
   blanked → RED.
4. **M6 (reviewer-original)** — invent a brand-new `compat-suite-nightly-node` token in a scanned
   script → **RED**. This is the one that matters: it proves the shape scan catches a name no
   allowlist could have anticipated, which is the PR's central claim about the guard.
5. **M7 (reviewer-original)** — a destination-less deflection carrying *no* `compat-suite-*` token,
   so only check (3) can fire → **RED**. Check (3) bites independently of check (2).

Every verdict branched on the runner's **exit code**. Each anchor asserted to occur **exactly
once** or abort; no `perl`. Restores verified byte-identical by sha256, `git status --porcelain`
clean after every mutation and at the end, residue grep for `compat-suite-nightly-node` clean.
The PR's own prover also re-ran here: 5/5 red, exit 0, tree clean.

**Local suite noise, not a PR defect.** `tests/mutation-residue-scan.test.ts` failed 2 tests under
parallel load (5 s timeout on a fixture `git commit`); it exits 0 in isolation both with and
without `commit.gpgsign=true`. Matches what the report already discloses.

## Read, not run

ADR-0007 §(c)/§c.2/§(d) text, `docs/compat-matrix.md` prose, `docs/compat/upstream-bun-sandbox-fetch-bug.md`
(existence only, 36 KB unread), the `public-release-readiness.md` wording.

**Claim 3 holds on the documents.** `compat-matrix.md:49` states in terms *"this ✅ is the **Node**
claim only"*; `:50` is ❌ with *"No green `runtime=bun` run has been observed"*. Nothing in the
matrix makes a claim #710 would falsify, and the matrix already says the v1.0 gate is not met.
"Not a release blocker" is correct.

---

## Verdict

The reasoning is sound and the recommendation to close #545 with #850 as successor is right —
closing it without #850 genuinely would have dropped the only live problem, and I confirmed #850
carries it. **B1–B4 block**: one is a repo-hygiene regression shipped under a docs commit message,
and three are wrong or self-contradictory statements in the document whose entire product is
correct statements about this project's compatibility record. All four are one-line fixes.
