# ADR-0057: Gate an honest line % over executable lines, alongside the raw one

- **Status:** **Proposed (2026-09-23).** Trigger-class: it changes what a CI gate measures. Under
  the 2026-09-22 workflow amendment, the PR merges on code review, spec review and green CI, and
  this ADR goes to the sprint-close design review as a flagged item. The review does not block
  the merge. **Amended** by Amendment 1 (2026-09-23, #1262): pure string-continuation lines are
  attributed from their statement's first line, under five allowlist rules. It is also
  Proposed and is on the sprint-close review list (#1259).
- **Implements:** #1248. **Relates to:** #884 (the merged-lcov gate), #871 (bun is the only
  runner), the coverage-to-95% milestone.

## Context

The coverage gate (`scripts/check-coverage.mjs`) merges about 425 per-process bun lcov reports,
because `scripts/bun-test.mjs` runs one process per test file for mock isolation. It then gates
the line % over the union of every `DA` record.

Measured on this tree, a large share of those `DA` records are on lines that hold no code.
bun emits a `DA` record, at 0 hits, for every line of a function that a given process never
ran. That includes blank lines, comments, lone `}` / `});` and type-only syntax. In a process
that did run the function, bun reports only its statement lines. The union keeps both sets, so
the noise lines always show as uncovered. `cli/validate.ts` is the clearest case. Its raw
figure is 240/388 (61.9%). A single-process run of the same files gives 240/240.

Totals for `packages/kn-next/src/**` (union of the per-process reports, plus the 0%
denominator for files no test loads):

| | found | hit | % |
|---|---|---|---|
| raw (today's gate) | 12598 | 9945 | 78.94 |
| honest (this ADR) | 8967 | 8280 | 92.34 |

The 3957 excluded records (global) are 1933 punctuation, 1334 comment, 317 blank, 309
type-only, and 64 template-literal continuation lines.

At a raw 79%, 95% is not reachable honestly: most of the remaining gap is formatting.

## Decision

1. **Classify every source line with the TypeScript parser** (`scripts/lib/executable-lines.mjs`).
   The rule is a whitelist of noise with a default of "executable". A line is noise only if every
   token *starting* on it is one of the following:
   - type-only syntax that TypeScript erases;
   - a closing delimiter or separator;
   - an opening delimiter that begins no runtime operation.

   Object and array literals, call-argument parens, element access and computed keys are runtime
   operations, so their openers stay executable. A line with no token starting on it is blank,
   comment-only, or the continuation of a multi-line token. A regex is never used.
2. **Report both numbers and gate both.** The raw floors (77 global / 78.5 core) are
   **unchanged**. New honest floors: **92 global / 92 core**. These are the measured 92.42% /
   92.34%, rounded down to 0.5. The coverage-to-95% target is read against the honest number.
3. **Fail toward noise.** If a source cannot be read or has parse errors, all of its records are
   kept. A `DA` line past the end of the file is also kept.
4. Key the generated 0% denominator entries by their real line numbers, not `1..N`, so the
   classifier reads the right source line. The count is unchanged, so the raw number is too.

## Options considered

| Option | Honest? | Hides code? | Cost | Verdict |
|---|---|---|---|---|
| **A. Parser-classified denominator, both numbers gated** | yes | no. Proved by a fixture, a repo-wide differential scan, and 13 mutations | one module, no new runner | **chosen** |
| B. Intersection merge (keep a line only if every report that loaded the file has it) | reads 95.02% | **yes.** It drops 219 lines the parser calls executable. Example: `asset-upload.ts:1080`, an uncovered `throw`, is missing from 41 of its 44 reports | trivial | rejected |
| C. V8-based tool (c8, `node --test --experimental-test-coverage`) | yes | no | a second runner. The suite uses `bun:test` and `mock.module`, and removing the second runner was the whole of #871 | rejected for now |
| D. bun's function/branch data | n/a | n/a | bun gives no function identity and emits no branch records | not usable |
| E. Keep raw only | no | no | none | rejected: 95% becomes unreachable honestly |

Option B was the leading alternative, because the inflation does come from how the per-process
reports are merged. Probing the reports rules it out. **A report that omits a line does not show
the line is non-executable.** `logger.ts:69` (`return rootLogger;`) is missing from 40 of 68
reports, even where lines around it in the same function were hit. An intersection therefore
deletes real, uncovered statements from the denominator.

jev (calibrated second opinion), run on the evidence above: picked A with confidence 0.99 (B
0.00). P(B violates the never-hide invariant) = 0.95.

## Consequences

- The gate prints two line numbers per scope. `--per-file` lists the honest uncovered lines per
  file, which is the right input for sizing a coverage batch.
- **Residual noise is kept on purpose.** A string-literal argument on its own line holds an
  expression, so it stays in the denominator even though bun never marks it. Example:
  `validate.ts` stays at 165/168 honest, where a single-process run gives 100%. That keeps the
  honest number conservative.
- **Known gap, not closed here:** an executable line that bun emits *no* `DA` record for, in any
  report, is still missing from both numbers. This ADR only removes records. It never adds any.
- The classifier is a trust point. It is guarded by
  `tests/coverage-executable-lines.test.ts`, which holds the tricky-case fixture and a
  differential scan. The scan checks every noise line in `packages/*/src` against TypeScript's
  own emitted JS and source map, and requires that the line emit no runtime JS. It is also
  guarded by `scripts/mutation-prove-honest-coverage.mjs`, which runs 12 red mutations and 1
  negative control. The red mutations cover both directions and the fail-closed paths.
- **The differential scan is not a proof of the invariant.** It only sees constructs that already
  occur in this tree. The PR's review found two latent erasures that no current source
  exercised:
  - `ts.isTypeNode` answers true for the runtime `void` operator's keyword;
  - TypeScript 4.7+ instantiation expressions used as values (`box<string>`) share a node kind
    with `implements` clauses.

  Both are fixed and pinned by fixtures and mutations. The lesson is that `ts.isTypeNode`
  identifies a node's *kind*, not its *position*. Any new erasure rule must check the type slot,
  not the kind alone.

## Action items

- [x] Classifier + gate wiring + honest floors (#1248).
- [ ] Sprint-close review: confirm the honest floor becomes the one the 95% milestone tracks.
- [ ] Re-rank the coverage batches by honest uncovered lines (posted on #1248).

## Amendment 1 (2026-09-23): attribute pure string-continuation lines (#1262)

- **Status:** Proposed. Same trigger-class handling as the ADR itself: it is flagged for the
  sprint-close design review (#1259) and does not block the merge. Revised in review round 2 of
  #1268, after the adversarial review broke the first version on real bun lcov. The break is
  described under rule 5.

### Context

The "residual noise is kept on purpose" consequence above turned out to be a merge artifact,
not a conservative constant. Re-verified against the per-process reports (`coverage-bun/*.info`)
for `deploy.ts`'s `describeFailedCRApply` and `cr-builder.ts`'s `validateCRImageRef`:

- A process that imports the module **without** running the branch emits `DA:<n>,0` for every
  line of it, including the 2nd+ physical lines of a `+`-joined string literal.
- A process that **does** run the branch emits a positive record for the statement's first
  line (`throw new Error(`, `return (`) and **no record** for some of the continuation lines.
- The merge sums hits, so those lines stay at 0 however many tests run the statement. More
  tests cannot fix them, which invites padding.

The classifier is right to keep these lines. They are expressions. What was wrong is the
0 the merge assigns them.

**What a bun line count actually means.** Bun's lcov comes from JavaScriptCore's basic-block
profiler. A line's count is the count of *entering the basic block* that covers it, not of
running the statement on it. Measured on bun 1.4.2: in `boom(); throw new Error('first ' +` /
`'second ' +` / `'third');`, where `boom()` always throws, the throw's line reads hit even though
the throw never runs. The same holds inside a bare nested `{ }` block. After an `if`, `for`,
`for…of`, `while`, `switch` or `try` (and in an `if`/`else` branch or a function body), the
next statement starts a fresh block. When that statement is not reached, its line reads 0.
Bun's raw data can itself be wrong the same way: in the case above it put a positive count on
the unrun `'second '` line. That affects the raw and honest numbers equally and is outside this
amendment, which only ever raises a 0.

### Decision

After the honest classification, and **for the honest number only**, a line whose merged count
is 0 takes the merged count of its statement's first line, if the line is **purely** a
string-literal continuation (`scripts/lib/continuation-attribution.mjs`). All five conditions
below are allowlists, so an unrecognised construct keeps the 0:

1. Every token starting on the line is a string literal (quoted, or a backtick literal with no
   substitution), a binary `+`, or a closer (`)` `,` `;`). At least one of them is a literal.
2. Each literal reaches its statement only through `+`, grouping parens, the arguments of a
   call or `new`, or a variable initializer. The statement must be a `return`, `throw`,
   expression statement or variable statement.
3. The statement is the first thing on its line, so that line's count belongs to it and not to
   an `if (x)` sharing the line.
4. Everything the statement evaluates before the literal is a literal, `+`, grouping parens,
   the keywords that open the statement, a declared name (`const msg =`), or an identifier used
   **only as a call or `new` callee** (`new Error(`). A call, a property access, an optional
   chain, a conditional, a short-circuit, an assignment, or an identifier that gets
   string-converted (`name + 'a'`, `${name}`) blocks attribution. A Symbol, or an object with a
   throwing `toString`/`valueOf`, throws during that conversion, so the literal after it may
   never run.
5. **The statement starts its own basic block.** It must be the first statement of a function
   body or of an `if`/`else` branch (braced or not), or every statement between it and the
   nearest preceding `if` / `for` / `for…of` / `while` / `switch` / `try` must be unable to
   throw. The only such statements allowed are a `const`/`let` whose initializers are literals,
   a function or type declaration, and an empty statement. Each accepted boundary was measured
   on bun 1.4.2. Anything unmeasured is refused: a bare `{ }` (measured *not* to start a block),
   a `case` clause, module top level, `for…in`, `do…while`, and a loop body.

It never adds a record, never lowers a count, and never touches a file it cannot read or parse.
The raw number is unchanged.

**Hard invariant:** a line that contains anything that could independently fail to run is never
marked covered. The same goes for a line whose statement might not run even though its first
line reads hit. When in doubt, the 0 stays.

### Options considered

| Option | Honest? | Hides code? | Verdict |
|---|---|---|---|
| **A. Allowlisted attribution from the statement's first line (rules 1-5)** | yes | no. A mixed line, a risky predecessor, or an anchor that may share a basic block with a throwing statement keeps its 0 | **chosen** |
| B. A separate "bun-unattributable" bucket, excluded from the denominator | partly | **yes.** It drops executable lines from the denominator outright, including ones whose statement never ran | rejected |
| C. Leave as is | yes | no | rejected: caps the honest % with lines no test can raise |
| D. Attribute every line of any statement whose first line is hit | no | **yes.** It credits ternary branches, `${call()}` lines, code after a short-circuit, and code after a throwing call in the same block | rejected |

For rule 4, keeping string-converted identifiers and documenting the risk was also considered.
It would attribute 41 lines instead of 11 (honest 93.33% / 93.34% instead of 93.03% / 93.01%).
Both options round down to the same 93.0 floor. Refusing them is the stricter reading of the
invariant.

jev (calibrated second opinion) scores:
- Overall option: A, confidence 0.68 (A 0.76, C 0.19, B 0.03, D 0.02).
- Rule 4 identifiers: refuse, confidence 0.68 (refuse 0.84, document 0.16).

### Consequences

- Measured on the full suite: 11 lines attributed across 3 files (`deploy.ts` 229-231 / 300 /
  304-306, `schema/preflight.ts` 345 / 355-356, `adapters/next-adapter.ts` 118).
  - Global honest: 92.92% → **93.03%** (9236/9928).
  - Core honest: 92.89% → **93.01%** (8356/8984).
  - The denominator is unchanged and nothing is excluded.
  - The honest floors move 92.5 → **93.0**. Raw floors are unchanged.
  - **Headroom is thin:** global clears 93.0 by 2 lines, core by 0 lines.
- The first version of this amendment attributed 60 lines. It violated the invariant (see
  rule 5) and also credited lines after `${identifier}` conversions. Those lines are
  `deploy.ts` 287-295, `cr-builder.ts` 453-454 / 480-482 / 579, and 41 more that followed a
  call or sat in a `case` clause. They deliberately stay uncovered.
- Guarded by `tests/coverage-continuation-attribution.test.ts`. What each part covers:
  - **Fixtures, rules 1-5:** the two-report-merge reproduction, the review's
    `boom(); throw new Error('first ' +` case verbatim, a bare nested block, a `case` clause, module
    top level, `${name}` and `name +` before the literal, a `${expr}` continuation, `foo() +`, a
    split ternary, a string passed to a function, `?.`, `||`/`??`/`&&`, `if (x) throw`, arrow
    bodies and `+=`.
  - **A real-bun ground-truth check.** Fixture shapes run in two real bun processes, one that
    only imports and one that runs. Each shape's outcome is fixed by construction, and the
    runner process asserts it. The check requires that a 0 is raised **only** when its chain
    really ran, and that the chains that did run in a sound shape **are** raised. This check is
    independent of the module, but it covers only the shapes in the fixture. It is not a
    repo-wide proof of rules 3 and 5.
  - **An end-to-end run of the gate** at the floor boundary, in both directions.
  - **A repo-wide re-check of rule 1 only.** TypeScript's scanner reads each attributed line's
    own text. It says nothing about rules 2-5.
- Also guarded by `scripts/mutation-prove-continuation-attribution.mjs`: 16 red mutations and 1
  negative control. Every fixture a mutation relies on fails exactly one rule, so each guard is
  observed on its own and not masked by another rule.
  - Over-attribution cases: a call-carrying line, the before-the-literal scan, the climb, the
    first-on-line check, a short-circuit, a record the reports never carried, parse errors, a
    `${…}` line, and a string-converted identifier.
  - A separate check on assignment `=` was **removed**, not left in as decoration. Every
    assignment target is an identifier or an access/pattern, and the string-converted-identifier
    rule and the allowlist already refuse both. No fixture could make that check go red on its
    own.
  - The first line hit on an unrelated path, in five forms: rule 5 disabled, a bare nested
    block accepted, every earlier statement treated as inert, an expression statement treated as
    a block boundary, and a `case` clause or module top level accepted.
  - Under-attribution cases: the lib no longer attributing, and the gate no longer wiring it in.
- **Residual trust points.** Rule 5's boundary list rests on measurements of bun 1.4.2. A bun or
  JSC upgrade that changes basic-block splitting could invalidate it. The real-bun
  ground-truth test re-measures on every run with whatever bun is installed, so such a change
  reds that test rather than passing silently.

### Action items

- [x] Attribution module, gate wiring, tests, prover, honest floors re-measured to 93.0 (#1262,
  #1268).
- [ ] Sprint-close design review (#1259): accept or reject this amendment, and decide whether
  the 0-line core headroom needs a batch of real coverage before the next floor raise.
- [ ] Re-run the real-bun ground-truth test on every bun upgrade (it runs in CI with the pinned
  bun). If a boundary stops holding, remove it from `BLOCK_BOUNDARIES`. Do not relax the test.
- [ ] Separately from this amendment, investigate bun's raw over-count: a positive count on an
  unrun continuation line directly after the anchor. It inflates the raw and honest numbers
  alike, and this amendment neither causes nor fixes it.
