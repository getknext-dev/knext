ISSUES_FOUND

# Adversarial code+spec review — PR #795 (docs/benchmarks/cold-start-ledger.md)

Docs-only, 51 new lines. Every number below was recomputed with `statistics.median`
(the same function the instrument uses, per `scripts/bench-a13-postready-lazy.py:76`)
against the raw 8-cycle data, and every cross-reference was opened.

## Issues, by severity

1. **cold-start-ledger.md:22 + :39-42 — "6/8 cycles 1.7–8.9 s over warm" is 7/8, and the
   exculpatory claim it supports rests on n=1.** Row-1 lazies sorted:
   `[98, 1714, 1955, 2555, 6883, 7565, 8555, 8896]`. Seven values lie in [1714, 8896]; only
   cycle 1 (98 ms) is clean. Either the count is 7/8 or the range must start at 2.0 s — as
   written the two halves contradict each other. This is not cosmetic: line 40 claims
   "row 0's non-stalled cycles and row 1's non-stalled cycles are alike (~630–750 ms)", and
   row 1 has exactly **one** cycle in that band (first = 629 ms). Its second-fastest is
   2249 ms — 3× row 0's clean band (624–728 ms). The "6/8" figure makes it read as though two
   clean cycles were compared. **Why it matters:** that comparison is the entire basis for
   "not because iteration 1 regressed it" and for the "different diseases, same symptom"
   framing. On n=1 that conclusion is not supported by this sitting; the honest statement is
   "cannot distinguish a regression from a wider tail at n=8, 1 clean cycle".

2. **cold-start-ledger.md:21 — row 0's "first median 728" is wrong; the true median is 699.**
   Row-0 firsts (A13 record table, run 2): `670, 3961, 624, 728, 649, 15617, 663, 15987` →
   median 699. 728 is cycle 4's *value*, not the median. The A13 record states no first-median
   at all (it states median **lazy** 164 and unstalled 70–190), so the ledger's row-0 number
   matches neither the record nor the arithmetic. The instrument's own source comment
   (`bench-a13-postready-lazy.py:72-74`) warns about exactly this class of median defect —
   "the instrument must not reproduce the defect its record corrects". **Why it matters:**
   728 → 5252 is the headline of both the doc and the PR body; the baseline term is inflated.

3. **cold-start-ledger.md:22 — row 1's "wake median 4462" matches nothing in the data.**
   Wakes `[5183,4817,4376,4400,5048,4156,4500,4323]` → median **4450**, upper-median 4500,
   mean 4600. Row 0's 4050 is likewise 4049 rounded up. The instrument emits no wake median
   (`:75-79` prints lazy/first/warm only), so both wake cells are hand-computed and unchecked.
   **Related and unmentioned:** every row-1 wake (min 4156) exceeds row-0's median (4049) and
   four exceed row-0's *max* (4227) — a systematic ~400 ms wake shift the ledger never
   acknowledges while asserting iteration 1 did not regress anything.

4. **cold-start-ledger.md:22, :36-37 — the DNS attribution conflates a TCP failure with a DNS
   one.** "`EAI_AGAIN pggw-apps…` + ioredis `connect ETIMEDOUT` on the pod's first **UDP**
   flows". `EAI_AGAIN` is a resolver error and does support the DNS story; ioredis
   `connect ETIMEDOUT` is a **TCP** connect timeout — resolution has already succeeded by then
   (a resolver failure surfaces as `EAI_AGAIN`/`ENOTFOUND`, which is what the PG line shows).
   Calling both "UDP flows" is factually wrong and doubles the apparent evidence for the
   named next lever. Either de-conflate (DNS: PG; TCP-connect: Redis, cause unproven) or show
   the Redis-side resolver error.

5. **cold-start-ledger.md:22 — "attributed with pod-log evidence" covers 2 of 7 tail cycles.**
   The two `~9 s` cycles (firsts 9091, 9421) are the ones with fallback bodies (14232 B) —
   that part checks out. But cycle 8 stalled 7421 ms with a **SUCCESS** body, and the 1.7–3.1 s
   cycles have no cited evidence at all. The doc (and the PR body's "the residual 1.7–8.9 s
   tail is attributed with pod-log evidence") generalises a 2-cycle observation to a 7-cycle
   tail. Scope the claim to the cycles it covers.

6. **cold-start-ledger.md:38, :51-52 — `ndots:5` is asserted, never verified, and the
   "5 wasted UDP round-trips per lookup" arithmetic does not derive.** Nothing records a
   `/etc/resolv.conf` from a fresh fm-node pod. Taking the standard ClusterFirst search path
   (`<ns>.svc.cluster.local`, `svc.cluster.local`, `cluster.local`), a 3-label name below
   ndots:5 costs **3** wasted attempts before the absolute try — 6 wasted *queries* if A+AAAA
   are counted. "5" is neither. Since lever 1 is chosen on this number, state the derivation
   or drop the figure. (The trailing-dot form in lever 1 is correct — the 5-label FQDN without
   the dot would still walk the path at ndots:5.)

7. **cold-start-ledger.md:22 — "CoreDNS itself healthy (<1 ms)" is a 60-line log sample and is
   structurally blind to the hypothesised failure.** CoreDNS logs only queries that *arrived*;
   a fresh-pod UDP race drops packets before they arrive, so <1 ms server-side latency neither
   confirms nor excludes it. Record the sample size and the limitation, or the reader inherits
   a stronger claim than the check can make.

8. **cold-start-ledger.md:31-34 — the `scaleDownDelay` proof has no control arm, and t+90 s is
   not clearly "past the default park point".** Knative default is a 60 s stable window **plus
   a 30 s scale-to-zero grace period** ≈ 90 s to termination, so a hit at t+90 s is *at* the
   default boundary, not past it. The stated contrast (354 ms vs 5063 ms cold) is against a
   cold start, not against the same drill with the delay absent — which is the comparison that
   would prove the delay caused the hit. (The 220 s park is fine and consistent: 60 + 120 + 30
   = 210 s; showing that arithmetic would help.)

9. **cold-start-ledger.md:19-22 — neither row records which path was measured, and row 1 has no
   backing record.** The instrument takes a path argument (`:15`, default `/dashboard`) and the
   A13 record proves the answer swings by 7× with it (run 1 `/` median lazy 22 ms vs run 2
   `/dashboard` 164 ms). Row 0 links to a full per-cycle table; row 1 publishes three medians
   and a tail count with no per-cycle data anywhere in the repo — which is precisely why
   issue 1 above is invisible to a future reader. For a file whose stated purpose is "the
   loop's memory", each row needs its path, its N, and either a per-cycle table or a linked
   record.

## Verified clean (checked, no issue)

- Row 0 warm median 539 (538.5) ✓; row 1 warm 533 ✓; row 1 first 5252 (5251.5) ✓.
- Row 0 "3/8 cycles 3.4–15.4 s" matches lazies 3434/15061/15448 ✓.
- "two `EAI_AGAIN`/fallback at ~9 s" matches the two 14232-byte cycles ✓.
- All references exist and say what is claimed: **#790** carries the 2026-08-20 mechanism-revision
  comment with the peer-awareness/`postponing sleep` evidence and the "~35×/h under pings →
  postponed 100% under one held connection" figures ✓; **#792** (stale Prometheus config) ✓;
  **#794** (imagePullSecrets — PR-body only, absent from the doc) ✓; **#751** (no knext operator
  on OKE) ✓; the A13 record exists and its per-cycle table matches the row-0 cells except as
  noted in issue 2 ✓.
- Instrument path `scripts/bench-a13-postready-lazy.py` exists and does what the header says
  (8 cycles, per-cycle image-pull events, `lazy = first − min(warm1, warm2)`) ✓.
- No secrets, no `:latest`, no shell-injection surface, no code change. Security rules N/A.

## Test quality

Docs-only, so no tests are expected and none are weakened — but the ledger is a *measurement*
artifact whose only guard is arithmetic, and three of its six published medians (row-0 first,
row-0 wake, row-1 wake) do not reproduce from the raw data; the row-1 raw data is not in the
repo at all, so nothing but this review can check it.

---

# Round 2 — verdict on 9573bf4 (554ccb8..9573bf4)

**ISSUES_FOUND** — 7 of 9 findings are genuinely fixed; one fix **introduced a new arithmetic
error in a number that was correct in round 1**, and the new per-cycle table does not reconcile
on one row. Both are in the same class the round-1 review was about, so neither is waivable.

## Blocking

1. **`cold-start-ledger.md:15` — row 0's warm median is now `528`; the correct value is 539
   (538.5). This is a REGRESSION: round 1 had it right.** The A13 record's warm-best column is
   `539, 527, 553, 538, 536, 555, 526, 539` → `statistics.median` = 538.5. `528` appears nowhere
   in the data. **Why it matters beyond the 11 ms:** it inverts the only cross-row warm signal.
   True 538.5 → 533 means warm rendering got marginally *faster* between sittings; as published,
   528 → 533 reads as a warm regression, and a future iteration could go chasing it. This is
   exactly the successive-round regression class `workflow.md` names ("three consecutive rounds
   each fixed the previous round's defect and introduced the next").

2. **`cold-start-ledger.md:25` — row 1's per-cycle table does not reconcile on cycle 4.**
   `first 2749 − warm 538 = 2211`, but the lazy cell says `1955`. Every other row closes to
   ±1 ms (cycle 2's 9091−537=8554 vs 8555 is pre-rounding, fine). So one of cycle 4's three
   cells is wrong — most likely the lazy column was assembled by rank from the instrument's
   *sorted* `lazies` output rather than computed per row, which is right 7 times and wrong once.
   **Why it matters:** the table's own new heading is "the loop's memory must be derivable", and
   this row is not derivable from itself. (Neither the 7/8 tail count nor any median moves:
   2211 is still >1.7 s and the lazy median is 4719 either way — so this is integrity, not
   headline. Fix the cell, or publish the instrument's raw JSON lines verbatim.)

## Verified fixed (re-derived, not taken on trust)

- Row 0 wake **4049** ✓, first **699** ✓ (both now match `statistics.median` of the A13 table);
  row 1 wake **4450** ✓, first **5252** (5251.5) ✓, warm **533** ✓.
- Tail is **7/8** with "only cycle 3 (98 ms) is clean" — matches the published table exactly ✓.
- The no-regression claim is rewritten to what n=1 supports: "different diseases is the supported
  claim; 'no regression' is not, at n=8 with one clean cycle" (`:60-66`) ✓. This is the finding
  I cared most about and it is now stated correctly, including the n=1 label on the 629 ms cycle.
- The +400 ms wake shift is carried in its own block (`:31-34`) with a candidate cause and an
  explicit "unattributed; carried, not hidden" ✓.
- Attribution de-conflated (`:16`, `:52-59`): `EAI_AGAIN` = DNS on the PG path; ioredis
  `ETIMEDOUT` = TCP, "resolution had succeeded there, cause unproven"; evidence scoped to the two
  fallback cycles with the 7.4 s SUCCESS render called out as unattributed; the CoreDNS sample is
  named "structurally blind to dropped-before-arrival packets, so it bounds nothing" ✓. That last
  sentence is stronger than what I asked for and is correct.
- `scaleDownDelay` (`:43-51`): 30 s grace boundary correction, `60+120+30 = 210 s` arithmetic,
  "no control arm", and "exercises the knob … without proving the delay caused the t+90 s hit" ✓.
- **ndots — independently re-verified by me on the live plane**, not accepted from the diff.
  `kubectl --context context-ckmva7v7zvq exec -n default pg-keepwarm-filemanager-… --
  cat /etc/resolv.conf` returns exactly:
  `search default.svc.cluster.local svc.cluster.local cluster.local knext.oraclevcn.com
  nodes.knext.oraclevcn.com` / `options ndots:5`. Five entries, two of them OCI VCN domains — so
  "5 wasted name attempts = 10 queries with A+AAAA" is right, the "leaves the cluster for OCI's
  resolver" note is right, and the trailing-dot correction (`:78-80`, the 4-dot FQDN still walks
  the path) is right ✓.
- Path + n now recorded on both rows ✓; row 1 publishes its full per-cycle table ✓.

## Non-blocking nit

- `:50-51` — "The pre-merge kind e2e and the earlier spike measurements carry the causal claim"
  names no PR, test file, or record. Every other pointer in this doc is citable; this one should
  be too, or a future reader inherits an unfindable warrant.

## Test quality (round 2)

Still docs-only, and arithmetic is still the only guard — which is why it must close: of the six
published medians, five now reproduce exactly and one (row-0 warm) newly does not, and the freshly
added per-cycle table fails its own subtraction on one of eight rows. Fix those two cells and this
is an APPROVE.

---

# Round 3 — verdict on 8919e9d

**APPROVE.** Both blocking cells are fixed, and the correction to my diagnosis is right — I
checked it rather than accepting it.

## Re-derived

- **Cycle 4: the wrong cell was warm-best, not lazy — confirmed.** With `warm1=794, warm2=1321`,
  `min = 794` and `2749 − 794 = 1955`, so the published lazy was correct all along and the row
  now closes. All eight rows reconcile to ±1 ms (cycle 2's 8554/8555 is pre-rounding).
- **Row-1 warm median is unaffected at 533** — mins `525,527,530,531,535,537,538,794` →
  `(531+535)/2 = 533` ✓. The outlier sits above the median, so it cannot move it.
- **Row-0 warm restored to 539** (538.5) ✓. All six published medians now reproduce from the raw
  data with `statistics.median`.
- **Citations exist and support the claim:** `docs/adr/0045-scale-down-delay.md` carries the
  **~52 ms in-window** figure verbatim (`:19`) and names the file-manager spike records (`:14`);
  `preview_annotation_disposition_test.go` exists and does reference the annotation (4 hits).
- ndots/resolv.conf claim stands as re-verified live in round 2.

## Two nits for whoever touches this next (not blocking, do not re-round for them)

1. **Cycle 4's warm best of 794 ms (warm2 1321) is the only warm above 538 in the row, and that
   is substantive, not cosmetic.** It means the disturbance in that cycle **outlived the first
   request** — both warm renders were degraded too. That mildly complicates the "fresh-pod first
   request" framing, and since the row's whole point is derivability, one clause noting it would
   preempt the next reader deriving it themselves and wondering what was suppressed.
2. **Citation precision:** the **2.28 s** true-cold median lives in
   `docs/benchmarks/fm-confirmatory-prepulled-ab-2026-08-18.md:139` (n=5, confirmed-zero), not in
   ADR-0045 — the ADR states the **2.1–2.7 s** range and points at those records. The attribution
   is substantively right, just one hop off. Likewise `scale_down_delay_test.go` is the more
   direct test citation than the preview-annotation file.

## Test quality (final)

Docs-only; arithmetic was the only available guard and it now closes completely — six of six
medians, eight of eight per-cycle rows, and every cross-reference opened and confirmed to say
what is claimed. Three rounds, each defect real and each fix verified against the raw data rather
than the commit message.
