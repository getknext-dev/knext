# A13 — the node standalone entry's post-readiness first-request lazy cost (OKE, 2026-08-19)

**Question (ADR-0042 action item A13, #765 follow-through):** after the node standalone server
reports Ready, does the first request pay >200 ms of lazy evaluation the vinext entry's
warm-on-boot would have absorbed? >200 ms ⇒ warm-on-boot promotes from target-specific to
contract.

**Answer: no — median 190 ms, typical 70–190 ms. Warm-on-boot stays target-specific.**
But the measurement surfaced a heavy tail that is NOT the entry's lazy cost — see below, it
belongs to the database path.

## Methodology (mirrors the vinext measurement: post-readiness, first request, warm image)

- `fm-node` on OKE (`context-ckmva7v7zvq`), the same digest-pinned file-manager image as the
  2026-08-18 A/B, min-scale 0, image **already present on the node every cycle** (verified from
  pod events), PG trickle keepwarm running.
- Per cold cycle: wait for 0 pods → wake via `GET /api/health` (Knative queues it until Ready;
  the app graph is untouched) → time the FIRST `GET` of a page on the fresh, ready process →
  two more `GET`s as the warm baseline. `lazy = first − min(warm1, warm2)`. 8 cycles per run.
- Run 1 hit `/` and invalidated itself: cycle 1 was a genuine render (`x-nextjs-cache: MISS`,
  lazy 213 ms) but cycles 2–8 were served `STALE` from the **shared Redis page cache** written by
  cycle 1 (lazy 3–33 ms — cache-serve latency, not a render). Recorded here because it is itself a
  finding: for cache-served pages the post-readiness first-request penalty is ~nothing.
- Run 2 (the A13 instrument) hit `/dashboard` — fully dynamic (`unstable_noStore()`, no
  `x-nextjs-cache` header, three PG queries per render), so every request is a genuine render.
  (`/observability` was tried first and is auth-gated, 401.)

## Result (run 2, `/dashboard`, n=8 genuine renders)

| cycle | wake (cold boot) | first | warm best | lazy |
|---|---|---|---|---|
| 1 | 4126 | 670 | 539 | 131 |
| 2 | 4052 | 3961 | 527 | **3434** |
| 3 | 4196 | 624 | 553 | 70 |
| 4 | 4029 | 728 | 538 | 190 |
| 5 | 4046 | 649 | 536 | 113 |
| 6 | 3896 | 15617 | 555 | **15061** |
| 7 | 3979 | 663 | 526 | 138 |
| 8 | 4227 | 15987 | 539 | **15448** |

Median lazy **190 ms**; the five unstalled cycles cluster at **70–190 ms** (median 131 ms).
Warm render is stable at ~530–560 ms; cold boot to first-health-response ~3.9–4.2 s.

## The tail is the database path, not the entry

Cycles 2/6/8 are not module evaluation:

- `@getknext/lib`'s pool sets `connectionTimeoutMillis = 15_000` (the deliberate cold-wake
  tolerance, pinned in `packages/lib/src/__tests__/clients-ro.test.ts:58`). The ~15.0–15.4 s
  "lazy" values are the first connection attempt exhausting exactly that timeout; the dashboard's
  `catch` then renders the zero-stats fallback — visible in the record as a **different body size**
  (14232 vs 14240 bytes) on precisely those cycles. The ~3.4 s cycle is the same path succeeding
  slowly (a DB wake inside the render).
- A warm-on-boot request would move this stall off the user's critical path — but that is an
  argument about **database warmth**, already owned by the DB-side knobs
  (`AppDatabase spec.tier: warm` / `spec.warmSchedule`, and the `GW_IDLE_MS` decision, #779),
  not about the node entry's module graph. Promoting warm-on-boot to hide a DB stall would mask
  the signal those knobs exist to fix — and 3/8 first visitors silently seeing zero-stats
  fallback content is a finding about the *app's* swallow-and-render-fallback pattern, not the
  runtime.

## Verdict

- **A13 criterion: NOT met.** 190 ms median < 200 ms, and the honest typical value (70–190 ms) is
  a fraction of the vinext entry's measured ~1.2 s app-graph evaluation. The node standalone
  server evaluates its graph at boot (inside its ~2.6 s-to-Ready), which is exactly why its
  post-readiness residue is small. Warm-on-boot remains **target-specific** (vinext/bun entry
  only) per ADR-0042's Consequences.
- Comparables, same app, same cluster: node post-readiness residue ~131 ms typical vs vinext
  lazy-entry ~1.2 s (2026-08-18 record) and vinext warm-entry `WARMED:… ms=480` overlapped with
  readiness.
- The run-1 observation stands on its own: a cache-served page's first request on a fresh pod
  costs ~29 ms median over warm — the shared Redis page cache makes post-readiness cost a
  non-issue for cached routes.

Harness: 8-cycle wake-then-measure script (health-wake, then first/warm/warm on the measured
path, pod-event pull evidence per cycle); run from the workstation against the public URL, cluster
otherwise quiet, one run at a time.
