# Iteration-2 — Independent System-Design Review

*Reviewer: independent senior system-design reviewer (round 3). I did not build this.
Blinded: judged only from primary sources — `gateway/`, `deploy/`, `warmstandby/`,
`bakeoff/`, `docs/` (README, CLAUDE, TASKS, ADR-0001/0002, getting-started, connecting,
operations), git log, and the live `orbstack` cluster (namespaces `scale-zero-pg`,
`bakeoff-cnpg`). I did not read `docs/reviews/` or `docs/plan-*.md`.*

*Date: 2026-07-02. Subject: the just-ratified foundation (ADR-0002: Neon, two-tier —
cold-zero default + opt-in 413 ms warm-standby prototype in `warmstandby/`).*

---

## Scorecard (1–10, with one-line justification)

| Metric | Score | Justification |
|---|---:|---|
| **Maturity** | **5** | Real evidence, honest ADRs, and a live 0→1→0→1 loop I reproduced myself — but the ratified decision-of-record contradicts its own body, and the tier it ratifies exists only as a bash-gated measurement harness. Experiment-plus, not yet boring. |
| **Ease of maintenance** | **4** | The ratified (Neon) path is 6 data-path workloads + a pinned compute↔storage version-pair + a disaggregated **Rust** storage cluster with zero Rust on-call staffed — the ADR counts this honestly, and the *rejected* option was the simple one. Two-tier adds a second compute Deployment + gate orchestration on top. |
| **Production reliability** | **4** | Data-survival drills, 2/3 WAL quorum, HA peer-aware gateway, and TOCTOU heal are genuinely good. But no backups, an acknowledged single-pageserver read SPOF, a warm-tier single-writer invariant guarded only by unversioned shell, and a version-pair held by human discipline. Happy path is solid; the catastrophic-loss safety net isn't built. |

*Trajectory: iteration-1 mean was ease 6.0 / reliability 4.7. Maintenance dips because
the two-tier ratification **added** ops mass the project's own bake-off argued against;
reliability roughly holds — HA gateway up, but backups still absent and a new warm-writer
corruption vector introduced.*

---

## Findings (real problems only)

| Sev | Finding | Evidence | Consequence | Remedy |
|---|---|---|---|---|
| **High** | **ADR-0002 contradicts itself.** The header ratifies "Neon, two-tier"; the Decision, Consequences, and the bake-off Recommendation still say the opposite. | `docs/adr-0002-database-foundation.md:3` ("**Neon, two-tier**") vs `:127` ("**Adopt CloudNativePG-hibernation as the default … (Proposed.)**") and `bakeoff/results/SUMMARY-final.md:43` ("**CNPG-hibernation as the default**"). | The single decision-of-record cannot tell a new engineer what was actually decided. The live cluster (`scale-zero-pg` fully deployed, `compute` Deployment 0/0) proves Neon is the live choice, so the header is authoritative and the body is stale — but nobody reading cold can know that. This is the exact 3-years-later failure mode. | Rewrite the Decision/Consequences/Recommendation to match the ratified header (Neon two-tier), or move the CNPG recommendation into a clearly-labeled "rejected alternative / escalation lane" section. Reconcile `SUMMARY-final.md` too. |
| **High** | **The "opt-in warm tier" that justifies the two-tier decision is a measurement harness, not a product — and its sacred single-writer invariant lives in unversioned bash.** | `warmstandby/_measure.sh:53` `assert_single_writer()` (shell); `warmstandby/README.md:138` ("A bug that releases the gate while `compute` is up = **two writers on one timeline = corruption**"); the gateway has no warm/tier concept (`gateway/internal/wake/wake.go` modes = static/exec/kubectl/template only). | ADR ratifies a *two-tier architecture* on a prototype that is single-tenant/pre-bound, wakes via `kubectl exec touch`, and whose only guard against double-attach corruption is a test script. There is no production path and no tested code enforcing the invariant. | Do not describe the warm tier as ratified architecture until it exists behind the gateway. If productized, the single-writer gate must be tested Go in the wake path (as `warmstandby/README.md:153` itself demands), not shell. |
| **Med** | **Backups / PITR genuinely not built — on the path that has the weaker backup story.** | `TASKS.md:37` (phase-3, unchecked); `docs/operations.md:43–53` durability model has no backup/restore; `deploy/` has no backup manifest (confirmed: none); ADR §3 notes CNPG ships `ScheduledBackup` CRDs, Neon "not yet built". | The ratified foundation is the one *without* a restore story: single pageserver (read SPOF), single MinIO, no `ScheduledBackup`, no rehearsed restore drill. Loss beyond the PVC = data loss. | Wire a pageserver→MinIO offload backup + a rehearsed restore drill before any "production-reliable" claim; add a secondary pageserver (kill-criterion #6 already treats a user-facing single-pageserver outage as a release blocker). |
| **Med** | **Wake-latency claims are optimistic vs observed.** | README headline "**2.4–2.5 s**" (`README.md:91`); ADR p50 **3.7 s**; `warmstandby/README.md:110` same-session **3420 ms**; **my independent live `deploy/_verify-wake.sh` run measured 5355 ms gateway wake latency.** | The public number (2.4 s) is a best-case CoreDNS-fixed sample, not representative. A single 5.4 s observation is already near kill-criterion #2's regression gate (>30% beyond the 5.1 s baseline ≈ 6.6 s). | Publish a percentile band (p50/p95 across N, as the bake-off does) rather than a best-case headline; wire kill-criterion #2 into the CI bake-off gate. |
| **Med** | **Compute↔storage version-pair (`8464`/`8464`) enforced by human discipline — a self-declared release blocker not yet closed.** | `docs/operations.md:110–117`; ADR kill-criterion #3 ("if it is ever trusted to human discipline in production ⇒ that is a release blocker"); no manifest/CI tag-parity check exists in `.github/`. | An accidental tag divergence on one of the two images gives an unsupported, "no cross-version guarantee" pairing with unsafe storage rollback. The project has flagged this as a blocker but not implemented the guard. | Add a manifest/CI validation that fails on `neon` vs `compute-node-v17` tag divergence (small, TDD-shaped). |
| **Low** | **TLS absent; plaintext dev creds.** | `deploy/10-gateway.yaml:117` ("front it with TLS termination"); `docs/connecting.md:8,13` `sslmode=disable`; `cloud_admin/cloud_admin`. | Fine for a local MVP; unshippable to a shared/prod network. Honestly tracked (`TASKS.md:37`). | TLS termination in front of the gateway + real secret management before external exposure. |
| **Low** | **NetworkPolicy is inert on the dev cluster.** | `docs/operations.md:68–75`; OrbStack CNI doesn't enforce NetworkPolicy; `_verify-netpol.sh` warns rather than faking a pass. | Isolation is declaratively correct but unverified locally. Handled honestly. | Re-run on Calico/Cilium before relying on isolation; keep the honest warn. |

---

## What breaks at 10×

- **Cold-wake thundering herd.** `ConnectWithWake` issues one wake then every connection
  polls the shared compute (`gateway/internal/wake/wake.go:248`). 10× concurrent
  cold-connects to one idle DB all block on a single 0→1 that took **5.4 s** in my run;
  `compute max_connections=100` and `GW_MAX_CONNS=90` cap throughput but not the wake
  stampede. Concurrent-cold-start p99 is explicitly untested (`TASKS.md:39`).
- **Single pageserver.** Read path is one pod (`deploy/53-pageserver.yaml:31`
  `replicas: 1`). At 10× tenants/read volume it is both a throughput ceiling and a
  whole-data-plane read SPOF — the growth lever (shard-split, ADR-0001) is documented
  but unexercised (`TASKS.md:38`).
- **Multi-tenancy doesn't exist.** The `template` wake mode is a seam
  (`wake.go:147`) but SCS is parked; today one gateway fronts one compute. 10× *systems*
  needs the parked provisioning path built and the warm pool moved to "design B"
  (attach-on-wake), which is not prototyped.
- **Warm tier at scale = corruption surface.** Design A pre-binds one pod to one
  timeline; N warm systems = N parked pods each guarded by the same bash invariant. The
  blast radius of a gate bug scales with tenant count.

## The 3-years-later test

A small team that inherits this in 2029 finds **admirably honest docs** — the ops-mass
inventory, kill criteria, and every gap (backups, SPOF, TLS, version-pair) are named, not
hidden. That is the project's strongest asset and rare. But they also find:

1. **A decision-of-record that argues with itself** (Finding 1). They cannot tell from
   ADR-0002 alone whether they are running Neon or CNPG; they must reverse-engineer it
   from the live cluster. A decision doc that requires archaeology has failed its one job.
2. **A "two-tier" platform where the second tier is a `warmstandby/` folder of shell** —
   no gateway integration, single-writer safety in a test script. If they try to turn on
   the warm tier a doc promised them, they risk two-writer corruption.
3. **A Rust storage cluster they cannot service.** Six data-path workloads and a
   version-pair treadmill, with "zero Rust storage on-call today" (ADR §3) still true.
   The first `8464`→next upgrade with a protocol change is an incident they can't resolve
   in-house — kill-criterion #1 tells them to pivot to managed, which is the honest answer
   but means the self-hosting was transitional all along.

**Net:** the engineering is careful and the evidence is real — the live loop passes, the
drills pass, the honesty is exemplary. The gap between *what was measured* (a working
cold-zero MVP + a warm-wake prototype) and *what was ratified* ("Neon, two-tier platform")
is where maturity is lost. Close Finding 1 (reconcile the ADR) and Finding 2 (stop calling
the harness a tier) and the same artifact reads two points more mature without a line of
new infrastructure.

---

### Live verification performed for this review

- `kubectl` (orbstack): `scale-zero-pg` — `compute` Deployment **0/0**, storage plane
  (safekeeper 3/3, pageserver 1/1, minio, broker) all Running, `pggw` **2/2**;
  `bakeoff-cnpg` — CNPG cluster healthy, PVC `pg-1` bound. Both foundations still live.
- `deploy/_verify-wake.sh` (I ran it): full **0→1→0→1 loop PASSED** — seeded 3 rows,
  compute to zero, cold connect woke it and returned 3 rows in **5355 ms gateway wake
  latency**, idle window scaled back to zero, reconnect re-woke with data intact.
