# A13 — the node standalone entry's post-readiness first-request lazy cost (OKE, 2026-08-19)

**Question (ADR-0042 action item A13, #765 follow-through):** after the node standalone server
reports Ready, does the first request pay >200 ms of lazy evaluation the vinext entry's
warm-on-boot would have absorbed? >200 ms ⇒ warm-on-boot promotes from target-specific to
contract.

**Answer: no — median of all eight cycles 164 ms; the five unstalled cycles span 70–190 ms
(median 131 ms). Warm-on-boot stays target-specific.** The call is close (164 ms against a 200 ms
bar, n=8 — see the knife-edge note in the Verdict), and the measurement surfaced a heavy tail that
is NOT the entry's lazy cost — it belongs to the database path.

## Methodology (A13's terms: post-readiness, first request, warm image)

- `fm-node` on OKE (`context-ckmva7v7zvq`), the same digest-pinned file-manager image as the
  2026-08-18 A/B, min-scale 0, image **already present on the node every cycle** (verified from
  pod events), PG trickle keepwarm running — which makes the tail section's DB-connect stalls a
  standing contradiction; see there.
- Per cold cycle: wait for 0 pods → wake via `GET /api/health` (Knative queues it until Ready).
  The wake is NOT app-graph-free — the health route evaluates its own slice of the server graph
  (`@getknext/lib/health` + the metrics registry) — but it is **production-faithful**: the operator
  wires the Knative readiness probe to this same path (`readinessProbePath()` → `/api/health`), so
  in production that slice is always evaluated before any user request. The measured lazy cost is
  the incremental residue beyond the health slice — the quantity a real first visitor pays. (An app
  with a fatter health route would measure a smaller residue; re-derive, don't transplant.) →
  time the FIRST `GET` of a page on the fresh, ready process →
  two more `GET`s as the warm baseline. `lazy = first − min(warm1, warm2)`. 8 cycles per run.
- Run 1 hit `/` and invalidated itself: cycle 1 was a genuine render (`x-nextjs-cache: MISS`,
  lazy 213 ms) but cycles 2–8 were served `STALE` from the **shared Redis page cache** written by
  cycle 1 — cache-serve latency, not a render. Published in full so its statistics are derivable
  (lazy per cycle: 213, 29, 15, 9, 33, −120, 120, 3 → **median 22 ms**; the −120 is warm-render
  noise exceeding the first request): for cache-served pages the post-readiness first-request
  penalty is ~nothing.
- Run 2 (the A13 instrument) hit `/dashboard` — fully dynamic (`unstable_noStore()`, no
  `x-nextjs-cache` header, three PG queries per render), so every request is a genuine render.
  (`/observability` was tried first and is auth-gated, 401.)

**Deviation from A13's "natural home":** the item suggested the Phase 1/A2 two-arm sittings,
whose control arm boots this entry anyway. This ran as a dedicated standalone sitting instead,
because the A/B arms measure end-to-end cold start — they cannot separate a post-readiness
first-vs-warm delta, which is the quantity A13 asks for. Dedicated instrument, same entry, same
cluster, one day after the sittings.

**Comparability caveat:** the vinext ~1.2 s cited below is a decomposition attribution from the
2026-08-18 record's *inadmissible-as-A/B* lazy-entry sitting, not a number produced by this
harness — treat the comparison as order-of-magnitude, not like-for-like.

## Result (run 2, `/dashboard`, n=8 genuine renders)

| cycle | wake (cold boot) | first | warm best | lazy | first-body bytes |
|---|---|---|---|---|---|
| 1 | 4126 | 670 | 539 | 131 | 14240 |
| 2 | 4052 | 3961 | 527 | **3434** | 14240 |
| 3 | 4196 | 624 | 553 | 70 | 14240 |
| 4 | 4029 | 728 | 538 | 190 | 14240 |
| 5 | 4046 | 649 | 536 | 113 | 14240 |
| 6 | 3896 | 15617 | 555 | **15061** | **14232** |
| 7 | 3979 | 663 | 526 | 138 | 14240 |
| 8 | 4227 | 15987 | 539 | **15448** | **14232** |

(Timings are held as floats and printed rounded, so a row's printed subtraction can be off by
1 ms; the lazy column is computed pre-rounding.)

Median lazy over all eight cycles: **164 ms**. The five unstalled cycles cluster at
**70–190 ms** (median 131 ms, max 190 ms). Warm render is stable at ~530–560 ms; cold boot to
first-health-response ~3.9–4.2 s.

## The tail is the database path, not the entry

Cycles 2/6/8 are not module evaluation:

- `/dashboard` uses the **writer** pool (`getDbPool()`), whose connect timeout defaults to
  `DEFAULT_DB_POOL_CONNECT_TIMEOUT_MS = 15_000` (`packages/lib/src/clients.ts:533`, applied at
  `:549-551`, overridable via `DB_POOL_CONNECT_TIMEOUT_MS`). **Deployed value verified on the
  running system, not assumed from source:** the fm-node ksvc carries no
  `DB_POOL_CONNECT_TIMEOUT_MS` env, so the 15 s default is live. Cycles 6/8: the first connection
  attempt exhausts that timeout, the dashboard's `catch` renders the zero-stats fallback, and the
  tail arithmetic closes (15617−555 ≈ 15 s + a ~600 ms render; 15987−539 ≈ 15 s + ~990 ms). The
  smaller body on exactly cycles 6/8 (14232 vs 14240 — see the table) **corroborates** the
  fallback render; it is not proof on its own (the fallback swaps the recent-files rows for a
  "no files" row, so an 8-byte delta implies the files table is near-empty, which was not
  independently checked). Cycle 2 (3434 ms) returned the **success** body size, so it was NOT a
  fallback; "the same connect path succeeding slowly" is the most likely reading but is
  **inference, not separately evidenced** — it is equally consistent with the activator/SKS
  transition stall this cluster has measured before.
- **The keepwarm contradiction is a finding in its own right:** the PG trickle keepwarm was
  RUNNING during this sitting, yet 2-3 of 8 first connections stalled — so these are NOT simple
  cold-database wakes. Whether the trickle's target does not cover this app's connect path, or the
  stall is in the gateway wake/auth path (wake budget, role-apply settle), is unattributed here;
  it bears directly on the #779 idle-window decision and #781's replacement of the trickle, and
  belongs to whoever picks those up.
- A warm-on-boot request would move this stall off the user's critical path — but that is an
  argument about **database warmth**, already owned by the DB-side knobs
  (`AppDatabase spec.tier: warm` / `spec.warmSchedule`, and the `GW_IDLE_MS` decision, #779),
  not about the node entry's module graph. Promoting warm-on-boot to hide a DB stall would mask
  the signal those knobs exist to fix — and 3/8 first visitors silently seeing zero-stats
  fallback content is a finding about the *app's* swallow-and-render-fallback pattern, not the
  runtime.

## Verdict

- **A13 criterion: NOT met — but on a knife-edge, stated rather than rounded away.** Median
  164 ms (all eight) / 131 ms (clean cycles) against a 200 ms bar, at n=8, one route, one day.
  The margin is real on every defensible statistic, but it is 18–35%, not 10×; and the
  invalidated run 1 contains one genuine render (`/`, `x-nextjs-cache: MISS`) at **213 ms — over
  the bar** on a different route's cost profile. That datapoint does not flip the verdict (a
  self-invalidated run, n=1, a route whose first render also writes the shared cache), but a
  criterion discharged this close must carry it visibly: a re-measure on a heavier page could land
  the other side, and the ADR's re-measure caveat exists for exactly that. The node residue is an
  order of magnitude under the vinext lazy entry's ~1.2 s attribution (see the comparability
  caveat above) because the node server evaluates its graph at boot (inside its ~2.6 s-to-Ready).
  Warm-on-boot remains **target-specific** (vinext/bun entry only) per ADR-0042's Consequences.
- Comparables — stated with their admissibility, since the source record calls its own lazy-entry
  sitting "inadmissible as a runtime A/B, different builds": the vinext **lazy-entry** ~1.2 s is
  from that different-build, PG-cold, decomposition-attributed sitting; the same-day
  **warm-entry** sittings put vinext app-graph evaluation at 430–480 ms (`WARMED:` on OKE) and
  557–714 ms. Node's ~131 ms typical residue also **excludes DB cost by construction** (the DB
  cycles are attributed to the tail), while the vinext figures do not all. Direction is safe —
  node's post-readiness residue is the smallest of every figure in this family — but no ratio
  quoted across these sittings is like-for-like.
- The run-1 observation stands on its own: a cache-served page's first request on a fresh pod
  costs ~22 ms median over warm (per-cycle values above) — the shared Redis page cache makes
  post-readiness cost a non-issue for cached routes.

## Limitations — what this number is and is not

Single sitting, n=8, one app, one route, one day, timed from a workstation over the public URL
(network jitter rides on every sample; the first−warm subtraction cancels the steady component
only). `lazy = first − min(warm1, warm2)` is an **upper bound on everything first-request** — lazy
module evaluation, JIT warm-up, pool creation, Redis connect — not module evaluation isolated. The
cost scales with app-graph size, so one app cannot settle the entry-contract question in general;
the ADR's re-measure caveat (Next major, entry rewrite — and, per the knife-edge, any heavier
page) is load-bearing, not boilerplate.

Harness: `scripts/bench-a13-postready-lazy.py` (committed with this record) — 8-cycle
wake-then-measure (health-wake, then first/warm/warm on the measured path, pod-event pull
evidence per cycle); run from the workstation against the public URL, cluster otherwise quiet,
one run at a time.
