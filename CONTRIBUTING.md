# Contributing to knext

## Where things go (triage path)

- **Bug?** Open an issue with the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml) —
  it asks for the version and cluster environment up front, which is most of what triage needs.
- **Feature idea?** Open an issue with the [feature request template](.github/ISSUE_TEMPLATE/feature_request.yml).
- **"How do I...?" / general question?** Use [Discussions](https://github.com/getknext-dev/knext/discussions),
  not the issue tracker — issues are for actionable work items.
- **Security vulnerability?** Do **not** open a public issue. See [SECURITY.md](SECURITY.md) for
  private reporting via GitHub Security Advisories.

## Mutation-proving a guard

Every new guard is mutation-proved (delete the behaviour it protects, watch it go RED, restore).
**Restore from a byte snapshot and run the residue scan** — `git status --porcelain` cannot see
residue in a file your PR legitimately modifies, which is how two near-misses happened in one
session:

```bash
bun run lint:mutation-residue     # red-on-fail in CI; run it before you commit
```

Read [`docs/guides/mutation-testing.md`](docs/guides/mutation-testing.md) before writing a harness;
it ships one (`scripts/lib/mutation-harness.mjs`) so you do not hand-roll the restore.

## Docs live with the code (`apps/docs/`)

The user-facing docs site (knext-platform.dev) lives in this monorepo at **`apps/docs/`** and consumes
`@getknext/core` via `workspace:*` (see `docs/adr/0024-docs-site-in-monorepo.md`).

- **If your PR changes documented behavior — public surface** (`@getknext/core` exports, the
  `KnativeNextConfig` / `NextApp` schema, CLI flags, or generated code) — **update
  `apps/docs/content/**` in the same PR**, or say why the change is invisible to users.
  This is judgment-based, not a hard gate: a soft CI reminder (`docs-drift-reminder`) will post a
  non-blocking warning when public surface changes without a `content/**` change, but it never
  fails the build.

- **`apps/docs/content/**` is USER-FACING.** Even though it now lives beside internal ADRs and
  issue history, it must contain **no ADR numbers, no issue/PR numbers (`#NN`), and no internal
  strategy jargon** (e.g. `vinext`, `Nitro`). Write for adopters, not maintainers. A soft CI
  reminder greps added `content/**` lines for these and warns — treat it as a nudge, not a gate.
  (The docs app's `next.config.ts` / `next-adapter.ts` / `knext.config.ts` legitimately reference
  internals; the guard is scoped to `content/**` only.)

## How the lead merges a PR (`scripts/merge-train.mjs`)

Once a PR has code review + spec review + CI green, the lead enqueues it with
`scripts/merge-train.mjs` rather than `gh pr merge` directly — three incidents (a base-branch
deletion auto-closing a stacked child PR, twice; a PR dequeued on a guard failure only visible on
the combined tree) motivated promoting this out of an ad-hoc scratch script into a tested tool.

```bash
# Enqueue the EXACT reviewed head (full 40-hex SHA only — a short SHA or a
# branch name is refused before anything is queued). Re-checks the PR's
# head on every poll tick and aborts with "HEAD MOVED" if a push landed
# after review. Before enqueueing, it merges current main into a scratch
# worktree of the PR head and runs the PR's changed test files against the
# COMBINED tree, refusing to enqueue (and printing the failing test) if that
# is red — skip only with --skip-preflight.
node scripts/merge-train.mjs enqueue <PR> <FULL_HEAD_SHA> [--timeout 8h] [--skip-preflight]

# If a merge-train run reports "DEQUEUED", or after the fact: find and print
# the merge-group run's failing job/step without digging through the UI.
node scripts/merge-train.mjs investigate <PR>

# Before deleting a merged base branch (the stacked-PR case): refuses and
# lists any open PRs still based on it, unless --retarget is passed, in
# which case it retargets them to main first.
node scripts/merge-train.mjs delete-base <branch> [--retarget]
```

Exit/status lines are deliberately terse and machine-greppable: `MERGED <sha> head-in-main`,
`HEAD MOVED: <old> != <new>`, `DEQUEUED: <reason>`, `TIMEOUT`. Every guard is mutation-proved
(`scripts/mutation-prove-merge-train.mjs`) against fake-`gh` unit tests
(`tests/merge-train.test.ts`, `tests/merge-train-cli.test.ts`) — no live GitHub call is made by
the test suite.

## Building the docs locally

From the repo root (workspace-aware install/build):

```bash
bun install
bun run --filter @getknext/lib build && bun run --filter @getknext/db build && bun run --filter @getknext/core build
bun run --filter knext-docs build            # vanilla (managed-host / Vercel) build
KNEXT_ADAPTER=1 bun run --filter knext-docs build   # self-host / adapter dogfood build
```
