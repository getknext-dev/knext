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
| 0 | 2026-08-19 | pre-loop baseline (A13 record): connect-close keepwarm silently flapping the DB 0↔1 every ~100 s | 4050 | 728 | 539 | 3/8 cycles 3.4–15.4 s (DB wake + 15 s pool timeout → fallback render) | DB cold wakes riding first requests |
| 1 | 2026-08-20 | keepwarm → hold shape (parks: ~35/h → **0**); merged appdb+knext operators rolled; Prometheus config converged + `WarmHoldBudgetPressure` live; `scaleDownDelay` proven on the CR path | 4462 | 5252 | 533 | 6/8 cycles 1.7–8.9 s over warm (two `EAI_AGAIN`/fallback at ~9 s) | **fresh-pod DNS**: `EAI_AGAIN pggw-apps.scale-zero-pg.svc` + ioredis `connect ETIMEDOUT` on the pod's first UDP flows; CoreDNS itself healthy (<1 ms, both replicas on one node); plane request-saturated (99%/85% CPU allocated) and memory-pressured (89%/81% used) |

## Iteration 1 — what was proven, in one place

- **The DB-flap tail is dead**: the 15 s pool-timeout class and the park/wake churn are gone
  (0 parks in 90 min under the held connection; DB compute up continuously, 0 restarts). The
  gateway's own peer-connection check ("N active connection(s) on peer gateways, postponing
  sleep") postpones every park under a hold — connect-close probes were the pathological input,
  not a gateway design gap (#790, revised).
- **`scaleDownDelay` works end-to-end on a real operator-reconciled CR** (`sdd-drill`,
  `scaleDownDelay: "2m"`): cold wake 5063 ms; a hit at t+90 s — past the default 60 s park point —
  found the pod still Running and served in **354 ms** (~14× better than cold); the pod parked
  220 s after last traffic (a window, not a pin).
- **The new dominant term is fresh-pod DNS.** Every scale-to-zero cold start creates a fresh pod,
  and that pod's first UDP lookups (`pggw-apps.scale-zero-pg.svc`, the Redis host) intermittently
  hit `EAI_AGAIN`/`ETIMEDOUT` while CoreDNS answers in microseconds — the classic fresh-pod DNS
  race, amplified by non-FQDN hostnames walking the `ndots:5` search path and by node pressure.
  The `first` median moved 728 → 5252 ms between rows 0 and 1 **not because iteration 1 regressed
  it** — row 0's non-stalled cycles and row 1's non-stalled cycles are alike (~630–750 ms) — but
  because the DNS tail hit 6 of 8 cycles in this sitting. Treat the two rows' tails as different
  diseases with the same symptom; the row-0 disease is cured, the row-1 disease is next.
- Caveat recorded honestly: the plane is crowded (two nodes, months of experiment services holding
  99%/85% of allocatable CPU and 81–89% of memory). Pressure plausibly widens the DNS race window;
  a cleanup pass (human-gated deletes) would de-confound row 2.

## Next iteration (chosen from the measurement)

**Fresh-pod DNS.** Candidate levers, cheapest first:
1. **FQDN with trailing dot in every platform-minted hostname** (`pggw-apps.scale-zero-pg.svc.cluster.local.`)
   — the appdb operator's DSNs and the docs' recipes; skips the search-path walk entirely
   (5 wasted UDP round-trips per lookup at `ndots:5`).
2. **Operator-set `dnsConfig` on the ksvc template** (`ndots:2`, or `single-request-reopen`) —
   a knext-operator change, CRD-adjacent (design-gate class).
3. **NodeLocal DNSCache** on the plane — infra, biggest hammer, needs the user.
4. **Spread CoreDNS across nodes** (both replicas currently share one node) — one-line topology
   constraint, plane-level.
