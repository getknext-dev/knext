APPROVE (round 2, 2adbf10) — round 1 below was ISSUES_FOUND; all five findings fixed, re-verified at the bottom of this file.

# Spec review — PR #789 (ADR-0042 action item A13)

Spec = A13's own text, preserved verbatim in the diff under `*(Original item follows.)*`
(`docs/adr/0042-vinext-bun-bytecode-as-the-default-runtime.md:1058-1064`). Diff reviewed:
`git diff origin/main...origin/measure/a13-node-postready-lazy` — 2 files, 103 insertions.

## Criteria checklist

| # | criterion (A13 text) | verdict | evidence |
|---|---|---|---|
| 1 | Measure the node standalone entry's post-readiness first-request lazy cost | **met** | `docs/benchmarks/fm-node-postready-lazy-a13-2026-08-19.md` — 8-cycle table, `lazy = first − min(warm1, warm2)` |
| 2 | "same methodology as the vinext measurement (post-readiness, first request, warm image)" | **partial** | see A, B below |
| 3 | ">200 ms ⇒ warm-on-boot promotes to contract" — the decision | **partial** | 190 < 200 recorded; margin and the contrary 213 ms datapoint not confronted (C, D) |
| 4 | "record the number even if under threshold, so the criterion is discharged by measurement rather than expiring unread" | **met** | ADR:1047 `A13 — DISCHARGED (2026-08-19), by measurement`; number in both ADR (:1050, :464) and record |
| 5 | "Natural home: the Phase 1 / A2 two-arm sittings" | **partial** | ran standalone; deviation is silent (E) |
| 6 | Also owed: user docs for `KNEXT_WARM_PATH`/`KNEXT_EAGER_WARM` | **met as a pointer, not discharged** | ADR:1068-1070 points at #783; #783 is still **OPEN** and its comment says exactly what the ADR claims (F) |
| 7 | No scope drift | **met** | only the ADR + the new record; no code, no config, no test |

## Findings

**A. "the app graph is untouched" is literally false — but the method survives it (precision defect).**
Record, Methodology: "wake via `GET /api/health` (Knative queues it until Ready; the app graph is
untouched)". `/api/health` imports `@getknext/lib/health` and `../_metrics/registry`
(`apps/file-manager/src/app/api/health/route.ts:1-2,14`), so the wake *does* evaluate a slice of the
server graph. The measured 190 ms is therefore the **incremental** residue beyond what the health
route already warmed. That is still the right number, because the operator wires the Knative
readiness probe to that same path — `readinessProbePath()` returns `/api/health`
(`packages/kn-next-operator/internal/controller/nextapp_controller.go:738-758`,
`readiness_probe_test.go:32-34`) — so in production the health slice is *always* evaluated before the
first user request. The methodology is production-faithful; the sentence claiming isolation is not,
and a later reader re-running this on an app with a fatter health route would silently get a
different quantity. Fix the sentence, keep the method (and cite the probe path as the justification).

**B. "mirrors the vinext measurement" overstates the fidelity.** The vinext ~1.2 s the record and ADR
compare against was not produced by this harness: it is a decomposition attribution off a sitting the
source record itself calls "**inadmissible** as a runtime A/B, different builds"
(`docs/benchmarks/fm-same-source-oke-ab-2026-08-18.md:33-35`). A13's harness (health-wake →
first/warm/warm delta) is arguably *cleaner* than the thing it says it mirrors. The record's
"Comparables" bullet is honest; the Methodology heading ("mirrors the vinext measurement") and the
ADR's "a fraction of the vinext entry's measured ~1.2 s" (:1051) are not — they present a
whole-cold-start attribution as a like-for-like post-readiness number.

**C. "Median lazy 190 ms" is not the median. (Wrong statistic, propagated three places.)**
The eight lazies sort to `70, 113, 131, 138, 190, 3434, 15061, 15448`; the median is **164 ms**
(mean of 4th/5th). 190 is the *maximum of the five unstalled cycles*. The record uses the standard
convention correctly two lines later ("the five unstalled cycles ... median 131 ms"), so the headline
is inconsistent with its own neighbour. The error is **conservative** — it reports the value closest
to the bar, against its own conclusion — and the verdict holds on either number (164 and 190 both
< 200). But "median 190 ms" now appears in the record, in ADR:1050, in ADR:464, and in the PR title,
and a later reader will take it literally. Relabel (e.g. "max of the clean cycles 190 ms; median of
all eight 164 ms; clean-cycle median 131 ms").

**D. The knife-edge is not stated, and the one genuine render that *exceeded* the bar is not
confronted.** 190 ms is 5% under a 200 ms threshold at n=8 with five clean cycles — the record's
Verdict says flatly "190 ms median < 200 ms" with no margin language, no dispersion, no "a re-measure
could land the other side". Worse, run 1 cycle 1 **was** a genuine render (`x-nextjs-cache: MISS`) at
**lazy 213 ms** — above the bar — and the record mentions it only as scaffolding for why run 1 was
invalidated, never as the datapoint pointing the other way. It is legitimately a different route (`/`,
with its own cost profile) and a self-invalidated run, so it should not flip the verdict; but a
criterion discharged at 5% margin that has one observed genuine render over the line must say so
out loud. The ADR entry omits 213 ms entirely. The existing re-measure caveat (ADR:468-469, "re-measure
before citing this number across a Next major or an entry rewrite") is the right instinct — it is just
not attached to the closeness of the number itself.

**E. The prescribed home was not used, silently.** A13 names "the Phase 1 / A2 two-arm sittings, whose
control arm boots the node standalone entry anyway". This ran as an 8-cycle standalone sitting on
2026-08-19, after the A/B sittings of 08-18. That is very likely the better instrument (the A/B
control arm measures end-to-end cold start, not a post-readiness first-vs-warm delta), and "natural
home" is soft language, not a mandate — but neither the record nor the ADR entry notes the deviation
or why. One sentence closes it.

**F. The docs half — the pointer is accurate, and the issue is correctly left open.** ADR:1068-1070
says the docs are "re-scoped on #783, 2026-08-19: those docs are gated on the compiled target itself
becoming user-facing, since no shipped surface reads the env vars". `gh issue view 783 --comments`
matches: the env vars are read in exactly one tracked surface (`examples/bun-exec/knext-bun-entry.mjs:213,217`),
`runtime: 'bun'` goes through `node-server.ts` which has no warm-on-boot, and there is no docs page for
the compiled target. #783 is **OPEN**, not closed — so this is an honest re-scope, not a false close.
Correctly, A13 is marked DISCHARGED only for the measurement half; the docs half remains owed and
tracked elsewhere. No objection. (Note the coupling #783 itself flags: had A13 measured >200 ms, the
knob would have become reachable on the default target and the docs immediately owed — the measurement
result is what keeps the re-scope valid.)

## Claims spot-checked and confirmed

- `/dashboard` fully dynamic, three PG queries, `catch` → zero-stats fallback:
  `apps/file-manager/src/app/dashboard/page.tsx:2,5,9-23` ✓ (so every request is a genuine render ✓)
- 15 s cold-wake connect timeout: `DEFAULT_DB_POOL_CONNECT_TIMEOUT_MS = 15_000`
  (`packages/lib/src/clients.ts:533`), applied to both pools (:549, :622) ✓. Nit: the record pins it via
  `clients-ro.test.ts:58` (the **reader** pool) while `/dashboard` calls `getDbPool()` (the **writer**
  pool, :549). Same constant, so the number is right; the citation points at the wrong pool.
- Tail attribution (15.0–15.4 s = timeout exhausted then fallback, with the 14232 vs 14240 body-byte
  tell) is internally consistent and correctly ruled **out of scope** for this criterion — refusing to
  hide a DB stall behind an entry warm is the right call and is the record's strongest section.
- Scope: two files, both documentation. No code, no test, no CRD/config/CLI touch. ✓
- Harness script not committed — consistent with every prior record in `docs/benchmarks/`, so noted as
  a standing repo-wide reproducibility gap, **not** a defect of this PR. Same for "warm image verified
  per cycle (from pod events)", which is asserted rather than shown (no per-cycle evidence column);
  precedent-consistent, but it is the one methodology clause A13 named explicitly, so a pod-event
  excerpt would cost a paragraph and close it.

## Verdict

**ISSUES_FOUND** — the measurement is sound, the decision (no promotion) is correct on any reading of
the data, the scope is clean, and the docs pointer is honest. All findings are text-only, in the two
documents this PR adds:

1. **(C) Fix the mislabelled "median 190 ms"** — it is the clean-cycle maximum; the true n=8 median is
   164 ms. It propagates to ADR:464, ADR:1050 and the PR title.
2. **(D) State the margin, and confront the 213 ms genuine render** from the invalidated run rather
   than leaving it as narrative scaffolding.
3. **(A) Drop or qualify "the app graph is untouched"** — cite `readinessProbePath()` returning
   `/api/health` as why the wake is production-faithful instead.
4. **(B) Qualify "mirrors the vinext measurement"** — the ~1.2 s comparable comes from a run its own
   record calls inadmissible.
5. **(E) State the deviation** from A13's named home (Phase 1 / A2 sittings) and why.

None of these change the verdict "criterion NOT met, warm-on-boot stays target-specific". A13 can be
marked DISCHARGED once the record says what it measured with the precision the item asked for.

---

# Round 2 — re-review at 2adbf10 (`git diff 1a7ddb1..2adbf10`)

**Verdict: APPROVE.** All five findings fixed; no new findings; scope still clean.

| finding | fix | verified |
|---|---|---|
| **C** wrong statistic | record answer line, under-table stats, Verdict, ADR:464, ADR:1052 and the PR title now carry **164 ms** (all-eight median) / **131 ms** (clean median) / **190 ms** (clean max) | `git grep "median 190\|typical 70–190" 2adbf10 -- docs/` → **zero hits**. PR title: "…164ms median (knife-edge)…". I recomputed the median independently: sorted `70,113,131,138,190,3434,15061,15448` → (138+190)/2 = **164 ✓**; clean-cycle median 131 ✓; clean max 190 ✓ |
| **D** knife-edge / 213 ms | Verdict heading is now "NOT met — **but on a knife-edge, stated rather than rounded away**"; states n=8, one route, one day; confronts the run-1 `/` MISS render at **213 ms — over the bar** verbatim, gives why it does not flip the verdict (self-invalidated run, n=1, cache-writing route) and what would (a re-measure on a heavier page). ADR Consequences (:464-467) carries the same two facts | margin arithmetic checks out: (200−164)/200 = **18%**, (200−131)/200 = **34.5%** → the stated "18–35%" ✓ |
| **A** "app graph is untouched" | replaced with an explicit statement that the health route evaluates its own slice (`@getknext/lib/health` + metrics registry), plus the production-faithfulness justification I asked for — `readinessProbePath()` → `/api/health` — the quantity relabelled "**incremental residue beyond the health slice**", with a don't-transplant warning | direction of the warning is correct: a fatter health route ⇒ *smaller* measured residue ✓ |
| **B** "mirrors the vinext measurement" | heading is now "Methodology (**A13's terms**: post-readiness, first request, warm image)"; a dedicated **Comparability caveat** marks the ~1.2 s as a decomposition attribution off the *inadmissible-as-A/B* 2026-08-18 sitting, order-of-magnitude only; the ADR's phrasing carries the same caveat inline | ✓ |
| **E** silent deviation | dedicated "**Deviation from A13's 'natural home'**" paragraph, with the reason: the A/B arms measure end-to-end cold start and cannot separate a post-readiness first-vs-warm delta | ✓ — and this is the right reason, not a post-hoc one |

**Scope re-checked against `main`:** `git diff --stat origin/main..2adbf10` → still exactly two files
(`docs/adr/0042-…md`, `docs/benchmarks/fm-node-postready-lazy-a13-2026-08-19.md`), 131 insertions,
2 deletions. No code, no test, no CRD/config/CLI/public-API path. No drift across the fix round.

**Unchanged and still correct from round 1:** the discharge decision (criterion NOT met, warm-on-boot
stays target-specific) holds on every statistic now published; the DB-tail attribution stays correctly
out of the criterion's scope; the docs half remains an honest pointer at an **open** #783 rather than a
false close, and A13 is marked DISCHARGED only for the measurement half.

**Two cosmetic nits, explicitly not blocking and not worth a round:** (1) in the per-cycle methodology
bullet the arrow chain is now interrupted mid-bullet by the production-faithfulness parenthetical, so
"→ time the FIRST `GET`" resumes after a four-line aside — readable, just no longer scannable as one
chain; (2) 131–164 ms vs ~1.2 s is ~7–9×, so "an order of magnitude below" is generous — but it is
explicitly qualified as order-of-magnitude-not-like-for-like in the very same sentence, which is the
honest framing, so it reads as intended.

Merging this resolves A13's measurement half as the item prescribed. Ship it.
