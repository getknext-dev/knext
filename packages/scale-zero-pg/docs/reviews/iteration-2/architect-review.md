# Iteration-2 — Independent Architect Review (Strategy lens)

*Round 3 of the standing review loop. Independent principal architect; I did not
build this. Blinded to `docs/reviews/**` and `docs/plan-*.md`. Primary sources:
README / CLAUDE / TASKS, the architecture doc, ADR-0001, ADR-0002, knext-research +
user docs, `gateway/`, `deploy/`, `bakeoff/` (TUNING.md + result CSVs),
`warmstandby/`, git log, and the live cluster (`scale-zero-pg`, `bakeoff-cnpg`;
context `orbstack`).*

---

## Scorecard (1–10, with one-line justification)

| Metric | Score | Justification |
|---|---:|---|
| **Maturity** | **5** | Evidence discipline is genuinely strong (measured bake-off, honest breakdowns, kill criteria, drills) — but the marquee decision was ratified on an **unbuilt warm tier** and the ADR of record **contradicts itself** (header = Neon; Decision body = CNPG). A prototype is being counted as a "tier." |
| **Ease of maintenance** | **4** | The owner ratified the **heavier** substrate: 6 data-path workloads + a pinned compute↔storage version-pair + 6 PVCs + Rust-storage on-call nobody staffs — and the two-tier choice now *adds* a warm-pool controller + single-writer gate to build. The foundation-agnostic Go gateway is a real asset that keeps this reversible; that is the only thing holding the score off 3. |
| **Production reliability** | **4** | Solid drills (2/3 SK quorum, HA gateway, compute-kill survival). But on the *chosen* path: **no backup/restore built**, single-pageserver read SPOF unmitigated (a self-declared release blocker), version-pair on human discipline, and the warm tier introduces a **new two-writer-corruption failure mode** guarded only by a shell harness. |

*Prior architect axes (iteration-1): evolution 7, fitness 6, maturity not scored.
Ease/reliability drop here because ratification moved to the higher-ops, lower-restore
foundation while the reliability debt (backups, SPOF, version gate) is still open —
and a corruption risk was newly introduced.*

---

## Top strategic findings

### 1. The ratified decision runs *ahead of its own stated evidence gates* — and the ADR now contradicts itself.
The ratification commit (`a05d4f2`) rewrote **only the header** to "ACCEPTED — Neon,
two-tier." The **Decision** section (ADR-0002 lines 127–150) and the boxed conditional
still read verbatim: *"Adopt CloudNativePG-hibernation as the default database
foundation… (Proposed)"* and *"**CNPG by default. Choose Neon iff** a hard product SLO
requires sub-~5 s cold wake **AND** knext commits to per-PR branch databases (ADR-0013)
or PITR within two quarters."* **Neither condition is met today** (evidence §4: knext is
engine-agnostic, CNPG-default, and has explicitly declined to commit to branching/PITR;
no consumer has stated a sub-5 s — let alone sub-second — SLO). So the document of record
now argues CNPG in its body and Neon in its header. This is not a cosmetic nit: an ADR is
a contract, and this one no longer says one thing. **The decision was made on a
*capability* argument ("sub-second is structural to Neon") rather than a *demand*
argument ("a consumer requires sub-second") — the capability is real and well-measured
(413 ms, size-independent attach; genuinely unmatchable by CNPG pod-recreate), but it is
being bought before anyone has asked to spend on it.** *Action: reconcile the ADR body to
the ratified header (or reopen). If Neon two-tier stands, the Decision/Consequences/
conditional must be rewritten to say so, and the "reuse thesis is currently false"
paragraph must be answered, not left standing under a Neon verdict.*

### 2. The "warm tier" is a single-tenant prototype with a harness-only single-writer gate — it is not yet a product tier.
`warmstandby/README.md` is admirably honest: design A is a **gated-pod, single-tenant**
pod pre-bound to one timeline via env, woken by `kubectl exec touch`, and the
single-writer invariant is enforced by `assert_single_writer` **in the measurement
harness**, not in the gateway or any controller. The README states the risk plainly: *"A
bug that releases the gate while `compute` is up = two writers on one timeline =
corruption."* Ratifying a *tier* on this prototype commits the platform to build, before
it is a product: **design B** (spec-less `compute_ctl` + attach-on-wake via the `:3080`
HTTP API) to make the pool multi-tenant and drop the exec trigger; the single-writer gate
moved **into the gateway/control-plane** as an enforced, tested invariant; and warm-pool
lifecycle ownership (who arms, drains, caps, evicts). As shipped, "warm tier" = **one
parked pod (256 Mi + 250 m reserved 24/7) per database**, which also **breaks the
platform's headline promise** ("idle DB consumes zero compute"). Until design B + an
in-band single-writer gate exist, the warm tier should be labelled an experiment, not an
offered tier.

### 3. Ratifying the heavier foundation *raised* the reliability bill it must now pay first — and that bill is still unpaid.
The bake-off's own ops-mass table (§3) shows CNPG shipped the exact reliability
primitives Neon lacks: operator-native `ScheduledBackup`/`Backup` CRDs (installed,
unconfigured) and a single-PVC survival story with **no hidden read SPOF**. Neon's chosen
path still has **no backup/restore built**, a **single pageserver = whole-data-plane read
SPOF** (`operations.md`, unmitigated), and a **compute↔storage version-pair trusted to
human discipline**. By the platform's *own* kill criteria (#3, #6) two of these are
release blockers. The strategic consequence: the two-tier decision earns an ops bill, and
what earns that bill back is **not more wake-speed work** (already sub-second in
prototype) — it is the durability/SPOF/restore story a "production-reliable" database is
*required* to have and this one does not.

---

## Reuse-vs-build audit (update)

| Verdict | Item | Note |
|---|---|---|
| ✅ Reuse (sound) | Neon storage stack (WAL durability, attach, lazy page-fetch), CNPG operator (bake-off), TimescaleDB Apache-2, `pg_partman`, KEDA (opt), Prometheus/Alertmanager | All off-the-shelf; correctly not rebuilt. |
| ✅ Build (justified, crown jewel) | The foundation-agnostic Go gateway | Proven to front either substrate byte-identically. This is what makes the whole decision late-bindable/reversible — the single best asset in the repo. |
| ⚠️ Build (newly *demanded* by ratification, not yet priced) | Warm-pool controller (design B), in-band single-writer gate, tier-selection plumbing | The two-tier verdict converts "reuse Neon's value" into "**build** a warm-pool + corruption gate." The ADR body's own line — *"we reuse Neon's cost, not its value"* — is now **more** true, not less: still no branching/PITR, and now net-new build on top. |
| ⚠️ Reuse-of-cost only | Neon branching / PITR / read-replicas | Unused, uncommitted by the consumer. The justification for a disaggregated plane (multi-tenant fan-out) is **neutralized by knext's per-zone data-sovereignty** (no shared DB). We are paying for a shape the only consumer's model doesn't use. |

---

## Decisions that will age badly (ranked, with evidence)

1. **Ratifying Neon two-tier while both stated conditions are unmet** (ADR §4 + conditional lines 145–149; ADR body still concludes CNPG). *Evidence: the document contradicts itself; kill criterion #5 — "Neon chosen but branching unused within one quarter ⇒ pivot to CNPG" — is armed and pointing at the ratified decision on day one.* **Highest risk.**
2. **Warm "tier" on design A** (single-tenant, `kubectl exec` trigger, harness-only single-writer gate). *Evidence: `warmstandby/README.md` trade-off table — "elevated" single-writer risk, "design A is single-tenant… a true pool needs design B."*
3. **No backup/restore on the chosen foundation** while the passed-over foundation had it for free. *Evidence: bake-off §3 "Backup story: not yet built" (Neon) vs "operator-native `ScheduledBackup`… installed" (CNPG); kill criterion #1/#6.*
4. **Single pageserver read SPOF unmitigated.** *Evidence: `operations.md` durability model; ADR §2 caveat; kill criterion #6 makes a user-facing pageserver outage a release blocker.*
5. **Version-pair (8464/8464) on human discipline.** *Evidence: `operations.md` Upgrades; kill criterion #3 says trusting it to humans in prod is itself a release blocker — no CI/manifest gate exists yet.*
6. **Load-bearing but unbuilt seams** — TimescaleDB TSL "escalation path" (ADR-0001, won't fire on scale-to-zero anyway) and SCS `template`-mode sharding (the write-scale story). *Evidence: ADR-0001 §Q2 consequences "not yet built (parked)."* Lower risk, but the growth narrative leans on them.

---

## Contracts to make explicit next

1. **Tier selection, per app.** Cold (default) vs warm (opt-in) must be an explicit,
   discoverable field the consumer sets and the gateway honors — likely on the
   `DATABASE_URL` Secret or a companion CR field. Today it is a separate deployment and a
   manual harness. Undefined selection = no product.
2. **Single-writer gate as a first-class, in-band invariant.** Move
   `assert_single_writer` out of the shell harness into the gateway/control-plane, with
   tests. This is non-negotiable before *any* warm pod runs in the same namespace as
   `compute`. Add: a fencing/observability check that alarms on dual-attach.
3. **Warm-pool ownership & lifecycle.** Who arms/drains/caps/evicts parked pods; what the
   per-app RAM reservation ceiling is; how the "idle DB = 0 compute" promise is restated
   for warm-tier apps.
4. **Backup/restore contract on the ratified path.** A written RPO/RTO + a *rehearsed*
   restore drill. Neon PITR is unexposed today; this is the single largest reliability
   gap and the ops bill the platform just committed to.
5. **Version-pair validation as a CI gate** (fail on compute/storage tag divergence) —
   directly discharges kill criterion #3.

---

## Recommended sequencing (next phase)

> **Pay the reliability debt the ratified foundation owes *before* productizing the warm
> tier — because wake speed is already solved in prototype and durability is not.**

1. **Backups + rehearsed restore drill on Neon** (discharge kill #1/#6 debt; the biggest
   gap). ▸ 2. **Secondary pageserver + failure-domain spread** (kill #6 release blocker).
   ▸ 3. **Version-pair CI gate** (kill #3). ▸ 4. **Reconcile ADR-0002 body to its header**
   (or reopen) — a self-contradicting decision of record blocks clean downstream planning.
   ▸ 5. **Warm tier → product only on demand:** build design B + in-band single-writer
   gate **iff** a consumer commits to a sub-second/sub-5 s SLO; otherwise keep it a
   documented experiment. ▸ 6. SCS `template` multi-tenancy stays parked — it is the *same
   seam* as warm-pool design B; do them together, not before there is demand.

One-line: **harden Neon's durability (backups → SPOF → version gate) before selling the
warm tier; fix the contradicting ADR; build the warm pool only when a consumer asks.**

---

## Kill-criteria check (are these still the right tripwires post-ratification?)

Mostly yes, but ratification created two that now need explicit reconciliation:

- **#5 fires on day one.** "Neon chosen but no branching/PITR/read-replica wired within
  one quarter ⇒ pivot to CNPG." Neon was just chosen; branching is unused *and*
  uncommitted. Either ratification implicitly retired #5, or the platform is in violation
  of its own tripwire immediately. **Reconcile: state whether the warm-tier latency
  capability now substitutes for branching as the Neon-justifying differentiator** — if
  so, #5 must be rewritten to track *warm-tier adoption*, not branching.
- **#4 (the *pro*-Neon trigger) also hasn't fired** — knext has not committed to
  ADR-0013/PITR. The decision preceded its own positive trigger. Worth an explicit
  sentence: "ratified on capability, ahead of #4."
- **Missing tripwire — warm-tier corruption.** Add: *any observed dual-attach / timeline
  divergence in the warm tier ⇒ warm tier pulled immediately.* The new failure mode has
  no kill criterion.
- **#1/#2/#3/#6 remain the right tripwires** and are well-formed; #3 and #6 should be
  promoted from "track" to "must-clear-before-next-release" given they are now on the
  chosen path.

---

*Hygiene note observed live: `deploy/compute` was at **1 replica** during this review —
the scale-to-zero default of record was not at rest. Likely a recent verify run inside
the idle window, but the resting invariant (`compute == 0` when idle) is the product's
headline claim and is worth a periodic assertion in CI/monitoring.*
