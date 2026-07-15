# System-design re-review — iteration 1

**Reviewer:** independent (did not build this system). Formed from primary sources only —
code, manifests, docs, git log, and the live `scale-zero-pg` cluster (context `orbstack`).
Prior reviews were deliberately not read.

**What I ran (live, 2026-07-02):**
- `deploy/_verify-wake.sh` → **pass**: real `0→1→0→1` loop, cold connect returned rows in **7s
  end-to-end**, gateway-reported wake latency **3544ms**, idle window returned compute to zero.
- `gateway/ go test ./...` → **all packages green** (gateway 7.3s, metrics, proto, wake).
- Cluster inspection: compute `0/0` at rest, 2× `pggw`, 3× `safekeeper`, 1× `pageserver`, 1× MinIO.
- Confirmed a separate `bakeoff-cnpg` experiment exists — **out of scope**, noted only.

---

## Executive verdict

This is a genuinely well-built MVP: the wake loop, single-writer safety (delegated to Neon's
safekeeper quorum), and durability story are real, verified, and honestly documented — the verify
scripts are executable specs that actually run and pass, and the docs rarely oversell. But the
platform's headline promise — *per-app scale-to-zero Postgres with data sovereignty* — is not yet
achievable: only **one** tenant/timeline is wired, multi-tenant `template` mode is parked and
untested, and one busy app pins the single shared compute up for everyone. Production-blocking gaps
remain around transport security (plaintext front door), a gateway connection cap that is 5× the
backend's `max_connections` with no pooler, and single-replica pageserver/MinIO with no
volume-loss runbook.

| Dimension | Score | One-line justification |
|---|---|---|
| **Maintainability** | **7/10** | Clean, tested, exceptionally well-commented code + honest verify scripts + thorough docs; dragged down by deep opaque Neon-internals coupling, manual version-pair upgrades, and no volume-loss recovery runbook. |
| **Production-readiness** | **5/10** | Verified wake + durability core, but single-tenant-only (the actual product goal is parked), no TLS, conn-cap/`max_connections` mismatch with no pooler, and single-point storage tiers. A strong demo, not yet production. |

---

## Findings

| # | Sev | Finding | Evidence | Consequence | Remedy |
|---|-----|---------|----------|-------------|--------|
| 1 | HIGH | The product goal is per-app scale-to-zero DBs ("one database per app"), but only **one** fixed tenant/timeline is provisioned; multi-DB `template` mode is parked and untested. | `deploy/55-storage-init.yaml` hardcodes `TENANT_ID=f000…f001`/`TIMELINE_ID=…f002`; `54-compute-files.yaml` `config.json` `"databases": []`; `wake.go:147` `templateDriver` has no live path/verify. `docs/connecting.md` states the one-DB-per-app policy that the wiring can't yet deliver. | Every knext app shares one Postgres compute → no data-sovereignty isolation, and any single app holding a connection keeps the compute (and its cost) awake for **all** apps. The differentiator is aspirational. | Wire + verify `template` mode end-to-end (per-system compute Deployments + provisioning) before claiming per-app scale-to-zero; until then, scope docs to "single shared DB". |
| 2 | HIGH | Gateway connection cap (500) is **5× the backend `max_connections` (100)** and there is no pooler. | `deploy/10-gateway.yaml` `GW_MAX_CONNS: "500"`; `54-compute-files.yaml` `max_connections=100`; gateway is a pure byte pipe post-handshake (`gateway.go:283-284`). | Under load, up to 400 connections pass the gateway's clean 53300 gate, then fail at Postgres with `too many clients` — a worse, later, less-legible failure. Thundering herd onto one 1Gi Postgres. | Align `GW_MAX_CONNS` to backend capacity, or front the compute with pgbouncer; document the relationship. |
| 3 | HIGH | All traffic is plaintext: the gateway declines SSL and the external `LoadBalancer` exposes `:55432` unencrypted, including md5 auth. | `gateway.go:181` writes `"N"` to every SSLRequest; `10-gateway.yaml` `pggw-lb` (type LoadBalancer) publishes `55432`. Documented as a phase-3 gap (`TASKS.md`). | Credentials + query data are sniffable on any path that leaves the cluster; a DB front door with no TLS is not shippable to production. | Terminate TLS in front of / inside the gateway (or restrict `pggw-lb` to in-cluster only) before external exposure. |
| 4 | MEDIUM | Cross-gateway sleep race: the TOCTOU wake-back heal only re-checks the **initiating** pod's local count. | `gateway.go:422-433` reads only `e.count` on the pod that slept; peer scrape (`peers.go`) narrows but doesn't close the window before `driver.Sleep`; `k8s.go:57-63` GetScale/UpdateScale has no conflict retry. | A connection landing on peer B in the sub-second window after A scraped B=0 can have its compute scaled to zero under it → dropped connection. Data-safe (single-writer holds; client reconnects), but a real availability blip. | Re-check the fleet (not just local) immediately before Sleep, or gate Sleep behind a short lease/annotation; retry on scale conflict. |
| 5 | MEDIUM | Peer-aware idle scrapes **every** sibling pod's metrics sequentially on each sleep decision, inside a 5s budget with a 2s/peer timeout. | `peers.go:52-70` (sequential loop), `peers.go:48` `Timeout: 2s`, `gateway.go:388` 5s ctx. | Beyond ~2-3 gateway replicas, one slow/restarting peer makes the whole check error → sleep is postponed → compute may **never** scale to zero, silently defeating the core feature. A ceiling on the always-on tier. | Parallelize + bound scrapes; treat unreachable (vs busy) peers distinctly; consider a shared count (annotation/CRD) over N² scraping. |
| 6 | MEDIUM | Config parsing is silent-fallback; no effective-config logging; whitelist-free env read means a typo'd knob is silently ignored. | `gateway.go:85-92` and `main.go:19-26` swallow parse errors → defaults; `wake.go:39-50` `EnvFromOS` takes any `GW_*` (so `GW_IDEL_MS` typo → default 300000, no warning). | Misconfiguration (bad idle window, disabled cap via negative value) fails silently and is hard to diagnose in prod. | Validate + fail-fast or warn on unparseable/negative values; log the resolved config at startup. |
| 7 | MEDIUM | Single pageserver + single MinIO are read/history SPOFs (acknowledged), but there is **no volume-loss recovery runbook**, and the pageserver runs with no storage controller. | `53-pageserver.yaml` `replicas:1`, `pageserver.toml` `control_plane_emergency_mode=true` + junk `control_plane_api`; `50-minio.yaml` single replica; `operations.md` covers *pod* loss only, not *PVC* loss. | If the pageserver or MinIO PVC is lost, re-attaching the tenant is a manual, undocumented operation — exactly when the team most needs a runbook. | Add a secondary pageserver (per TASKS phase 3) and write an explicit "pageserver/MinIO volume lost → recover from S3" runbook. |
| 8 | MEDIUM | Doc-vs-reality drift: `connecting.md` says "the gateway doesn't cap connections," which is false since `GW_MAX_CONNS=500` shipped. | `docs/connecting.md` pooling rule #3 vs `10-gateway.yaml` `GW_MAX_CONNS`. | Operators sizing pools trust a stale guarantee; erodes the otherwise-high doc trust. | Update the pooling section to describe the cap and its 53300 rejection. |
| 9 | LOW | `handshakeUntilReady` opens a fresh TCP connection to the backend on every 57P03 retry. | `gateway.go:334` calls `ConnectWithWake` again inside the retry loop. | Minor connection churn against a just-booting Postgres during cold start. | Reuse the socket where possible, or cap retry cadence (already bounded by `RetryMs`). |
| 10 | LOW | The compute spec (`config.json`) carries an opaque baked-in JWKS key, `operation_uuid`, and `format_version` with no provenance/ownership doc. | `54-compute-files.yaml` `compute_ctl_config.jwks`, `operation_uuid`, `format_version:1.0`. | Nobody on a small team can safely regenerate or reason about these; a Neon spec-format change strands them. | Document where each opaque field comes from and how to regenerate, or link the upstream Neon reference. |
| 11 | LOW | Published wake numbers are optimistic vs observed. | Docs cite `2.4s`/`5.2s`; live run measured `3544ms` gateway latency / `7s` end-to-end. | Same ballpark, not misleading, but claims drift from reality over time. | Keep a single sourced latency number refreshed from the verify script output. |

*No CRITICAL findings.* Single-writer correctness holds: `Recreate` + `replicas 0↔1` never yields two
computes, and Neon's safekeeper generation fencing prevents split-brain even during a scale race —
the data-safety core is sound.

---

## What breaks at 10×

- **10× connections (~5000 concurrent):** `GW_MAX_CONNS=500` rejects ~90% cleanly (good), but of
  the 500 admitted, ~400 exceed the compute's `max_connections=100` and fail at Postgres auth
  (finding #2). No pooler, one 1Gi Postgres → herd. **Breaks well below 10×.**
- **10× databases (10 apps):** all still land on the **one** wired tenant/timeline (finding #1).
  `template` mode is untested; there is no provisioning API. Per-app scale-to-zero and per-app
  sharding don't exist yet. **Doesn't scale on this axis at all today.**
- **10× write volume:** single pageserver (1Gi memory limit → OOM on a larger working set), single
  MinIO, safekeeper PVCs at 2Gi. Read path is one pageserver. **Storage tier is the ceiling; needs
  a second pageserver + right-sized PVCs/limits before real write load.**
- **10× gateway replicas:** peer-idle N² scraping (finding #5) makes reliable scale-to-zero
  *harder* as you add gateways — the always-on tier has its own ceiling.

---

## The 3-years-later test (written down vs trapped in heads)

**Genuinely written down (above average for an MVP):**
- `operations.md` — full config table, monitoring/alerts, durability model, password rotation,
  upgrade (version-pair) procedure, troubleshooting table.
- `connecting.md`, `getting-started.md`, `README.md`, `ADR-0001` (with reproducible evidence).
- Verify scripts (`_verify-*.sh`) double as executable, honest acceptance specs; CI runs
  gofmt/vet/test. Inline comments explain *why* (CoreDNS neg-cache, Recreate, publishNotReadyAddresses).

**Still trapped in heads / Neon-internals coupling (the real 3-year risk):**
- The `compute_ctl` spec semantics — `format_version`, `operation_uuid`, JWKS provenance,
  `generation:1`, `AttachedSingle` — are opaque Neon internals with no local doc (findings #10).
- **How to create a second database/tenant** end-to-end (the parked path) is undocumented; the fixed
  magic IDs (`f000…`) hide that there's no provisioning story.
- **Volume-loss recovery** (pageserver/MinIO PVC) has no runbook (finding #7).
- Why `fsync=off` is safe, `synchronous_standby_names=walproposer`, and the hardcoded 3-name
  `neon.safekeepers` list (must be hand-edited if safekeepers are rescaled) — partially in
  `compute-files/README.md`, but the safekeeper-list coupling is a silent trap.
- The entire platform rests on deep Neon knowledge no doc captures; a Neon release that changes the
  spec format or wire protocol would strand a small team on the pinned `8464` pair.

**Bottom line:** a competent engineer inheriting this could operate the *happy path* from the docs
in an afternoon, but would hit a wall the first time they must add a second database or recover a
lost storage volume — the two things most likely to actually happen.
