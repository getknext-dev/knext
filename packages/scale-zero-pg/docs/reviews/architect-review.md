# Independent Architect Review — scale-zero-pg

*Reviewer: independent principal architect. Formed from primary sources only
(README, CLAUDE.md, TASKS.md, `postgres-neon-scs-architecture-detailed.md`,
ADR-0001, knext-research, gateway/ Go, deploy/ manifests, git log). I did not
read other reviews.*

---

## Executive verdict

The custom Go wake-gateway is the right thing to build and is built well; the
decision to **self-host Neon's disaggregated Rust storage plane** for a
single-database MVP is the wrong place to spend the complexity budget against a
goal that literally says *"easy to host, easy to maintain."* You have taken on
the hardest-to-operate component to save build effort on the easiest-to-reason-
about one (durability), and you did it with no measured comparison to the
lighter CNPG-hibernation path — which is, notably, your consumer knext's *own
default* database engine. The platform works and demos cleanly, but its
foundation was chosen by inheritance from the architecture doc, not by a
decision that weighed the goal's ease-of-operation clause.

| Dimension | Score | One-line justification |
|---|---|---|
| **Architecture fitness** (right shape for the goal) | **6/10** | Gateway is correct and clean; storage foundation is over-built for "easy to host, reliable-enough single DB," and no measured alternative was tried. |
| **Evolution readiness** (grow to prod + multi-tenant without rework) | **5/10** | Single-tenant is baked in (fixed compute key), the idle decision lives in the wrong layer, secrets/TLS are unbuilt, and compute/storage versions are unpinned — all need rework before N-tenant production. |

---

## Reuse-vs-build audit — where complexity is spent well vs wasted

**Spent well:**

- **The Go gateway is the axle worth building.** ~1,900 LOC, TDD throughout
  (red/green pairs visible in `git log`), clean layering
  (`proto` / `wake` / `gateway` / `metrics`). Wake-on-connect over raw TCP is
  genuinely *not* provided by Neon's OSS self-host path (Neon's `proxy` is
  coupled to its cloud control plane), so this is real, novel glue. The 57P03
  "starting up" absorption (`gateway.go:257`) and the mode-agnostic `Driver`
  seam (`wake.go:67`) are thoughtful. This is exactly the "build only the axle"
  principle from the architecture doc, executed.
- **Reusing Neon storage rather than rebuilding WAL/snapshot/replication.**
  Against the abandoned PGlite plan (which hand-built a WAL service, snapshot
  subsystem, and fencing), adopting Neon's durability is unambiguously correct —
  single-writer is intrinsic, no bespoke lease. The *principle* of the pivot is
  sound.

**Spent poorly / inverted:**

- **Operating the full Neon storage plane for one database.** `deploy/` carries
  MinIO, storage-broker, a 3-member safekeeper quorum, a pageserver, a storage-
  init Job, and compute ConfigMaps (`50`–`55`) — a disaggregated Rust storage
  cluster — to serve a *single* tenant/timeline. The product value delivered
  (scale-to-zero) is a 1,900-line proxy; the operational mass sits entirely in
  the reused component you must now run, patch, and debug in production. The
  architecture doc *itself* flags this: A1 (`architecture-detailed.md` §2),
  principle 6 (§3), the trade-off reading (§12: *"if the operational burden is
  unacceptable, the honest alternative is managed Neon/Aurora"*), and open
  question §15.6 (*"do we have the capacity to run a Rust-based disaggregated
  storage system in production?"*). The build answered "yes, self-host" without
  recording that decision or its evidence.
- **The unchosen alternative is your consumer's default.** `docs/knext-research.md`
  §4: knext's default zone DB is **CloudNativePG**, and knext's own docs
  (`postgres-scale-to-zero.md` §5) flag *"Neon self-hosting is unsupported for
  production."* knext's draft ADR even evaluated the exact KS-PG shape — Option
  C, CNPG + `cnpg-i-scale-to-zero` (hibernate) + a wake-on-connection proxy —
  and the *same Go gateway would sit in front of it unchanged*. CNPG-hibernation
  trades slower wake (pod resume + volume attach vs Neon lazy page fetch) and
  loses free branching/PITR, but for "easy to host, reliable enough" it is very
  plausibly the better trade — and it reuses an operator that is already run at
  scale and is already in your consumer's stack. That this bake-off was never
  measured is the single biggest gap in the reuse-vs-build reasoning.

---

## Decisions that will age badly (ranked)

1. **Self-hosting Neon storage as the foundation, decided implicitly.**
   *Evidence:* five storage manifests + init Job vs a proxy as the actual
   deliverable; the architecture doc's own A1/§12/§15.6 escape hatches; knext
   marking Neon self-host "unsupported for production." *Decide instead:* write
   the ADR that was skipped — **managed Neon vs self-host Neon vs CNPG-
   hibernation**, scored on the goal's own metrics (wake p99, ops toil per
   month, failure-drill outcomes). Run the CNPG path in parallel for one sprint
   with the *same gateway* and compare. You may well confirm self-host Neon —
   but decide it, don't inherit it.

2. **The gateway owns the idle/sleep decision.** *Evidence:*
   `gateway.go:308` (`connEnded`) → `scheduleSleep` (`:324`) plus the whole
   `peers.go` fleet-scrape, RBAC on `pods` (`10-gateway.yaml:22`), and a
   fail-safe that biases to *never sleep* on any peer error. A stateless data-
   path proxy has quietly become a stateful, quorum-ish distributed *controller*
   — split-brain sleep is a real enough failure mode that you had to write a
   drill (`_verify-ha.sh`). This is control-plane logic living on the hot data
   path. *Decide instead:* wake stays in the gateway (it must, to hold the
   connection); **scale-down ownership moves to KEDA** (already scaffolded in
   `40-keda-scaledobject.yaml.optional`) or a tiny dedicated controller. Do it
   now, at one DB — template mode will multiply this problem by N.

3. **kubectl-mode single-deployment scaling as the default.** *Evidence:*
   `wake.go:129` `kubeDriver`, `Target.Key = ns+"/"+deployment` (`wake.go:204`),
   `GW_K8S_DEPLOYMENT=compute` hardcoded. The design is implicitly single-tenant;
   `templateDriver` exists (`wake.go:147`) but is parked and *unexercised* (no
   test, no manifest, TASKS.md "un-park SCS"). *Decide instead:* treat
   template-mode as a first-class, tested path *before* claiming a multi-tenant
   evolution story — or explicitly declare single-tenant-per-cluster as the
   supported topology and stop implying otherwise.

4. **The load-bearing "pool idle < GW_IDLE_MS" contract exists only in prose.**
   *Evidence:* README §knext-integration; nothing enforces it. A misconfigured
   knext pool (`DB_POOL_IDLE_TIMEOUT_MS` ≥ `GW_IDLE_MS`) silently defeats
   scale-to-zero — i.e. defeats the entire product. The architecture doc even
   says "treat never-scales-to-zero as alertable" (§6.6) but no alert exists.
   *Decide instead:* ship the alert (idle compute that never reaches zero) and
   document the sizing rule as a checked invariant, not advice.

5. **Secrets/TLS deferred on a shared-cluster database.** *Evidence:* dev creds
   `cloud_admin/cloud_admin`, md5 in a ConfigMap, `compute_ctl` re-applies spec
   roles every boot so `ALTER USER` won't stick (README ops note); TLS is
   "in front of the gateway" future work (TASKS.md Phase 3). For a DB multiple
   knext zones will share, this is a debt clock, and it's squarely inside
   "reliable enough."

---

## Contracts to make explicit

- **compute ↔ storage version compatibility.** `20-compute.yaml:54` runs the
  compute as `compute-node-v17:latest` while the init/wait container and storage
  plane pin `neondatabase/neon:8464` (`20-compute.yaml:35`). `:latest` on the
  compute is a time-bomb: a Neon image bump can silently break wire/protocol
  compat with the pinned pageserver. **Pin the compute image and document the
  compute/storage version pair as a supported matrix.**
- **Who is allowed to scale `compute`.** Today the gateway (kubectl mode) *and*
  optionally KEDA can both drive replicas 0↔1. If both are ever enabled they
  fight. Make scaling ownership singular and written down.
- **The knext ↔ platform interface.** The `DATABASE_URL` Secret + the pool-idle
  sizing rule is *the* contract and it's prose. Write it as an interface spec,
  including the single-writer invariant (one primary per timeline) — currently
  enforced only by `strategy: Recreate` (`20-compute.yaml:21`) plus "don't run
  two," with the failure mode unstated.
- **"Storage plane never scales to zero" is enforced by nothing.** No
  PodDisruptionBudget, no policy guard. A stray `kubectl scale` on a safekeeper
  *is* data loss. This invariant is load-bearing and unprotected.

---

## Recommended sequencing (my order — I don't know what other reviewers said)

The roadmap order (warm-standby → template multi-tenancy → shard-split →
TLS/secrets) optimizes the wrong axis first. Mine:

1. **Foundation bake-off + kill-criteria ADR.** Measure CNPG-hibernation+proxy
   vs self-host-Neon vs managed-Neon on wake p99, ops toil, and failure drills,
   with the *same gateway* in front. Decide the foundation before hardening it —
   building warm-standby on an unvalidated foundation compounds the risk.
2. **Move scale-down ownership out of the gateway** (KEDA or a small controller).
   Do it at one DB, before template-mode multiplies the split-brain surface.
3. **Security/secrets/TLS hardening.** Table stakes for a shared platform DB and
   the biggest current gap against "reliable enough." Precedes any prod or
   multi-tenant use.
4. **Warm-standby pool (sub-second wake).** This is a *perf* optimization and it
   deepens Neon-specific attach-on-wake coupling (harder to walk back) — so it
   comes *after* the foundation and ownership calls, not before.
5. **Template multi-tenancy.** Only after 1–4; it multiplies every unsolved
   problem (idle ownership, secrets, version compat) by N.
6. **Pageserver shard-split.** Correctly last — genuinely out until a real
   tenant's measured storage I/O is the bottleneck (ADR-0001 already frames it
   as a growth lever, not a task).

**Declare out-of-scope forever:** horizontal *write* scaling within one DB
(single primary is accepted — keep it); cross-region active/active; forking or
re-operating a bespoke Neon-storage operator; TSL TimescaleDB features on
scale-to-zero compute (ADR-0001 already kills these correctly).

---

## Kill criteria — measurable pivot triggers

Pivot **off self-hosted Neon** (→ managed Neon, or CNPG-hibernation + this same
gateway) if any of these hold after an honest measurement window:

- **Ops toil:** storage-plane incidents (pageserver/safekeeper recovery, S3
  offload stalls, storage-controller reassignment) exceed **~1 engineer-day per
  month** in steady state, or any incident causes data loss / unrecoverable
  timeline.
- **Wake latency isn't the differentiator:** if measured cold-wake p99 stays
  **> ~2s** (currently k8s pod mechanics dominate, ~2.4s — the Neon lazy-fetch
  edge is only ~123–160ms of it per README), then Neon's headline advantage over
  CNPG-hibernation has evaporated and you're paying storage-cluster ops for
  nothing.
- **Operator/version treadmill:** keeping compute/pageserver/safekeeper versions
  mutually compatible costs more than one upgrade-sprint per quarter, or a Neon
  image bump breaks the plane in a way you can't quickly diagnose without Rust /
  Neon-internals expertise you don't have (§15.6).
- **Consumer posture:** if knext standardizes its zones on CNPG (its current
  default) and KS-PG remains the only Neon-self-host consumer, the platform is
  carrying a storage stack its sole consumer's docs call "unsupported for
  production" — pivot to align.
- **Branching/PITR go unused:** if, after a quarter of real use, per-PR branch
  databases and point-in-time restore (the capabilities that justify Neon over
  CNPG) are not actually exercised by knext, the Neon premium isn't buying
  anything the lighter path wouldn't.

Pivot **to managed Neon specifically** if the team cannot staff the operating
expertise for a disaggregated Rust storage system — the architecture doc names
this honestly (§15.6); the review just makes it a trigger.
