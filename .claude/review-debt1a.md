APPROVE

Adversarial code review of #804 — fm typecheck gate.
Branch `fix/fm-typecheck-gate`, worktree `/Users/banna/alpheya/pocs/knext-wt/fm-typecheck-gate`,
diff vs `origin/main` (6 files, +67/-10). Reviewer did not write the change. Read-only review.

I attacked all five axes and could not defeat the change.

## Mutation proofs (branched on EXIT CODE, never output-grep)

Every mutation script asserted its anchor occurred EXACTLY ONCE before substituting and aborted
otherwise; each restore was verified byte-identical against the pre-mutation buffer.

| # | Mutation | Exit |
|---|---|---|
| 0 | baseline `pnpm --filter file-manager typecheck` | **0 (green)** |
| 1 | `apps/file-manager/src/components/NavLink.tsx:14` — `const isActive = pathname === href;` -> `const isActive: number = ...` | **2 (RED, correct)** |
| 2 | `apps/file-manager/src/app/dashboard/page.tsx` — `export default async function DashboardPage` -> `...DashboardPage(): number` | **2 (RED, correct)** |
| 3 | restored both | **0 (green)** |
| 4 | baseline contract test | **0** |
| 5 | deleted the `Typecheck file-manager` step from `.github/workflows/ci.yml:190-191` | **1 (RED, correct)** |
| 6 | deleted `"typecheck"` from `apps/file-manager/package.json:11` | **1 (RED, correct)** |
| 7 | restored both | **0** |

`git status --porcelain` was clean before and after every mutation — only the untracked
`.claude/impl-debt1a-report.md` remains. No mutation residue.

## Axis findings

**1. The gate checks real app source — NOT vacuous.**
`apps/file-manager/tsconfig.typecheck.json:11` includes `**/*.ts`, `**/*.tsx`, `**/*.mts`, so
`src/app/**` routes, `src/components/**`, plus `e2e-support/`, `hack/`, `scripts/` are in scope;
`strict: true` / `noEmit` inherit from `apps/file-manager/tsconfig.json:6-7`. Mutations 1 and 2 were
planted in REAL APP SOURCE (a client component and an App Router page), not test files, and both
went red. Notably my run was the COLD-CHECKOUT case — neither `apps/file-manager/.next` nor
`next-env.d.ts` exists on disk in this worktree — so the determinism claim in the tsconfig docblock
is proven rather than asserted. The `.next` exclusion drops Next's generated route-type validators,
but that is not an uncovered hole: `next build` runs for fm at `ci.yml:308`, `:358`, `:411`, and
there is no `ignoreBuildErrors`/`ignoreDuringBuilds` anywhere in fm's `next.config`.

**2. No suppressions, no type-widening.**
Zero added `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` / `as any` / `: any` in the diff.
`as any` count in `next-adapter.test.ts` is **21 on origin/main and 21 on HEAD** — nothing was
widened to force green. The single added assertion, `apps/file-manager/next-adapter.test.ts:35`
(`rsc: {} as OnBuildCompleteCtx['routing']['rsc']`), is narrowly scoped to a Next-internal
header-literal bundle the adapter never reads, and is commented. `OnBuildCompleteCtx` is derived
from the adapter module itself, correctly dodging the cross-instance nominal issue the file header
documents.

**3. Contract records are honest.**
`packages/kn-next/src/__tests__/ci-typecheck-contract.test.ts:43-67` no longer lists `file-manager`;
it is now COVERED, not excluded/skipped. The guard is genuinely two-sided — `:180` requires
COVERED-or-DOCUMENTED-EXCLUDED, `:195` requires BOTH script and ci.yml step (no half-wiring), `:226`
keeps the buckets exclusive. Mutations 5 and 6 prove it fails on either half being removed.
Contract test 10/10 green.

**4. CI step present, correctly ordered, unfiltered, no soft-fail.**
`.github/workflows/ci.yml:190-191` sits in the `lint-and-test` job (`:91`), which carries no `if:`,
no path filter (the workflow triggers on branches at `:3-7`, not paths), and NO `continue-on-error`
— the two `continue-on-error` occurrences in the file are the docs Trivy job at `:980` and comments
at `:47-48`/`:1188`. The step is UNCONDITIONAL, which is strictly stronger than the brief's "runs
when fm files change", and is correctly ordered after the lib->db->core builds (`:142-152`) it is
dist-dependent on, and before `Run tests` (`:193`).

**5. fm runtime behavior unchanged.**
`pnpm exec vitest run apps/file-manager` -> **38 files passed / 3 skipped, 372 tests passed /
14 skipped, 0 failed**. `pnpm exec biome check --diagnostic-level=error` on all five changed paths
-> exit 0 (the 24 remaining diagnostics are pre-existing `any` WARNINGS, unchanged in count).

## Report claims: VERIFIED vs REFUTED

Verified by independent evidence rather than by re-reading the report:
- "Legacy `routes` is KEPT and the adapter's counting branch prefers it, so the legacy-path
  assertions test exactly what they did before" — **VERIFIED** at
  `packages/kn-next/src/adapters/next-adapter.ts:167-184`, which is
  `if (legacyRoutes) {...} else if (routing) {...}`. Adding `routing: emptyRouting` to fixtures that
  also carry `routes` cannot switch branches. This was the report's most load-bearing claim (it is
  what stands between "re-typed" and "silently weakened assertions") and it holds.
- "TS1501 `/s` flag was inert" — **VERIFIED**: the pattern
  `serverExternalPackages:\s*\[([^\]]*)\]` contains no `.`, and `[^\]]` already spans newlines.
  `apps/file-manager/standalone-seam-alive.test.ts:150` is behaviour-identical.
- "No ts-ignore anywhere" — **VERIFIED** (grep of added lines; `as any` count flat at 21).
- "typecheck exit 0", "contract 10/10 green", "fm suite green", "biome green" — all independently
  reproduced.
- "Mutation-proved: the gate can go red" — **VERIFIED and STRENGTHENED**. The report only mutated
  "a stray fm `.ts`"; I re-proved it against REAL APP SOURCE (component + App Router page), which is
  the claim that actually matters for a non-vacuous gate. It holds.

**REFUTED: nothing.** The report's environmental note about 2 gpg-signing failures in
`tests/compat-window-fingerprint.test.ts` is outside this diff and not load-bearing for the verdict.

## Minor, explicitly NON-BLOCKING observations

- `packages/kn-next/src/__tests__/ci-typecheck-contract.test.ts:44-48` — the #804 narrative comment
  now sits INSIDE `DOCUMENTED_EXCLUSIONS` describing an entry that no longer exists, directly above
  `spike-bun-bytecode`'s own comment, so the two read as one block. Purely cosmetic.
- The `emptyRouting` fixture is added to every fixture but never actually exercised, since the
  legacy branch always wins — so the 16.2 `ctx.routing` counting branch at
  `packages/kn-next/src/adapters/next-adapter.ts:180-184` remains untested. PRE-EXISTING coverage
  debt, not introduced by this PR, and the natural follow-up now that the fixtures type-check.

## Test quality

Meaningful and not weakened to pass — the fixtures were genuinely re-typed rather than suppressed,
`as any` count is flat at 21, the legacy-count assertions still exercise the same branch they always
did, and the contract guard was mutation-proved red on BOTH half-wiring modes.
