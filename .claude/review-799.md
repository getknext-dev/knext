APPROVE (final, round 3 on 064df58 — round 1 ISSUES_FOUND, round 2 ISSUES_FOUND; both closed below)

# Adversarial review — PR #799 (ledger row 2 + in-cluster A13 harness)

Standard applied: `.claude/review-795.md` (three rounds). Every published number below was
recomputed with `statistics.median` from the raw 8-cycle data; every cross-reference was opened;
the new harness was read against the workstation harness it replaces
(`scripts/bench-a13-postready-lazy.py`, on `main`).

## Blocking

1. **`cold-start-ledger.md` row 2, wake cell — `4990` matches nothing in the data.**
   Wakes `[5348,5866,4844,4735,5446,3818,4130,5143]` → `statistics.median` = **4993.5**
   (upper-median 5143, mean 4916.25). This is *literally* review-795 issue 3 recurring
   ("row 1's wake median 4462 matches nothing"), and for the same root cause, which this PR had
   the chance to close and did not: **the instrument still does not emit a wake median**
   (`bench-a13-postready-lazy-incluster.py:93-100` prints lazy/first/warm only), so the wake cell
   is the one hand-computed, unchecked number in every row. Fix the cell *and* add
   `median_wake_ms` to the summary — otherwise row 3 gets it wrong too.
   *(All other row-2 medians reproduce exactly: first 226 ✓, warm 125 ✓, lazy 103 ✓, and all
   eight per-cycle rows reconcile to ±1 ms.)*

2. **The +544 ms wake shift row 1 → row 2 is unacknowledged — the exact check row 1 ran on
   itself.** Row-1 wake median 4450 → row-2 4993.5. The row asserts "**Wake stays comparable**
   (dominated by in-cluster scheduling/boot, not RTT)" and, one sentence earlier, that rows 0–1
   carry "~400 ms of WAN+ingress RTT per sample" — the wake sample is an HTTP GET like any other,
   so by the row's own accounting the RTT-adjusted wake shift is ~**+950 ms**. Row 1 carries a
   dedicated "Unacknowledged-shift check, run on this row deliberately" block for a smaller
   (+400 ms) move; row 2 declares wake comparable and then does not run the check. Either run it
   (with a candidate cause, "carried, not hidden") or withdraw the comparability claim.
   Cheap de-confounder that is already collected and thrown away: the harness captures per-cycle
   `Pulled/Pulling` events (`:65-73`) and the file header advertises "per-cycle image-presence
   evidence", but no row publishes the column. If any cycle pulled, that is the wake shift.

3. **The instrument change inserts a confound in the direction of the headline, and the row does
   not state it.** The row's defence is "kubectl-exec overhead is excluded: the milliseconds
   printed are measured in-pod around the HTTP call only" (`:31-35` of the harness). That is true
   of each *sample* and false of the *experiment*: A13's metric is "the **first** GET on the
   fresh, ready process", and moving to `kubectl exec` inserts ~0.5–2 s of dead time (apiserver
   round trip, exec setup, a fresh interpreter start in-pod) **between the wake response and the
   measured first GET** — wall-clock in which post-readiness lazy work, DNS retries and pool
   warmup can finish before the thing that is supposed to pay for them is issued. Under the
   workstation harness the same gap was one in-process `urlopen` turnaround. This shrinks `lazy`
   for a reason that is not the lever, it is unbounded, and it is invisible in the published data
   because the harness records no wall-clock timestamps around the execs. It cannot explain the
   7–9 s row-1 cycles, but it can plausibly account for the low end of row-1's tail
   (1.7/1.95/2.5 s), which is 3 of the 7 tail cycles. State it, and bound it (printing the gap
   costs two lines).

4. **"`lazy` (first − warm) is the cross-row comparable, since both terms share whatever path the
   sitting used" is refuted by the counterexample in the same paragraph.** The discarded sitting
   had "median 'lazy' **10218 ms** with 90 s *warm* renders" — both terms shared the path there
   too, and the difference still carried ~10 s of instrument. So sharing a path makes RTT cancel
   *in expectation*; it demonstrably does **not** make `lazy` immune to path pathology, which is
   the failure mode row 1's sitting is suspected of. The honest form is narrower: *lazy is the
   least incomparable of the three, and it is not protected against a degraded path* — with the
   discarded sitting cited as the proof of that limit rather than as a footnote. As written, the
   4719 → 103 headline is a lever effect and an instrument change measured together, and the
   paragraph asserting the confound away is the one place a reader would look for it.

## Should fix

5. **The ~400 ms RTT explanation for warm 533 → 125 is fitted from the difference it explains.**
   533 − 125 = 408, so "~400 ms" is the residual relabelled as a cause; nothing in the ledger
   measures the workstation→ingress RTT for the row-1 sitting. The only nearby independent number,
   "372 ms probes", is introduced as a property of the **degraded** window and so cannot be
   applied to row 1. Downgrade to "consistent with", or cite an RTT measurement with its own
   provenance. (Also imprecise: row 2 still traverses the ingress/LB — it hairpins to the same
   public sslip.io URL — so only the WAN term was removed, not "WAN+ingress".)

6. **The header block (`:5-11`) is now false for row 2 and was not touched.** It names
   `scripts/bench-a13-postready-lazy.py` as *the* instrument and says "all times ms, **from the
   workstation over the public URL**". A file whose stated purpose is the loop's memory cannot
   have its global instrument note contradicted by its newest row; name both harnesses and scope
   the workstation clause to rows 0–1.

7. **The discarded sitting is the sole warrant for discarding a full sitting, and its numbers are
   not in the repo** ("raw lines preserved in the session records"). This is the same unfindable-
   pointer class as the round-2 nit in review-795, but load-bearing rather than decorative: a
   reader cannot check whether the sitting was invalid or merely inconvenient, and "one sitting
   discarded" is precisely the operation that, unchecked, turns a measurement loop into a
   selection process. Publish its per-cycle lines (8 rows, ~10 lines) as row 2's appendix.

8. **"the re-mint the row-1 caveat required" — row 1 carries no such caveat.** Grepping the
   merged ledger, row 1 (and its analysis) never mentions the hand-made benchmark Secret or a
   re-mint; that caveat lives in **#796's body** ("the hand-made file-manager Secret must be
   re-applied by hand"). Cite #796, not row 1, or the pointer is unfollowable.

9. **#796 is still OPEN, and the row pins causation to a PR number rather than to what was
   running.** #796's own body says "the end-to-end runtime proof lands in the lead's OKE
   measurement" — this row *is* that proof, so it must record the deployed state it verified (the
   rooted DSN actually read back from the pod's env/Secret, and the commit SHA that was applied),
   not a PR reference whose branch can still change before merge. This repo has twice attributed
   behaviour to source that was not what the cluster was running.

10. **Retry semantics can silently convert a cold sample into a warm one, in the headline's
    favour.** `timed_get` (`:44-57`) retries whenever the exec returns non-zero **or** prints
    nothing — it cannot distinguish "exec died before the request" from "the request completed
    and the exec's output was lost". On the `wake` or the measured `first` call, the retried
    sample is the *second* request to that pod, so `first` (and `lazy`) collapse for instrument
    reasons. This run is clean (`workstation_retries` 0) — but the row does not publish that, and
    that counter is the only evidence the bias did not occur. Publish it per row, and consider
    aborting the cycle rather than retrying the wake/first calls (the `pods()` comment already
    reasons exactly this way about not silently measuring a warm pod as cold).

11. **The instrument is not reproducible from the repo.** `bench-timer` appears nowhere outside
    this script — no manifest, no creation code, no documented image or that `python` is on its
    PATH; a future reader cannot re-run row 2. Related: the docstring's `Usage:` line still names
    `bench-a13-postready-lazy.py` (the workstation script), not this file.

12. **Iteration-3 pointers vs what the rows establish — lever 1 is half-taken and reads as
    untaken.** The candidate list still opens with "1. **Rooted FQDN (trailing dot) in every
    platform-minted hostname**" unannotated, while row 2 names "the still-unrooted app-level Redis
    host" as a residual candidate — i.e. lever 1 was taken for the *platform-minted PG* path only.
    Annotate it (taken in #796 for minted DSNs; app-level Redis / `ZONE_GATEWAY_HOST` / gateway
    dial targets still open) so iteration 3 does not re-derive the split.

## Nits (do not re-round for these)

- Document order now reads row 2's analysis **before** "## Iteration 1 — what was proven", and
  there is no "Iteration 2 — what was proven" heading paralleling iteration 1's.
- The tail column reads "2/8 cycles 3.6 / 5.5 s"; those are *lazy* values (firsts are 3.7/5.6 s)
  under a column headed "first tail". Row 1 said "over warm" explicitly; row 2 dropped it.
- `x-nextjs-cache` is collected per cycle and never published; for the two residual cycles it is
  exactly the discriminator between "slow dependency" and "MISS vs HIT".
- `subprocess.run` on the exec has no `timeout=`; the in-pod `timeout=180` does not bound a hung
  exec, so a sitting can hang indefinitely.
- `MEASURED_PATH` (argv) is string-concatenated into the in-pod `python -c` source. No shell is
  involved (argv-array `kubectl exec`), the URL is a hardcoded public host with no credential, and
  the two paths used are safe — but a `'` in the argument breaks the in-pod program and burns all
  three retries. Validate the path (`^[A-Za-z0-9/_\-.?=&]+$`) or pass it via `sys.argv` after `-c`.

## Verified clean (re-derived, not taken on trust)

- **All eight per-cycle rows reconcile**: `first − warm-best = lazy` to ±1 ms on every row
  (cycles 2/4/5/6 are the ±1 pre-rounding cases). Bodies all 14240 = the SUCCESS length row 1
  established (fallback 14232), so "no fallbacks" and "both SUCCESS" hold ✓.
- **`4719` matches the merged ledger's row 1** — `[98,1714,1955,2555,6883,7565,8555,8896]` →
  (2555+6883)/2 = 4719 ✓. "6/8 in a 90–122 ms band" ✓ (`90,95,98,101,105,122`); "row 1's ONE clean
  cycle" ✓; "2/8 at 3.6/5.5 s" ✓ (3591/5465).
- **No keep-alive asymmetry across the instrument boundary** (the lead's question): the workstation
  harness calls `urllib.request.urlopen` per sample, which opens a fresh `HTTPConnection` and sends
  `Connection: close` — no reuse in-process; the in-cluster harness spawns a fresh interpreter per
  sample, so likewise none. Both use `timeout=180`, so the tail-censoring threshold is identical
  and no cycle is truncated differently across rows ✓. (The in-cluster client also re-resolves the
  ingress name per sample, but that host is 6-dot ≥ `ndots:5` → absolute-first, no search walk, and
  it is paid by `first` and `warm` alike.)
- **KCTX is correct** — `KCTX + [...]` at all three call sites (`get pods`, `exec`, `get events`);
  no slicing, no shell. `check=True` retained on `pods()`/events with the stated abort rationale;
  `statistics.median` used, with the comment explaining why the index form is wrong ✓.
- Candidate attributions are labelled candidates, and the n=8/tail-frequency caveat ("a
  distribution shift consistent with the lever, not a proof the residual is zero") is the right
  strength ✓. Path and n are recorded on the row ✓ (review-795 issue 9 stays fixed).
- Security: no secrets, no `:latest`, no shell string-building, no cluster mutation (read-only
  `get`/`exec`), nothing published to logs beyond timings ✓.

## Test quality

Docs + an uncommitted-until-now instrument, so arithmetic and instrument-reading are the only
guards. Three of four row-2 medians and eight of eight per-cycle rows reproduce exactly — but the
one median the instrument still refuses to compute (wake) is wrong again, in the same cell class
that was wrong in #795, which is the strongest available argument that the fix belongs in the
harness rather than in the cell. The harness itself has no self-check at all: no guard that a
retried sample is discarded, no wall-clock gap recorded, no `bench-timer` precondition asserted.

---

# Round 2 — verdict on ab9cf77 (da4d859..ab9cf77)

**ISSUES_FOUND** — all four blocking findings and all four should-fixes I flagged are genuinely
fixed, and I re-derived each rather than accepting the summary. But **the fix to finding 7
(publish the discarded sitting) introduced a claim that no committed instrument can produce**,
and the fix to finding 3 instruments a quantity that is not the one its own comment defines. The
first is blocking; it is the successive-round class `workflow.md` names, and it is one sentence
from closed.

## Blocking

1. **`cold-start-ledger.md` (discarded-sitting block) — "3 SYN-timeout retries" cannot have come
   from the workstation harness, so the discarded sitting's provenance is now unresolvable.**
   `scripts/bench-a13-postready-lazy.py:30-35` has **no retry loop, no retry counter, and no
   `except` anywhere in the file** (`timed_get` is a bare `with urlopen(...)`): a SYN timeout there
   raises `URLError` and kills the run mid-sitting. It cannot complete 8 cycles *and* report
   retries. Only the in-cluster harness has `RETRIES`. So either:
   - **(a) the discarded sitting was run in-cluster** — in which case the 92 s figures are *in-pod*
     durations, the workstation WAN was by construction outside the measured interval, and the
     block's framing ("the workstation WAN degraded … one full sitting discarded as
     instrument-invalid", "**Forced, not chosen**") is wrong about the mechanism. In-pod 90 s
     transfers to the public `sslip.io` URL implicate the LB/ingress hairpin — a path row 2 also
     traverses — which would make the discard **data selection on a misbehaving plane**, not
     instrument correction, and would mean row 2's own instrument is not immune to it; or
   - **(b) it was run with an uncommitted workstation variant** — in which case the numbers now in
     the ledger were produced by code that is not in the repo, which is the same
     unfindability the fix was meant to remove, one level down.
   Name the harness (and the commit) that produced the discarded sitting, and if it was the
   in-cluster one, re-justify "instrument-invalid" against in-pod timings. *(The arithmetic itself
   checks out: `statistics.median([-81223,-67544,3768,4264,16172,17991,91327,92298])` = **10218** ✓,
   and the two negative lazies are consistent with the 81–92 s warm renders — publishing these was
   the right call and they make the point better than the prose did.)*

## Should fix (not blocking)

2. **`bench-a13-postready-lazy-incluster.py:67-73` — `exec_gap_ms` measures the first exec's own
   overhead, not the gap the comment defines.** With the wake exec returning at `T0`, the in-pod
   request running for `d`, and the exec returning at `T1`, the printed value is
   `(T1−T0) − d = first-exec setup + first-exec **teardown**`. The confound interval is
   `wake-exec teardown + first-exec setup` — the trailing teardown it includes happens *after* the
   measurement and the wake teardown it omits happens *before* it. The two are similar in
   magnitude, so it is a serviceable proxy, but the comment claims it is "wall-clock between the
   wake response and the first measured GET being issued", and it isn't. Either take a monotonic
   stamp inside the wake exec's output (the in-pod program can print its own `t_end`) or relabel
   the field as `first_exec_overhead_ms` so row 3 bounds the confound with an honestly-named
   number. *(Genuinely good side effect, worth keeping: a retried first call inflates this value,
   so a contaminated cycle is now visible.)*
3. **The pull column is *stated*, not published — so the exclusion is unfalsifiable.** "image pulls
   are EXCLUDED as a cause (… read 'already present' on all 8 cycles)" is prose about data the
   harness collected and the row still does not carry, in the one file whose standard is "the
   loop's memory must be derivable". Cluster events are gone after ~1 h, so nobody can ever check
   it. It is one column of already-collected strings; the discarded sitting got exactly this
   treatment two paragraphs earlier, and the same reasoning applies here. (Note also
   `:66-73` reads events from `p[0]` only and falls back to `pull="?"` when the pod list is
   momentarily empty — the column would show whether any cycle actually got `?`.)
4. **Carry-overs from round 1 that were not in the eight (all still open, all still non-blocking):**
   #9 the row pins causation to **#796, which is still OPEN**, rather than to the rooted DSN read
   back off the pod plus the applied SHA — and #796's body says this measurement *is* its runtime
   proof; #10 `workstation_retries` (0) still unpublished for row 2, now sharper given item 1;
   #11 `bench-timer` still has no manifest anywhere in the repo, so row 2 is not reproducible;
   #12 lever 1 still heads the candidate list unannotated though it is taken for minted PG DSNs.

## Verified fixed (re-derived, not taken on trust)

- **Wake cell `4993.5` ✓** — exact `statistics.median`, and the root cause is closed at the
  instrument in **both** variants (`median_wake_ms` added to the in-cluster summary `:106-108` and
  to the workstation one `:75-77`), which is the fix I actually wanted.
- **Wake-shift check now runs as row 1 ran it ✓** — `+544` raw (4450 → 4993.5, I recompute 543.5)
  and `~+950` RTT-adjusted, "unattributed; carried, not hidden", with candidate causes named and
  the RTT-accounting caveat marked as this row's own.
- **Exec-gap confound named, bounded exactly as framed, and instrumented ✓** — "points toward the
  headline", cannot explain the 7–9 s class, plausibly covers row 1's 1.7–2.5 s low tail (3 of 7),
  unmeasured for row 2, and the headline is restated as "lever effect and instrument change
  measured together" with the beyond-doubt claim narrowed to the disappearance of the failure
  *signature*. That narrowing is the single most important edit in this commit.
- **`lazy` reframed ✓** — "least incomparable of the three, not a protected quantity", with the
  discarded sitting cited as the proof of the limit ("its terms shared a path too"). Exactly right.
- **RTT explanation labelled fitted ✓** ("fitted from the difference it explains … plausible, not
  established"); **header names both instruments ✓** with the ±100 ms noise clause correctly
  scoped to rows 0–1 and the exec-gap caveat forward-referenced; **re-mint citation ✓** — now
  points at #796's measurability note, which I opened: it does say the benchmarked app is in the
  unaffected set and must be re-minted by hand.
- Row-2 medians and all eight per-cycle reconciliations are unchanged and still exact; no secrets,
  no `:latest`, no shell, no cluster mutation.

## Test quality (round 2)

Arithmetic is the only guard and it now closes on every cell, including the wake median that was
wrong twice — and, better, the guard moved into both harnesses so the class cannot recur. What is
left is provenance rather than arithmetic: the newly published discarded-sitting numbers name a
behaviour (retries) that neither committed instrument could have produced for the sitting the
prose describes, and the new `exec_gap_ms` is not the interval its comment defines. Close item 1
and this is an APPROVE.

---

# Round 3 — verdict on 064df58 (ab9cf77..064df58)

**APPROVE.** Both round-2 items are genuinely closed, and I verified the two specific things you
asked me to rather than accepting the summary. Three non-blocking items below — one of them is a
hazard the *fix itself* introduced, so fix it before the workstation harness is next used, but it
touches no published number in this PR and is not worth another round.

## Verified — item 1 (provenance / retry loop)

- **The committed loop can produce exactly the behaviour the discarded numbers imply.**
  `bench-a13-postready-lazy.py:30-52`: 3 attempts per call, `RETRIES["n"]` incremented per failed
  attempt, one logged JSON line each, and `workstation_retries` now in the summary (`:99`). So
  "3 SYN-timeout retries **and** 8 completed cycles" is reachable (retries are per-call, not
  per-sitting), which the previous code could not do — it had no `except` at all and would have
  died on the first timeout, which is precisely what made the claim uncheckable. Case (b)
  confirmed, and closed the right way: by committing the instrument rather than softening the prose.
- **`t0` is re-stamped inside the attempt loop**, so a returned duration excludes time burnt in
  failed attempts — correct for the connect-timeout case the comment justifies. The discarded
  sitting's 92 s values are therefore single completed transfers, not accumulated retries, which
  is consistent with the −81/−67 s lazies published alongside them ✓.
- Ledger provenance paragraph is accurate about the mechanism and honest about the copy; the
  in-pod/WAN distinction ("shares only the LB/ingress hop, not the degraded WAN path") is the
  right correction and is what makes "instrument-invalid" stand.

## Verified — item 2 (gap arithmetic)

`exec_gap_ms = (LAST_CALL["issue"] − wake_done_epoch) × 1000` is now **the defined interval**:
`t_issue` is stamped in-pod immediately before `urlopen` and `t_done` in-pod after `r.read()`
(`:38-56`), both from the same `bench-timer` process family on one pod's clock, so no skew and no
exec setup/teardown asymmetry. Three checks I ran on it:

- The in-pod interpreter start and `import urllib.request` land **inside** the gap (t_issue is
  stamped after the imports) — correct, that dead time is part of the confound ✓.
- `LAST_CALL` is written only on success, so a retried `first` call makes the gap *grow* by the
  failed attempts and their sleeps — a contaminated cycle stays visible rather than being
  smoothed ✓.
- `wake_done_epoch` cannot be `None` (`timed_get` either returns having set `LAST_CALL`, or
  raises) ✓. Both scripts byte-compile.

## Non-blocking (do not re-round; fix before next use)

1. **`bench-a13-postready-lazy.py:44` — `except OSError` is far broader than the justification
   above it.** The comment's warrant is "a connect that NEVER completed sent nothing to the
   activator, so retrying is still a genuine cold wake". True for a connect timeout — but
   `URLError`, `socket.timeout` **and `HTTPError` are all `OSError` subclasses** (verified), so a
   180 s *read* timeout, a mid-transfer reset, or a 5xx is retried under the same banner. In those
   cases the request **did** reach the app: the wake was already triggered, the retry measures an
   already-warming pod, and `wake_ms`/`first_ms` are silently under-reported — the same
   silently-warm hazard I raised for the in-cluster harness, now committed into the workstation
   one by the fix for item 1. Narrow it to the connect phase (or classify and record which failure
   class fired, and refuse to retry `wake`/`first` on a non-connect error).
2. **No `median_exec_gap_ms` in the summary (`:111-117`).** You just closed the "one
   hand-computed cell per row" class by adding `median_wake_ms` to both harnesses, then added a
   new per-cycle-only field that row 3's prose will want as a single number. That is the exact
   shape of the defect that produced the wrong wake cell twice. One line.
3. **Still open from round 2, all still non-blocking:** the pull column is stated, not published
   (cluster events have since expired, so it is now permanently uncheckable); row 2 does not
   publish its `workstation_retries` (0); `bench-timer` has no manifest; #796 is still OPEN and
   the row pins causation to the PR number rather than the DSN read off the pod plus the applied
   SHA; lever 1 heads the candidate list unannotated. Nit: `time.monotonic()` would be preferable
   to `time.time()` for the two in-pod stamps — it is system-wide on Linux, so it is comparable
   across the two execs and immune to an NTP step inside the gap window.

## Test quality (final)

Arithmetic was the only guard available and it now closes on every published cell, with the guard
moved **into both instruments** (`median_wake_ms`) so the recurring wake-cell class cannot repeat;
the discarded sitting's numbers and the instrument that produced them are both in the repo; and
the confound that would have flattered the headline is now measured by construction rather than
argued about. Three rounds, every defect real, every fix re-derived from the raw data and the
source rather than from the commit message.
