# ADR 0012 — Fail toward the reversible outcome

Status: Accepted
Date: 2026-09-20

> Numbered to continue the `docs/adr/000N` sub-series (0001–0003, then 0010, 0011). The
> root `docs/adr-000N-*.md` files are a SEPARATE, older series; "ADR-0004" elsewhere in
> the repo means the root provisioning ADR, not this one.
>
> This ADR records a cross-cutting **principle**, not a new mechanism. It names the
> invariant that ADR-0010 and ADR-0011 each apply in one direction, so the two are not
> read as contradictory and "harmonised" the wrong way. It ships no code of its own; the
> code lives in those two ADRs and in `deploy/_validate.sh` (the C3 placement contract).

## Context

The failover-chain hardening sprint produced two ADRs whose **defaults point in opposite
directions**, and neither states the reason they agree:

- **ADR-0010 fails CLOSED.** When it cannot establish that a promotion is safe — base
  tenant not held on the standby, an uncorroborated non-base tenant absence, an
  unreadable/unrecoverable generation ledger — `pswatcher` **refuses to promote** and
  leaves reads down. It prefers a continued read outage over a wrong promotion.
- **ADR-0011 fails SAFE (open).** When it cannot read the maintenance-freeze ConfigMap, or
  the freeze's `until` is malformed, it treats the freeze as **absent** — HA stays ON — and
  counts the read error, rather than aborting the tick. It prefers keeping automatic
  failover armed over silently disabling it.

Read side by side these look inconsistent: one refuses to act on uncertainty, the other
acts anyway on uncertainty. A future reader will see the adjacent ADRs as contradictory and
"fix" one to match the other — in the wrong direction, reopening exactly the failure class
the sprint closed. The reconciling invariant currently exists only implicitly, spread
across two documents. This ADR makes it explicit.

## Decision — the principle

**When forced to act under uncertainty, fail toward the REVERSIBLE outcome.**

Rank the candidate outcomes by reversibility and choose the one you can still undo:

| Outcome | Reversible? | Blast radius | Bounded? |
|---|---|---|---|
| Promote the standby (ADR-0010) | **No** — one-way, fences the old primary at `gen+1`, consumes the single warm standby | Whole storage plane | — |
| Suppress HA via a freeze (ADR-0011) | Yes, but **silently** — nothing forces it to end if the read fails | Whole storage plane, indefinitely | No (until TTL) |
| Continue a read outage (ADR-0010 fail-closed) | **Yes** — the plane is untouched; a human or a later tick can still promote | Reads only | Yes (self-resolves on recovery or on a confirmed death) |
| Keep HA armed on an unreadable freeze (ADR-0011 fail-safe) | **Yes** — a genuinely-needed freeze can be re-set; a spurious promotion is still gated by ADR-0010's own closed checks | Reads only | Yes |

Both ADRs fall out of this single rule:

- **ADR-0010 refuses to promote** because promotion is *irreversible and standby-consuming*
  — the one action on this plane you cannot take back — while a read outage is reversible.
  So under uncertainty it chooses the reversible read outage.
- **ADR-0011 keeps HA on** because *suppressing HA is silent and unbounded* — a freeze that
  can never be confirmed to end is the worse, less-reversible state — while a spurious
  promotion is still gated by ADR-0010's own closed checks. So under uncertainty it chooses
  the reversible armed state, and bounds even a *successfully-read* freeze with a hard TTL
  (`PSW_MAX_FREEZE_MS`).

There is no contradiction: each ADR is choosing the reversible branch of its own decision.
"Fail closed" and "fail safe" are the same rule applied to decisions whose irreversible
branches sit on opposite sides.

## Consequences

**Positive.**
- The two ADRs' opposite defaults are legible as one principle; a future reader amends them
  in the correct direction (preserve reversibility) rather than forcing them to match.
- New decisions on this plane have a tiebreaker: when a check is inconclusive, pick the
  branch you can still undo, and make the irreversible branch require positive evidence.

**Negative / residual (stated honestly).**
- "Reversible" is a judgement, not a measurement. A branch can be reversible in principle but
  expensive in practice (a long read outage is reversible yet still an incident). The
  principle ranks *irreversibility*, not *cost* — it does not license an unbounded outage.
  ADR-0010's abort conditions are each loud (log + counter + alert) precisely because the
  reversible branch it chooses is still a live outage someone must resolve.
- Choosing the reversible branch concentrates pressure on **detection**: the plane sits in
  the safe-but-degraded state until something confirms it is safe to take the irreversible
  action. That makes the "is automatic failover armed right now?" question load-bearing — see
  the composite-signal follow-up below.

## Two contracts this principle surfaces

**(1) The drill-needs-recovery contract (test-harness, not just MTTR).** A destructive
failover drill is **only repeatable on a plane with convergent recovery.** The drill
hard-fails setup if the plane is already failed over, and restoring redundancy needs a
re-seeded warm Secondary — so "run the drill later" is not a free re-run. Recovery
(`rollout restart deploy/pswatcher` + standby re-warm; the T6 convergent-recovery work) is
therefore part of the drill's **harness contract**, not merely an availability feature: T5's
destructive discrimination verification *depends on* T6's convergent recovery to return the
plane to a testable state. This is a **verification edge** the code-only task graph did not
carry, and the next task-graph template should model every task with two edges — a code edge
and a verification edge (what cluster state its proof requires, and which task produces it).

**(2) Legibility before an incident.** Because this principle deliberately gives `pswatcher`
"more reasons to refuse than to act" (ADR-0010) and one reason to suppress (ADR-0011), the
plane's *armed-ness* must be observable **before** an incident, not reconstructed during one.
Each abort/suppress precondition is individually observable today, but there is no composite
signal answering "is automatic failover armed right now?". → **Follow-up:** a
`pswatcher_failover_armed` gauge (or a composing alert) that goes **0** whenever ANY
abort/suppress precondition holds — base tenant not held on the standby, an uncorroborated
non-base absence, an unrecoverable ledger, or an active freeze — and 1 otherwise. This makes
the aggregate posture legible on a dashboard rather than latent across four counters.

## Options considered

- **Fold the principle into ADR-0010 §Decision (one paragraph).** Cheapest, but it hides a
  cross-cutting invariant inside the fail-*closed* ADR, where a reader of ADR-0011 (the
  fail-*safe* one) would never find it — the exact "read as contradictory" failure mode.
- **A short cross-cutting ADR-0012 (chosen).** Costs one file, but gives the invariant a home
  both ADRs cross-reference, and a place to record the two contracts above and the composite
  signal follow-up without overloading either mechanism's ADR. Recommended.
- **Leave it implicit.** Rejected: the sprint-close review found this was the single most
  valuable artifact the sprint produced and it existed only implicitly — that is how it gets
  "harmonised" away.

## Action items

- [x] Record the reversible-outcome invariant and cross-reference ADR-0010 / ADR-0011 (this
      ADR); ADR-0010's Consequences now points here for the placement + tradeoff framing.
- [x] Failure-domain placement (ADR-0010's precondition, sprint-close C3): HARD anti-affinity
      on the standby (57) only, SOFT on the primary (53) and pswatcher (58), with the repelled
      label VALUE — not just the term's shape — scanned by `deploy/_validate.sh`.
      The asymmetry is itself an instance of this ADR's invariant: hard terms on BOTH sides of
      the pair is the IRREVERSIBLE arrangement — on a single-node cluster whichever pod binds
      first wins the only node, and `IgnoredDuringExecution` can then strand the PRIMARY Pending
      forever after any reschedule, taking the data plane down to protect a standby that has
      nothing to fail over to. One hard side gives the identical separation guarantee (the
      standby can never be placed on the primary's node) while keeping the primary always
      schedulable, so the failure mode is a Pending standby — visible, and reversible by adding
      a node. Documented for users in `README.md`'s quickstart.
- [ ] Follow-up: `pswatcher_failover_armed` composite gauge/alert (0 whenever any
      abort/suppress precondition holds), so the armed posture is legible before an incident.
- [ ] Adopt the two-edge (code + verification) task-graph format so the drill-needs-recovery
      coupling is visible at planning time, not discovered mid-sprint.

## Cross-references

- **ADR-0010** — fail-closed promotion (refuse rather than risk split-brain); the
  compute-bounce authority note and the failure-domain placement precondition.
- **ADR-0011** — fail-safe freeze read (an unreadable/malformed freeze keeps HA on),
  TTL-bounded so even a successful freeze cannot silently disable HA.
