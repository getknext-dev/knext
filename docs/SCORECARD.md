# KS-PG Scorecard — per-iteration ratings (1–10)

Standing rule: at each iteration's review step, three independent, blind
reviewers (system designer, DevOps/SRE, architect) each score three metrics:

- **Maturity** — how far from "experiment" toward "boring, trusted platform".
- **Ease of maintenance** — can a small team that didn't build it keep it healthy?
- **Production reliability** — will it stay up, keep data safe, behave under load?

Reviewers score 1–10 per metric with a one-line justification each; scores land
in their review files under `docs/reviews/iteration-N/` and are transcribed here.

## History

Rounds 0–1 were scored on the reviewers' native axes; mapped here as
Maintainability/Operability/Evolution → *ease of maintenance*,
Production-readiness/-performance/Fitness → *production reliability*; maturity
was not separately scored before iteration 2 (marked —).

| Iteration | Reviewer | Maturity | Ease of maintenance | Production reliability |
|---|---|---|---|---|
| 0 (post-MVP) | System designer | — | 5 | 3 |
| 0 (post-MVP) | DevOps/SRE | — | 3 | 2 |
| 0 (post-MVP) | Architect | — | 5 *(evolution)* | 6 *(fitness)* |
| 1 | System designer | — | **7** (+2) | **5** (+2) |
| 1 | DevOps/SRE | — | **4** (+1) | **3** (+1) |
| 1 | Architect | — | **7** *(evolution)* (+2) | **6** *(fitness)* (=) |
| **2** | System designer | **5** | **4** | **4** |
| **2** | DevOps/SRE | **4** | **5** | **3** |
| **2** | Architect | **5** | **4** | **4** |
| **3** | System designer | **6** | **7** | **6** |
| **3** | DevOps/SRE | **6** | **7** | **5** |
| **3** | Architect | **7** | **6** | **5** |
| **4** | System designer | **6** | **5** | **5** |
| **4** | DevOps/SRE | **6** | **6** | **5** |
| **4** | Architect | **7** | **6** | **7** |
| **5** | System designer | **7** | **6** | **6** |
| **5** | DevOps/SRE | **6** | **6** | **5** |
| **5** | Architect | **8** | **6** | **7** |
| **6** | System designer | **7** | **7** | **6** |
| **6** | DevOps/SRE | **7** | **7** | **6** |
| **6** | Architect | **7** | **6** | **7** |
| **7** | System designer | **7** | **7** | **6** |
| **7** | DevOps/SRE | **7.5** | **7** | **6.7** |
| **7** | Architect | **8** | **7** | **7** |
| **v0.6.0** | System designer | **6** | **6** | **5** |
| **v0.6.0** | DevOps/SRE | **6** | **6** | **5** |
| **v0.6.0** | Architect | **8** | **6** | **7** |
| **v0.6.1** | System designer | **7** | **6** | **6** |
| **v0.6.1** | DevOps/SRE | **7** | **6** | **7** |
| **v0.6.1** | Architect | **8** | **6** | **7** |
| **v1.0.0** | System designer | **7** | **6** | **7** |
| **v1.0.0** | DevOps/SRE | **7** | **6** | **6** |
| **v1.0.0** | Architect | **8** | **6** | **7** |
| **v2.0.0** | System designer | **6** | **6** | **6** |
| **v2.0.0** | DevOps/SRE | **6** | **6** | **5** |
| **v2.0.0** | Architect | **8** | **6** | **6** |

**Iteration-1 mean (mapped axes): ease 6.0, reliability 4.7** (round 0: 4.3, 3.7).
**Iteration-2 mean (explicit metrics): maturity 4.7, ease 4.3, reliability 3.7.**
**Iteration-3 mean: maturity 6.3, ease 6.7, reliability 5.3**
**Iteration-4 mean: maturity 6.3, ease 5.7, reliability 5.7**
**Iteration-5 mean: maturity 7.0, ease 6.0, reliability 6.0**
**Iteration-6 mean: maturity 7.0, ease 6.7, reliability 6.3**
**Iteration-7 mean: maturity 7.5, ease 7.0, reliability 6.6** — the arc-closing
row. The correctness lap found NO live defect; the DevOps reviewer ran the full
battery from docs alone (all green) and rendered the milestone verdict: "I would
carry this pager for real money TODAY for the stated MVP scope." All three
reviewers ruled GRADUATE: per-iteration reviews end; a blind trio re-convenes on
release tags, ADR changes, kill-criterion tripwires, or a failing upgrade
rehearsal (#36). Graduation condition: #60 (alerting dead-man's-switch) closes
on/around graduation. Owner ratified; graduation executed after iteration 8.
**v0.6.0 release review (first trigger-gated round): maturity 6.7, ease 6.0,
reliability 5.7** — the honest cost of shipping a new surface: the single-DB
core KEPT its pager-YES ("still green and drilled: wake 2.9s"), the identity
shift to a multi-tenant platform was RATIFIED (ADR-0003 sound), but the new
surface re-opened the pager for its own scope (unmonitored tenants/RO pool
#79-class, cross-tenant access #74, per-app S2Z break under 2-replica gateway
#75, janitor single-tenant assumption #77, provision orphans #76). Next lap =
v0.6.1 hardening of exactly that list; the loop's trigger cadence held.
**v0.6.1 rematch: maturity 7.3, ease 6.0, reliability 6.7 (all-time reliability
high). THE SPLIT FLIPS: DevOps pager verdict "YES — conditional (carry it)" for
the full multi-tenant scope — every v0.6.0 NO-driver closed and drilled live on
the unified image; defeat attempts held (cloud_admin dead, crafted names refused
both surfaces, per-app idle held). Architect ruled the 12-fixes-in-a-day "a
tight loop over well-scoped defects, not stopgaps" and drafted the 9-point
v1.0/GA criteria (#73, owner ratification pending). Residue: existence oracle
(#92), orphan-WAL reclaim circularity + PV growth alert gap, drill tooling
papercuts (#94/#95) — the GA lap's backlog. — all-time high on
every axis. Observability debt closed (KSM + exact-join rules + presence check,
paged end-to-end by the reviewer). Named residue: the silent-machinery class is
~2/3 closed (#48 KSM self-guard, #49 janitor-stale, #51 readiness) and the
failover authority is instrumented-not-corrected (#25/#26). Architect ruling:
one final correctness lap, then graduate the loop to on-release cadence (#36). — the arc-capping
row: every p1 across five iterations closed, the north star demonstrated 5/5
(and reported honestly: the 13s both-cold finding redirects optimization to the
app tier). First individual 8 (architect: maturity). Convergent next debt, found
independently twice: the load-bearing wal-janitor has NO failure signal (#29
elevated p1, #41). Caveat on the reliability column: two reviewers deducted for
"failover not live" on stale issue state — pswatcher had 7h+ verified uptime;
correction on the PR record. Ease pinned at 6 by the priced-in Neon ops ceiling
plus the new intricate machinery (skctl, hex-WAL shell math). — reliability up
(read-SPOF cleared, off-cluster DR, writable restore; architect ruled ADR-0002
kill-criterion 6 CLEARED); ease deliberately DOWN: reliability was bought with
maintenance surface (new watcher + serializer + OCI deps), and the trio
independently priced that debt (#22/#23/#27/#29). The loop caught its own
grep-green/prod-red class a third time (#27: merged ≠ deployed) — fixed live. — first row rendered
as PR reviews (getknext-dev/scale-zero-pg #10/#11); the jump credits the OKE
migration, 11/11 battery, closed ratification debts, and the GitHub-native loop.
Reliability stays lowest exactly where issues #2/#3/#4/#5 are open — plan and
scores agree.
The apparent dip is a re-basing, not a regression: iteration-2 scores judge the
RATIFIED Neon-two-tier path against a production bar — pricing in the accepted
obligations (backups, pageserver SPOF, warm-tier productization, version-pair
gate) that ratification turned from options into debts. All three reviewers
independently converged on 4±1 across the board.

## Reading guide

- The architect's "fitness" deliberately holds until ADR-0002 decides the
  foundation — polishing an inherited decision doesn't raise it.
- DevOps scores lag by design: they weigh backups/HA/on-call, where the biggest
  gaps (single node, single pageserver, no restore drill) still sit.
- Convergence between reviewers matters more than any single number: a finding
  two reviewers hit independently is treated as confirmed.

*(From iteration 2 on, all three metrics are scored explicitly by every reviewer.)*


**v1.0.0 GA release review: maturity 7.3, ease 6.0, reliability 6.7.** All three
reviewers APPROVED v1.0.0 as a legitimate 1.0 for its stated scope; the isolation
fix (#112/#115) was independently RE-VERIFIED live (not a regression). DevOps GA
pager verdict: **YES-WITH-LIST** ("carry it for real money on the shipped MinIO
config"). Architect: "the gate held — the process worked as designed." The v1.0.1
list (findings that outran live-proven state): operator undeployable-as-shipped
(#125), object-storage portability half-delivered — backup/janitor still MinIO-
pinned so the advertised OCI backup path silently breaks (#120), RO pool evicts
under its own load (#121), manifest-contract gate red vs the live cluster (#126),
plus #116/#117/#118. Ease held at 6 (Neon ops ceiling + accreting machinery + the
new backup/live-store config split-brain). None retract the GA; all are the v1.0.1
hardening lap.

**v2.0.0 zone-axis release review (trigger-gated): maturity 6.7, ease 6.0,
reliability 5.7.** Architect SIGN-OFF — "architecturally defensible v2 for its
stated intra-cluster scope"; the 4-axis scaling model is complete and coherent,
the SCS un-park is done responsibly (coupling declared via both-sides-agree,
directional + subset-scoped opt-in publishes, eventual BY CONTRACT never a silent
default, single-writer-per-table, bounded blast radius). No tag retraction. The
reliability dip is the honest, precedented cost of shipping a new frontier surface
(v0.6.0 pattern): the single-DB/tenant/read core keeps its pager-YES and is
untouched (slot-janitor verified inert on the slot-free plane), but the zone axis
re-opens the pager for its OWN scope. **CONVERGENT top finding, hit independently
by DevOps + system-designer + live-confirmed: v2-2 (Zone CRD + operator) is NOT
DEPLOYED on the live cluster** — `_verify-zones.sh` applies 86/87, drills, then
tears them down on EXIT, so the flagship surface is proven only in throwaway drills
(the #27/#125 "merged ≠ deployed" class; v2-1 repl-wake + v2-3 WAL-bound ARE live).
The v2.0.1 hardening list: deploy the zone operator + CRD to live with soak (#151);
#142 janitor-disarm alert (v2 WIDENS it — the exact class that caused the
2026-07-06 DiskPressure); self-healing re-sync actuator for an invalidated slot +
stale `streaming` status (designed-not-built); Zone Degraded/Failed/subscription-
error alerting; single-writer fail-open on a Zone-lister outage (#147, the invariant
that keeps "eventual" from "eventually wrong"); cross-zone plaintext creds
(sslmode=disable — blocker for the §4e cross-cluster future); manifest-contract gate
doesn't cover the new zone surface. None retract v2.0.0; all are the v2.0.1 lap.