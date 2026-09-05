APPROVE (current, round 3 @ 74dbf78 — rounds 1 and 2 were ISSUES_FOUND; history kept below)

_Round 1 verdict: ISSUES_FOUND._

# Code review — PR #806 (`ci: pin bun to 1.3.14`)

## What I verified (all clean)
- **Diff is exactly the five pins + comments.** `origin/main...origin/fix/pin-bun-version` =
  1 file, `.github/workflows/ci.yml`, +30/−5. No other file, no code change.
- **YAML is valid and the value is a quoted string.** Parsed the branch's `ci.yml` with a real
  YAML loader: 21 jobs, 5 `setup-bun` steps, every one `{"bun-version":"1.3.14"}` (string, not
  `1.3.14` bare → no float coercion risk). Jobs: `compat-smoke` (if `matrix.runtime == 'bun'`),
  `bun-exec-hardcap`, `vinext-precompile-closure`, `bun-exec-alpine-image`,
  `compile-cache-bun-probe`. The multi-line comment continuation landed at valid indentation at
  all five sites.
- **No surviving unpinned bun site in `.github/workflows/`.** Grepped both directions — every
  `oven-sh/setup-bun` occurrence on the branch is one of the 5 ci.yml sites,
  `test-e2e-deploy.yml:643` and `bun-sandbox-fetch-ab.yml:67`; **no setup-bun step lacks a
  `bun-version` key** (the loader confirms, not just grep). No other bun install path
  (`bun.sh/install`, `oven/bun` base image, `bun upgrade`) exists in CI. Action itself stays
  SHA-pinned.
- **The comment's factual claims hold.** Run 32381429220 (14:39Z, `feat/fm-slow-dependency-timing`)
  failed **only** `compile-cache diagnostic under real bun (#309)`, with
  `AssertionError: expected '/tmp/knext-309-healthy-cache-…/v1.4.0-x86_64-34cbb9a40-1001' to be
  null` — i.e. Bun **1.4.0**, probe returns a path for a healthy dir, exactly as described.
  `main`'s 11:32Z run was green. `#754` (pin the toolchain) and `#807` (Bun 1.4 compat) are both
  open and correctly scoped; the `#188` dispatch knob is where the comment says it is
  (`test-e2e-deploy.yml:62-66` input, `:660` setup-bun fallback).
- **Consistency:** `1.3.14` matches `test-e2e-deploy.yml:660` and `bun-sandbox-fetch-ab.yml:69`.
- **Security rules:** no secrets, no `:latest` image, no shell-building, no endpoint surface. N/A.
- **PR CI:** the previously-red `compile-cache diagnostic under real bun (#309)` job is green on
  this branch; no failing checks.

## Issues

1. **`.github/workflows/ci.yml` (all five sites) — no guard test; the pin is enumerated, not
   scanned.** There is *no* test anywhere that asserts bun is pinned in `ci.yml`
   (`git grep bun-version -- tests/` returns only `#188`/`test-e2e-deploy.yml` assertions), and no
   actionlint/yamllint step. So the exact regression this PR exists to prevent is unguarded:
   a sixth `setup-bun` step added tomorrow with `bun-version: latest` — **or with the key omitted
   entirely, which also means latest** — reds nothing. This repo already does the analogous thing
   for the same drift class (`tests/release-action-pins.test.ts` asserts pin *form and scope*;
   `tests/compile-cache-health-bun-ci.test.ts:71` already asserts this very job's setup-bun is
   SHA-pinned, and is the natural home for a one-line sibling). `workflow.md` states the rule
   directly: *"prefer scanning to enumerating — an enumerated list of call sites is how the second
   one gets missed; make an unparseable construct fail."* A scanning test over every
   `.github/workflows/*.yml` setup-bun step (`bun-version` present AND not `latest`/`canary`,
   allowing the documented `${{ inputs… || 'x.y.z' }}` fallback form) is cheap and mutation-provable
   by deleting one pin. **Why it matters:** without it, this fix has a half-life of one PR, and the
   next drift is again discovered by a red lane rather than by a gate.

2. **`.github/workflows/test-e2e-deploy.yml:66` — the dispatch path still floats, so "the e2e
   workflows were already pinned" is only true for the schedule.** The `bun-version` input is
   `default: 'latest'`, and on `workflow_dispatch` GitHub materialises input defaults — so
   `github.event.inputs.bun-version` is the string `latest` and the `|| '1.3.14'` fallback at
   `:660` never applies. Every **manually dispatched** compat/e2e run from now on gets 1.4.0. That
   is the lane knext gates parity claims on, and a manual dispatch is precisely how a re-baseline
   is run. Out of this PR's diff, but it is the same `#754` drift and the PR body asserts it is
   already handled. Either flip the default to `'1.3.14'` (which requires updating
   `tests/compat-suite-workflow.test.ts:2812-2821`, whose assertion *pins the default to `latest`*)
   or say explicitly in `#807`/`#754` that the dispatch path is intentionally floating.

3. **`.github/workflows/ci.yml:268` (and the four copies) — "redding every branch's run within
   hours" overstates the measurement.** Exactly one red is attributable to 1.4.0 (run
   32381429220). The four earlier reds that day on the same branch (11:54, 12:16, 12:27, 13:35)
   failed `Lint & Test`, not the bun probe — unrelated. The load-bearing fact ("`latest` floated
   under us and the probe shape changed") is fully supported; the "every branch, every lane"
   framing is not, and this repo's standing rule is to re-read claims against the measurement.
   Trim to what was observed. Minor, but it is a comment future readers will treat as evidence.

4. *(nit)* The identical six-line block is duplicated verbatim at all five sites, including the
   compile-cache-probe-specific rationale in `bun-exec-hardcap` / `bun-exec-alpine-image` /
   `vinext-precompile-closure`, where the probe had nothing to do with the pin. One full block at
   the first site plus `# PINNED — see the compat-smoke setup-bun step (#754)` elsewhere would
   drift less. Not blocking.

## Test quality
No tests were added or changed, and none exist to weaken — which is the finding: a CI-config
change whose entire value is *staying* pinned ships with nothing that fails when it stops being
pinned, in a repo that guards the neighbouring line (setup-bun's SHA) with a test.

---

# Round 2 — db0341c (`the pin gets a scanning guard; the dispatch default follows the pin`)

**Verdict: ISSUES_FOUND** — one substantive (a ~6-line fix), the rest small. All four round-1
items are genuinely fixed; the guard is real and I re-proved it independently rather than taking
the mutation claim on trust.

## Verified, not assumed

- **Diff scope:** `63ac70c..db0341c` = `ci.yml` (−26 comment lines), `test-e2e-deploy.yml` (1 line),
  `tests/bun-version-pins.test.ts` (new, 69), `tests/compat-suite-workflow.test.ts` (assertion
  inverted). No production code. ci.yml still parses (7 setup-bun steps repo-wide, all pinned).
- **I re-ran the scanner's logic over mutated copies of the real workflows** (extracted verbatim
  into `/tmp`, repo untouched). **Seven mutations, seven detections, zero false-greens:**
  `latest`; `canary`; the key deleted at four sites (`version: null` → flagged as
  omitted-equals-latest); a brand-new setup-bun step with **no `with:` block at all**; a partial
  `1.3`; an expression value `${{ env.BUN_VERSION }}`; and the shape I specifically went looking
  for — an unpinned setup-bun step followed by a `- run:`-first step (which the boundary regex
  `^\s*-\s+(name|uses):` does *not* match) and then a pinned setup-bun step, i.e. the case where
  the walk could run on and adopt a *later* step's pin. It is caught, because the walk breaks on
  the second `- uses:`. Good.
- **The guard-bug fix the lead flagged is real and load-bearing.** The unmutated scan reports
  `test-e2e-deploy.yml:643 -> ${{ github.event.inputs.bun-version || '1.3.14' }}` — i.e. the step
  whose pin sits **16 lines of rationale below** its `uses:` line is found. A fixed 15-line window
  would have reported it as unpinned; the walk-to-step-boundary fix is what makes the scan honest
  on this repo's actual comment density.
- **The compat-suite inversion is a proper both-halves pair**, not a flipped boolean: it asserts
  the default is **not** latest/canary AND that it **matches** `x.y.z`. Deleting the pin fails the
  second; setting `latest` fails the first.
- **Comment dedup + overclaim trim are correct:** one full rationale at `ci.yml:268`, four short
  pointers naming the guard file, and the claim is now "the first lane to run after the release
  went red while main's morning run (1.3.14) passed" — which is exactly what run 32381429220 and
  main's 11:32Z run show. Round-1 item 3 closed.

## Issues

1. **`tests/bun-version-pins.test.ts:15-18` — the docstring's cross-file promise is only half
   true, so the fallback form's other half is unguarded in `bun-sandbox-fetch-ab.yml`.** The
   scanner deliberately accepts `${{ github.event.inputs.bun-version || 'x.y.z' }}`, on the stated
   ground that "the INPUT's default must itself be a pin (workflow_dispatch materialises defaults;
   **asserted in compat-suite-workflow.test.ts**)". That assertion reads
   `test-e2e-deploy.yml` **only** (`WORKFLOW_PATH`, line 105). The *other* fallback-form site,
   `bun-sandbox-fetch-ab.yml:67`, takes its value from an input declared at `:38-41` whose
   `default: '1.3.14'` **is asserted nowhere** — `tests/bun-sandbox-fetch-ab-workflow.test.ts`
   contains zero `bun-version`/`default` assertions (grepped). So flipping *that* default to
   `latest` reintroduces exactly the drift this PR exists to stop, and **both** new guards stay
   green: the scanner sees the accepted `||` form, and the compat test never looks at that file.
   This is the round-1 finding relocated one file to the left, and it is this repo's recurring
   "guard asserts one half" shape. **Fix inside the new test** rather than by adding a third
   cross-file promise: when a step's value matches `FALLBACK_RE`, resolve the referenced input in
   the *same file* and assert its `default:` matches `PIN_RE`. That makes the guard self-contained
   and kills the docstring's dependency on a test in another file.

2. **`docs/compat-matrix.md:50` is now stale, and no test catches it.** The Bun-axis row still
   reads "A `bun-version` `workflow_dispatch` input (string, **default `latest`**; dispatch-only —
   **the weekly schedule always runs `latest`**)". After db0341c the default is `'1.3.14'`, and the
   second clause has been wrong since the #187 follow-up pinned the fallback — the weekly runs the
   pin, not `latest`. `compat-matrix.md` is the repo's single source of truth for which rows are
   really gated, `tests/compat-matrix.test.ts` asserts nothing about this sentence, and
   `workflow.md` step 5 puts docs inside delivery. Two-line fix; leaving it means the doc actively
   contradicts the workflow it describes.

3. **`tests/bun-version-pins.test.ts:20 — `WF_DIR = '.github/workflows'` is CWD-relative**, against
   an explicitly-documented repo convention. Every sibling guard uses
   `REPO_ROOT = resolve(import.meta.dirname, '..')` (`action-pin-sha-tag-nightly.test.ts:57`,
   `blank-non-code.test.ts:26`, `anonymous-install-path.test.ts:68`, …), and `vitest.config.ts:44`
   spells out why: "Absolute so a project run from a sub-directory (e.g. `cd apps/docs && vitest`)
   still resolves … not a non-existent CWD-relative one." This fails loudly (ENOENT) rather than
   false-green, so it is low severity — but it is one line and the repo already paid for this
   lesson once.

4. **`tests/bun-version-pins.test.ts:54` — the non-vacuity floor is `>= 5` while the true count is
   7.** The two sites that can go missing are precisely the two hardest to detect (the fallback
   form behind long comment blocks); a future tweak to the `uses:` regex could drop both and the
   vacuity check would still pass at 5. Assert the exact count, or better, per-file expectations
   (`ci.yml` 5, `test-e2e-deploy.yml` 1, `bun-sandbox-fetch-ab.yml` 1) so a *disappearing* step is
   as loud as an unpinned one.

5. *(nits, not blocking)* (a) The scan covers `.github/workflows` only — a composite action under
   `.github/actions/**` calling setup-bun would be invisible; none exists today, so widening the
   read is cheap insurance. (b) Nothing ties `test-e2e-deploy.yml`'s input default (`'1.3.14'`) to
   the same step's fallback pin (`'1.3.14'`); they can drift to two different pins without
   tripping anything. Both are pins, so no float — a single-source assertion would just be tighter.
   (c) `docs/adr/0007-compat-suite.md:127` still shows `with: { bun-version: 'latest' }` in an
   example block; historical ADR text, correctly out of the scanner's scope, but it is a live
   copy-paste source.

## Test quality (round 2)
Materially better than round 1's "none". The new scanner is a genuine scan — it fails on the quiet
form (omitted key), on `latest`/`canary`, on partial versions, on expression values, and on a
newly-added step; I independently mutation-proved all of that, and its non-vacuity assertion means
it cannot pass by finding nothing. The compat-suite edit inverts an assertion for a stated,
defensible reason and keeps both halves. The one gap is that the scanner's own permissive branch
(the `||` fallback) leans on an assertion that covers only one of the two files using it.

---

# Round 3 — 74dbf78 (guard self-contained; matrix row restored)

**Verdict: APPROVE** — both round-2 blockers are closed and I re-proved them independently. Two
non-blocking nits and one merge-gating observation below; none needs another round.

## Verified by mutation, not by report

I re-extracted the round-3 scanner over copies of the real workflows (repo untouched) and mutated
the *new* code path — the in-file input-default resolution:

| Mutation | Result |
|---|---|
| `bun-sandbox-fetch-ab.yml` input default → `latest` | **RED** (`…:67 … [def=latest]`) |
| `test-e2e-deploy.yml` input default → `latest` | **RED** |
| sandbox default → `canary` | **RED** |
| sandbox default → `1.3` (partial) | **RED** |
| sandbox `default:` line deleted entirely | **RED** (see nit b) |
| a whole pinned ci.yml setup-bun step deleted | **RED via the per-file count** (`ci.yml: 4 ≠ 5`) |

So round-2 item 1 is genuinely closed **at the site that was unguarded** — `bun-sandbox-fetch-ab.yml`'s
default is now load-bearing, which is the specific thing I could not say last round — and item 4's
exact per-file map (5/1/1) really does make a *disappearing* step as loud as an unpinned one. Item 3
is fixed the conventional way (`REPO_ROOT = resolve(import.meta.dirname, '..')`, line 7, with the
`vitest.config.ts` rationale cited). The docstring's cross-file promise is now belt-and-braces
rather than the sole guarantee, which is the right shape.

## The middle-commit incident (5c510d1 → 74dbf78) — checked independently

I did not take "restored" on trust. **Word-diff of `docs/compat-matrix.md` from `origin/main` to the
PR head shows exactly one changed region inside the Bun-axis row** and nothing else: the file is
net **+1/−1** across the whole PR, the row is still a single table row, its ❌, the `—` evidence
column, the campaign history (749→784, run IDs 28622051531 / 29276122186 / 28734528961 / 28702729595,
the 3+1 red-file ledger, the `$knextQuarantines` provenance, the flip-to-✅ contract) are all
byte-identical to `main`. Only the stale clause is replaced, and its replacement is accurate:
default pinned to `'1.3.14'`, dispatch materialises defaults, the weekly runs the pinned fallback
rather than `latest` — which matches `test-e2e-deploy.yml:66` and `:660` as they now stand.

Worth recording, since the lead surfaced it rather than burying it: the failure mode was **the
harness, not the edit** — a verification chain that grepped for a summary line instead of gating on
the runner's exit code, i.e. the exact class in this session's memory rule ("branch on exit code,
never output-grep"). Self-caught, and the fix commit states it plainly. That is the behaviour the
workflow rules ask for.

## Notes (none blocking)

- **(merge gate, not a defect) `Lint & Test` is still `pending` on 74dbf78.** That is the job that
  runs both `tests/bun-version-pins.test.ts` and `tests/compat-matrix.test.ts` — the honesty guard
  the middle commit reddened. 22 checks green, 0 failures, 2 skipped, but **merge on that job going
  green, not on the local 164/164**; the whole point of the incident above is that a local
  green was read wrong once already.
- **nit (a) — a duplicate `bun-version` input declaration shadows the real one.** `inputDefaultOf`
  returns the **first** `bun-version:` input block that carries a `default:` and stops. I mutated
  `test-e2e-deploy.yml` to declare a `workflow_call` input `bun-version` with `default: '1.3.14'`
  *above* a `workflow_dispatch` default of `latest`: the scan goes **green**. Contrived — no
  workflow here has both trigger sections — but the fix is nearly free and matches the file's own
  "scan, don't enumerate" premise: collect **every** `bun-version` input default in the file and
  require all of them to match `PIN_RE`, instead of returning on the first.
- **nit (b) — deleting the `default:` line is reported as unpinned, though it is actually safe.**
  With no default, `github.event.inputs.bun-version` is the empty string on dispatch, so the
  `|| '1.3.14'` fallback *does* apply. The guard reds anyway (`def=null`). Conservative direction,
  fails loud, costs nothing — just be aware the message would be misleading in that case.
- **nit 5a (composite actions) — not taken, and that is fine.** Confirmed there is no
  `.github/actions/` directory at all (`.github/` contains only `dependabot.yml` and `workflows/`),
  so the scan's scope is complete today. If one ever appears, the per-file count map is the thing
  that will need widening at the same time.

## Test quality (round 3)
Strong. The guard now proves its own permissive branch instead of pointing at another file for it,
the vacuity check became an exact per-file census, and every assertion I mutated failed for the
reason it claims to exist. Six independent mutations red, zero false-greens on the paths that
matter; the one green mutation I found (nit a) is a shape this repo does not currently have.
