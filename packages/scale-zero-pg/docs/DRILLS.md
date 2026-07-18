# DRILLS — the verification drill-battery guide

**Audience:** a future LLM agent (or operator) who needs to *verify* scale-zero-pg —
either the full OKE acceptance suite before a review, or one targeted drill to
prove a specific behavior still holds. This is a navigable index, not a tutorial;
it links out rather than restating.

> **Read first:** [`ARCHITECTURE.md` §8 "The drill battery"](ARCHITECTURE.md#the-drill-battery)
> for the code-map view (where the scripts live, the numbered-manifest convention).
> This doc is the *operator/agent* companion: how to run a drill, what each one
> proves, and how to read a FAIL. Recorded numbers live in
> [`BENCHMARKS.md`](BENCHMARKS.md); pager/ops runbooks in
> [`operations.md`](operations.md).

Drills are `deploy/_verify-*.sh` (one concern each, ~35 scripts), plus
`deploy/_measure-ro-staleness.sh` (a measurement drill) and
`deploy/_rehearse-upgrade.sh` (a kill-criterion tripwire rehearsal). Every drill
is **self-contained, idempotent, and self-tearing-down** (`trap … EXIT`): it
provisions its own throwaway app/plane, asserts, and destroys it — a passing drill
leaves the cluster as it found it.

---

## 1. How to run a drill

```sh
# most drills — run bare (they gate their own main, no subcommand):
sh deploy/_verify-storage.sh
sh deploy/_verify-multitenant.sh
sh deploy/_verify-wake.sh

# a few drills parse a subcommand (they default to `run` when bare, and expose
# `teardown` to reclaim a wedged run — zones also has `alerts`):
sh deploy/_verify-zones.sh run          # or: teardown / alerts
sh deploy/_verify-repl-wake.sh run      # or: teardown
sh deploy/_verify-slot-janitor.sh run   # or: teardown
sh deploy/_verify-wake-guard.sh run     # or: teardown

# flag-driven (not run/teardown):
sh deploy/_verify-drift.sh --context context-ckmva7v7zvq   # for CI; --deep for a sample wake
```

When in doubt, run the script with `-h`/`--help` or read its top-of-file `Usage:`
comment — the invocation is stated there. The subcommand drills (zones,
repl-wake, slot-janitor, wake-guard) **default to `run`** when invoked bare, so
`sh …/_verify-zones.sh` and `… run` are equivalent; their `teardown` (and zones'
`alerts`) subcommands exist to reclaim or re-check a run without redoing it.

**`selftest` (cluster-free).** The shared helper library exposes a unit-test mode
that needs **no cluster** — it exercises the drills' own timing-budget math:

```sh
sh deploy/_lib-drill.sh selftest         # pure helper unit tests (see §3)
sh deploy/_measure-ro-staleness.sh selftest
```

Run these anywhere (CI, a laptop with no OKE session) to catch a broken helper
before spending cluster time.

**Cluster prerequisites** for the live drills:

- kube-context **`context-ckmva7v7zvq`**, namespace **`scale-zero-pg`** (the default
  `CONTEXT`/`KCTX`/`NS` in the drills; override via env where a drill exposes it).
- A **valid OCI session** — an expired session surfaces as OKE API TLS timeouts
  (see §4). Refresh per [`HANDOFF.md` §6](../HANDOFF.md) (`oci session authenticate`).
- The storage plane deployed and Ready; `deploy/gen-secrets.sh` already run (mints
  the strong `cloud_admin` / base-admin credentials the drills authenticate with,
  #168).
- Client-side: `kubectl` on PATH. Drills spin up throwaway `psql` client pods from
  an always-pullable image (`postgres:17-alpine`, #171) rather than assuming a
  local `psql`.

---

## 2. The battery index

Each drill → **what it proves** → the issue(s)/ADR it guards (a regression here is
a defect against that ticket). Grouped by theme.

### Cold-boot / wake
| Drill | What it proves | Guards |
|---|---|---|
| `_verify-wake.sh` | Base single-DB 0→1→0: connect through the gateway wakes compute, serves rows, idles back to 0. | #61 #168 #171 |
| `_verify-coldboot.sh` | Per-app cold-boot **role-apply race** never surfaces a transient `28P01` — N cold cycles, valid creds, zero auth failures (the `GW_ROLE_APPLY_SETTLE_MS` gate). | #132 #171 |
| `_verify-warmtier.sh` | The productized **warm-standby tier** (gated pod) wakes sub-1.5s and the cold path stays green afterward. | #94 #164 #168 #171 |
| `_verify-wake-guard.sh` | Per-app **wake budget** caps unauthenticated wakes (CNI-independent side-channel control); a sustained breach pages past the 3m debounce. | #116 #166 · ADR-0008 |
| `_verify-ha.sh` | Gateway HA: 2 replicas, no SPOF, no idle split-brain. | #168 #171 |

### Read-scaling
| Drill | What it proves | Guards |
|---|---|---|
| `_verify-readpool.sh` | RO lane end-to-end via `GW_RO_PORT`: reads served, **writes on the RO DSN rejected**, tip-following staleness bounded, and the read HPA drives `compute-ro` 1→N under load. | #66 #83 #94 #99 #112 #121 #168 #171 #198 |
| `_verify-perapp-ro.sh` | Per-app read replicas are **tenant-isolated** — app A's RO listener never exposes app B's data. | #112 #117 #127 #132 #164 |
| `_verify-warmtier.sh` | (see Cold-boot/wake) the warm RO tier. | #94 #164 |
| `_measure-ro-staleness.sh` | **Measures** warm-plane per-app RO staleness precisely (isolates cold-catchup from steady-state lag; sub-second contract, #169). | #99 #127 #132 #167 #169 #187 #188 |

### Multi-tenant / quotas / scale-ceiling
| Drill | What it proves | Guards |
|---|---|---|
| `_verify-multitenant.sh` | Branch-per-app isolation + independent 0↔1: two apps, own Neon branches, one's write invisible to the other, gateway routes by `database=<app>`. | #74 #75 #76 #92 #112 #113 #171 #198 · ADR-0003 |
| `_verify-tenant-quotas.sh` | Noisy-neighbour bound: a hostile app's low CPU cap doesn't change a victim's default; per-app CPU limit rendered. | #89 #112 #171 · ADR-0003 |
| `_verify-scale-ceiling.sh` | The ADR-0003 "tens/low-hundreds" claim: provisions **N apps on one plane**, measures template WAL-pin growth + safekeeper pressure (30-app linear). | #86 #171 · ADR-0003 |
| `_verify-operator.sh` | **AppDatabase CRD operator** lifecycle: one CR → provisioned app, reconcile/ownerRefs/finalizer cascade. | #96 #119 #122 #127 #171 · ADR-0004 |

### Zones / repl-wake / slot-janitor
| Drill | What it proves | Guards |
|---|---|---|
| `_verify-zones.sh` | **Zone operator** end-to-end, driven entirely through Zone CRs (the zone-scaling axis payoff). | #139 #140 #143 #145 · ADR-0007 |
| `_verify-zone-deploy.sh` | The zone operator is **actually deployed to the live plane** (not drill-only) — the "merged ≠ deployed" guard. | #27 #125 #126 #142 #151 · ADR-0007 |
| `_verify-repl-wake.sh` | Gateway-mediated **replication-wake**: a subscriber wakes a sleeping publisher; publishers keep scale-to-zero. | #133 #139 · ADR-0007 |
| `_verify-slot-janitor.sh` | Live storage plane: WAL bounded past `max_slot_wal_keep_size`, monitor CronJob alerts on breach, an **active** slot is NOT pruned + subscriber catches up. | #133 #139 #142 #144 · ADR-0007 |
| `_verify-wal-janitor.sh` | The wal-janitor's **delete safety invariants** against the live durability bucket (highest blast-radius code): only below-horizon complete segments deleted. | #37 #42 #59 #77 #87 #91 #95 |
| `_verify-janitor-protect.sh` | **Offline** contract: resolve-slot-floors **fails closed** (global floor) when a slot LSN is unreadable, instead of fail-open. | #142 #143 #144 |

### Storage / failover / backup / restore / object-store
| Drill | What it proves | Guards |
|---|---|---|
| `_verify-storage.sh` | Storage plane Ready, compute serves Postgres, one-table data survives a compute pod kill (no volume, no restore). | (core DoD) |
| `_verify-pageserver-failover.sh` | Two pageservers: kill A, promote B to `AttachedSingle`, marker still reads — measures failover RTO (~8s). | #1 #2 #3 #4 #25 |
| `_verify-restore.sh` | **Rehearsed DR** for the fixed platform tenant: back up, stand up a fresh plane in a throwaway ns, marker row readable. | (the every-round CRITICAL finding) |
| `_verify-app-restore.sh` | Per-app (branch-per-app) DR: a **single app's Neon branch** restores end-to-end. | #1 #2 #97 · ADR-0003 |
| `_verify-backup-portability.sh` | Backup + wal-janitor are **portable to a non-MinIO** OCI bucket (no MinIO split-brain). | #4 #21 #105 #120 |
| `_verify-objstore.sh` | Pageserver runs against a **configured object store**, not only bundled MinIO (GetPage@LSN served from remote layers). | #4 #105 |
| `_verify-upgrade.sh` | **Executes** a real storage-plane upgrade end-to-end; data queryable + writable after; measures duration + control-format weld. | #50 #98 #105 · ADR-0002 |

### Security
| Drill | What it proves | Guards |
|---|---|---|
| `_verify-netpol.sh` | Network-exposure contract: manifest-level checks (deterministic, CNI-independent) + enforcement-aware isolation (blocks non-gateway pods, or WARNs honestly if the CNI doesn't enforce). | #4 #112 #114 #168 |
| `_verify-tls.sh` | The gateway TLS listener is **actually encrypting** the wire (real handshake, not `pg_stat_ssl`). | #113 #168 #171 |
| `_verify-base-admin.sh` | Base single-DB tiers are hardened to a **strong `cloud_admin`** (no default-credential wake). | #112 #168 #171 |
| `_verify-wake-guard.sh` | (see Cold-boot/wake) the unauthenticated-wake budget. | #116 #166 · ADR-0008 |
| `_verify-drift.sh` | **Live-spec-vs-manifest drift** ("grep-green, prod-red"): presence + readiness of every load-bearing workload, pointed at the OKE plane. `--deep` wakes a bounded sample. | #13 #27 #48 #51 + many · ADR-0007 |

### Observability
| Drill | What it proves | Guards |
|---|---|---|
| `_verify-alerting.sh` | An alert that fires **reaches the sink** (Prometheus → Alertmanager → webhook), via a synthetic always-firing rule; unique per-run identity avoids dedup suppression. | #60 #80 |
| `_verify-cronjob-alerting.sh` | A **real failing CronJob** pages via the same path (the real failure signal, not a synthetic). | #23 #29 #41 |
| `_verify-ksm-down.sh` | `kube-state-metrics` (sole producer of the CronJob-failure signal) self-guards: scale it to 0 → `KubeStateMetricsDown` reaches the sink. | #48 |

### Performance / capacity
| Drill | What it proves | Guards |
|---|---|---|
| `_verify-loadsoak.sh` | **Sustained-load / soak / throughput harness**: an in-cluster k6 Job ramps VUs to a ceiling then holds a ≥10-min soak against ONE app, records RPS + p50/p95/p99 + error rate, the **concurrency→latency** curve (to set W2 ContainerConcurrency), and snapshots both planes (gateway `pggw_*`, writer replicas/restarts, DB CPU) to record **which wall broke first** (app pods / `GW_MAX_CONNS=90` / writer / DB CPU). `SELFTEST=1` runs cluster-free. | #375 #376 |

### Operator / extensions
| Drill | What it proves | Guards |
|---|---|---|
| `_verify-operator.sh` | (see Multi-tenant) AppDatabase CRD lifecycle. | #96 · ADR-0004 |
| `_verify-extensions.sh` | An app can **self-enable** trusted extensions (TimescaleDB, pgvector) that survive scale-to-zero. | #177 #178 · ADR-0001 |
| `_verify-writer-autoscaler.sh` | The **writer vertical autoscaler** resizes the compute CPU limit up under pressure and shrinks it back down. | #103 |

### Upgrade / rehearse
| Drill | What it proves | Guards |
|---|---|---|
| `_rehearse-upgrade.sh` | Upgrade path is **walkable**: boots the next neon tag clean-slate, probes its control-file format (v9 manifest bump vs new format). A **kill-criterion tripwire** — exit ≠ 0 convenes a review. | #50 · ADR-0002 |
| `_verify-upgrade.sh` | (see Storage) executes the real upgrade. | #50 #98 · ADR-0002 |

---

## 3. The shared helper — `_lib-drill.sh` + `WAKE_BUDGET_MS`

Drills **source** (`.`) `deploy/_lib-drill.sh`; they never execute it (except
`selftest`). Every function is **pure** (no cluster, no side effects) so `selftest`
can unit-test it — keep it that way, cluster calls belong in the drills.

The design (issue #198): the battery's timing budgets were once fixed magic
numbers calibrated for a fast ~2–5s cold wake. On a slow / CPU-request-constrained
cluster (cold wakes ~14s mean / ~19s max) those budgets **false-failed** healthy
products. So every idle/hold/poll timeout is now derived from **one knob**:

- **`WAKE_BUDGET_MS`** — assumed worst-case cold-wake latency in ms. **Default
  30000 (30s)**: generous for the 2-node OKE cluster, still bounded. Lower it on a
  fast cluster to tighten the battery; raise it on an even slower one.
- Derived (values below are at the 30s default): `idle_budget_ms` = 2× wake,
  **floored at 30s** (→ 60s idle budget at the default; keeps a just-woken compute
  from being slept back to 0 before the post-wake assertion);
  `hold_budget_s` = wake×4 + 30s margin = **150s** (a "busy app stays awake" hold
  outlasting the other app's whole wake-then-idle sequence); `idle_wait_s` = gateway
  idle + wake + slack (how long to wait for scale-to-zero). Sanitizers floor a bogus
  value so a typo can't collapse every budget to ~0.

`sh deploy/_lib-drill.sh selftest` unit-tests `ceil_div`, the budget math, and the
DSN builder — **cluster-free**, so run it in CI or before touching the cluster.

---

## 4. Interpreting results — signal vs noise

A drill FAIL is not automatically a product bug. Classify it (per
[`HANDOFF.md` §5](../HANDOFF.md) "Signal vs noise"):

| Class | Looks like | Verdict |
|---|---|---|
| **Product REGRESSION** | An assertion about *behavior* fails: rows lost, write accepted on RO DSN, cross-tenant read, alert never reaches the sink, isolation breach. | **Real — investigate + block.** This is the signal. |
| **Drill-timing** | A timeout fires because the drill's window was shorter than the cluster's actual cold-wake (the #198 class). | Not a product bug. Raise `WAKE_BUDGET_MS` and re-run; fix the drill if a budget is still hard-coded. |
| **Capacity-BLOCKED** | `Insufficient cpu` / pods `Pending` / co-scheduling writer+RO fails on the 2-node cluster (~88–93% CPU-request reserved). | Cluster ceiling, not code. **Park** the multi-compute drill; note it; a roomier cluster unblocks it. **Never scale down production to free capacity** (§5). |
| **Transient-infra** | OKE API TLS timeouts, kubectl hangs, a lapsed OCI session. | Re-auth (`oci session authenticate`) and re-run. Report honestly; fall back to offline/code-traced proof if the API stays flaky. |

**Reference run — full battery, 2026-07-13** (see [`HANDOFF.md`](../HANDOFF.md),
numbers in [`BENCHMARKS.md`](BENCHMARKS.md)):

- **ZERO product regressions.**
- Read-scaling **HPA scale-up verified** under real CPU load (1→2→1).
- 30-app **scale-ceiling linear** (ADR-0003 holds).
- Observability pager path honest end-to-end.
- **Caveats (both infra, not code):** cold-wake elevated to **~14s mean / 19s max
  (p95 ~50s under load)** — CPU-request scheduling pressure on the 2-node cluster,
  node CPU *usage* only 7–16%; and that same **2-node capacity ceiling** blocks
  clean multi-compute drills (warm writer + RO co-schedule). A larger drill cluster
  restores ~2–5s wakes and unblocks them. Drill-harness gaps found were fixed in
  #198/#199 — not product defects.

---

## 5. Guardrails when running the battery

- **Run drills SEQUENTIALLY.** They share one cluster and mutate live state
  (scale compute, apply CRs, run janitors against the durability bucket). Parallel
  runs cross-contaminate and produce false fails.
- **NEVER scale down production to free capacity.** If a drill is capacity-BLOCKED
  on the 2-node cluster, **park it** and note it — do not evict resident platform
  workloads to make room. Losing the platform to free a drill is a self-inflicted
  outage.
- **Verify self-teardown after each drill.** Every drill traps `EXIT` and destroys
  its throwaway app/branch/plane. Confirm it — a crashed drill can leave a residue
  (e.g. a leftover `storage-objstore` deletion disarms the janitor, the 2026-07-06
  incident). After a run, check no throwaway app/namespace lingers
  (`kubectl -n scale-zero-pg get appdatabase,deploy | grep -i drill`); a
  `{run|teardown}` drill exposes `teardown` to reclaim a wedged run.
- **Record every number.** Any drill/bake-off number lands in
  [`BENCHMARKS.md`](BENCHMARKS.md) in the same batch (CLAUDE.md rule 2b) — with
  its methodology and environment (local vs OKE).
- **On a trigger event** (release tag, ADR change, kill-criterion tripwire,
  `_rehearse-upgrade.sh` exit ≠ 0), run the relevant drills before convening the
  blind trio review — the OKE battery must be green *before* sign-off (CLAUDE.md
  loop step 3/4).

---

## See also
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the code map (drill battery in §8).
- [`BENCHMARKS.md`](BENCHMARKS.md) — every recorded number, with provenance.
- [`operations.md`](operations.md) — pager runbooks, alerting/drift drill usage,
  kill-criteria tripwires.
- [`../HANDOFF.md`](../HANDOFF.md) — current state, cluster access, signal-vs-noise.
