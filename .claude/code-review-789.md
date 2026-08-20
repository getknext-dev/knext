ISSUES_FOUND

# Code review — PR #789 @ 2adbf10 (round 2)

Round 1 was against 1a7ddb1. 2adbf10 fixes five spec-review defects; three of them overlap findings
I had raised independently (median, health-slice, comparability), and the fixes are **good** — they
are honest corrections, not re-labelling. But one fix left a contradicting sentence behind, two new
sentences overclaim on their own terms, and **eight round-1 findings are untouched**.

## New in 2adbf10

### Fixed, verified

- **Median.** `record:57-59` now reads "Median lazy over all eight cycles: **164 ms** … five
  unstalled cycles … 70–190 ms (median 131 ms, max 190 ms)". Recomputed from the table: sorted
  70,113,131,138,190,3434,15061,15448 → median (138+190)/2 = **164 ✓**, clean median **131 ✓**,
  clean max **190 ✓**. Both ADR sites (`:464`, `:1052`) carry the corrected figure. Correct.
- **Knife-edge margins.** "18–35%": (200−164)/200 = 18.0% ✓, (200−131)/200 = 34.5% ✓. ADR's "18% on
  the all-cycles median" ✓.
- **Health-slice honesty.** `record:20-27` now states the wake is NOT app-graph-free, names what it
  does evaluate, and argues production-faithfulness from `readinessProbePath()`. Verified:
  `nextapp_controller.go:743-748` returns `/api/health`, `readiness_probe_test.go:32-34` asserts it.
  The "incremental residue beyond the health slice" framing is the right quantity, and
  "re-derive, don't transplant" is the right caveat. Good fix.
- **Comparability caveat.** `record:41-44` names the source as "a decomposition attribution from the
  2026-08-18 record's *inadmissible-as-A/B* lazy-entry sitting, not a number produced by this
  harness". That matches `fm-same-source-oke-ab-2026-08-18.md:33-34` exactly. Good fix.
- **213 ms confronted.** `record:82-90` now states it in the Verdict as "**213 ms — over the bar**"
  with its discounts given as reasons, not as dismissal. This is the round-1 item #2, properly closed.
- **Phase 1/A2 deviation** (`record:35-39`) — reason given is substantive (the A/B arms measure
  end-to-end cold start and cannot separate a first-vs-warm delta). Correct on the face of it.

### New / surviving overclaims introduced or left by the fix

1. **`record:91-93` — the Verdict's second bullet was not updated and now contradicts the fix.** It
   still reads "Comparables, **same app, same cluster**: node … ~131 ms typical vs vinext lazy-entry
   ~1.2 s". Two lines above, the same document now says the comparison is "order-of-magnitude, not
   like-for-like" off an *inadmissible* sitting. "Same app" is also the specific claim the source
   record undercuts (`fm-same-source…:41`: "a different entry, a different cache state, and
   (yesterday) **a different application**"). Delete "same app, same cluster" or point the bullet at
   the new caveat. As it stands the fix reads as bolted on rather than applied.

2. **`record:89` + ADR:1053 — "an order of magnitude" is not what the numbers say, in a commit whose
   whole point was that precision.** 1200/164 = **7.3×**; 1200/131 = 9.2×. The same paragraph is
   careful to write "18–35%, **not 10×**" about the margin, then claims 10× for a 7.3× ratio on the
   now-headline statistic. Write "~7–9×" or "several-fold".

3. **`record:83-84` — "The margin is real on **every defensible statistic**" is stronger than the
   data.** Over all eight cycles the mean is **4323 ms** and the p75 sits above 3.4 s; only
   tail-robust location statistics clear the bar. Restricted to the clean stratum it is true (median
   131, mean 128, max 190). Say "on every statistic robust to the DB-stalled tail" — the honest
   version, and it costs nothing since the stratification is already argued.

4. **Minor — the closest clean sample is 5% under the bar, not 18%.** `record:83` quotes 18–35% from
   the two medians; the max of the five clean cycles is 190 vs a 200 ms bar. Given the section is
   titled "knife-edge", quoting the 190/200 gap is the more conservative statement and strengthens
   the section's own point.

5. **Minor — "the operator wires the readiness probe to this same path" is a *default*, not an
   invariant.** `nextapp_controller.go:744-746` honours `spec.healthCheckPath` first. For an app that
   overrides it, the wake path and the probe path diverge and the production-faithfulness argument
   does not hold. One clause ("absent `spec.healthCheckPath`") closes it.

## Round-1 findings still unaddressed at 2adbf10

6. **`record:16` vs `:64-68` — PG keepwarm contradiction.** Methodology asserts "PG trickle keepwarm
   running"; the tail section attributes 3/8 cycles to a *cold* DB connect exhausting 15 s. Either
   keepwarm was ineffective — a finding that belongs in the record and bears on #779 / `spec.tier:
   warm` — or the cold-wake attribution is wrong. Still neither.

7. **`record:64-65` — the timeout citation names the wrong pool, and source rather than deployment.**
   `/dashboard` uses `getDbPool()` (`apps/file-manager/src/app/dashboard/page.tsx:7`), the **writer**
   pool; the cited `packages/lib/src/__tests__/clients-ro.test.ts:58` asserts the **RO** pool. Right
   number, wrong anchor — use `packages/lib/src/clients.ts:533` + `:549-551`. And it is a default
   overridable by `DB_POOL_CONNECT_TIMEOUT_MS`, never read from the deployed pod.

8. **`record:67-68` — the "14232 vs 14240 bytes" tell still cites evidence the record does not
   publish.** No byte column in the table; which size is the fallback is never said; the fallback
   swaps up to five file rows for one "No files uploaded yet" row (`page.tsx:60-73`), so an 8-byte
   delta only makes sense if `files` is empty — unstated. "on precisely those cycles" remains
   ambiguous between {6,8} and {2,6,8}, and if cycle 2 *succeeded* its body should match the
   **success** size, contradicting the sentence.

9. **`record:68` — "The ~3.4 s cycle is the same path succeeding slowly" is still asserted as fact.**
   No body size, no DB log, no pool metric for cycle 2. It is equally consistent with the
   activator/SKS transition stall this repo measured at 5.5–6.0 s (`fm-confirmatory…:38-42`). Mark
   as inference or drop. (Cycles 6/8 arithmetic does hold: 15617−555 ≈ 15 s + ~600 ms render;
   15987−539 ≈ 15 s + ~990 ms — keep that, it is the strong part.)

10. **ADR `0042…:450` still contradicts `:464`.** "the node standalone path's first-request lazy cost
    has **not been measured**" sits 14 lines above "Measured (2026-08-19, A13)". The ADR's own
    convention for this is at `:435` ("*(Original consequence, premise now false, follows.)*").

11. **ADR `0042…:1049` — "A13 — DISCHARGED" while a named half of A13 is openly not done** (the
    `KNEXT_WARM_PATH`/`KNEXT_EAGER_WARM` docs, deferred onto **#783, still OPEN**). Use "DISCHARGED
    IN PART". Secondary: the re-scope note is written *inside* the "*(Original item follows.)*"
    block, so the preserved original is no longer the original — the A12 precedent (`:1083`)
    preserves it verbatim.

12. **`record` "~29 ms median" (Verdict, run-1 bullet) is still not derivable from anything
    published** — the record gives only "lazy 3–33 ms" and no run-1 table, yet the ADR pins the
    29 ms median as one of "two things a later reader needs". Publish run 1's samples or quote the
    range.

13. **Reproducibility — the harness script is still not committed.** The record describes an
    "8-cycle wake-then-measure script"; nothing in the diff. A knife-edge criterion whose re-measure
    is explicitly invited (ADR: "re-measure before citing this number across a Next major") should
    ship the instrument, or say where it lives.

14. **Minor — three table rows still do not subtract.** 624−553=71 (recorded 70), 15617−555=15062
    (15061), 663−526=137 (138). Rounding of sub-ms values, presumably — say so or fix. Cycles
    1/2/4/5/8 are exact.

## Not at issue

Docs-only; no auth, secrets, image tags, shell construction, CRD/CLI/public-API surface touched.
The `#783` pointer still matches the issue comment's verification verbatim.

**Test quality:** no tests (docs-only) — the measurement *is* the test. Round 2 materially improved
its honesty (true median, stated knife-edge, confronted counter-sample), but it remains a single
unreplicated n=8 sitting whose harness is uncommitted, and the two cheapest corroborations it
already has in hand — run 1's per-cycle table and the per-cycle body sizes its own tail argument
leans on — are still unpublished.

---

# Round 3 — @ 705dab2

**ISSUES_FOUND** — but small ones. Ten of my thirteen round-1 items are properly closed, several
with better fixes than I asked for. What remains is (a) the committed harness still contains the
exact bug this PR is a correction of, (b) two spots where round 3's own new precision did not
propagate, and (c) one substantive question the newly-published run-1 data raises and the record
does not answer.

## Verified closed

- **Run 1 published and derivable** (`record:28-33`): 213, 29, 15, 9, 33, −120, 120, 3 → sorted
  −120,3,9,15,29,33,120,213 → median (15+29)/2 = **22 ✓**. ADR:1067 updated 29→22 ✓. Note this also
  silently retracts round 1's "lazy 3–33 ms" range, which the published data contradicts (−120, 120
  are outside it) — retracting by publication is the right call.
- **Pool citation** (`record:72-76`): writer pool, `clients.ts:533` + `:549-551`, override name
  correct — all verified against the tree. The "deployed value verified on the running system"
  claim is the right kind of claim (workflow step 4) and I take it on the author's word.
- **Body bytes in the table** (`record:50-59`), tell downgraded to "corroborates … not proof on its
  own", the near-empty-files premise stated as unchecked, and cycle 2's success-size body used to
  *withdraw* the fallback reading and mark the slow-connect reading as "inference, not separately
  evidenced" — with the activator/SKS alternative named. This is exactly right and is a stronger
  fix than the finding asked for.
- **Keepwarm contradiction** (`record:17-18`, `:86-91`) — surfaced in Methodology, made a named
  finding, unattributed rather than guessed, routed to #779/#781. Correct handling.
- **Comparables bullet** (`record:113-120`) rewritten with admissibility, the same-day 430–480 /
  557–714 ms figures, the DB-exclusion asymmetry, and "no ratio quoted across these sittings is
  like-for-like". Round-2 finding 1 closed.
- **ADR:450** premise-now-false marker ✓. **ADR:1051** DISCHARGED IN PART with the docs half named
  as not discharged and #783 flagged open ✓. **Original item restored verbatim** (ADR:1074) ✓.
- **ADR:1055-1056** replaced "an order of magnitude below … ~1.2 s" with "well below … 430 ms–1.2 s
  across sittings, builds and methods — not like-for-like" ✓ — better than the "~7–9×" I suggested.
- **Limitations section** (`record:125-133`) covers n, route, day, network, and that
  `first − min(warm)` is an upper bound on everything first-request ✓. **Rounding note** at
  `record:61-62` explains the off-by-one rows ✓. **Harness committed** ✓.

## New findings

1. **`scripts/bench-a13-postready-lazy.py:67-69` — the committed harness still computes the upper
   median, i.e. it ships the exact defect this PR corrects.** `lazies[len(lazies) // 2]` on n=8
   returns the 5th element (190), not `(4th+5th)/2` (164) — this is the origin of both "190 ms" and
   "29 ms". The prose is now right; the instrument is not. Anyone acting on the ADR's own
   "re-measure" caveat gets 190 back. Same for `median_first_ms` / `median_warm_ms`. Fix is one
   line (`statistics.median`).
2. **`scripts/bench-a13-postready-lazy.py:4-5` — the retracted claim is committed verbatim in the
   header comment:** "Wake via /api/health (Knative queues it until Ready; **the app graph is
   untouched**)". `record:20-25` corrected precisely this sentence at 2adbf10. A stale claim in a
   new file outlives the record that retracted it.
3. **`record:96-97` — "3/8 first visitors silently seeing zero-stats fallback content" is
   contradicted by this commit's own table and `record:82`.** Cycle 2 returned the **success** body
   (14240); only cycles 6/8 (14232) rendered the fallback. It is **2/8**. `record:87` already
   hedges correctly ("2-3 of 8 first connections stalled"); this line did not get the update.
4. **ADR:1061-1062 did not receive round 3's qualifications.** It still summarises all three tail
   cycles as "the database path (the pool's deliberate 15 s **cold-wake** `connectionTimeoutMillis`,
   then **a fallback render**)". Per the record now: cycle 2 was not a fallback and its DB
   attribution is explicitly inference, and `record:86-88` states these were "NOT simple
   cold-database wakes" because keepwarm was running. The ADR is the durable artifact; it should not
   assert what the record withdrew.
5. **The newly-published run 1 quantifies an instrument noise band the record does not
   reconcile.** On a cache-served route where true lazy ≈ 0, the same harness produced **−120 and
   +120 ms**. If that is the noise floor, it is the same order as the signal (131 / 164 ms) and the
   "18–35% margin" reads very differently. There is a good counter-argument available — run 2's warm
   renders are tight (526–555, a 29 ms spread) so run 2 was evidently quieter — but the record makes
   neither the observation nor the rebuttal. For a criterion the record itself calls a knife-edge,
   quantifying the instrument's own dispersion is the missing limitation.
6. **`scripts/bench-a13-postready-lazy.py:17-21,46-50` — `subprocess.run` return codes are never
   checked.** A failing `kubectl` yields empty stdout → `pods()` returns `[]` → the wait loop exits
   immediately and the harness measures a **warm pod as a cold cycle**. A tooling failure silently
   fabricates a sample rather than aborting — the failure mode this repo names explicitly ("a
   checker that goes green when it cannot reach upstream is worse than none"). Add `check=True`.
   (No injection risk: no `shell=True`, args passed as a list, no credentials in the file. The
   hardcoded context/URL and `/dashboard` path are fine but mean run 1's `/` variant is not
   reproducible from the committed file.)

## Carried over from round 2, still open (all minor)

7. **`record:104` — "the margin is real on every defensible statistic"** is still stronger than the
   data: over all eight cycles the mean is 4323 ms and p75 > 3.4 s. True only for tail-robust
   statistics; say so.
8. **`record:109-110` still says "an order of magnitude under … ~1.2 s"** — 1200/164 = 7.3×, and the
   ADR has already been softened to "well below … not like-for-like" (ADR:1055). Record and ADR now
   disagree in strength; align the record to the ADR.
9. **`record:83` quotes 18–35% from the two medians**; the closest clean sample is 190 vs the 200 ms
   bar — **5%**. In a paragraph titled knife-edge, the 5% figure is the conservative one and is
   already in the table.
10. **`record:22` — "the operator wires the readiness probe to this same path" is a default**, not an
    invariant: `nextapp_controller.go:744-746` honours `spec.healthCheckPath` first. One clause
    ("absent `spec.healthCheckPath`") closes it.

## Assessment

Items 1, 2 and 6 are in the harness and are the ones I would not merge without — a committed
instrument that reproduces the defect the commit message is about, and that turns a `kubectl`
failure into a fabricated cold sample, is worse than no committed instrument. Items 3 and 4 are
two-line propagation fixes of this commit's own conclusion. 5 is the one judgement call worth a
paragraph. 7–10 are wording.

**Test quality:** materially improved — the record now publishes both runs, its byte evidence, its
own contradiction, its limitations, and its harness, and it withdraws claims rather than defending
them. The remaining weakness is that the harness is documentation of the method rather than a
trustworthy re-run of it (upper median, no return-code checks, stale header comment).

---

# Round 4 — @ 5c4cfa3

**APPROVE.**

All ten round-3 findings verified fixed against the tree, including the three I would not have
merged without.

**Harness (the blocking three):**
- `bench-a13-postready-lazy.py:72-77` — `statistics.median` on all three summary stats, with a
  comment naming the index form as the origin of 190/29. Re-running now reproduces 164/22 rather
  than regenerating the defect. ✓
- `…py:2-9` — header rewritten to the corrected claim (health slice evaluated, production-faithful,
  "absent spec.healthCheckPath"). The retracted sentence is gone. ✓
- `…py:16-24,51-56` — `check=True` on both `kubectl` calls, comment naming the fabricated-cold-sample
  failure mode, and the `if out.strip() else []` swallow removed so a malformed response raises
  rather than silently returning "no pods". Correct direction: fail loudly. Bonus: `MEASURED_PATH`
  via argv makes run 1's `/` variant reproducible from the committed file, and the wake stays pinned
  to `/api/health`. Still no `shell=True`, list args, no credentials. ✓

**Propagations:**
- `record:97-99` — **2/8** with "(cycles 6/8; cycle 2 served the real page slowly)". Matches the
  table and `record:82`. ✓
- ADR:1061-1065 — now splits the tail correctly: two exhausted the timeout and rendered the
  fallback, "the third served the real page slowly (inference, not separately evidenced)", plus
  "NOT simple cold-database wakes … attribution open, feeds #779/#781". The ADR no longer asserts
  what the record withdrew. ✓ (Either reading of cycle 2 — slow connect or SKS stall — leaves the
  exclusion from the entry's lazy cost intact, which is the load-bearing part.)

**Judgement call (my finding 5):** `record:133-138` now states the ±120 ms band from run 1, that it
is the same order as the signal, the counterweight (run 2 warm spread 29 ms vs run 1's 1035 ms), and
lands on "a single sample from this harness should be read as ±100 ms class noise, which is exactly
why the knife-edge framing and the re-measure caveat are load-bearing". That is the honest version —
it makes the instrument's dispersion an argument *for* the caveat rather than hiding it.

**Wording:** 5% closest-clean-sample stated (`record:102-104`); "every defensible" scoped to
"every tail-robust statistic" with the ~4.3 s mean named and why mean/p75 answer a different
question; "order of magnitude" replaced by "well below … 430 ms–1.2 s across sittings; no
cross-sitting ratio is like-for-like", aligned with ADR:1055; readiness path qualified with "by
default … absent a `spec.healthCheckPath` override — none is set on fm-node". ✓

**Cosmetic only, not a blocker:** `record:138` is 174 chars where the file otherwise wraps near 100
(the Limitations insert ran into the following sentence). No markdown linter in the repo and the ADR
already carries 320 such lines, so this is style, not a gate.

**Assessment.** Over four rounds this record went from a headline statistic that was the wrong
percentile, an unsupported byte "tell", an inadmissible cross-sitting ratio and a half-open item
marked DISCHARGED — to a record that publishes both runs, its own contradiction, its instrument's
noise floor, the counter-sample that argues against its verdict, and a harness that cannot silently
reproduce either the statistical defect or a fabricated cold cycle. The remaining uncertainty (n=8,
one route, one day, a 5% margin on the closest clean sample) is now stated by the artifact itself
rather than found by a reviewer, which is the correct end state for a knife-edge discharge.

**Test quality:** docs + instrument; the measurement is the test, and it is now reproducible from
the committed harness, with its statistics derivable from published per-cycle data and its failure
modes made loud rather than silent.
