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

/** A non-zero `exit <n>` at the top level of a shell block, or null. */
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
type Fixture = Record<string, unknown>;

/** Raised for any construct the evaluator does not model. FAIL CLOSED. */
class UnsupportedCondition extends Error {}

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
      // `?.` short-circuits; a plain `.` on nullish would throw at runtime, and
      // a gate that throws is red — which is not what this audit is measuring.
      if (node.questionDotToken) return undefined;
      throw new UnsupportedCondition(`property access on a nullish base: ${node.getText()}`);
    }
    return (base as Fixture)[node.name.text];
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

/** One polarity case: the summary, whether the branch must fire, and why. */
interface PolarityCase {
  summary: Fixture;
  fires: boolean;
  why: string;
}

/** Every polarity case a condition fails, as problem fragments. */
function polarityProblems(cond: ts.Expression, cases: PolarityCase[]): string[] {
  const problems: string[] = [];
  for (const { summary, fires, why } of cases) {
    let actual: unknown;
    try {
      actual = evaluateCondition(cond, summary);
    } catch (err) {
      if (err instanceof UnsupportedCondition) {
        return [
          `uses a construct this audit does not model (${err.message}), so its POLARITY cannot be judged — teach \`evaluateCondition\` the construct or state here why the branch is still a tooth. Refusing beats guessing: an inverted condition looks identical to a correct one under a syntax check`,
        ];
      }
      throw err;
    }
    if (Boolean(actual) !== fires) {
      problems.push(
        fires
          ? `does NOT fire on ${JSON.stringify(summary)} (${why}) — the branch, its ::error:: lines and its exit are all still there, and none of them run`
          : `FIRES on ${JSON.stringify(summary)} (${why}) — the polarity is inverted: this gate fails a green shard and passes a red one`,
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
  if (nodeStart !== -1) {
    const tail = run.slice(nodeStart).replace(/'[\s\S]*'/, "'…'");
    if (/\|\|/.test(tail)) {
      exitReachesStep.push(
        "the `node -e` invocation is followed by `||` — its non-zero exit is swallowed exactly the way the shard run step's is (`|| true`), and all three teeth become decoration",
      );
    }
    // `||` is stripped first: it is reported above with its own message, and a
    // naive `|` search would report the SAME defect twice under two names.
    if (/\|/.test(tail.replace(/\|\|/g, ''))) {
      exitReachesStep.push(
        'the `node -e` invocation is piped — a pipeline reports the LAST command’s status, not the gate’s',
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

  // A shard with ONE real failure and a clean one must be told apart, and so
  // must a shard with one phantom not-run file. Three cases rather than one:
  // the second is what makes `||` → `&&` a finding, and the third is what makes
  // an inversion or a `> 999` threshold one.
  auditJsTooth('failed-or-not-run', ['failed'], (cond) =>
    polarityProblems(cond, [
      {
        summary: { failed: 1, notRun: 0, truncated: false },
        fires: true,
        why: 'one REAL test failure — run 28552585087 in miniature',
      },
      {
        summary: { failed: 0, notRun: 1, truncated: false },
        fires: true,
        why: 'one phantom not-run file (a jest infra abort, not a test result)',
      },
      {
        summary: { failed: 0, notRun: 0, truncated: false },
        fires: false,
        why: 'a genuinely clean shard',
      },
    ]),
  );

  auditJsTooth('truncated', ['truncated'], (cond) =>
    polarityProblems(cond, [
      {
        summary: { failed: 0, notRun: 0, truncated: true },
        fires: true,
        why: 'a shard killed mid-run: partial results',
      },
      {
        summary: { failed: 0, notRun: 0, truncated: false },
        fires: false,
        why: 'a complete result set',
      },
      {
        summary: { failed: 0, notRun: 0 },
        fires: false,
        why: 'a summary that carries no truncated flag at all — firing here makes the gate permanently red, which is the other way to make it meaningless',
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
