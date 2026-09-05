# Release blocker 3 — the compat gate's own red/flaky state (#545 + #710)

Repo /Users/banna/alpheya/pocs/knext. Branch `fix/compat-gate-honesty` from origin/main,
isolated worktree under /Users/banna/alpheya/pocs/knext-wt/. Commit --no-gpg-sign, push when
green, no PR. **If you hit a Fable 5 usage limit: run /model opus and continue.**

This is a PUBLIC-RELEASE BLOCKER (docs/release/public-release-readiness.md, blocker 3): the
project's central credibility claim is compat-suite-backed parity, and the gate that backs it is
red on the bun lane (#710) and shard-level flaky (#545 — "the v1.0 gate is unreachable until it
isn't"). Read BOTH issues fully first (gh issue view 545; gh issue view 710), plus
docs/compat-matrix.md's honesty rules and ADR-0007.

Deliverable, in priority order:
1. **Diagnose #545's flakiness with evidence, not impressions.** Pull the recent compat runs
   (gh run list --workflow test-e2e-deploy.yml --limit 20 --json ...; gh run view <id> for the
   red ones) and build a table: which shards fail, how often, same-test-or-different, and whether
   the failures cluster by shard index, by test family, or by runner. The repo's own quarantine
   ledger ($knextQuarantines in test/deploy-tests-manifest.knext.json) already has entries with
   provenance — check whether the current flakes are NEW or re-runs of quarantined families.
2. **Classify each failure**: upstream-known (already fixed after the pinned ref → quarantine with
   provenance per ADR-0007 §c/§d), knext-side real bug (file it, or fix if contained), or
   infrastructure (runner OOM/timeout → the harness's problem, fix the harness).
3. **#710's bun-lane red specifically**: the 3 documented Bun ≤1.3.14 gaps are known (edge-sandbox
   outbound fetch; the instrumented not-found invariant) — verify the current red is those and
   not something new; if new, that is the finding.
4. Implement whatever is contained and in-repo: quarantine entries with full provenance (the
   ledger's format is strict — read tests/deploy-manifest.test.ts's guard), harness fixes, or a
   flake-retry policy ONLY if ADR-0007 permits it (check — do not invent one).
5. **Do NOT weaken the gate to make it green.** Anything you quarantine must carry run IDs, the
   failure mechanism, and an expiry condition, and the guard test must still pass.

Report → worktree .claude/impl-rel2-report.md: the failure table, the classification, what you
changed, and — critically — an honest statement of what still blocks a green compat claim.
