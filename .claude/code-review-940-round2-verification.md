# PR #940 round-2 verification — APPROVE

Branch `agent/s3-isr-prover` @ 754a343f. Measured, not read.

## 1. Swept provers — false-kill class closed (simulation + live runs)
Replayed `mutation-harness.mjs mutate()` semantics (single-line replacement →
`${text} // KNEXT-MUTATION` appended) against the branch's real files, then ran
`jsStillParses` on the result:

| case | anchors | parses |
|---|---|---|
| C6 completion, NEW `    .filter((a) => a.count !== 1)` | 1 | YES |
| C6 completion, OLD `(a) => a.count !== 1` | 1 | NO — `')' expected` |
| M3 seam, NEW (`…/g)) {` end-of-line) | 1 | YES |
| M3 seam, OLD (ends at regex literal) | 1 | NO — `',' expected` |
| seam M1/M2, ISR M6/M7 | 1 each | YES |

The old anchors reproduce the round-1 defect exactly; the new ones are clean.

Live prover runs (worktree `.claude/worktrees/agent-s3-isr-r2`, tree clean before
and after, byte-identical restore asserted by each prover):
- `mutation-prove-isr-staleness.mjs` exit 0 — `{"declared":8,"run":8}`, M1–M7 KILLED, M8 TOLERATED
- `mutation-prove-prover-completion.mjs` exit 0 — `{"declared":8,"run":8}`, 7 red + NC green
- `mutation-prove-seam-relocation-clock.mjs` exit 0 — `{"declared":4,"run":4}`, M1–M3 KILLED, M4 TOLERATED

## 2. Shared helper
`scripts/lib/parse-validity.mjs` imports `typescript` only — no `child_process`,
no spawn. Lane audit `tests/mutation-prover-lane.test.ts:175-192` globs the whole
`scripts/lib` dir, so the helper is inside the audit's scope, not a bypass around
it. No local copy of `jsStillParses` remains in the ISR prover (imports only).
Two integration shapes, both correct: `guard-prover.mjs:202` calls the `validate`
hook inside the `try` (restore unconditional); the completion prover's bespoke
loop throws at `:236` before `check()`, with `finally` restoring.

## 3. M7 expire boundary — direction verified against the code
`cache-handler.js:826` `ageSeconds > expire` → `'expired'` is checked BEFORE
`:829` `ageSeconds > revalidate` → `'stale'`. So at `age === expire` the expired
branch does not fire and the entry falls to the revalidate check (60 > 1) →
`'stale'`; `+1ms` → `'expired'`. The two new frozen-clock cases pin exactly that
(`revalidate: 1, expire: 60`; `lastModified = frozen - 60000` and `- 60001`).
M7 KILLED, negative renumbered to M8 and TOLERATED, declared 8 == ran 8.

## 4. Docblock claim
Reframed to "THIS HANDLER'S tie-break rule" — accurate. The
"no upstream source vendored to cite" statement is true: `vinext` is absent from
the root `node_modules` and appears only under gitignored `apps/*/node_modules`
as compiled `dist`, which *consumes* `isStale`/`cacheState` from the handler and
pins no age/expire comparison of its own.

## 5. Regression skim
- `biome check --diagnostic-level=error` on all 5 changed files: exit 0 (754a343f import-order fix landed clean)
- `tsc -p tsconfig.typecheck.json --noEmit`: exit 0
- `tests/mutation-prover-lane.test.ts`, `mutation-residue-scan`, `mutation-harness` (bun:test runner): all exit 0
- each prover's own baseline step reports its spec green before mutating
- worktree `git status --porcelain` empty after every run

Nit (non-blocking): `mutation-prove-isr-staleness.mjs:123` comment "see
`jsStillParses`" now points at an imported symbol rather than a local definition.

**Verdict: APPROVE.**
