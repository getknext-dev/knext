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

**Iteration-1 mean (mapped axes): ease 6.0, reliability 4.7** (round 0: 4.3, 3.7).
**Iteration-2 mean (explicit metrics): maturity 4.7, ease 4.3, reliability 3.7.**
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
