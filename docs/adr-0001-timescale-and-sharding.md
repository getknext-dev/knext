# ADR-0001 — TimescaleDB option & sharding mechanism

- **Status:** Proposed
- **Date:** 2026-07-02
- **Context of decision:** next-phase planning (maturity / reliability / performance) for the
  scale-to-zero Postgres MVP (Neon OSS storage plane + Go wake gateway; one DB per knext app/zone).
- **Evidence base:** empirical checks on `neondatabase/compute-node-v17:latest`,
  `neondatabase/neon:8464`, and the live `scale-zero-pg` cluster (2026-07-02), plus vendor docs.
  Commands and raw output are reproducible via the image + `kubectl exec` on `deploy/compute`.

---

## Q1 — TimescaleDB

### Evidence (measured)
- **Bundled & preloadable.** `timescaledb.control` (`default_version = 2.17.1`, `trusted = true`)
  and `timescaledb-2.17.1.so` ship inside the compute image. Our own compute spec
  (`deploy/54-compute-files.yaml:109`) already lists it:
  `shared_preload_libraries = 'neon,pg_cron,timescaledb,pg_stat_statements'`.
- **`CREATE EXTENSION timescaledb` succeeds** on the live compute; it appears in
  `pg_available_extensions` (2.17.1).
- **Hypertables work** (Apache-2 feature): `create_hypertable('ts_test','ts')` → OK.
- **TSL features are license-gated OFF.** `SHOW timescaledb.license` → `apache`. Under it:
  - `ALTER TABLE … SET (timescaledb.compress)` / `add_compression_policy` → `ERROR: functionality
    not supported under the current "apache" license`.
  - `CREATE MATERIALIZED VIEW … WITH (timescaledb.continuous)` → same error.
- **License is boot-fixed.** `SET timescaledb.license='timescale'` → `ERROR: Cannot change a
  license in a running session … Change the license in the configuration file or server command line.`
  The `apache` default is compiled into Neon's build (not present in our `postgresql.conf`), so
  flipping it would require adding a `timescaledb.license = timescale` setting to the compute spec.

### Analysis
**(a) Inside our Neon compute — Apache-2 works, TSL is a fight we shouldn't pick.**
The base feature (hypertables = native range partitioning by time + chunk pruning) runs today with
zero infra change. The valuable TSL features — **native columnar compression, continuous
aggregates, automated retention/compression policies** — are (i) disabled by Neon's `apache`
license default, and (ii) even if we flipped the license in our self-hosted spec, they are driven by
**TimescaleDB background-worker jobs** (`timescaledb_information.jobs` scheduler). Our compute
**scales to zero** — background workers stop with the pod, so policy-driven refresh/compression/
retention **would not fire while idle**, the exact window a time-series DB accumulates data. This is
an architectural mismatch, not just a license toggle. Neon's own docs confirm the platform ships
"only Apache-2 licensed features … Compression is not supported," and recommend `drop_chunks()`
over compression.

**(b) TimescaleDB as an alternative stack (self-hosted TSDB / CNPG).** License is *not* the
blocker: TimescaleDB TSL/Community is source-available and free to self-host (the only bar is you
can't offer it *as a managed DBaaS to third parties* — internal platform use is fine). The cost is
architectural: we would **throw away the entire shipped plane** — stateless compute, sub-second
attach, scale-to-zero, instant branching/PITR from pageserver — and adopt a **stateful,
always-on** Postgres with local/EBS volumes (TimescaleDB is a normal single-node PG with a big
`.so`). We gain compression + continuous aggregates; we lose the whole reason this project exists.

**(c) Multi-node is gone.** Distributed/multi-node TimescaleDB was **deprecated in 2.13 and removed
in 2.14** (2024-02-08); 2.17.1 is single-node only. It is not a scale-out option.

### Decision (Q1)
- **ADD-ON, conditional — not a replacement.** Keep `timescaledb` preloaded and let apps
  `CREATE EXTENSION` for **hypertables / chunk pruning / `drop_chunks` retention** (Apache-2, works
  now). Document it as "Apache-2 tier only."
- **Do NOT rely on TSL** (compression, continuous aggregates, policy jobs) on scale-to-zero compute.
  If a specific hot app genuinely needs them, that app is a candidate to move **off** our plane onto
  a dedicated always-on TimescaleDB/CNPG instance — an escalation path, not the platform default.
- **NO to adopting self-hosted TimescaleDB as the base stack** — it deletes scale-to-zero.

### Consequences
- Time-series apps get "good enough" partitioning with no new components. ✅
- We must be honest in docs that compression/continuous-aggregates are unavailable here. ⚠️
- *Uncertain / untested:* whether adding `timescaledb.license=timescale` to our compute spec is
  even accepted by Neon's build, and whether any TSL job would survive a wake cycle. Not worth
  validating unless (b)-escalation is on the table.

---

## Q2 — Sharding mechanism

### Evidence (measured)
- **Neon storage sharding is real in OSS 8464.** `storage_controller --help` exposes
  `--split-threshold`, `--initial-split-threshold`, `--initial-split-shards` (default 2),
  `--max-split-shards` (default 16), `--shard-split-request-timeout` — automatic + initial tenant
  **shard splits across pageservers**, orchestrated by the storage controller. This is *storage*
  scale-out (GetPage@LSN throughput / capacity), stripe size 256 MiB, transparent to compute.
- **`pg_partman` 5.1.0** is available on the live compute (native declarative partitioning helper).
- **No Citus** anywhere in the compute image (`find … citus` → empty).

### Analysis
- **(a) Per-app scale — already sharded by tenant.** Our model is *one DB (tenant/timeline) per
  knext app/zone*. That **is** application-level sharding: N apps = N independent primaries + their
  own storage, no cross-tenant contention. Adding pageserver shard-split on top scales a *single
  large tenant's* storage I/O across pageservers **without touching compute** — but our MVP runs 1
  pageserver, so this is a documented growth lever, not wired yet.
- **(b) Write scaling within one DB.** All options for a single hot writer:
  - *Native declarative partitioning + `pg_partman`* — works everywhere, no new infra, our
    recommendation. Doesn't add write throughput past one primary but bounds table/index size and
    enables cheap `DETACH`-based retention.
  - *Citus* — **NO.** Licensing is fine (AGPL, fully open-sourced), but Citus workers are
    **stateful Postgres nodes with local storage** and its own coordinator/cluster manager —
    fundamentally incompatible with our disaggregated, stateless, scale-to-zero compute. Not in the
    image. Would replace, not extend, our plane.
  - *Timescale hypertables* — single-node partitioning; works wherever the extension works (see Q1).
    Multi-node removed (2.14).
  - *App-level shard-per-tenant behind the gateway's `template` wake mode* — the natural KS-PG
    scale-out: split a hot app into multiple tenants/timelines, route by shard key at the gateway.
    This is the seam already reserved for SCS multi-tenancy.
- **(c)** Neon gives storage read-scaling free; nobody gives single-primary *write* scaling free
  except by partitioning (bounds one node) or sharding across tenants (our gateway's job).

### Decision (Q2)
1. **Per-app scale → keep tenant-per-app.** It is already sharding; no new mechanism. ✅
2. **A single app outgrows its storage I/O → enable Neon pageserver shard-split** (OSS, already in
   8464). Add pageservers + set split thresholds on the storage controller. Reuse, don't reinvent.
3. **A single app outgrows one *writer* → native partitioning + `pg_partman` first**; if it truly
   needs write scale-out, **shard-per-tenant behind the gateway `template` mode**, not Citus.
4. **Time-series workloads → hypertables (Apache-2)** for chunk pruning + `drop_chunks` retention.

### Consequences
- Everything recommended is already in our images or a config/pageserver-count change — no new
  external system, satisfies "don't reinvent + easy to host." ✅
- Real write scale-out defers to gateway `template`-mode sharding, which is **not yet built**
  (parked with SCS multi-tenancy) — this ADR names it as the future seam. ⚠️
- *Uncertain:* pageserver shard-split has not been exercised on our 1-pageserver MVP; validate
  before relying on it for a production hot tenant.

---

## Sources
- Empirical: `neondatabase/compute-node-v17:latest`, `neondatabase/neon:8464`, live `scale-zero-pg`
  (2026-07-02); `deploy/54-compute-files.yaml`.
- Neon TimescaleDB support — https://neon.com/docs/extensions/timescaledb
- Neon extensions list — https://neon.com/docs/extensions/pg-extensions
- Neon storage sharding — https://neon.com/blog/how-we-scale-an-open-source-multi-tenant-storage-engine-for-postgres-written-rust
- Neon pageserver sharding issue — https://github.com/neondatabase/neon/issues/4650
- TimescaleDB multi-node removal (2.13 deprecate / 2.14 remove) —
  https://github.com/timescale/timescaledb/blob/main/docs/MultiNodeDeprecation.md ,
  https://github.com/timescale/timescaledb/releases/tag/2.14.0
- TimescaleDB editions (Apache-2 vs TSL/Community) — https://docs.timescale.com/about/latest/timescaledb-editions/
</content>
</invoke>
