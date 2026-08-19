# Cold-start ledger — one row per loop iteration, measured on OKE

> The standing loop: **measure cold start after each iteration; improve it next iteration.**
> This file is the loop's memory. Every iteration appends its measurement and names the next
> lever it chose FROM that measurement. Instrument:
> `scripts/bench-a13-postready-lazy.py [path]` (8 cold cycles against `fm-node`; per-cycle
> image-presence evidence; `wake` = full cold start to first health response, `first` = the
> first page render after readiness, `warm` = the same page on the warm process). Cluster
> `context-ckmva7v7zvq`; single runner, cluster otherwise quiet; all times ms, from the
> workstation over the public URL (±100 ms class instrument noise — see the A13 record's
> Limitations).

| # | date | plane state (what changed since the last row) | wake median | first median | warm median | first tail | attribution of the dominant term |
|---|---|---|---|---|---|---|---|
| 0 | 2026-08-19 | pre-loop baseline (A13 record, run 2, `/dashboard`, n=8) | 4049 | 699 | 528 | 3/8 cycles 3.4–15.4 s (DB wake + 15 s pool timeout → fallback render) | DB cold wakes riding first requests |
| 1 | 2026-08-20 (`/dashboard`, n=8, per-cycle table below) | keepwarm → hold shape (parks: ~35/h → **0**); merged appdb+knext operators rolled; Prometheus config converged + `WarmHoldBudgetPressure` live; `scaleDownDelay` exercised on the CR path | 4450 | 5252 | 533 | **7/8** cycles 1.7–8.9 s over warm; only cycle 3 (98 ms) is clean | **fresh-pod resolution/connect failures**: DNS is directly evidenced for the PG path (`EAI_AGAIN pggw-apps.scale-zero-pg.svc`); the Redis-side ioredis `connect ETIMEDOUT` is a TCP connect failure whose own cause is unproven. Evidence covers the two ~9 s fallback cycles only; the 1.7–7.4 s cycles (incl. a 7.4 s SUCCESS render) are unattributed. Plane request-saturated (99%/85% CPU allocated) and memory-pressured (89%/81% used) |

### Row 1 per-cycle data (the loop's memory must be derivable)

| cycle | wake | first | warm best | lazy | body |
|---|---|---|---|---|---|
| 1 | 5183 | 2249 | 535 | 1714 | 14240 |
| 2 | 4817 | 9091 | 537 | 8555 | **14232** (fallback) |
| 3 | 4376 | 629 | 531 | 98 | 14240 |
| 4 | 4400 | 2749 | 538 | 1955 | 14240 |
| 5 | 5048 | 8095 | 530 | 7565 | 14240 |
| 6 | 4156 | 9421 | 525 | 8896 | **14232** (fallback) |
| 7 | 4500 | 3082 | 527 | 2555 | 14240 |
| 8 | 4323 | 7421 | 538 | 6883 | 14240 |

**Unacknowledged-shift check, run on this row deliberately:** every row-1 wake (min 4156)
exceeds row-0's median (4049) and four exceed row-0's max (4227) — a systematic ~+400 ms wake
shift between sittings. Candidate cause: the plane got more crowded between the rows (the drill
app and its revisions landed in between; requests at 99%/85%). Unattributed; carried, not hidden.

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
  the expected shape without proving the delay caused the t+90 s hit. The pre-merge kind e2e and
  the earlier spike measurements carry the causal claim; this drill adds the CR-path wiring proof.
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

**Fresh-pod DNS.** Verified on the plane, not assumed (`/etc/resolv.conf` from a running
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
