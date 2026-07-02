# ADR-0002 — The database foundation: self-hosted Neon vs CloudNativePG-hibernation

- **Status:** Proposed (owner ratifies)
- **Date:** 2026-07-02
- **Deciders:** architecture owner (ratify), bake-off run by phase-4B
- **Supersedes the "decided by inheritance" foundation** flagged in `bakeoff/README.md`
  and the iteration-1 architect review (`docs/reviews/iteration-1/architect-review.md`).
- **Gate:** per `docs/plan-phase4.md` §4B, no further Neon-only hardening (4C) lands
  until this ADR is ratified.

---

## Context

KS-PG is a wake-on-connect scale-to-zero Postgres for exactly one consumer, the
**knext** platform. The storage foundation underneath the gateway was adopted from
the original architecture doc **without a measured comparison** — the iteration-1
architect review named this the single most important open decision and demanded a
bake-off promoted to a decision gate.

The bake-off's central, already-proven claim: **the same Go wake-gateway binary
fronts either foundation** — byte-identical `/gateway`, only the driver *mode* and
wake/sleep mechanism differ (kubectl-scale for Neon, hibernation-annotate for CNPG;
`bakeoff/results/SUMMARY-initial.md`). The foundation is therefore a **late-bindable
choice**, and this ADR binds it on evidence.

Two candidates, one ruler:

| | **Neon (incumbent)** | **CNPG-hibernation (candidate)** |
|---|---|---|
| Namespace | `scale-zero-pg` | `bakeoff-cnpg` |
| Storage | Disaggregated: safekeeper×3 + pageserver + broker + MinIO | One PVC on the primary pod |
| Wake | scale 0→1 + attach + lazy page fetch | un-hibernate = pod reschedule + PVC attach + PG start |
| Gateway mode | `kubectl` (scale subresource) | `exec` (`kubectl annotate` hibernation) |

---

## Evidence

### 1. Latency (n=20 per cell, one in-cluster psql client, connect + `SELECT count(*) FROM t` through each gateway)

Run id **`20260702T192637`**. Raw CSVs: `bakeoff/results/{neon,cnpg}-{cold,warm,reconnect}-20260702T192637.csv`.
Harness: `bakeoff/_run-battery.sh` (fixes the scaffold's cold-forcing bugs — see §Method).

| Foundation | Dimension | n | min | **p50** | **p95** | **p99** | max |
|---|---|---:|---:|---:|---:|---:|---:|
| **Neon** | cold wake | 20 | 3504 | **3717** | **4956** | 5067 | 5095 |
| **CNPG** | cold wake | 20 | 12261 | **14413** | **14848** | 14917 | 14934 |
| **Neon** | warm | 20 | 116 | **121** | 131 | 133 | 134 |
| **CNPG** | warm | 20 | 112 | **115** | 122 | 144 | 150 |
| **Neon** | reconnect-after-drain | 20 | 3565 | **3692** | **4878** | 4908 | 4915 |
| **CNPG** | reconnect-after-drain | 20 | 12808 | **14446** | **15223** | 16309 | 16580 |
*(all values ms; includes a constant ~100–200 ms `kubectl exec` client offset, identical for both foundations)*

**Reading:**
- **Cold wake is Neon's one real, measured differentiator.** Neon p50 3.7 s / p95 5.0 s
  vs CNPG p50 14.4 s / p95 14.8 s — Neon is **~3.9× faster cold**, very tight variance on
  both. Reconnect-after-drain mirrors cold on both (no meaningful warm-cache benefit
  either side).
- **Warm is a statistical tie (~120 ms both).** Steady-state latency is dominated by the
  *shared* gateway + probe, not the foundation — direct confirmation that the gateway is
  foundation-agnostic and the substrate only matters at the cold edge.
- **The gap is a latency delta, not a capability CNPG lacks.** CNPG serves the same rows;
  it is simply ~10 s slower to leave zero.

### 2. Failure drills (data survival — the reliability axis)

| Foundation | Drill | Result | Recovery |
|---|---|---|---|
| **CNPG** | hibernate (pod deleted, PVC kept) → un-hibernate | **PASS** — 3 rows intact, no restore (`SUMMARY-initial.md`) | sleep ~3.3 s |
| **CNPG** | **hard pod-kill** (`delete pod --grace-period=0 --force`) → operator reschedules on same PVC | **PASS** — a *new* pod (uid changed) served 3 rows on PVC `pg-1`, no restore (`bakeoff/_drill-cnpg-podkill.sh`) | **~16 s** (force-kill → new pod Running & serving) |
| **Neon** | compute pod-kill (no volume) → fresh pod re-attaches to tenant/timeline | **PASS** — proven in `deploy/_verify-storage.sh` | (re-attach, no restore) |

Both foundations survive their catastrophic-pod case with **no restore step** and the
seeded dataset intact. CNPG's single-PVC survival is simpler to reason about; Neon's
survival flows through the safekeeper-quorum + pageserver re-attach path. Note the
iteration-1 review's standing caveat: Neon's **single pageserver is a whole-data-plane
read SPOF** (`operations.md`), not yet mitigated — CNPG has no equivalent hidden SPOF.

### 3. Ops-mass inventory (the "easy to host/maintain" axis — counted honestly, live cluster)

| Axis | **Neon** | **CNPG** |
|---|---|---|
| Distinct workloads on the data path | **6**: compute + safekeeper×3 (STS) + pageserver (STS) + storage-broker + MinIO | **2**: 1 operator Deployment + 1 Cluster (1 pod) |
| Bootstrap Jobs | storage-init + minio-create-buckets | none (operator bootstraps) |
| Container images to track/pin | **≥3 data-path**: `neondatabase/neon:8464`, `neondatabase/compute-node-v17:8464`, `minio` (+ busybox) — **plus a compute↔storage version-PAIR** (`8464`/`8464`, "no cross-version guarantee", unsafe storage rollback) | **2**: `cloudnative-pg:1.29.2`, `postgresql:17.2` |
| PVCs | **6**: pageserver 5Gi + safekeeper×3 (2Gi ea) + minio 5Gi + (prometheus) | **1**: `pg-1` 1Gi (per instance) |
| Bespoke wiring | storage-init Job, compute ConfigMaps (`compute-config`, `compute-files`, `pageserver-config`), CoreDNS negative-cache fix | operator-managed; one declarative hibernation annotation |
| Upgrade unit | compute/pageserver/safekeeper protocol compat (Rust internals) — human-enforced today | operator handles rolling PG upgrades |
| Backup story | **not yet built** (single pageserver + single MinIO; PITR unexposed) | operator-native `Backup`/`ScheduledBackup` CRDs installed, unconfigured |
| Expertise needed | operate a disaggregated **Rust** storage cluster (zero Rust storage on-call today) | operate a widely-run PG operator |

**Neon = 6 data-path workloads + a pinned version-pair + 6 PVCs. CNPG = 1 operator +
1 pod + 1 PVC.** This is the counterweight to the ~10 s wake advantage.

### 4. knext posture (the consumer's own architecture — decisive input)

From `docs/knext-research.md`:
- knext's **default zone DB is PostgreSQL via CloudNativePG** — a *hard rule*
  (`scs-zones.md`). We would be replacing our only consumer's own default with a
  heavier stack.
- knext's data model is **per-zone data sovereignty**: every zone owns an *isolated*
  store, **no shared database**, enforced by `protect-zone-data-sovereignty.sh`. This
  **neutralizes Neon's shared-pageserver fan-out** — the multi-tenant economics that
  most justify a disaggregated plane don't map onto knext's isolated-per-zone model.
- knext's own draft ADR (`knext-plan-out/database-engine/`) evaluates *exactly the
  KS-PG design* (CNPG hibernate + wake-on-connection proxy) and decides knext stays
  **engine-agnostic and builds no DB scale-to-zero machinery** — it does **not** commit
  to Neon branching/PITR.
- The one place a Neon differentiator *could* land is knext **ADR-0013 (per-PR preview +
  data isolation)** — O(1) copy-on-write branching maps onto per-PR databases and CNPG
  cannot do it cheaply. But that commitment **does not exist today**.

---

## Decision

**Adopt CloudNativePG-hibernation as the default database foundation for KS-PG. (Proposed.)**

Rationale, weighing the evidence above against the architect's kill criteria:
- Neon's cold-wake advantage is **real but at the architect's decision boundary**: p95
  5.0 s vs 14.8 s ≈ **2.96×** — i.e. *within* the "~3× of CNPG" band the architect set as
  "not decisive enough to justify the ops mass **if** branching stays unused."
- **Branching / PITR / read replicas are all unused**, and the consumer has explicitly
  declined to commit to them. The reuse thesis ("reuse Neon's value") is therefore
  currently **false**: we reuse Neon's *cost* (6 workloads + version-pair + Rust on-call
  we don't staff), not its value.
- knext's own default is CNPG and its data-sovereignty model erases Neon's fan-out
  economics. Aligning KS-PG with the consumer's default **reduces** total system ops mass.
- Reliability favors the simpler substrate: CNPG has a single, well-understood PVC and no
  hidden read SPOF; Neon's single pageserver is an unmitigated whole-data-plane read SPOF.
- The cost of being wrong is low: the **gateway is foundation-agnostic**, so this is a
  reversible, late-bindable decision. Keep the Neon path (`scale-zero-pg`) as a
  **documented escalation lane**, not the default.

**The conditional, stated honestly (the shape the charter allows):**
> **CNPG by default. Choose Neon *iff* a hard product SLO requires sub-~5 s cold wake
> AND knext commits to per-PR branch databases (ADR-0013) or PITR within two quarters**
> — in which case wire Neon branching end-to-end (4C) and revisit this ADR. Absent that
> commitment, the ~10 s wake delta does not buy back Neon's ops mass.

---

## Consequences

**If ratified (CNPG default):**
- 4C hardens CNPG: configure the operator-native `ScheduledBackup` + a rehearsed
  restore drill (the backup story Neon still lacks); pair a `Pooler`/PgBouncer for the
  connection-cap story (knext's own recipe); keep the Neon manifests as an escalation lane.
- The knext ↔ KS-PG contract simplifies to the consumer's *own* default engine.
- We give up Neon's size-independent fast wake (accept ~14.5 s cold) and its unused
  branching/PITR/read-replica capabilities. If a wake SLO later bites, the gateway lets us
  swap back per the conditional above.

**In-process CNPG hibernate driver (decision INPUT only — do NOT implement here).**
Exec-mode parity is currently *honest but shell-dependent*: `bakeoff/gateway-exec.Dockerfile`
re-bases the byte-identical `/gateway` onto Alpine purely to supply `sh`+`kubectl`, which
`execDriver` shells out to (`GW_WAKE_CMD='kubectl annotate … cnpg.io/hibernation=off'`).
A native driver removes the shell and restores **distroless parity** with the Neon path. It
would mirror the existing `kubeDriver`/`k8sScaler` split (`gateway/internal/wake/{wake.go,k8s.go}`):
a new `cnpgDriver` implementing the 5-method `wake.Driver` interface (~30 lines, like
`kubeDriver`), backed by a `Hibernator` that lazily builds a client-go **dynamic** client
(mirroring `k8sScaler`'s `sync.Once` init, ~25 lines) and issues a single
`MergePatchType` patch of `metadata.annotations["cnpg.io/hibernation"]` on the
`postgresql.cnpg.io/v1, Resource=clusters` GVR (~5 lines of patch logic), plus a `"cnpg"`
case in `MakeDriverWithScaler` reading `GW_CNPG_NAMESPACE`/`GW_CNPG_CLUSTER` (~15 lines).
**Estimate: ~75–100 lines of production Go + table tests** (fake Hibernator, exactly as
`wake_test.go` fakes the `Scaler`). No new RBAC beyond the existing `patch clusters` Role.
This is small, TDD-shaped, and is a 4C task if CNPG is ratified.

---

## Kill criteria (measurable pivot triggers — adopted from the iteration-1 architect review)

Track these; any one firing re-opens this ADR.

1. **Ops toil > ~1 eng-day/month** operating the chosen foundation ⇒ escalate to managed
   (managed Neon / Aurora Serverless). For Neon specifically: **one** version-compat/upgrade
   incident unresolvable without Rust/Neon-internals expertise we do not staff ⇒ pivot off
   self-hosting immediately.
2. **Wake p99 regression:** if the chosen foundation's cold p99 regresses >30% beyond this
   ADR's baseline (CNPG 14.9 s / Neon 5.1 s) in the CI bake-off gate ⇒ investigate before
   any release.
3. **Version-treadmill cost (Neon path):** the compute↔storage `8464`/`8464` pair must
   become a manifest/CI validation (fail on tag divergence). If it is ever trusted to human
   discipline in production ⇒ that is a release blocker.
4. **knext posture change:** if knext commits to per-PR branch databases (ADR-0013) or PITR
   within two quarters ⇒ the Neon differentiator becomes real; re-evaluate toward Neon +
   wired branching. If knext stays engine-agnostic/CNPG-default ⇒ CNPG stands.
5. **Branching unused (Neon path):** if Neon is chosen but no justifying capability
   (branching / PITR-to-LSN / shared-pageserver read replicas) is wired and demonstrated
   on-cluster within one quarter ⇒ the reuse thesis is falsified; pivot to CNPG.
6. **Reliability floor (foundation-independent):** if a single-pageserver read outage
   reaches users before a secondary pageserver is deployed (Neon path) ⇒ "reliable-enough"
   is falsified; treat as a release blocker. CNPG's single-PVC survival is the simpler
   baseline this floor is measured against.

---

## Method note (how the numbers were made honest)

`bakeoff/_run-battery.sh` fixes the two cold-forcing bugs the scaffold flagged
(`SUMMARY-initial.md`):
1. **Neon `readyReplicas` quirk (k8s 1.34 omits it at zero):** cold is confirmed only when
   `spec.replicas==0` **AND** zero compute pods remain — **counting Terminating pods**
   (a draining compute still holds the wake timeline). Cold is forced deterministically by
   scaling the Deployment to 0, then asserting the above before each timed sample.
2. **Quiesce interference:** nothing else touched `scale-zero-pg` during Neon sampling; each
   cold sample re-asserts compute is genuinely at 0 (skips + logs if not).
The failure-drill recovery time was likewise made honest: a naive probe reported ~200 ms
because the `-rw` service briefly still routed to the dying old process; the drill now
requires a **new pod (uid changed), Running, and serving rows** before declaring recovery
(→ ~16 s, consistent with cold wake + reschedule). Quiescent state (compute=0, CNPG
hibernated, PVCs bound) restored after the run.
