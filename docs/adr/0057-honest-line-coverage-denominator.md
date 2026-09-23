# ADR-0057: Gate an honest line % over executable lines, alongside the raw one

- **Status:** **Proposed (2026-09-23).** Trigger-class: it changes what a CI gate measures. Under
  the 2026-09-22 workflow amendment, the PR merges on code review, spec review and green CI, and
  this ADR goes to the sprint-close design review as a flagged item. The review does not block
  the merge.
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

- **Status:** Proposed, same trigger-class handling as the ADR itself (flagged for the
  sprint-close design review, not a merge blocker).

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

### Decision

After the honest classification, and **for the honest number only**, a line whose merged count
is 0 takes the merged count of its statement's first line, if the line is **purely** a
string-literal continuation (`scripts/lib/continuation-attribution.mjs`). All four conditions
below are allowlists, so an unrecognised construct keeps the 0:

1. Every token starting on the line is a string literal (quoted, or a backtick literal with no
   substitution), a binary `+`, or a closer (`)` `,` `;`). At least one of them is a literal.
2. Each literal reaches its statement only through `+`, grouping parens, the arguments of a
   call or `new`, or a variable initializer. The statement must be a `return`, `throw`,
   expression statement or variable statement.
3. The statement is the first thing on its line, so that line's count belongs to it and not to
   an `if (x)` sharing the line.
4. Everything the statement evaluates before the literal is a literal, an identifier, a
   template substitution of those, `+`, grouping parens, or the keywords that open the
   statement. A call, a property access, an optional chain, a conditional, a short-circuit or
   an assignment before the literal could skip it while the first line still reads as hit, so
   any of them blocks attribution.

It never adds a record, never lowers a count, and never touches a file it cannot read or parse.
The raw number is unchanged.

**Hard invariant:** a line that contains anything that could independently fail to run is never
marked covered. When in doubt, the 0 stays.

### Options considered

| Option | Honest? | Hides code? | Verdict |
|---|---|---|---|
| **A. Allowlisted attribution from the statement's first line** | yes | no. A mixed line or a risky predecessor keeps its 0 | **chosen** |
| B. A separate "bun-unattributable" bucket, excluded from the denominator | partly | **yes.** It drops executable lines from the denominator outright, including ones whose statement never ran | rejected |
| C. Leave as is | yes | no | rejected: caps the honest % with lines no test can raise |
| D. Attribute every line of any statement whose first line is hit | no | **yes.** It credits ternary branches, `${call()}` lines and code after a short-circuit | rejected |

jev (calibrated second opinion), on the evidence above, picked A with confidence 0.68 (A 0.76,
C 0.19, B 0.03, D 0.02).

### Consequences

- Measured on the full suite: 60 lines attributed across 15 files. Global honest
  92.92% → **93.52%** (9285/9928). Core honest 92.89% → **93.52%** (8402/8984). The denominator
  is unchanged and nothing is excluded. The honest floors move 92.5 → **93.5**. Raw floors are
  unchanged.
- A check against the per-process reports backs all 60. For each one, some single report has a
  positive count on the anchor line **and** a positive record on another line of the same
  statement. So no attribution rests on a stray count on the anchor line alone.
- Lines with a `${…}` substitution, like `cr-builder.ts:452/479/577`, keep their own record.
  So does a pure line that comes after a call in the same statement, like the `asset-upload.ts`
  lines after `[...RESERVED_STATIC_DIRS].sort().join(", ")`.
- Guarded by `tests/coverage-continuation-attribution.test.ts`. It holds the two-report-merge
  reproduction, the tricky fixtures (a `${expr}` continuation, `foo() +`, a split ternary, a
  string passed to a function, `?.`, `||`/`??`/`&&`, `if (x) throw`, arrow bodies, `+=`), an
  end-to-end run of the gate at the floor boundary in both directions, and a repo-wide scan.
  The scan checks every attributed line with an independent oracle: TypeScript's scanner over
  the line's own text.
- Also guarded by `scripts/mutation-prove-continuation-attribution.mjs`: 11 red mutations and 1
  negative control, in both directions. Over-attribution cases: a call-carrying line, the
  before-the-literal scan, the climb, the first-on-line check, a short-circuit, an assignment,
  a record the reports never carried, parse errors, and a `${…}` line. Under-attribution cases:
  the lib no longer attributing, and the gate no longer wiring it in.
- **Rule 4 is stricter than bun's semantics.** bun marks a whole statement's first line as hit
  even when a call inside it throws. Rule 4 refuses attribution in that case anyway. The cost is
  a few lines kept at 0, which is acceptable under the invariant.
