/**
 * The compat fail-on-red gate, audited PER BRANCH (#700).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `.github/workflows/test-e2e-deploy.yml`'s "Fail shard on red results
 * (revocation teeth)" step is the ONLY thing that turns a red compat RESULT
 * into a red compat JOB — the shard run step swallows run-tests.js's exit
 * (`|| true`) and `scripts/compat-run-ledger.mjs` deliberately has no
 * `failed > 0` floor. That one step carries THREE independent teeth:
 *
 *   1. the summary artifact is MISSING          — no results is not green;
 *   2. `failed > 0` or `notRun > 0`             — real test failures;
 *   3. the summary is TRUNCATED                 — a shard killed mid-run.
 *
 * The guard that protected them was a single regex over the whole step block:
 *
 *     expect(/exit 1|process\.exit\(1\)/.test(gate)).toBe(true)
 *
 * which is this repo's family (b) — a substring check where the needle
 * legitimately recurs, and here the recurrence IS the design. Deleting any ONE
 * tooth left the OR satisfied by the other two. Measured: removing
 * `process.exit(1)` from the `failed > 0` branch kept the entire `tests/` suite
 * green while the step kept its name, kept `if: always()`, still printed its
 * `::error::` lines, and exited 0 — so a night with real test failures concludes
 * SUCCESS and counts toward the 14-night v1.0 window in
 * `docs/compat/window-node-lane.md`.
 *
 * WHY STRUCTURAL, NOT TEXTUAL
 * ---------------------------
 * #697's spelling axis was a non-event precisely because it parses the workflow;
 * #698 took three blocking defects from text-matching. So the step is located
 * through the parsed YAML document, the shell prelude is walked as `if`/`fi`
 * blocks, and the embedded `node -e` program is parsed into a real AST with the
 * TypeScript compiler. Each tooth is then matched to the branch that OWNS it —
 * by the property its condition reads, not by where it sits in the file — and
 * judged on its own. Deleting one tooth reds exactly one assertion, and the
 * message names that branch.
 *
 * PRESENCE, VALUE **AND POLARITY**, per tooth. An `exit` that is present but
 * zero is not a tooth; a condition that is present but can never fire
 * (`failed > 999`) is not a tooth; and a condition that fires on the WRONG case
 * (`!( … )`, `||` swapped for `&&`, a dead conjunct) is worse than no tooth,
 * because the gate then fails green shards and passes red ones.
 *
 * The first version of this file checked only the first two, and it checked the
 * second SYNTACTICALLY — "does a `failed > 0` comparison appear anywhere in this
 * condition" — which four one-line edits walked straight past with all five
 * assertions green. Polarity is therefore decided by EVALUATING the parsed
 * condition against synthetic summaries: it must fire on the red case and stay
 * quiet on the green one. That is the difference between asking what a
 * condition CONTAINS and asking what it DOES, and only the second question has
 * an answer that a new spelling cannot dodge.
 */

import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { parse } from 'yaml';

/** The `deploy-tests` step that converts a red RESULT into a red JOB. */
export const FAIL_ON_RED_STEP = 'Fail shard on red results (revocation teeth)';

/** The job that step lives in. */
export const FAIL_ON_RED_JOB = 'deploy-tests';

/** The three teeth, in the order they fire in the step. */
export const TOOTH_IDS = ['missing-summary', 'failed-or-not-run', 'truncated'] as const;
export type ToothId = (typeof TOOTH_IDS)[number];

/** Human wording used in every problem message, so a red names its branch. */
const TOOTH_LABEL: Record<ToothId, string> = {
  // The shell test is written in two pieces so the literal never contains a
  // `${` … `}` pair — biome's noTemplateCurlyInString would otherwise flag a
  // plain string that merely QUOTES shell syntax.
  'missing-summary': `the MISSING-SUMMARY branch (\`[ ! -f "$\{SUMMARY}" ]\`)`,
  'failed-or-not-run': 'the `failed > 0 || notRun > 0` branch',
  truncated: 'the TRUNCATED-SUMMARY branch (`s.truncated === true`)',
};

/**
 * Stated on every "no exit" finding, because the finding is narrower than it
 * sounds and saying "the step exits 0" would be untrue for some shapes.
 *
 * `process.exitCode = 1` and a bare `throw` both DO fail the step; this audit
 * simply does not recognise them, and reports the branch rather than guessing.
 * That is fail-closed — a false red that a human resolves in one line — but the
 * message has to say which it is.
 */
const RECOGNISED_EXIT =
  'Only a literal `process.exit(<non-zero>)` counts here — `process.exitCode = 1` and `throw` do fail the step but are not recognised, so say so rather than relying on them.';

/**
 * What it COSTS when a given tooth is missing — the concrete night, not a
 * generic "the gate is weaker". One message per branch, because a shared
 * sentence would attribute run 28552585087 (eight real test failures, workflow
 * SUCCESS) to a branch that had nothing to do with it.
 */
const COST: Record<ToothId, string> = {
  'missing-summary':
    'A shard whose summarize step died reports nothing, and no results is NOT green',
  'failed-or-not-run':
    'Deleting exactly this call is what run 28552585087 looked like: eight REAL test failures, and the workflow concluded SUCCESS',
  truncated:
    'A shard killed mid-run (step timeout, runner eviction) reports 20 of 45 selected tests and reads as a clean sweep',
};

interface RawStep {
  name?: unknown;
  run?: unknown;
}
interface RawJob {
  steps?: unknown;
}
interface RawDoc {
  jobs?: Record<string, RawJob>;
}

export interface GateTeethAudit {
  /** Per-tooth findings. An empty array is a tooth with real teeth. */
  teeth: Record<ToothId, string[]>;
  /** Findings about the script's exit status reaching the step at all. */
  exitReachesStep: string[];
  /** Which teeth were actually LOCATED — non-vacuity evidence. */
  branchesFound: ToothId[];
  /** Shell `if` blocks walked, and JS `if` statements parsed. */
  shellIfBlocks: number;
  jsIfStatements: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Locating the step (structural: the parsed document, never a text slice)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The step's `run:` script, or a problem explaining why there is none.
 *
 * A text slice of the file would have to know where a step ends; the parsed
 * document already does, and it is immune to re-indentation and to the next
 * step being inserted above.
 */
export function failOnRedGateScript(workflowPath: string): { run: string | null; problem: string } {
  const doc = parse(readFileSync(workflowPath, 'utf8')) as RawDoc | null;
  const job = doc?.jobs?.[FAIL_ON_RED_JOB];
  if (!job) {
    return { run: null, problem: `job \`${FAIL_ON_RED_JOB}\` is not defined in ${workflowPath}` };
  }
  const steps = Array.isArray(job.steps) ? (job.steps as RawStep[]) : [];
  const step = steps.find((s) => s?.name === FAIL_ON_RED_STEP);
  if (!step) {
    return {
      run: null,
      problem: `job \`${FAIL_ON_RED_JOB}\` has no \`${FAIL_ON_RED_STEP}\` step — the shard run step swallows its own exit (\`|| true\`), so without it NOTHING fails the job on a red result`,
    };
  }
  if (typeof step.run !== 'string' || step.run.trim() === '') {
    return {
      run: null,
      problem: `the \`${FAIL_ON_RED_STEP}\` step carries no \`run:\` script — a step that runs nothing cannot fail anything`,
    };
  }
  return { run: step.run, problem: '' };
}

// ─────────────────────────────────────────────────────────────────────────────
// The shell half — `if … ; then … fi` blocks, walked with nesting
// ─────────────────────────────────────────────────────────────────────────────

interface ShellIfBlock {
  condition: string;
  body: string;
}

/**
 * Every `if` block in a POSIX-ish shell script, with the body of its THEN arm.
 *
 * Nesting-aware, so an inner `fi` cannot close an outer block — the alternative
 * (regex to the first `fi`) is exactly the substring trap this file exists to
 * replace. `body` stops at a top-level `else`/`elif` for the same reason: an
 * `exit 1` in the ELSE arm fires on the opposite condition, and counting it
 * would let "the summary is present" be the thing that fails the job.
 *
 * Honest scope: this is a line walker, not a shell parser. It is enough for the
 * gate's four-line prelude, and it is applied only to that prelude — never to
 * the embedded JavaScript, which gets a real AST.
 */
export function shellIfBlocks(script: string): ShellIfBlock[] {
  const lines = script.split('\n');
  const blocks: ShellIfBlock[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (!/^\s*if\b/.test(line)) continue;
    const condition = line
      .replace(/^\s*if\b/, '')
      .replace(/;\s*then\s*$/, '')
      .trim();
    const body: string[] = [];
    let depth = 1;
    let inThenArm = true;
    let j = i + 1;
    for (; j < lines.length && depth > 0; j += 1) {
      const inner = lines[j] as string;
      if (/^\s*if\b/.test(inner)) depth += 1;
      if (/^\s*fi\b\s*$/.test(inner)) {
        depth -= 1;
        if (depth === 0) break;
      }
      if (depth === 1 && /^\s*(else|elif)\b/.test(inner)) inThenArm = false;
      if (inThenArm) body.push(inner);
    }
    blocks.push({ condition, body: body.join('\n') });
    i = j;
  }
  return blocks;
}

/**
 * A non-zero `exit <n>` somewhere in a shell block's THEN arm.
 *
 * HONEST SCOPE, and the SAME limit the JS half carries (see
 * `directFailingExit`): this is not reachability analysis. An `exit 1` nested
 * inside `if false; then … fi` within the branch still counts. Stated on BOTH
 * halves rather than one, because a limit documented on only one of two
 * symmetric checks reads as a claim that the other does not have it.
 *
 * Both are adversarial camouflage rather than a plausible disarm — nobody
 * weakens a gate by wrapping its exit in a false conditional — so the cost of
 * modelling them is not paid. What IS checked properly on both halves is the
 * polarity of the branch that owns the tooth.
 */
function shellFailingExit(body: string): { found: boolean; zero: boolean } {
  let found = false;
  let zero = false;
  for (const m of body.matchAll(/^\s*exit\s+(\d+)\s*$/gm)) {
    found = true;
    if (Number(m[1]) === 0) zero = true;
    else return { found: true, zero: false };
  }
  return { found, zero };
}

// ─────────────────────────────────────────────────────────────────────────────
// The JS half — the embedded `node -e '…'` program, parsed into an AST
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The program passed to `node -e '…'`.
 *
 * A POSIX single-quoted word cannot contain a single quote, so the closing
 * delimiter is the very next `'` — that is exact, not a heuristic, and it is
 * what makes it safe to hand the remainder to a real parser.
 */
export function embeddedNodeProgram(script: string): string | null {
  const open = script.indexOf("node -e '");
  if (open === -1) return null;
  const start = open + "node -e '".length;
  const close = script.indexOf("'", start);
  if (close === -1) return null;
  return script.slice(start, close);
}

/** Every `IfStatement` in a parsed program, at any depth. */
function jsIfStatements(program: string): ts.IfStatement[] {
  const sf = ts.createSourceFile(
    'gate.js',
    program,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const found: ts.IfStatement[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isIfStatement(node)) found.push(node);
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return found;
}

/** Every identifier / property name referenced anywhere under `node`. */
function namesIn(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const walk = (n: ts.Node) => {
    if (ts.isIdentifier(n)) names.add(n.text);
    ts.forEachChild(n, walk);
  };
  walk(node);
  return names;
}

// ─────────────────────────────────────────────────────────────────────────────
// POLARITY — does the branch FIRE on the case it is supposed to fire on?
//
// This replaces a sub-tree existence search that asked "does a `failed > 0`
// comparison appear anywhere in this condition". It never asked whether the
// branch fires, and four one-line edits walked straight past it with all five
// assertions green — measured on the real workflow:
//
//   `if (!( … ))`                          the gate fails a GREEN shard and
//                                          passes a RED one — the exact
//                                          inversion of the tooth this file
//                                          exists for;
//   `||` → `&&`                            one character, and it reproduces run
//                                          28552585087 verbatim (8 real
//                                          failures, notRun=0 → exit 0);
//   `s.neverSet === "zzz" && ( … )`        a dead conjunct;
//   `if (!(s.truncated === true))`         the same, on tooth 3.
//
// So the condition is EVALUATED against synthetic summaries instead: it must be
// true on the red case and false on the green one. Semantic rather than
// syntactic, which is what keeps the next spelling out — none of the four above
// needed a new rule, they all fall out of the same two evaluations.
// ─────────────────────────────────────────────────────────────────────────────

/** A synthetic shard summary — the `s` a gate condition reads. */
export type Fixture = Record<string, unknown>;

/** Raised for any construct the evaluator does not model. FAIL CLOSED. */
class UnsupportedCondition extends Error {}

/**
 * Raised when the condition would THROW on a real summary of this shape.
 *
 * Kept separate from `UnsupportedCondition` because the two say different
 * things. "I cannot model this" asks a human to teach the evaluator; "this
 * throws on a green shard" is a live defect — an uncaught throw inside
 * `node -e` exits non-zero, so the gate goes red on every shard of that shape.
 */
class ConditionThrows extends Error {}

/**
 * Evaluate a gate condition against a synthetic summary.
 *
 * A deliberately SMALL expression language — property access on `s`, literals,
 * `!`, the comparison operators, `&&`/`||`/`??`, and a ternary. Anything else
 * (a call, an element access, a bare identifier that is not `s`) raises, and
 * the caller turns that into a finding.
 *
 * Refusing is the point. A gate rewritten as `Number(s.failed) > 0` is probably
 * fine, but this audit cannot SAY so, and the alternative to refusing is
 * `new Function(...)` on text pulled out of a workflow file — evaluating
 * arbitrary code from a file whose whole purpose here is to be adversarially
 * mutated. A finding that says "teach me this construct" is the cheap outcome;
 * a silent pass is the expensive one.
 */
function evaluateCondition(node: ts.Node, s: Fixture): unknown {
  if (ts.isParenthesizedExpression(node)) return evaluateCondition(node.expression, s);

  if (ts.isPrefixUnaryExpression(node)) {
    const operand = evaluateCondition(node.operand, s);
    if (node.operator === ts.SyntaxKind.ExclamationToken) return !operand;
    if (node.operator === ts.SyntaxKind.MinusToken) return -Number(operand);
    throw new UnsupportedCondition(`unary operator ${ts.SyntaxKind[node.operator]}`);
  }

  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    // Short-circuiting operators evaluate the right side lazily, exactly as the
    // real gate would — otherwise a `&&` guard could not protect its right arm.
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      const left = evaluateCondition(node.left, s);
      return left ? evaluateCondition(node.right, s) : left;
    }
    if (kind === ts.SyntaxKind.BarBarToken) {
      const left = evaluateCondition(node.left, s);
      return left ? left : evaluateCondition(node.right, s);
    }
    if (kind === ts.SyntaxKind.QuestionQuestionToken) {
      const left = evaluateCondition(node.left, s);
      return left === null || left === undefined ? evaluateCondition(node.right, s) : left;
    }
    const l = evaluateCondition(node.left, s);
    const r = evaluateCondition(node.right, s);
    switch (kind) {
      case ts.SyntaxKind.GreaterThanToken:
        return (l as number) > (r as number);
      case ts.SyntaxKind.GreaterThanEqualsToken:
        return (l as number) >= (r as number);
      case ts.SyntaxKind.LessThanToken:
        return (l as number) < (r as number);
      case ts.SyntaxKind.LessThanEqualsToken:
        return (l as number) <= (r as number);
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
        return l === r;
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        return l !== r;
      // `==` / `!=` are deliberately NOT modelled. Faithfully evaluating them
      // would mean writing loose equality here, which this repo's lint bans
      // outright — and the alternative, approximating them with `===`, would
      // make this evaluator disagree with the gate it is judging. Refusing is
      // the honest third option: a gate rewritten with `==` gets a finding that
      // says so, and a human decides.
      default:
        throw new UnsupportedCondition(`binary operator ${ts.SyntaxKind[kind]}`);
    }
  }

  if (ts.isConditionalExpression(node)) {
    return evaluateCondition(node.condition, s)
      ? evaluateCondition(node.whenTrue, s)
      : evaluateCondition(node.whenFalse, s);
  }

  if (ts.isPropertyAccessExpression(node)) {
    const base = evaluateCondition(node.expression, s);
    if (base === null || base === undefined) {
      if (node.questionDotToken) return undefined;
      // NOT an unmodelled construct — a condition that would genuinely THROW on
      // this summary. Reported as its own class because the consequence is
      // different and specific: an uncaught throw inside `node -e` exits
      // non-zero on EVERY shard with that shape, which is a permanently-red
      // gate, not a missing tooth. `s.notRunFiles.length` on a green shard is
      // exactly this, and the emitter omits that key on every green shard.
      throw new ConditionThrows(`\`${node.getText()}\` — the base is absent from this summary`);
    }
    return (base as Fixture)[node.name.text];
  }

  // `s.notRunFiles[0]` throws on a green shard exactly as `s.notRunFiles.length`
  // does. Modelled for the same reason, and reported as the same class — the
  // distinction the class name draws is about the CONSEQUENCE, so it has to
  // cover every access form that produces it, not the one form first written.
  if (ts.isElementAccessExpression(node)) {
    const base = evaluateCondition(node.expression, s);
    if (base === null || base === undefined) {
      if (node.questionDotToken) return undefined;
      throw new ConditionThrows(`\`${node.getText()}\` — the base is absent from this summary`);
    }
    const key = evaluateCondition(node.argumentExpression, s);
    return (base as Record<string, unknown>)[String(key)];
  }

  // A CALL is not modelled — but `s.failures.some(…)` throws on a green shard
  // before the call is ever reached, and reporting that as "teach me this
  // construct" would send a reader to the wrong place. So the CALLEE is
  // evaluated first: if resolving it throws, that is the real finding.
  if (ts.isCallExpression(node)) {
    evaluateCondition(node.expression, s);
    throw new UnsupportedCondition(`call expression: ${node.getText()}`);
  }

  if (ts.isIdentifier(node)) {
    if (node.text === 's') return s;
    if (node.text === 'undefined') return undefined;
    throw new UnsupportedCondition(`identifier \`${node.text}\` (only \`s\` is modelled)`);
  }

  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;

  throw new UnsupportedCondition(`${ts.SyntaxKind[node.kind]}: ${node.getText()}`);
}

/**
 * The per-run METADATA a shard summary carries alongside its counts.
 *
 * Split out because it is the half a gate verdict must be INDEPENDENT of, and
 * pinning it to one value is what let an entire disarm class hide: the probes
 * varied only `failed`/`notRun`/`truncated`/`passed`, so a dead conjunct keyed
 * on the CONSTANT — `s.ref === "v16.2.1" && …` rather than
 * `s.neverSet === "zzz" && …` — evaluated true in every probe and survived. The
 * mirror image of the spelling that was already proved.
 */
export interface ShardMeta {
  shard: string;
  ref: string;
  runtime: string;
  excluded: number;
  expectedTotal: number;
  runtimeVersion?: string;
}

/**
 * The node nightly: 16 shards of the pinned ref, `runtimeVersion` ABSENT.
 * `e2e-summary.mjs` omits that key on the node lane deliberately, to keep the
 * artifact byte-stable for the matrix publisher.
 */
const NODE_LANE: ShardMeta = {
  shard: '3/16',
  ref: 'v16.2.1',
  runtime: 'node',
  excluded: 2,
  expectedTotal: 45,
};

/**
 * The Bun weekly: a different shard of a different ref on the other runtime,
 * with `runtimeVersion` PRESENT — and a different `expectedTotal`.
 *
 * Every field differs from the node lane on purpose; that is what makes the
 * invariance check below bite. Two of these are live disarms rather than
 * hypotheticals: `NEXTJS_REF` is bumped routinely (so `s.ref === "v16.2.1" &&`
 * kills the gate at the next bump, silently), and the SAME `deploy-tests` job
 * runs the Bun lane via `KNEXT_RUNTIME` (so `s.runtime === "node" &&` disarms an
 * entire lane in one line).
 *
 * `expectedTotal` is deliberately NOT 44-or-45. Today's matrix gives ~45 per
 * shard, and probing only values near it is exactly how `< 46` survived. A
 * plausible different matrix (half the shards, twice the tests each) is the
 * probe that makes a constant ceiling fall out of the invariance property
 * instead of needing its own enumerated rule.
 */
const BUN_LANE: ShardMeta = {
  shard: '11/8',
  ref: 'v16.3.0-canary.7',
  runtime: 'bun',
  excluded: 0,
  expectedTotal: 90,
  runtimeVersion: '1.3.14',
};

/**
 * The metadata assignments EVERY polarity verdict must be identical across.
 *
 * This is the property, stated once, rather than a row per field: "the branch's
 * verdict depends on the counts and nothing else". Five metadata disarms and the
 * whole constant-ceiling family fall out of it without anyone enumerating them.
 */
export const METADATA_VARIANTS: readonly ShardMeta[] = [NODE_LANE, BUN_LANE];

/**
 * A REAL shard summary, field-for-field as `scripts/e2e-summary.mjs` emits it.
 *
 * WHY THE FULL SHAPE, AND NOT JUST THE THREE COUNTS THE GATE READS. A probe
 * carrying only `{failed, notRun, truncated}` is not a summary the pipeline can
 * ever produce, and a condition is only as well-judged as the data it is judged
 * on. Measured against the three-field version of these fixtures, all four of
 * these disarms passed with every assertion green:
 *
 *   if (s.shard === undefined && ( … ))   never fires — `shard` was absent from
 *   if (s.ref === undefined && … )        the probe, so the guard read `true`;
 *   if ( … || s.passed > 0)               fires always — `passed` was absent, so
 *   if (s.truncated === true || s.passed > 0)   the added disjunct read
 *                                         `undefined > 0`, i.e. false.
 *
 * The first pair is the exact inverse of the dead-conjunct row the proof DOES
 * carry (`s.neverSet === "zzz" && …`, correctly caught), and the inverse is the
 * one that worked — because the gap was in the fixture, not in the workflow.
 * The second pair is the "permanently red is the other way to make it
 * meaningless" class this file guards on tooth 3, reached through a field the
 * fixture did not have.
 *
 * It also closes the `==`/`!=` refusal's one hole: an unmodelled operator hidden
 * behind `s.shard ? … : …` was never evaluated, because no fixture gave `shard`
 * a value. A realistic summary reaches both arms.
 *
 * Counts stay INTERNALLY CONSISTENT — `passed + failed + notRun === expectedTotal`, and the
 * `failures` / `notRunFiles` arrays are as LONG as the counts they attribute, because
 * `e2e-summary.mjs` derives both from the same set. An impossible summary is its
 * own under-specified oracle.
 *
 * OMISSION IS PART OF THE SHAPE. `failures` and `notRunFiles` are spread
 * conditionally by the emitter (`e2e-summary.mjs:267-270`) and are ABSENT, not
 * empty, on a green shard — the gate itself proves it by reading them as
 * `s.failures ?? []`. An earlier version of this builder emitted `[]` instead,
 * and that made the oracle disagree with reality in the OTHER direction:
 * `if (s.truncated === true || s.notRunFiles.length > 0)` stayed GREEN here while
 * on a real green artifact it throws `TypeError: Cannot read properties of
 * undefined` — a non-zero exit on EVERY green shard, i.e. the permanently-red
 * gate this file claims to guard against. With the keys faithfully omitted, the
 * evaluator's own nullish-base refusal catches it.
 */
export function shardSummary(overrides: Fixture = {}, meta: ShardMeta = NODE_LANE): Fixture {
  const failed = Number(overrides.failed ?? 0);
  const notRun = Number(overrides.notRun ?? 0);
  const expectedTotal = meta.expectedTotal;
  return {
    shard: meta.shard,
    ref: meta.ref,
    runtime: meta.runtime,
    ...(meta.runtimeVersion === undefined ? {} : { runtimeVersion: meta.runtimeVersion }),
    passed: expectedTotal - failed - notRun,
    failed,
    notRun,
    excluded: meta.excluded,
    expectedTotal,
    truncated: false,
    // Both keys OMITTED when empty, exactly as e2e-summary.mjs writes them, and
    // one entry per counted file so the attribution matches the count.
    ...(failed > 0
      ? {
          failures: Array.from({ length: failed }, (_, i) => ({
            file: `test/e2e/app-dir/red-${i}.test.ts`,
            kind: 'assertion',
            cases: ['renders'],
          })),
        }
      : {}),
    ...(notRun > 0
      ? {
          notRunFiles: Array.from(
            { length: notRun },
            (_, i) => `test/e2e/app-dir/aborted-${i}.test.ts`,
          ),
        }
      : {}),
    ...overrides,
  };
}

/**
 * A summary from a shard whose runner log carried no `total: N` header.
 *
 * `expectedTotal` and `truncated` are emitted as a PAIR or not at all
 * (`e2e-summary.mjs` spreads them from one conditional), so the absent-flag
 * case has to drop both — dropping only `truncated` would be a shape the
 * pipeline never produces.
 */
export function untruncatableSummary(meta: ShardMeta = NODE_LANE): Fixture {
  const { expectedTotal: _e, truncated: _t, ...rest } = shardSummary({}, meta);
  return rest;
}

/**
 * A summary rendered for a FAILURE MESSAGE — compact, and honest about the
 * arrays.
 *
 * `JSON.stringify` was the first version and it buried the finding: the
 * all-45-failures probe serialises 45 attribution records, so the sentence
 * naming the disarmed branch scrolled off the top of a 6 KB blob. A red a human
 * cannot read is barely better than no red. Arrays collapse to their length,
 * and an ABSENT key is printed as `absent` rather than omitted — the absence is
 * frequently the whole point of the case.
 *
 * NOTHING IS FILTERED OUT. An earlier version hid `shard`/`ref`/`runtime`/
 * `excluded` for brevity, which was survivable only while those fields were
 * constants. They vary now — they are the subject of the invariance check — so
 * hiding them would print two "different" summaries that look identical and
 * make every metadata red undiagnosable. That is the same unreadable-message
 * defect in a new costume.
 */
function describeSummary(s: Fixture): string {
  const parts = Object.entries(s).map(
    ([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.length} entries]` : JSON.stringify(v)}`,
  );
  for (const k of ['runtimeVersion', 'expectedTotal', 'truncated', 'failures', 'notRunFiles']) {
    if (!(k in s)) parts.push(`${k}: absent`);
  }
  return `{ ${parts.join(', ')} }`;
}

/**
 * One polarity case.
 *
 * `summary` is a BUILDER, not a value, because every case is evaluated once per
 * metadata variant and some of them are defined relative to the metadata — "the
 * shard where every selected test failed" is `failed: meta.expectedTotal`, not
 * `failed: 45`. Baking today's 45 in is what made a `< 46` ceiling invisible.
 */
interface PolarityCase {
  summary: (meta: ShardMeta) => Fixture;
  fires: boolean;
  why: string;
}

/**
 * Every polarity case a condition fails, as problem fragments.
 *
 * TWO properties per case, and the second is the round-5 addition:
 *
 *   1. the branch fires exactly when the COUNTS say the shard is red, and
 *   2. its verdict is IDENTICAL across metadata variants — the shard id, the
 *      Next.js ref, the runtime lane, the excluded count and the expected total
 *      must not change whether a shard goes red.
 *
 * Property 2 is what closes the dead-conjunct class keyed on a real value
 * (`s.ref === "v16.2.1" && …`) rather than on `undefined`, and it closes it as a
 * PROPERTY rather than as one row per field. It also takes the constant-ceiling
 * family with it: a `< 46` bound fires on a 45-test shard and not on a 90-test
 * one, so it breaks invariance even though both probes are "all tests failed".
 */
function polarityProblems(cond: ts.Expression, cases: PolarityCase[]): string[] {
  const problems: string[] = [];
  for (const { summary: build, fires, why } of cases) {
    /** The verdict under each metadata variant, or a fatal finding. */
    const verdicts: Array<{ meta: ShardMeta; summary: Fixture; value: boolean }> = [];

    for (const meta of METADATA_VARIANTS) {
      const summary = build(meta);
      let actual: unknown;
      try {
        actual = evaluateCondition(cond, summary);
      } catch (err) {
        if (err instanceof ConditionThrows) {
          return [
            `would THROW on ${describeSummary(summary)} (${why}): ${err.message}. An uncaught throw inside \`node -e\` exits NON-ZERO, so this gate goes red on every shard of that shape — permanently red is the other way to make a gate meaningless. \`e2e-summary.mjs\` omits \`failures\` and \`notRunFiles\` entirely on a green shard, which is why the gate reads them as \`?? []\``,
          ];
        }
        if (err instanceof UnsupportedCondition) {
          return [
            `uses a construct this audit does not model (${err.message}), so its POLARITY cannot be judged — teach \`evaluateCondition\` the construct or state here why the branch is still a tooth. Refusing beats guessing: an inverted condition looks identical to a correct one under a syntax check`,
          ];
        }
        throw err;
      }
      verdicts.push({ meta, summary, value: Boolean(actual) });
    }

    // Property 2 FIRST: "the verdict moved with the metadata" is a sharper and
    // more actionable finding than "it did not fire on variant B", and reporting
    // the weaker one would send a reader looking at the counts.
    const first = verdicts[0] as (typeof verdicts)[number];
    const divergent = verdicts.find((v) => v.value !== first.value);
    if (divergent) {
      const differing = (Object.keys(first.meta) as Array<keyof ShardMeta>)
        .filter((k) => first.meta[k] !== divergent.meta[k])
        .map((k) => `\`${k}\``)
        .join(', ');
      problems.push(
        `has a verdict that DEPENDS ON METADATA (${why}): it ${first.value ? 'fires' : 'does not fire'} on ${describeSummary(first.summary)} but ${divergent.value ? 'fires' : 'does not fire'} on ${describeSummary(divergent.summary)} — same counts, different ${differing}. Only the counts may decide whether a shard is red: \`NEXTJS_REF\` is bumped routinely, the same \`deploy-tests\` job runs the Bun weekly lane, and \`expectedTotal\` differs per shard, so a condition keyed on any of them fails OPEN on an ordinary change`,
      );
      continue;
    }

    if (first.value !== fires) {
      problems.push(
        fires
          ? `does NOT fire on ${describeSummary(first.summary)} (${why}) — the branch, its ::error:: lines and its exit are all still there, and none of them run`
          : `FIRES on ${describeSummary(first.summary)} (${why}) — the polarity is inverted: this gate fails a green shard and passes a red one`,
      );
    }
  }
  return problems;
}

/**
 * A `process.exit(<non-zero>)` under `node` that is not inside a nested
 * function.
 *
 * The function-boundary rule earns its keep: `if (…) { const f = () => process.exit(1); }`
 * declares an exit that never runs, and a plain sub-tree search would call that
 * a tooth.
 *
 * HONEST SCOPE — this is NOT reachability analysis. `if (0) { process.exit(1) }`
 * inside the branch still counts, as does an exit under a nested `if` that can
 * never be true. Those are adversarial camouflage rather than a plausible
 * disarm (nobody weakens a gate by wrapping its exit in `if (0)`), so the cost
 * of modelling them is not paid here — but the limit is written down rather
 * than left for someone to discover. The POLARITY of the branch that OWNS the
 * tooth is checked properly, above; it is only nested dead code that is not.
 */
function directFailingExit(node: ts.Node): { found: boolean; zero: boolean } {
  /** Every `process.exit(…)` status found, `null` where it is absent. */
  const statuses: Array<number | null> = [];
  const walk = (n: ts.Node) => {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n)
    ) {
      return;
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === 'process' &&
      n.expression.name.text === 'exit'
    ) {
      const arg = n.arguments[0];
      statuses.push(arg !== undefined && ts.isNumericLiteral(arg) ? Number(arg.text) : null);
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  // `zero` only when EVERY exit found is a non-failing one: a branch that
  // exits 1 somewhere is a tooth even if it also exits 0 elsewhere.
  return { found: statuses.length > 0, zero: statuses.every((s) => s === null || s === 0) };
}

// ─────────────────────────────────────────────────────────────────────────────
// The audit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Judge each tooth on its OWN branch.
 *
 * Every problem string names the branch it belongs to, so a red says which of
 * the three was disarmed rather than "the gate must fail the job on red".
 */
export function auditFailOnRedGateTeeth(workflowPath: string): GateTeethAudit {
  const teeth: Record<ToothId, string[]> = {
    'missing-summary': [],
    'failed-or-not-run': [],
    truncated: [],
  };
  const branchesFound: ToothId[] = [];
  const exitReachesStep: string[] = [];

  const { run, problem } = failOnRedGateScript(workflowPath);
  if (run === null) {
    for (const id of TOOTH_IDS) teeth[id].push(`${TOOTH_LABEL[id]}: ${problem}`);
    exitReachesStep.push(problem);
    return { teeth, exitReachesStep, branchesFound, shellIfBlocks: 0, jsIfStatements: 0 };
  }

  // ── the script's exit status must actually reach the step ─────────────────
  // Three teeth that all `exit 1` are worth nothing if the command carrying
  // them is `|| true`'d, piped, or run with `set +e`. That is precisely how the
  // shard RUN step lost its exit, one step above this one.
  //
  // FIRST, before any early return. This block used to sit at the end, past the
  // `program === null` bail-out, so a gate whose program had been moved to
  // `node scripts/gate.mjs` AND had errexit turned off produced an EMPTY finding
  // list — the assertion titled "the exit status reaches the step" was green
  // while its own claim was false. Nothing that judges the SCRIPT may depend on
  // the embedded program being locatable.
  const nodeStart = run.indexOf("node -e '");
  // The swallow scan covers the WHOLE script, not the tail after `node -e '`.
  // Anchoring it there left the same vacuous shape one hole over: move the
  // program out of `node -e` AND append `|| true`, and there was no anchor to
  // slice from, so the finding list came back empty. Whether the program is
  // inline is irrelevant to whether the script swallows an exit.
  //
  // Shell single-quoted spans are blanked first so the embedded JS's own `||`
  // is not read as a shell operator.
  //
  // HONEST SCOPE — the parity check below is NECESSARY, not SUFFICIENT. An odd
  // count means the script is definitely not quoted the way this audit assumes,
  // and it refuses. An even count does NOT prove the pairing is right: an
  // apostrophe inside a double-quoted string, or after a `#`, is not a shell
  // quote, and two stray ones bracketing a `|| true` would blank it. Measured
  // and confirmed reachable only by contrivance — the live script has exactly
  // two apostrophes, both `node -e` delimiters — so this is a decay hazard
  // rather than a live hole. Tracked as #702 rather than papered over; a real
  // shell lexer is the complete fix.
  const quoteCount = (run.match(/'/g) ?? []).length;
  if (quoteCount % 2 !== 0) {
    exitReachesStep.push(
      "the gate script's single quotes do not pair, so a shell `||` cannot be told from one inside the embedded program — this audit refuses to guess rather than report a swallow it is not sure about",
    );
  } else {
    const shell = run.replace(/'[^']*'/g, "''");
    if (/\|\|/.test(shell)) {
      exitReachesStep.push(
        "the gate script contains a shell `||` — a non-zero exit is swallowed exactly the way the shard run step's is (`|| true`), and all three teeth become decoration",
      );
    }
    // `||` is stripped first: it is reported above with its own message, and a
    // naive `|` search would report the SAME defect twice under two names.
    if (/\|/.test(shell.replace(/\|\|/g, ''))) {
      exitReachesStep.push(
        'the gate script contains a pipeline — a pipeline reports the LAST command’s status, not the gate’s',
      );
    }
  }
  if (/set\s+\+e/.test(run)) {
    exitReachesStep.push(
      '`set +e` appears in the gate script — with errexit off, a failing command no longer aborts the step',
    );
  }
  if (!/set\s+-([a-z]*e|o\s+errexit)/.test(run)) {
    exitReachesStep.push(
      'the gate script never sets `-e` — a failing command mid-script would not abort it',
    );
  }

  // ── tooth 1: the shell branch on a missing summary ────────────────────────
  // Only the SHELL prelude is walked as shell. The embedded JS also contains
  // lines beginning `if (`, and feeding those to a shell walker would invent
  // blocks that never close — a parser pointed at the wrong language is how a
  // structural check quietly becomes as unreliable as the regex it replaced.
  const blocks = shellIfBlocks(nodeStart === -1 ? run : run.slice(0, nodeStart));
  const missing = blocks.filter((b) => /!\s+-f\b/.test(b.condition) && /SUMMARY/.test(b.condition));
  if (missing.length === 0) {
    teeth['missing-summary'].push(
      `${TOOTH_LABEL['missing-summary']} is GONE — no shell branch tests for the summary's absence. No results is NOT green: a shard whose summarize step died would sail through`,
    );
  } else if (missing.length > 1) {
    teeth['missing-summary'].push(
      `${TOOTH_LABEL['missing-summary']}: ${missing.length} branches test for a missing summary — this audit cannot say which one owns the verdict; collapse them into one`,
    );
  } else {
    branchesFound.push('missing-summary');
    const exit = shellFailingExit((missing[0] as ShellIfBlock).body);
    if (!exit.found) {
      teeth['missing-summary'].push(
        `${TOOTH_LABEL['missing-summary']} has NO \`exit\` of its own. Only a literal non-zero \`exit <n>\` counts here — say so if this branch fails the step some other way. ${COST['missing-summary']}`,
      );
    } else if (exit.zero) {
      teeth['missing-summary'].push(
        `${TOOTH_LABEL['missing-summary']} exits ZERO — an exit is present but it is not a tooth; the job stays green`,
      );
    }
  }

  // ── teeth 2 and 3: the branches inside the embedded node program ──────────
  const program = embeddedNodeProgram(run);
  if (program === null) {
    const why = `the step's \`node -e '…'\` program could not be located, so neither result branch can be audited`;
    teeth['failed-or-not-run'].push(`${TOOTH_LABEL['failed-or-not-run']}: ${why}`);
    teeth.truncated.push(`${TOOTH_LABEL.truncated}: ${why}`);
    return {
      teeth,
      exitReachesStep,
      branchesFound,
      shellIfBlocks: blocks.length,
      jsIfStatements: 0,
    };
  }

  const ifs = jsIfStatements(program);

  /** One JS tooth: locate its branch by the property it READS, then judge it. */
  const auditJsTooth = (
    id: Exclude<ToothId, 'missing-summary'>,
    reads: string[],
    polarityCheck: (cond: ts.Expression) => string[],
  ) => {
    const owners = ifs.filter((s) => reads.every((r) => namesIn(s.expression).has(r)));
    if (owners.length === 0) {
      teeth[id].push(
        `${TOOTH_LABEL[id]} is GONE — no branch in the gate reads ${reads.map((r) => `\`${r}\``).join(' and ')}. Nothing else fails the job on it`,
      );
      return;
    }
    if (owners.length > 1) {
      teeth[id].push(
        `${TOOTH_LABEL[id]}: ${owners.length} branches read ${reads.map((r) => `\`${r}\``).join(' and ')} — this audit cannot say which owns the verdict; collapse them into one`,
      );
      return;
    }
    const owner = owners[0] as ts.IfStatement;
    branchesFound.push(id);
    for (const p of polarityCheck(owner.expression)) teeth[id].push(`${TOOTH_LABEL[id]} ${p}`);
    const exit = directFailingExit(owner.thenStatement);
    if (!exit.found) {
      teeth[id].push(
        `${TOOTH_LABEL[id]} has NO \`process.exit(…)\` of its own. ${RECOGNISED_EXIT} ${COST[id]}`,
      );
    } else if (exit.zero) {
      teeth[id].push(
        `${TOOTH_LABEL[id]} calls \`process.exit\` with a ZERO (or absent) status — present, but not a tooth`,
      );
    }
  };

  // The counts go past 1, and the top-of-domain cases are expressed RELATIVE to
  // `expectedTotal` so they move with the metadata variant. A probe set of {0,1}
  // accepted `=== 1` and `&& s.failed < 2`; extending it to 8 only moved the
  // ceiling to `< 9`. Anchoring the top case to `meta.expectedTotal` is what
  // lets the invariance property in `polarityProblems` take the whole
  // constant-ceiling family, rather than this list growing a rung at a time.
  auditJsTooth('failed-or-not-run', ['failed'], (cond) =>
    polarityProblems(cond, [
      {
        summary: (m) => shardSummary({ failed: 1 }, m),
        fires: true,
        why: 'one REAL test failure',
      },
      {
        summary: (m) => shardSummary({ failed: 8 }, m),
        fires: true,
        why: "EIGHT real test failures — run 28552585087's actual shape",
      },
      {
        summary: (m) => shardSummary({ notRun: 1 }, m),
        fires: true,
        why: 'one phantom not-run file (a jest infra abort, not a test result)',
      },
      {
        summary: (m) => shardSummary({ notRun: 3 }, m),
        fires: true,
        why: 'three phantom not-run files',
      },
      {
        summary: (m) => shardSummary({ failed: m.expectedTotal }, m),
        fires: true,
        why: 'every one of the selected tests failed — the worst shard there is',
      },
      {
        summary: (m) => shardSummary({ notRun: m.expectedTotal }, m),
        fires: true,
        why: 'not one of the selected tests produced a result',
      },
      {
        summary: (m) => shardSummary({}, m),
        fires: false,
        why: 'a genuinely clean shard',
      },
    ]),
  );

  auditJsTooth('truncated', ['truncated'], (cond) =>
    polarityProblems(cond, [
      {
        summary: (m) => shardSummary({ truncated: true, passed: 20 }, m),
        fires: true,
        why: 'a shard killed mid-run: 20 of the selected tests reported',
      },
      {
        summary: (m) => shardSummary({}, m),
        fires: false,
        why: 'a complete result set',
      },
      {
        summary: (m) => untruncatableSummary(m),
        fires: false,
        why: 'a summary with no expectedTotal, so no truncated flag at all — firing here makes the gate permanently red, which is the other way to make it meaningless',
      },
    ]),
  );

  return {
    teeth,
    exitReachesStep,
    branchesFound,
    shellIfBlocks: blocks.length,
    jsIfStatements: ifs.length,
  };
}
