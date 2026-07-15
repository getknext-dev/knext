# Iteration-1 — Independent Architect Re-Review (STRATEGY lens)

*Reviewer: independent principal architect. I did not build this. Judgment formed
from primary sources only (README, CLAUDE.md, TASKS.md, the architecture doc, ADR-0001,
knext-research, user docs, `gateway/` Go, `deploy/`, `bakeoff/` + its results, git log,
and the live `scale-zero-pg` + `bakeoff-cnpg` namespaces). I did not read `docs/reviews/`
or `docs/plan-phase3.md`.*

---

## Executive verdict

The engineering is disciplined and the crown jewel — a small, mode-agnostic Go wake-gateway
that fronts **both** foundations from a byte-identical binary — is genuinely good and is the
real, portable asset here. But the foundation itself (self-hosted disaggregated Neon storage)
was, by the team's own admission in `bakeoff/README.md`, "decided by inheritance," and it sits
in direct tension with the north-star ("easy to host, easy to maintain"): you are operating a
6-workload Rust storage cluster with a pinned compute/storage version-pair, while **none** of the
capabilities that justify that complexity (branching, PITR, cheap read replicas) are actually
wired. The `bakeoff/` experiment is the single best thing in the repo — it converts an inherited
decision into a measured one — and it must be finished and promoted to a decision gate before more
hardening is spent on Neon.

- **Architecture fitness: 6/10** — Excellent gateway + honest TDD, but the foundation buys the
  Ferrari engine and drives it to the grocery store: full ops cost of Neon, none of its
  differentiating value in use, for a single consumer whose own default is CNPG.
- **Evolution readiness: 7/10** — Strong seams (mode-agnostic gateway, `template` mode, ADR
  discipline, and crucially the bake-off harness as a decision instrument); loses points because
  the foundation is still undecided-but-inherited and no written, measurable kill criteria exist.

---

## Reuse-vs-build audit

**What is reused (Neon storage plane) — the thesis is right in principle, thin in practice.**
The stated bet ("reuse WAL durability, replication, branching, PITR; build only the axle") is the
correct instinct. The build side is admirably small: the whole gateway is ~2.3k lines incl. tests,
mode-agnostic, and TDD'd (57P03 absorb, sleep TOCTOU heal, peer-aware idle, maxconns, races). That
is a well-shaped deep module.

**But the reuse is paying for capability it does not consume.** This is the core strategic finding.
Neon's disaggregated storage exists to deliver: O(1) copy-on-write **branching**, **PITR to any
LSN**, **size-independent cold start**, and **shared-pageserver read replicas**. In the shipped
system:
- Branching: not exposed. PITR: not exposed. Read replicas: not deployed (1 pageserver, live).
- Only **size-independent fast wake** is actually used — and the bake-off measures it at ~2.4–5s
  vs CNPG's ~13.3s. Real, but it is *one* of four justifications, and it is a latency delta, not a
  capability CNPG lacks.

So the honest ledger: you reuse Neon's **operational cost** (safekeeper×3 + pageserver + broker +
MinIO + storage-init + compute ConfigMaps + a `neon:8464`/`compute-node-v17:8464` version-pair with
"no cross-version guarantee" and unsafe storage rollback) while reusing very little of Neon's
**value**. The reuse thesis is currently *asserted*, not *realized*.

**The gateway is the durable asset; the foundation is a swappable decision.** The bake-off proves
the same binary wakes Neon (kubectl/scale) and CNPG (exec/annotate). That is the most important
architectural fact in the repo: **the product is a foundation-agnostic wake proxy; the storage
substrate is a late-bindable choice.** Lean into this — it de-risks everything downstream.

---

## Decisions that will age badly (ranked, with evidence)

1. **Self-hosted Neon as the foundation, adopted by inheritance.** Evidence: `bakeoff/README.md`
   states the storage plane was "decided by inheritance from the original architecture doc … adopted
   without a measured comparison." knext's *own* docs (`docs/knext-research.md §4`) call "Neon
   self-hosting … unsupported for production," and knext's default zone DB is **CNPG**
   (`scs-zones.md`). You are proposing to replace your only consumer's own default with a heavier
   stack, justified so far only by an ~8–10s wake delta. This will age badly unless (a) the bake-off
   confirms the delta at scale, and (b) a Neon-only capability gets used.

2. **Single pageserver is a whole-data-plane SPOF, under-weighted against the safekeeper-quorum
   story.** Evidence: `operations.md` — "Pageserver loss (single, MVP): serving stops." The 3-SK
   write quorum is real and drilled, but *all reads* flow through one pageserver; the reliability
   narrative leads with the quorum and buries the actual weakest link. "Reliable-enough" is not yet
   true for reads.

3. **Credential model via compute-spec re-apply.** Evidence: `operations.md` + README — `compute_ctl`
   re-applies `roles[].encrypted_password` on every boot, `ALTER USER` does not stick, and rotation
   means hand-editing an md5 hash into a ConfigMap and restarting. This collides with the knext
   `DATABASE_URL`-Secret contract and with any real secret manager the moment there is more than one
   DB. It is a usability/security wart that compounds with scale.

4. **TLS deferred; `sslmode=disable` on the wire.** Evidence: `connecting.md`. Acceptable for a local
   MVP; a growing liability for a DB fronting multiple app zones. Retrofitting TLS + auth through a
   byte-pipe gateway is harder later than designing the seam now.

5. **`template`/multi-DB (SCS) is the named seam but unbuilt, and its cost model differs by
   foundation.** Evidence: `wake.go` `templateDriver` exists; TASKS "un-park SCS." Per-app Neon
   tenants *share* the storage plane (cheap to fan out); per-app CNPG clusters do **not** (PVC +
   pod each). The foundation choice therefore silently determines the multi-tenant economics — and
   it is still open. Deciding SCS shape before the foundation is settled would be building on sand.

---

## Contracts that should be made explicit

- **knext ↔ KS-PG interface.** Today it is prose ("apply a Secret"). Make explicit and versioned:
  (a) the DSN shape + `sslmode`; (b) the **pool-idle-timeout < `GW_IDLE_MS`** invariant — this is a
  *correctness* condition for scale-to-zero (a leaking pool defeats the entire product) yet it lives
  only in a docs bullet, enforced nowhere; (c) the credential re-apply behavior that will surprise
  knext operators; (d) the mapping of knext's "one data store per zone" (`scs-zones.md`) onto
  "one Neon tenant/timeline per app." Align the two rule systems in one place.

- **Compute↔storage version-pair (8464+8464).** Documented in `operations.md` but enforced nowhere.
  Make it a manifest/CI validation (fail if tags diverge) — an internal wire protocol with "no
  cross-version guarantee" must not be trusted to human discipline.

- **Wake-latency SLO.** CLAUDE.md says "sub-second(ish)"; measured is ~2.4s (README) / up to ~5s
  cold (bake-off). State the real SLO (~2.5s cold, <X ms warm) and make the bake-off harness its
  CI gate. Stop shipping the aspiration as if it were the number.

- **"Foundation-agnostic gateway" is currently an implicit hedge — promote it to a stated product
  contract.** Both drivers (kubectl for Neon, exec for CNPG) first-class, both in CI. This is the
  strategic insurance policy; write it down so it is not quietly lost.

---

## Recommended sequencing (my order — differs from a "harden Neon next" reading)

1. **Finish the bake-off to a verdict.** 20+ samples × all three dimensions (cold / warm /
   reconnect-after-drain), ops-mass priced, on a quiesced namespace (fix the `readyReplicas`
   cold-forcing bug the SUMMARY already flags). This is the highest-leverage work in the repo: it
   turns the foundation from inherited to decided. Everything else waits on it.
2. **Officially declare the gateway foundation-agnostic** and keep both drivers first-class. Cheap,
   already true, de-risks the rest.
3. **Decide the foundation against written kill criteria (below).** The burden of proof is on Neon
   because it costs more and the consumer's default is CNPG. Decision hinges on one question:
   **does knext commit to per-PR preview databases?** knext ADR-0013 (per-PR preview + data
   isolation, per `knext-research.md`) is a *decisive* argument for Neon — O(1) branching maps
   exactly onto that feature and CNPG cannot do it cheaply. If yes → commit to Neon **and wire
   branching**. If no → the ops mass is unjustified; pivot to CNPG-hibernation and keep Neon as the
   "large/hot tenant" escalation path only.
4. **Harden only the chosen foundation:** if Neon — secondary pageserver (kill the read SPOF),
   failure-domain spreading, version-pair CI gate; then TLS + real secret management (both
   foundations).
5. **Then un-park `template`/SCS** with a provisioning API — only after the foundation fixes the
   multi-tenant cost model.
6. **Load/density/idle-audit last** (concurrent cold-start p99, tenant density).

---

## Kill criteria (measurable — pivot triggers)

- **Pivot to CNPG-hibernation if:** the finished bake-off shows Neon cold-wake p95 within ~3× of
  CNPG's, **AND** knext does not commit to branching/PITR within two quarters. (Unused
  differentiating capability ⇒ the ops mass is not worth ~8s of wake.)
- **Keep Neon only if:** within one quarter at least one justifying capability — per-PR branch DBs
  for knext previews (ADR-0013), PITR-to-LSN, or shared-pageserver read replicas — is wired and
  demonstrated on-cluster. Otherwise the reuse thesis is false: you are reusing Neon's cost, not its
  value, and should stop.
- **Pivot to managed Neon / Aurora serverless if:** operating the storage plane exceeds ~a few
  hours/week of toil, **or** you hit one version-compat/upgrade incident that cannot be resolved
  without Neon/Rust-internals expertise you do not staff (today: zero Rust storage on-call).
- **Pivot away from self-hosting entirely if:** the knext footprint stays below ~a few dozen
  databases — the fixed cost of a disaggregated storage plane only amortizes across many tenants;
  under that, a single always-on CNPG (or managed Neon) is cheaper on every axis.
- **Reliability floor (independent of foundation):** if a single-pageserver read outage reaches
  users before a secondary is deployed, "reliable-enough" is falsified — treat secondary-pageserver
  (or CNPG's simpler single-PVC survival) as a release-blocker, not a phase-3 nice-to-have.
