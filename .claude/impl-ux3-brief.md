# Iteration-3 brief — ergonomics loop, finding 1c (doctor's no-cluster misdirection)

You are the implementer for knext ergonomics-loop iteration 3. Repo: `/Users/banna/alpheya/pocs/knext`.

## Setup
- Create branch `feat/ux-doctor-no-cluster` FROM `feat/ux-guided-first-contact` (stacked — that
  branch is iteration 2, locally committed, not yet on origin).
- Work in an isolated worktree (`git worktree add`), NOT the main checkout.
- Commit with `--no-gpg-sign` (pinentry unavailable). Leave everything local; the lead handles
  origin/PRs once auth returns.

## Spec
`docs/ux/ergonomics-ledger.md` finding **1c** (on branch `measure/ux-ergonomics-ledger-row1`:
`git show measure/ux-ergonomics-ledger-row1:docs/ux/ergonomics-ledger.md`). Persona: **zero
cloud/Kubernetes knowledge**.

Today `kn-next doctor` with a stale or absent kubeconfig says "cluster connection flaked — check
network/VPN and retry" — misdirection for a user who has NO cluster yet.

Required: `doctor` (`packages/kn-next/src/cli/doctor.ts`) distinguishes the **no-cluster-configured**
states from a real reachability flake:
1. no kubeconfig file at all,
2. empty config / no current-context,
3. connection refused to a **local** apiserver (127.0.0.1 / localhost / 0.0.0.0 — the stale
   local-cluster leftover case),

and answers the persona plainly: "you don't have a Kubernetes cluster connected yet" + what to do
next (point at the real docs site — verify the exact URL from `apps/docs` or README; never invent
one). Keep the existing flake hint for genuinely-remote-but-unreachable servers.

## Conventions on your base branch (iteration 2) — binding
- Usage/expected states go through the friendly write-and-exit paths in `cli/shared.ts`
  (`UsageError` / `ConfigNotFoundError` pattern) — NEVER a FATAL stack dump.
- An inverted scan guard fails any bare `throw new Error(` under `src/cli/` unless allowlisted with
  justification — work with it, not around it.
- pino writes FATAL to **stdout** — assert BOTH output streams in tests.

## Discipline
- TDD: failing tests first for each of the three states plus the remote-flake case (must stay
  distinguishable).
- Mutation-prove any new guard: exit-code-branched, anchor-asserted, restore and verify the tree
  clean after each mutation.
- Suite + package `tsc --noEmit` + biome green.
- Report to the worktree's `.claude/impl-ux3-report.md`, first line DONE or BLOCKED, with the
  before/after doctor output for all four states.
