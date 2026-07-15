# Iteration-3 plan — from the iteration-2 blind reviews + ADR-0002 ratification

> Inputs: `reviews/iteration-2/*` (scores: maturity 4.7, ease 4.3, reliability 3.7 —
> re-based to the ratified Neon-two-tier path's production bar). Status: PROPOSED → executing.

## Convergent findings (3/3 or 2/3 reviewers, independently)

1. **No backups anywhere** — MinIO + pageserver are single un-backed-up local PVCs;
   with the pageserver read SPOF this is "the project-ending incident." *(3/3, every round)*
2. **The warm tier is a prototype being counted as a tier** — its single-writer
   invariant lives in an unversioned shell script = new corruption class if
   productized as-is. *(3/3)*
3. **Alerting is unsound in both directions** *(devops, hands-on)*: the drill hung
   for a second operator (nc sink discards payloads → content unverifiable), AND
   `ComputePhantomKeepalive` false-fires (cumulative wakes−sleeps drift, value 41
   at replicas 0). Silence-risk + cry-wolf simultaneously.
4. **Version-pair on human discipline** — no CI gate enforcing compute↔storage 8464/8464. *(2/3)*
5. **Wire security absent live** — plaintext Postgres on an LB; netpol inert on the
   OrbStack CNI. *(2/3, carried)*
6. **"50 apps" doesn't fit the single-DB shape** — 300 pooled conns vs 100; the
   capacity story needs multi-tenancy (template mode) or explicit topology limits. *(devops + sysdesign)*

## Sequence

**5A — make the pager honest (fast, unblocks trust in everything else)**
1. Replace the nc sink with a real logging receiver (tiny Go http logger — no JS rule;
   ~40 LOC, distroless) that logs request bodies; make `_verify-alerting.sh` bounded
   (timeout + cleanup trap) so it can never hang an operator.
2. Fix `ComputePhantomKeepalive`: alert on *state* (active_connections==0 AND compute
   up for >X) not cumulative counter arithmetic; add a rule unit-test in the drill.

**5B — pay the ratification debts (the reliability core)**
3. **Backups + rehearsed restore**: scheduled MinIO bucket mirror + pageserver/safekeeper
   PVC snapshot procedure → object storage; `_verify-restore.sh` drill that destroys a
   throwaway copy and restores it. RTO documented from measurement.
4. **Second pageserver** (or documented+tested fast-restart RTO if 8464's storage
   controller can't do multi-pageserver cleanly — honest finding either way).
5. **Version-pair CI gate**: validate contract that compute tag == storage tag in
   manifests; fails the build on drift.

**5C — productize the warm tier (the differentiator the decision bought)**
6. Single-writer gate into the platform: gateway "warmpool" driver (in-process, no
   shell) that (a) verifies cold deployment fully drained via the k8s API before
   releasing the gate, (b) releases via ConfigMap/exec-free mechanism, (c) re-parks
   on idle. TDD in Go; the shell harness retires.
7. Tier selection contract: per-app annotation/Secret field choosing cold-zero vs
   warm; documented in connecting.md; `_verify-warmtier.sh` joins the battery.

**5D — close the loop**
8. TLS at the gateway front (or documented mesh/ingress termination recipe + test).
9. Battery (now incl. restore + warmtier drills) → iteration-3 blind review trio
   (scorecard per the standing rule) → plan iteration 4.

Deferred consciously: multi-tenancy build-out (template mode) — it inherits the
single-writer gate from 5C; scheduled after the warm tier proves the gate pattern.
Kill criteria: standing, unchanged.
