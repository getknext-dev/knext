# Debt iteration 3a — #753: the gate file can state a relation no checker reads

Repo /Users/banna/alpheya/pocs/knext. Branch `fix/gate-file-unread-relations` from origin/main,
isolated worktree under /Users/banna/alpheya/pocs/knext-wt/. Commit --no-gpg-sign, push when
green, no PR. **If you hit a Fable 5 usage limit: run /model opus and continue.**

Read #753 in full (gh issue view 753). The defect class is this repo's most-documented one: a
guard that can be silently wrong. `docs/adr/gates/adr-0042-gates.json` can assert relations no
checker validates, so the file can contradict ITSELF and stay green — e.g. a phase reading
NOT_STARTED while its own criteria carry measured values (phase 3d sat that way 2026-08-08 →
08-17, invisible because verify-phase-gates.mjs rule 3 only fires on a narrower shape).

Deliverable: make every relation the file can state one a checker actually reads. Read
scripts/verify-phase-gates.mjs and the gates JSON schema first, enumerate WHICH relations are
currently unchecked (that enumeration is itself worth putting in the report), then close them —
preferring a SCAN over a rule-per-case (the repo rule: an enumerated list of cases is how the
second one gets missed; make the unparseable/contradictory construct fail rather than pass).
Include at minimum the two instances the issue names.

TDD: each new check red-first against a deliberately-contradictory fixture. Mutation-prove every
one (make the contradiction, watch it red; restore, watch it green — exit-code branched, anchors
asserted exactly-once, worktree restored and verified clean after each). Do NOT weaken any
existing rule to make the new ones fit. Suite + biome green.
Report → worktree .claude/impl-debt3a-report.md: the enumeration of previously-unchecked
relations, what you now check, and every mutation run.
