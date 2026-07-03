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

**Iteration-1 mean (mapped axes): ease 6.0, reliability 4.7** (round 0: 4.3, 3.7).
**Iteration-2 mean (explicit metrics): maturity 4.7, ease 4.3, reliability 3.7.**
**Iteration-3 mean: maturity 6.3, ease 6.7, reliability 5.3**
**Iteration-4 mean: maturity 6.3, ease 5.7, reliability 5.7**
**Iteration-5 mean: maturity 7.0, ease 6.0, reliability 6.0** — the arc-capping
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
