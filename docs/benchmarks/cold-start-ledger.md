# Cold-start ledger — one row per loop iteration, measured on OKE

> The standing loop: **measure cold start after each iteration; improve it next iteration.**
> This file is the loop's memory. Every iteration appends its measurement and names the next
> lever it chose FROM that measurement. Instruments (each row names which it used):
> `scripts/bench-a13-postready-lazy.py [path]` (rows 0–1: workstation-timed over the public URL,
> ±100 ms class noise — see the A13 record's Limitations) and
> `scripts/bench-a13-postready-lazy-incluster.py` (row 2+: in-pod timing via `kubectl exec`,
> which removes WAN noise and adds the exec-gap consideration stated in row 2). Both: 8 cold
> cycles against `fm-node`; per-cycle image-presence evidence; `wake` = full cold start to first
> health response, `first` = the first page render after readiness, `warm` = the same page on
> the warm process. Cluster `context-ckmva7v7zvq`; single runner, cluster otherwise quiet; all
> times ms.

| # | date | plane state (what changed since the last row) | wake median | first median | warm median | first tail | attribution of the dominant term |
|---|---|---|---|---|---|---|---|
| 0 | 2026-08-19 | pre-loop baseline (A13 record, run 2, `/dashboard`, n=8) | 4049 | 699 | 539 | 3/8 cycles 3.4–15.4 s (DB wake + 15 s pool timeout → fallback render) | DB cold wakes riding first requests |
| 1 | 2026-08-20 (`/dashboard`, n=8, per-cycle table below) | keepwarm → hold shape (parks: ~35/h → **0**); merged appdb+knext operators rolled; Prometheus config converged + `WarmHoldBudgetPressure` live; `scaleDownDelay` exercised on the CR path | 4450 | 5252 | 533 | **7/8** cycles 1.7–8.9 s over warm; only cycle 3 (98 ms) is clean | **fresh-pod resolution/connect failures**: DNS is directly evidenced for the PG path (`EAI_AGAIN pggw-apps.scale-zero-pg.svc`); the Redis-side ioredis `connect ETIMEDOUT` is a TCP connect failure whose own cause is unproven. Evidence covers the two ~9 s fallback cycles only; the 1.7–7.4 s cycles (incl. a 7.4 s SUCCESS render) are unattributed. Plane request-saturated (99%/85% CPU allocated) and memory-pressured (89%/81% used) |

### Row 1 per-cycle data (the loop's memory must be derivable)

| cycle | wake | first | warm best | lazy | body |
|---|---|---|---|---|---|
| 1 | 5183 | 2249 | 535 | 1714 | 14240 |
| 2 | 4817 | 9091 | 537 | 8555 | **14232** (fallback) |
| 3 | 4376 | 629 | 531 | 98 | 14240 |
| 4 | 4400 | 2749 | 794 | 1955 | 14240 |
| 5 | 5048 | 8095 | 530 | 7565 | 14240 |
| 6 | 4156 | 9421 | 525 | 8896 | **14232** (fallback) |
| 7 | 4500 | 3082 | 527 | 2555 | 14240 |
| 8 | 4323 | 7421 | 538 | 6883 | 14240 |

**Unacknowledged-shift check, run on this row deliberately:** every row-1 wake (min 4156)
exceeds row-0's median (4049) and four exceed row-0's max (4227) — a systematic ~+400 ms wake
shift between sittings. Candidate cause: the plane got more crowded between the rows (the drill
app and its revisions landed in between; requests at 99%/85%). Unattributed; carried, not hidden.

| 2 | 2026-08-20 (`/dashboard`, n=8, per-cycle below; **instrument moved in-cluster**) | rooted-FQDN DSN minting (#796) verified pre-merge on OKE: rooted env applied to the operator, the hand-made benchmark Secret re-pointed at the rooted host (the re-mint required by #796's measurability note — the benchmark subject was in the unaffected set) | 4993.5 | 226 | 125 | **2/8** cycles 3.6 / 5.5 s (both SUCCESS bodies, no fallbacks) | the fresh-pod DNS tail collapsed: 6/8 cycles in a 90–122 ms lazy band vs row 1's ONE clean cycle; **median lazy 4719 → 103 ms**. The two residuals are unattributed (candidates: the still-unrooted app-level Redis host, residual UDP races) |

### Row 2 per-cycle data

| cycle | wake | first | warm best | lazy | body |
|---|---|---|---|---|---|
| 1 | 5348 | 220 | 122 | 98 | 14240 |
| 2 | 5866 | 228 | 122 | 105 | 14240 |
| 3 | 4844 | 3725 | 134 | 3591 | 14240 |
| 4 | 4735 | 224 | 124 | 101 | 14240 |
| 5 | 5446 | 248 | 127 | 122 | 14240 |
| 6 | 3818 | 219 | 130 | 90 | 14240 |
| 7 | 4130 | 221 | 126 | 95 | 14240 |
| 8 | 5143 | 5589 | 124 | 5465 | 14240 |

**Instrument change, stated:** rows 0–1 timed from the workstation; row 2 times **in-cluster**
(pod `bench-timer`, `kubectl exec`, milliseconds measured in-pod around the HTTP call —
`scripts/bench-a13-postready-lazy-incluster.py`). Forced, not chosen: the workstation WAN
degraded mid-sitting to SYN timeouts and 90 s transfers on a path also serving 372 ms probes.
One full sitting was **discarded as instrument-invalid**; its numbers are preserved here rather
than in an unfindable side-channel — per-cycle lazies
`[-81223, -67544, 3768, 4264, 16172, 17991, 91327, 92298]`, "median lazy" 10218 ms, with warm
renders up to 92 s and 3 SYN-timeout retries — 90 s *warm* renders on requests the same plane
served in ~530 ms is what "instrument-invalid" means concretely. **Provenance:** that sitting ran
on the WORKSTATION harness with a logged-retry loop that had been added mid-investigation in a
scratchpad copy (the committed script would have died on the first SYN timeout); the retry loop
is now committed into `scripts/bench-a13-postready-lazy.py`, so the instrument that produced
these numbers exists in the repo. Timing was workstation-side, so the WAN framing stands — the
in-pod row-2 instrument shares only the LB/ingress hop, not the degraded WAN path.

Three consequences, none asserted away:

- Absolute `first`/`warm` are NOT comparable across the boundary. The warm drop (533 → 125 ms)
  is *consistent with* removing WAN+ingress RTT, but that explanation is fitted from the
  difference it explains — no independent RTT measurement was taken; treat it as plausible, not
  established.
- **`lazy` is the least incomparable of the three, not a protected quantity.** Path RTT cancels
  in expectation because both terms share the path — but the discarded sitting is this row's own
  proof of the limit: its terms shared a path too, and its "lazy" still carried ~10 s of
  instrument. A degraded path corrupts lazy; a merely *different* path mostly cancels.
- **The exec-gap confound points toward the headline and is bounded, not denied.** Moving to
  `kubectl exec` inserts dead time (apiserver round trip, exec setup, interpreter start) between
  the wake response and the first measured GET — wall-clock in which post-readiness lazy work
  can finish unmeasured. It cannot explain row 1's 7–9 s cycles, but it can plausibly account
  for the low end of row-1's tail (1.7–2.5 s, 3 of 7 tail cycles). The harness now prints the
  per-cycle exec gap so row 3 bounds it with data; for row 2 it is unmeasured and the headline
  is therefore stated as *lever effect and instrument change measured together* — what is
  lever-attributable beyond doubt is the disappearance of the failure SIGNATURE (resolver
  errors, fallback bodies, the 7–9 s class).

**Wake-shift check, run on this row as row 1 ran it on itself:** row-1 wake median 4450 →
row-2 **4993.5** (+544 raw; by this row's own RTT accounting the adjusted shift is ~+950 ms,
since a wake sample rides the same path as any other GET). Unattributed; carried, not hidden.
Candidate causes: the plane gained the `bench-timer` pod and the drill services on a
request-saturated two-node cluster; image pulls are EXCLUDED as a cause (the harness's per-cycle
pull evidence read "already present" on all 8 cycles — the column the header promises, now
stated). The instrument previously did not emit a wake median (the one hand-computed cell in
every row, and twice the one with the error); both harness variants now print
`median_wake_ms`.

**What row 2 establishes:** with the PG DSN rooted, the row-1 failure signature
(`EAI_AGAIN` + fallback bodies + a 7/8 multi-second tail) is gone — 6/8 cycles sit in a
90–122 ms lazy band, and zero fallback renders. At n=8 per sitting and tail frequencies that
have varied 3/8 → 7/8 → 2/8 across rows, the honest claim is a distribution shift consistent
with the lever, not a proof the residual is zero. The two 3.6/5.5 s residuals rendered
successfully (so: a slow dependency, not the 15 s timeout or a resolver hard-fail) and are the
next attribution target.

## Iteration 1 — what was proven, in one place

- **The DB-flap tail is dead**: the 15 s pool-timeout class and the park/wake churn are gone
  (0 parks in 90 min under the held connection; DB compute up continuously, 0 restarts). The
  gateway's own peer-connection check ("N active connection(s) on peer gateways, postponing
  sleep") postpones every park under a hold — connect-close probes were the pathological input,
  not a gateway design gap (#790, revised).
- **`scaleDownDelay` is exercised end-to-end on a real operator-reconciled CR** (`sdd-drill`,
  `scaleDownDelay: "2m"`): cold wake 5063 ms; a hit at t+90 s found the pod still Running and
  served in **354 ms**; the pod parked 220 s after last traffic — consistent with
  60 s stable window + 120 s delay + 30 s scale-to-zero grace = 210 s, so the delay is a window,
  not a pin. **Two honesty caveats:** Knative's default is 60 s stable PLUS a ~30 s grace period,
  so t+90 s is *at* the default termination boundary rather than clearly past it; and there was
  **no control arm** (the same drill with the delay absent), so this exercises the knob and shows
  the expected shape without proving the delay caused the t+90 s hit. The causal claim lives in ADR-0045
  (`docs/adr/0045-scale-down-delay.md` — the measured ~52 ms in-window vs 2.28 s true-cold spike
  record) and the operator's annotation tests
  (`packages/kn-next-operator/internal/controller/preview_annotation_disposition_test.go` pins the
  stamping; the #773/#774 PR suites pin the plumbing); this drill adds the CR-path wiring proof.
- **The new dominant term is fresh-pod resolution/connect failure, with DNS directly evidenced on
  the PG path.** The captured stall pod logs `EAI_AGAIN pggw-apps.scale-zero-pg.svc` (a resolver
  failure) for Postgres; the Redis-side errors are ioredis `connect ETIMEDOUT` — a **TCP** connect
  timeout, i.e. resolution had succeeded there, cause unproven. That evidence covers the two ~9 s
  fallback cycles; the 1.7–7.4 s cycles (including a 7.4 s SUCCESS render) are unattributed in
  this sitting. CoreDNS answers arrived-queries in <1 ms (60-line log sample) — a check that is
  **structurally blind** to dropped-before-arrival packets, so it bounds nothing about the race
  itself; both CoreDNS replicas share one node.
  **On the row-0 → row-1 `first` median move (699 → 5252 ms): this sitting cannot distinguish "a
  wider tail" from "a regression".** Row 1 has exactly ONE clean cycle (629 ms — which does match
  row 0's clean band of 624–728 ms, n=1), and a systematic ~+400 ms wake shift the table above
  carries. What IS established: the row-0 signature (15 s pool-timeout class + park/wake churn)
  is gone — 0 parks in 90 min, DB up continuously — and the row-1 failures carry a different
  error class. Different diseases is the supported claim; "no regression" is not, at n=8 with one
  clean cycle.
- Caveat recorded honestly: the plane is crowded (two nodes, months of experiment services holding
  99%/85% of allocatable CPU and 81–89% of memory). Pressure plausibly widens the DNS race window;
  a cleanup pass (human-gated deletes) would de-confound row 2.

## Next iteration (chosen from the measurement)

**Fresh-pod DNS — taken in iteration 2 (#796); row 2 above carries the result.** The residual
2/8 tail and the still-unrooted app-level Redis host are iteration 3 candidates, alongside the
plane-level levers below (unchanged, still open) and the saturation cleanup (human-gated).

Verified on the plane, not assumed (`/etc/resolv.conf` from a running
default-namespace pod): `options ndots:5` with a **five-entry** search path — the standard three
plus two OCI VCN domains (`knext.oraclevcn.com`, `nodes.knext.oraclevcn.com`). So a 3-label name
like `pggw-apps.scale-zero-pg.svc` (2 dots < 5) attempts **all five** search suffixes before the
absolute name: 5 wasted name attempts = 10 wasted queries with A+AAAA, and the two VCN misses
leave the cluster for OCI's resolver on every in-cluster lookup. Note also: the 5-label FQDN
*without* a trailing dot (4 dots) is still below ndots:5 and **still walks the whole path** —
only the rooted form (trailing dot) or an ndots reduction skips it.

Candidate levers, cheapest first:
1. **Rooted FQDN (trailing dot) in every platform-minted hostname**
   (`pggw-apps.scale-zero-pg.svc.cluster.local.`) — the appdb operator's DSNs and the docs'
   recipes; skips the search walk entirely, saving 10 queries per lookup on this plane's
   resolv.conf. Client compatibility with the trailing dot must be verified per consumer, not
   assumed.
2. **Operator-set `dnsConfig` on the ksvc template** (`ndots:2`, or `single-request-reopen`) —
   a knext-operator change, CRD-adjacent (design-gate class).
3. **NodeLocal DNSCache** on the plane — infra, biggest hammer, needs the user.
4. **Spread CoreDNS across nodes** (both replicas currently share one node) — one-line topology
   constraint, plane-level.
