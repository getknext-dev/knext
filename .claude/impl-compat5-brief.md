# Brief — release checklist step 5: the last honesty gate (#545, #710)

You are working **release checklist step 5** in `docs/release/public-release-readiness.md`:

> 5. [ ] Agent: compat flake hunt (#545) and the bun-lane weekly red (#710) — the last honesty gate.

This is the only unchecked **agent-doable** item on the release checklist. Steps 1–2 are
human-gated (ghcr visibility click, `npm login`) and steps 3/4/6 depend on those. So this is the
critical path for everything release readiness can reach without the founder.

Repo: `/Users/banna/alpheya/pocs/knext`. Work in a **worktree**, not the main checkout.

## What you must establish

### A. Where does the full/weekly compat suite actually run?
`ci.yml:238-243` says the `compat-smoke` job is **NOT** the official Next.js compatibility suite,
and that the official deploy-test harness is *"a separate scheduled job (A3-2, compat-suite-full)"*.
**There is no such workflow file in `.github/workflows/`.** Find where it really runs — or
establish that it does not run at all any more. Candidates: `gh workflow list` (a workflow can exist
on the default branch's Actions surface without a file you spotted), another repo in the
`getknext-dev` org, or `scripts/compat-run-ledger.mjs` and whatever writes its data.

**If the weekly lane does not exist, say so plainly** — that changes what #710 even means, and it
would mean a release-checklist item is guarding a lane that is not running. That is a
discovered-fact escalation under `.claude/rules/workflow.md`; report it, do not paper over it.

### B. #710 — "Compat weekly RED (bun lane)"
Get the **actual failing shard and test names** from the last runs, not a summary. Then discriminate:
- a **real** Next.js incompatibility on the bun runtime, or
- **infrastructure** flake (timeout, OOM, registry, scheduling)?

The distinction decides whether this blocks the release claim or is a CI-hygiene item.

### C. #545 — "Compat suite is flaky at shard level"
Quantify from the ledger (`scripts/compat-run-ledger.mjs` and its data), not from impressions:
how many distinct tests flake, how many runs went red-then-green on re-run with no code change,
and whether the v1.0 gate (ADR-0007's bar is a **flake** bar) is reachable. Note that the previous
release-audit round cleared a *different* claim — the **nightly** gate showed 28 nights with zero
re-runs. #545 is about **shard-level** flake in the full suite. Do not conflate them.

## Deliverables
1. A findings file `docs/release/compat-honesty-gate.md` — measured, with run IDs and test names.
2. A comment with the evidence on **#710** and on **#545** (`gh issue comment`).
3. If a fix is tractable within this round: TDD it (failing test first), push a branch, open a PR
   with `Closes #<n>`. If not tractable, say exactly what it would take and why it is out of round.
4. Update the step-5 line in `docs/release/public-release-readiness.md` to reflect the measured
   state — check it only if it is genuinely discharged.

## Discipline (non-negotiable — each has burned this project)
- **Branch on exit codes, never grep output.** ANSI in vitest output has already certified 14
  decorative mutations as all-green.
- **Mutation-prove every new guard**: delete the behaviour it protects, watch it go red. A guard
  that stays green when its subject is removed is decoration. Never mutate with `perl`; use a script
  that asserts the anchor occurs **exactly once** and aborts otherwise.
- **Assert both halves** of any invariant — the single most common defect class in this repo.
- **Prefer scanning to enumerating**, and state honestly in your report which parts are SCANNED and
  which are ENUMERATED.
- Compute ages against `datetime.now(timezone.utc)` — GitHub timestamps are UTC and local
  wall-clock comparison has already produced a false "stuck for hours" call here.
- Never push to `main`, never force-push, never rewrite history. Feature branch + PR only.

## Report
Write `.claude/impl-compat5-report.md` in your worktree with: what you measured, run IDs, the
verdict on each issue, what is SCANNED vs ENUMERATED, and anything you could not establish.
