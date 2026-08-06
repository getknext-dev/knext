# W6 (#594) — Is the compat-suite flakiness in #545 runtime-caused or harness-caused?

**Wayfinder ticket:** W6, child of map #588.
**Question:** does the flakiness described in issue #545 originate in the **knext runtime** (→ in scope
for the stability plan #588) or in the **harness / CI environment** (→ out of scope, belongs to a
separate feedback-loop effort)?

**Verdict up front: neither, as #545 frames it — and the framing is wrong.**
See §5. Confidence: **high** for the per-lane numbers and the bun-lane classification, **medium-high**
for the single node-lane red.

> **Window extended 2026-08-06 — read §7 before quoting §3's determinism claim or §5's
> "only the bun lane is red".** The original analysis closed on a window ending **2026-08-01**; two
> further scheduled reds have landed since (08-02 bun, 08-03 node). The **central conclusion is
> unchanged and in fact strengthened** — there is still no evidence of a knext *node runtime* defect
> producing intermittent compat reds — but two supporting statements no longer hold as written:
> the bun lane's reds are **no longer byte-identical across runs**, and the node lane is **no longer
> literally never red**. §7 records what changed and what it does and does not overturn. Sections 1–5
> are left as they were written, correct for the window they examined.

---

## 1. Method and window

Evidence is the **actual run history**, not a reading of the harness.

- Workflow: `.github/workflows/test-e2e-deploy.yml` — "Compat suite (official Next.js deploy harness)".
  Two lanes from one workflow file, selected by which cron fired:
  `KNEXT_RUNTIME: ${{ github.event.inputs.runtime || (github.event.schedule == '17 5 * * 0' && 'bun') || 'node' }}`
  — **node** daily (`17 3 * * *`), **bun** weekly Sunday (`17 5 * * 0`). 16 shards, `fail-fast: false`.
- Window examined: **2026-07-02 → 2026-08-01** (last 60 runs listed; 35 of them `schedule`).
  `workflow_dispatch` runs are excluded from the rates below — they are debugging dispatches on
  feature branches, not the gate. **§7 extends this window to 2026-08-05**; every number in §§2–5
  is scoped to the original 07-02 → 08-01 window and is not restated there.
- **Lane attribution is measured, not inferred from cron timing.** Every
  `compat-suite-summary-<n>-16.json` artifact carries a `"runtime"` key; I downloaded the 16 summaries
  for runs 30193384289, 29678368535 and 29984259723 and read it directly
  (`runtime=bun`, `runtime=bun`, `runtime=node` respectively).

---

## 2. Per-lane failure rate

### Node lane (daily) — the compat-matrix credential

| window | scheduled node runs | red | rate |
|---|---|---|---|
| 2026-07-02 → 2026-08-01 (full) | 31 | 4 | 12.9 % |
| **2026-07-05 → 2026-08-01 (post-graduation)** | **28** | **2** | **7.1 %** |
| post-graduation, excluding the deterministic packaging break | 28 | **1** | **3.6 %** |

The three windows differ because two of the four reds pre-date the state the gate is actually in:

- `28571240186` (07-02) and `28697744187` (07-04, **16/16 shards red**) both pre-date the
  compat-matrix ✅ credential, which is run **28702729595** (2026-07-04, `workflow_dispatch`,
  778 passed / 0 failed). Counting reds from before the suite was ever green inflates the rate with
  the graduation campaign itself. The 07-04 red is also plainly not a flake: every shard failed with
  **25–37 failures each** and **30 `MODULE_NOT_FOUND`** occurrences in the logs — a systemic module-
  resolution break, resolved the same day by the dispatch run that earned the credential.
- `29182334221` (07-12) failed at **`Prepare prebuilt next + harness` → "adapter-tarball preflight
  FAILED: npm install of the packed tarballs exited 1"**. Zero shards ran, zero adapter signal. This is
  the #255/#256 packaging incident (fixed by PR #266), already recorded as such in
  `docs/compat-matrix.md:50`. It is a **deterministic build break**, not a flake — it hit *both* lanes
  on the same commit that day.

**That leaves exactly one genuine node-lane red in the 28-run post-graduation window:**
`29984259723` (2026-07-23), shard 2 of 16, `failed=1 / notRun=0 / passed=48`.

**Current streak: 9 consecutive green node-lane runs** (2026-07-24 → 2026-08-01), every shard green.

### Bun lane (weekly, Sundays)

| run | date | result | shards red |
|---|---|---|---|
| 28734528961 | 2026-07-05 | ❌ | 6, 8 |
| 29184529993 | 2026-07-12 | ❌ | *(none — died at Prepare, packaging incident)* |
| 29678368535 | 2026-07-19 | ❌ | 6, 8 (`failed=1` / `failed=2`) |
| 30193384289 | 2026-07-26 | ❌ | 6, 8 (`failed=1` / `failed=2`) |

**4 scheduled runs, 4 red — a 100 % failure rate.** The bun lane has **never been green**; the matrix
row is honestly ❌ and says so ("No green `runtime=bun` run has been observed").

---

## 3. Do the failures cluster? Yes — and not the way "flaky" implies

**By lane:** overwhelmingly. Bun 4/4; node 1/28.

**By shard, on the bun lane:** the reds are **identical across runs, to the test count**.
07-19 and 07-26 both produced `shard 6: passed=48 failed=1` and `shard 8: passed=47 failed=2`.
07-05 produced the same shards 6+8. That is not rotation, and it is not timing — that is a
**deterministic, reproducible result**.

**By test, on the bun lane** (from `--log-failed` on run 30193384289):

| test file | failing cases | signature |
|---|---|---|
| `test/e2e/middleware-fetches-with-any-http-method/index.test.ts` | `passes the method on a direct fetch request`, `passes the method when providing a Request object` | **60000 ms** timeout |
| `test/e2e/app-dir/app-static/app-static.test.ts` | `should cache correctly with post method and revalidate edge`, `should not cache correctly with POST method request init` | **60000 ms** timeout |
| `test/e2e/app-dir/app-static/app-static.test.ts` | `should handle dynamicParams: false correctly`, `…partial-gen-params with layout/page dynamicParams = false` | **9–59 ms** assertion failure |
| `test/e2e/app-dir/parallel-routes-root-param-dynamic-child/…test.ts` | `should render a 404 for /es/gsp/stories/{static,dynamic}-123` | **4 ms** assertion failure |

These are **exactly the three documented Bun red files** already written up in
`docs/compat-matrix.md:50`, with two named mechanisms:
1. **edge-sandbox outbound `fetch()` never resolves** under Bun (the 60 s hangs) — proven *not*
   version-gated: it persists on Bun canary 1.4.0 (run 28622051531);
2. **the instrumented not-found `invariant` class** (the millisecond assertion diffs) — partially
   clears on canary 1.4.0.

**By test, on the node lane:** the single 07-23 red is one test —
`test/e2e/app-dir/segment-cache/dynamic-on-hover/dynamic-on-hover.test.ts ›
dynamic on hover › prefetches the dynamic data for a Link on hover`, failing with
`Exceeded timeout of 60000 ms for a test`, on both the initial attempt and the retry.

**By time:** the reds cluster in early July (the graduation campaign + the 07-12 packaging break) and
then stop. Nothing in the last 9 node runs.

---

## 4. Classification of every inspectable failure

| run | lane | cause | class |
|---|---|---|---|
| 28571240186 (07-02) | node | pre-graduation campaign red, shard 10 | **pre-credential; not evidence of flakiness of the current gate** |
| 28697744187 (07-04) | node | 16/16 shards red, 25–37 failures per shard, 30× `MODULE_NOT_FOUND` — systemic module-resolution break, pre-graduation | **pre-credential; deterministic, not a flake** |
| 29182334221 (07-12) | node | `adapter-tarball preflight FAILED: npm install of the packed tarballs exited 1` | **knext packaging break — deterministic, not a flake** (#255/#256, fixed by #266) |
| 29184529993 (07-12) | bun | same preflight failure, same commit | **same packaging break** |
| 28734528961 (07-05) | bun | shards 6+8, the 3 documented red files | **Bun-runtime gap — deterministic** |
| 29678368535 (07-19) | bun | shards 6+8, identical counts | **Bun-runtime gap — deterministic** |
| 30193384289 (07-26) | bun | shards 6+8, identical counts | **Bun-runtime gap — deterministic** |
| 29984259723 (07-23) | node | `segment-cache/dynamic-on-hover` — 60 s jest timeout, failed on retry too | **upstream Next.js race amplified by runner CPU contention — quarantine-bookkeeping gap** |

### The 07-23 node red in detail — this is the one that matters

`segment-cache/dynamic-on-hover` is **not** in `$knextQuarantines`. But **eight of its immediate
siblings are**, all at `level: "file"`, all with the *same* recorded mechanism:

```
segment-cache/basic, segment-cache/cached-navigations, segment-cache/refresh,
segment-cache/search-params, segment-cache/staleness (×2), segment-cache/vary-params,
segment-cache/prefetch-layout-sharing
  → "60s jest timeout ... via createRouterAct", root cause recorded in docs/compat-matrix.md as
    upstream's client segment-cache race under CPU contention, fixed upstream AFTER the pinned ref
    (vercel/next.js#95301). Upstream itself suite-skipped five of these files as "too flaky".
```

So the one node-lane red in 28 runs is the **same already-diagnosed upstream mechanism**, in a sibling
file that simply has not been added to the ledger yet. It is not a new or unexplained defect.

---

## 5. Verdict

**#545's central framing — "the gate is flaky at shard level", implying a broadly unstable suite whose
node lane flakes at ~1-in-12 — is not supported by the run history.** The numbers say:

- The bun lane is not *flaky*; it is **deterministically red**, on the same two shards, on the same
  three files, with the same failure counts, every single run. Reruns do not turn it green. The
  "re-run until green" failure mode #545 warns about **cannot occur on this lane**.
- The node lane over the 28 scheduled runs since the credential was earned has **one** genuine red —
  **3.6 %**, or 1 in 28 — and is currently **9 consecutive runs green**. #545's "~1-in-12 node-lane
  flake rate" comes from an 8-run sample that (a) straddles the graduation campaign and (b) counts a
  bun-lane red and a deterministic packaging break toward a node-lane rate.
- #545's own §2 ("Separate lane flakiness from suite flakiness … If the node lane is stable and only
  bun flakes, that is a much smaller problem and #410 covers it") sets exactly the right test.
  **The evidence answers it: the node lane is stable and only the bun lane is red, and #410 does cover
  it.** #545's remedy is therefore mostly already discharged by the answer, not by the work it proposes.

**Scope verdict — three-way split, not the binary the ticket assumed:**

| source | share of reds | in scope for #588? |
|---|---|---|
| **Bun runtime gaps** (edge-sandbox `fetch()`, not-found `invariant`) | 3 of 4 bun reds | **Out of scope for #588** — this is the **bun lane**, tracked by **#410**, and the matrix row is already honestly ❌. It is a real runtime defect, but it belongs to the bun-target track, not the node stability plan. |
| **Upstream Next.js segment-cache race under runner CPU contention** | the only post-graduation node red | **Out of scope as a runtime defect** — the root cause is upstream, fixed after the pinned ref. What *is* in scope is the **quarantine-bookkeeping gap**: `dynamic-on-hover` is an unquarantined member of an already-quarantined family. That is a small, tractable ledger edit, not a stability workstream. |
| **knext packaging break** (07-12 preflight) | 2 reds, one per lane | Already fixed (PR #266). Deterministic, not flakiness. |

**Therefore: the flakiness described in #545 is NOT runtime-caused in the sense that would put it in
map #588's scope.** There is no evidence of a knext *node* runtime defect producing intermittent
compat-suite reds. Nor is it cleanly "harness/environment-caused" — the dominant cause (bun lane) is a
real, deterministic runtime gap that is simply on a different lane and already owned by #410.

**Recommended disposition:**
1. **Do not** carry #545 into #588 as a runtime-stability workstream. Re-scope or close it against the
   measured numbers here.
2. The one genuinely actionable item is **~30 minutes of ledger work**: add
   `test/e2e/app-dir/segment-cache/dynamic-on-hover/dynamic-on-hover.test.ts` to `$knextQuarantines`
   at `level: "file"` with run 29984259723 as the observed evidence and vercel/next.js#95301 as the
   upstream provenance — matching its eight already-quarantined siblings. **Check the ≤15 family cap
   first** (`tests/compat-quarantine-bounds.ts`): the ledger currently holds 14 entries, so this lands
   at the boundary and may need the escalation path rather than a silent add.
3. #545's item 3 — *make flakiness visible rather than incidental*, i.e. record per-shard outcomes
   durably so the rate is a number rather than folklore — is **still worth doing and is genuinely
   feedback-loop work, not runtime work.** This investigation had to reconstruct the rate by
   downloading artifacts run-by-run; that is exactly the gap. It belongs to the separate feedback-loop
   effort, not to #588.
4. The v1.0 gate ("14 consecutive node-lane runs, every shard `failed:0`/`notRun:0`") is, on this
   evidence, **reachable by waiting** — contrary to #545's claim. At 9 green and counting, and with the
   only observed blocker being a one-line ledger addition, the streak is a scheduling question, not a
   defect-fixing one.

---

## 6. Confidence and what would change the answer

- **High confidence** on the per-lane rates and lane attribution: read from the `"runtime"` key in the
  shard summary artifacts, not from cron timing.
- **High confidence** that the bun lane is deterministic, not flaky: three independent scheduled runs
  produced byte-identical shard/pass/fail shapes.
- **Medium-high** on the single node red. One data point is one data point. The attribution to the
  upstream segment-cache family rests on the mechanism match (identical 60 s `createRouterAct` timeout
  signature, same directory, eight quarantined siblings) rather than on a root-cause trace of that
  specific file.
- **What would overturn this:** a node-lane red in the next few weeks whose cause is *not* the
  segment-cache/prefetch family. That would mean the node lane has a second, unexplained failure mode
  and the scope question should be reopened. One more red of the same family would not — it would just
  confirm the ledger gap.

---

*Evidence: `gh run list --workflow=test-e2e-deploy.yml --limit 60`; 16 `compat-suite-summary-*.json`
artifacts each from runs 30193384289 / 29678368535 / 29984259723; `gh run view --log-failed` on runs
30193384289, 29984259723, 29182334221, 28571240186; `docs/compat-matrix.md` rows 49–50;
`test/deploy-tests-manifest.knext.json` `$knextQuarantines`; `.github/workflows/test-e2e-deploy.yml`.*

---

## 7. Window extension to 2026-08-05 — two new reds, and what they overturn

**Why this section exists rather than an edit above.** §§1–5 were correct for the window they
examined and are left intact; this section states what the four days after that window changed. The
original finding is not deleted — it is dated.

### The two new scheduled reds, measured

Both were verified with `gh run view` and by reading the `compat-run-ledger` artifact's `lane` key,
which is the same measured attribution discipline §1 used (the per-shard artifacts have since been
renamed from `compat-suite-summary-<n>-16` to `compat-suite-summary-<n>`; the `"runtime"` key inside
is unchanged).

| run | date | lane (measured) | shards red | totals |
|---|---|---|---|---|
| `30738274907` | 2026-08-02 | **bun** (`lane: "bun"`, `runtimeVersion: 1.3.14`) | **6, 8, and 16** | 774 passed / 4 failed, all 16 shards recorded |
| `30790778590` | 2026-08-03 | **node** (`lane: "node"`) | **16** | 730 passed / 0 failed across the **15** shards recorded |

Interleaving, for completeness: 08-01, 08-02 06:12 UTC, 08-04 and 08-05 were all scheduled **node**
runs, all green, all 16 shards, 778 passed / 0 failed (ledgers read directly). The 08-02 bun run is
the second scheduled run that day — the weekly Sunday cron, not a second node run.

### What the 08-02 bun run overturns: the determinism claim, not the classification

§3 says the bun reds are "identical across runs, to the test count" and §6 rates that **high
confidence**. That no longer holds:

- A **third shard** went red. Shards 6 (`failed=1`) and 8 (`failed=2`) still carry their usual
  counts, but **shard 16** failed on `test/e2e/edge-compiler-can-import-blob-assets/index.test.ts`
  (`allows to fetch a remote URL`, `…with a path and basename`, both 60 000 ms timeouts).
- That file is **not new to the project, but it is new to a stable-Bun scheduled run**.
  `docs/compat-matrix.md:50` records it as a red seen **only** on Bun canary 1.4.0 (run 28622051531)
  and dismisses it as "pre-release noise". This run's ledger reports `runtimeVersion: 1.3.14` — the
  stable lane. **The "canary-only / pre-release noise" characterisation is therefore falsified**, and
  that matrix cell should be revisited by whoever owns the bun-lane row.
- **Both** of the long-standing shards also changed **mechanism**, and in *opposite* directions:
  - Shard 8: §3 recorded `parallel-routes-root-param-dynamic-child` as a **4 ms assertion** diff;
    on 08-02 it fails as a **60 000 ms timeout** across its whole case list. A timeout appeared.
  - Shard 6: §3's table records `app-static` failing **twice over** — a 60 000 ms timeout pair (the
    POST-method cases, i.e. the edge-sandbox fetch-hang mechanism) *and* a 9–59 ms assertion set. On
    08-02 the shard-6 summary carries **only** `kind: "assertion"` with the three `dynamicParams`
    cases. A timeout **disappeared**.

**The full failed-file set on 08-02 is four files, not three** — worth stating because shard 8
carries two of them and a per-shard count hides that:

| shard | file | kind |
|---|---|---|
| 6 | `app-dir/app-static` | assertion (3 cases) |
| 8 | `app-dir/parallel-routes-root-param-dynamic-child` | timeout (7 cases) |
| 8 | `middleware-fetches-with-any-http-method` | timeout (2 cases) |
| 16 | `edge-compiler-can-import-blob-assets` | timeout (2 cases) |

**Methods differ, so do not read the mechanism shifts as proven either way.** §3's per-case detail
came from `gh run view --log-failed` on run 30193384289, which predates the ledger artifact and has
none (`0` ledger artifacts on that run). §7's comes from the structured `compat-run-ledger` and
per-shard summary JSON. Two extractions of different fidelity are not a controlled comparison: a
case absent from one may be absent from the *run* or merely from the *extraction*. What is solid is
the shard set and the per-shard counts, which both sources agree on the meaning of.

**What it does not overturn:** the mechanism classification. All four files fail with the two
already-documented bun signatures — the edge-sandbox outbound `fetch()` hang and the instrumented
not-found `invariant` class. The bun lane remains **out of scope for #588**, tracked by **#410**,
and the matrix row remains honestly ❌. What is now wrong is calling the lane *stable in shape*: the
shard set moves, so a future bun red on a shard not in {6, 8} is not automatically a new defect.

### What the 08-03 node run overturns: the wording, not the conclusion

§5 concludes "the node lane is stable and only the bun lane is red". Literally, that is now false —
a scheduled node run went red. **Substantively it survives, because this red never executed a test.**

Job `Deploy tests (shard 16/16)` (id `91614133100`) failed at **step 3, "Unpack workspace tarball"**,
before the harness, the adapter, or a single test ran. Its only check-run annotation is:

> `The hosted runner lost communication with the server. Anything in your workflow that terminates
> the runner process, starves it for CPU/Memory, or blocks its network access can cause this error.`

Steps 4 onward never started (`conclusion: null`), and the job's log blob has already expired
(`BlobNotFound`) — the annotation and the step states are the surviving evidence. The other 15
shards were green: 730 passed / 0 failed.

So this is neither a knext runtime defect **nor** a test flake. It is **runner infrastructure loss** —
a third category §4's table did not have, and the one §6 asked for ("a node-lane red whose cause is
*not* the segment-cache/prefetch family"). It answers that question in the least alarming way
available: the node lane has no second *runtime* failure mode; it has a CI-provider failure mode,
which every workflow on GitHub-hosted runners has.

**Corrected verdict, replacing §5's sentence for the extended window:** *the node lane shows no
runtime-caused flakiness; over 07-05 → 08-05 its only test-executing red remains the single
07-23 upstream segment-cache timeout, and its one other red never ran a test. Only the bun lane is
red for runtime reasons — and its reds are deterministic in mechanism but no longer in shape.*

### Consequence for the v1.0 window — smaller than it first looks, because the window is not open

§5 item 4 says the 14-consecutive-green gate is "reachable by waiting". **Read the gate's own
record before quantifying that**, which neither §5 nor an earlier draft of this section did:
`docs/compat/window-node-lane.md` says of itself "This file is the record", and it currently reads
**"NOT YET OPEN"**, **nights recorded 0 / 14**, with no start ref and no start fingerprint. The
clock starts on the first scheduled node run after the harness-fingerprint script landed.

So **nothing had accrued for 08-03 to reset.** The run-history streaks in §2 and above (9 green,
then 2) are arithmetic over the run list; they are **not** the gate's count, and the two must not
be conflated. There was no streak of 9 and there is no streak of 2 in the sense that matters to
v1.0 — there is a window that has not started.

Two things are still worth flagging, stated at their real size:

- **The rules do not distinguish a runner loss from a real red.** Rule 1 restarts the count on any
  fingerprint change and rule 2 requires every shard `failed:0`/`notRun:0`; a job that died before
  running a test satisfies neither cleanly. Whoever polices the window should decide **before** it
  opens whether an infrastructure loss that executed zero tests counts as a failed night —
  deciding it afterwards, having seen which way it falls, is the failure mode to avoid.
- **The automated half never registered 08-03 as red at all.** The `Per-shard ledger (flake
  attribution)` job on run `30790778590` concluded **`success`**. So the run is red at the workflow
  level (the shard job failed) while the ledger-producing job that feeds the record is green — see
  the next subsection, which is the same defect seen from the other end.

### The 08-03 ledger recorded a clean sheet — already owned elsewhere, do not fix here

The 08-03 `compat-run-ledger` artifact contains **15 shard entries, not 16**. Shard 16/16 died before
its "Upload summary artifact" step, so no summary existed to collect, and the ledger **omitted the
shard rather than recording it as missing** — the artifact reads as `730 passed / 0 failed`, a clean
sheet, for a night the gate went red. Anyone reading the ledger alone would conclude the run was
green.

This is exactly **issue #695** ("compat-run-ledger records a clean sheet for a red night: a shard with
no summary artifact is omitted, not counted missing"), which is **open and owned by another
workstream**. It is recorded here as corroborating evidence, with a live instance to test any fix
against; **it is deliberately not fixed in this document's change.** Until it is fixed, treat a
ledger's shard count — not just its totals — as part of reading a run.

**Connect this to the window rules, because it is the same hole.** `window-node-lane.md`'s rule 2
is *"Every shard `failed:0` and `notRun:0`"* — a rule stated over the shards the ledger **contains**.
An omitted shard is not `failed:1`; it is absent, so it satisfies rule 2 vacuously. That is the
precise mechanism by which 08-03 could have been recorded as a qualifying night: 15 shards, all
`failed:0`/`notRun:0`, rule 2 met, one shard's failure invisible. The window not yet being open is
the only reason this cost nothing this time. **#695 is therefore not merely a reporting nuisance —
it is a soundness hole in the v1.0 gate**, and it should be fixed before the window opens rather
than during it. Rule 2 needs a shard-**count** assertion (16 present) alongside its per-shard
assertion; that belongs to #695's fix, not here.

### Confidence on this section

- **High** on both lanes' attribution and on the 08-03 root cause: `lane` read from the ledger
  artifacts, and a runner-loss annotation is a statement by the CI provider, not an inference.
- **High** that `edge-compiler-can-import-blob-assets` red on stable Bun 1.3.14 — read from the
  ledger's per-shard `runtimeVersion`, not from the lane's default.
- **Not established:** whether the 08-02 bun shard-16 red is persistent or a one-off. One weekly run
  is one data point; the next bun weekly decides whether the matrix's "canary-only" note needs a
  rewrite or merely a caveat.
- **Not established:** the two mechanism *shifts* on shards 6 and 8. The 08-02 and §3 figures come
  from different extraction methods (structured ledger vs `--log-failed`), so a case present in one
  and absent in the other may reflect the extraction rather than the run. The shard set and the
  per-shard counts are solid; the per-case mechanism deltas are indicative only.

*Evidence for this section: `gh run view 30738274907`, `gh run view 30790778590`;
`compat-run-ledger` artifacts from runs 30738274907, 30790778590, 30735484416, 30882760738,
30979973943; `compat-suite-summary-{5,7,15}` from 30738274907;
`gh api repos/getknext-dev/knext/actions/jobs/91614133100` (steps) and its check-run annotations;
the `Per-shard ledger (flake attribution)` job conclusion on run 30790778590;
`docs/compat/window-node-lane.md` (status + rules); `gh issue view 695`.*
