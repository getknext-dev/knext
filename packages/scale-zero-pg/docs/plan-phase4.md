# Iteration-2 plan — from the round-2 (blind) re-reviews

> Inputs: `reviews/iteration-1/{system-design,devops,architect}-review.md`.
> Scores moved +1..+2 on five of six axes (architect fitness flat at 6 by design:
> the foundation question is still open). Status: PROPOSED → executing.

## Convergent round-2 findings (the new backbone)

1. **Connection-cap incoherence** *(devops + sysdesign, independently)*: gateway
   admits 500 (`GW_MAX_CONNS`) into a Postgres that refuses at 100
   (`max_connections`), no pooler. The cap must be coherent end-to-end.
2. **Alerts route nowhere** *(devops CRITICAL)*: Prometheus evaluates 3 rules,
   no Alertmanager/receiver; metrics on emptyDir (~6h). Observability gap moved,
   not closed.
3. **The product promise is parked** *(sysdesign headline + architect's "Ferrari
   engine")*: one tenant wired; `template` multi-tenancy untested; and none of
   Neon's differentiators (branching/PITR/replicas) are in use — we pay full ops
   cost for capabilities nobody exercises.
4. **Foundation still inherited, not decided** *(architect, again)*: finish the
   bake-off and make it a **gate** on further Neon-specific hardening.
5. Carried from round 1, still open: backup/restore drill, single
   pageserver/MinIO, TLS front door, single-node topology.

## Sequence (architect's gate logic adopted)

**4A — coherence quick wins (hours, foundation-agnostic)**
1. Align the caps: `GW_MAX_CONNS=90` (< backend 100, headroom for probes),
   cross-referenced comments both sides + docs. Pooler decision deferred to 4C
   (it depends on the foundation: Neon ships one; CNPG pairs with PgBouncer).
2. Alertmanager (minimal, same style as 60-prometheus) + `alerting:` block +
   webhook receiver placeholder; Prometheus data on a small PVC with 15d
   retention. Alert-fire drill: force a wake failure, see it reach the receiver.

**4B — the decision gate (the centerpiece; blocks 4C)**
3. Full bake-off run: 20+ samples × {cold, warm, reconnect-after-drain} × both
   foundations; fixed Neon cold-forcing (readyReplicas quirk); CNPG pod-kill
   drill; ops-mass table. In-process hibernate driver for the gateway (no shell,
   distroless-compatible) so exec-mode parity is honest.
4. **ADR-0002: the database foundation** — decision + adopted kill criteria.
   No further Neon-only hardening lands until this merges.

**4C — harden the winner + unlock the promise**
5. Backup + rehearsed restore drill for the winner's history store.
6. If Neon wins: wire ONE differentiator end-to-end (per-PR branch database via
   timeline branching) — it's both product value and the standing test of the
   "branching unused" kill criterion. If CNPG wins: migration plan for the plane.
7. Multi-tenancy: `template` mode end-to-end (or an explicit ADR declaring
   single-DB-per-cluster topology). The sysdesign headline either ships or is
   descoped honestly.
8. TLS in front of the gateway; second pageserver (Neon path only).

## Loop mechanics

Implement → full battery on the local cluster → round-3 blind re-review trio →
plan iteration 3. Same blinding rules; reviews land in
`docs/reviews/iteration-2/`.
