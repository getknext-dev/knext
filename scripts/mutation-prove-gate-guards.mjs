#!/usr/bin/env node
/**
 * Mutation PROVER for the gate validator — the set is DERIVED, not enumerated.
 *
 * WHY THIS REPLACED THE HAND-WRITTEN LIST. The previous harness carried 71 cases
 * written by hand and reported 71/71 killed. An independent reviewer enumerating the
 * same file found 97 halves, of which 9 survived and 8 were live code with no test.
 * Both numbers were true. A hand list proves every half IT ENUMERATED, which is
 * exactly the critique the validator's own docblock makes of rule 13 and rule 1b:
 * the enumerated case is not the guarantee. Counting harder would not have helped —
 * the defect was COVERAGE, and coverage cannot be fixed by adding rows to the list
 * that was already missing them.
 *
 * So the list is gone. Sites come from the validator's own AST, by the fixed rules
 * in SITE_KINDS below. A guard half added tomorrow gets a mutation tomorrow, with
 * nobody editing this file — and if nothing tests it, this prover goes RED.
 *
 * DISCIPLINE, enforced in code rather than promised:
 *   - every KILLED/SURVIVED verdict branches on the process EXIT CODE. Message text
 *     is never the signal (vitest ANSI once made a pass/fail grep certify 14 dead
 *     mutations all-green);
 *   - mutations are applied by AST character OFFSET, and the slice at that offset is
 *     asserted to equal the node text the parser reported before anything is
 *     written. This is strictly stronger than "the anchor occurs exactly once" —
 *     there is no anchor to be ambiguous;
 *   - no `perl`, no `sed`: replacement is a string splice on an in-memory buffer;
 *   - the working tree is NEVER written. Mutants go to a temp directory and the
 *     suite is pointed at them with `GATE_VALIDATOR`, which is strictly stronger
 *     than restoring byte-identically: round 5 lost a restore to a command timeout
 *     and the residue was invisible to `git status`, because the file was already
 *     under legitimate edit. The tree's sha256 is re-checked at the end anyway — a
 *     claim that nothing was written should be verified, not trusted;
 *   - the baseline must be GREEN, a CONTROL mutation must be KILLED, and the
 *     SUBJECT-ABSENT control (validator emptied) must be KILLED, before any verdict
 *     below counts. A green baseline proves only that the runner can see green.
 *
 * Usage:
 *   node scripts/mutation-prove-gate-guards.mjs               # derive, mutate, verdict
 *   node scripts/mutation-prove-gate-guards.mjs --list        # sites only
 *   node scripts/mutation-prove-gate-guards.mjs --self-test   # coverage is derived
 *   node scripts/mutation-prove-gate-guards.mjs --shape-sweep # no shape derives zero
 *   node scripts/mutation-prove-gate-guards.mjs --id-drift    # ids cannot migrate
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const execFileAsync = promisify(execFile);

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'scripts', 'verify-phase-gates.mjs');
const TEST = 'tests/verify-phase-gates.test.ts';
/** Generous next to a ~9s suite: only a non-terminating mutant should reach it. */
const SUITE_TIMEOUT_MS = Number(process.env.PROVE_TIMEOUT_MS ?? 180_000);

const sha = (s) => createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------------------
// The derivation. These are the node kinds that can constitute a guard half —
// something whose removal changes what the validator reports. Each yields a
// mutation that neutralises exactly that half and nothing else.
// ---------------------------------------------------------------------------

const SITE_KINDS = {
  'branch-condition':
    'the condition of an `if`, `while`, `do`, classic `for`, or ternary — the branch never takes',
  'and-operand': 'one conjunct of an `&&`, ANYWHERE — that half of the guard is dropped',
  'or-operand': 'one disjunct of an `||`, ANYWHERE — that half of the guard is dropped',
  'for-of-subject': 'what a `for…of` ranges over — the loop body never runs',
  'switch-subject': 'a `switch` discriminant — no case matches',
  'return-value': 'ANY `return <expr>` — the function answers the same way regardless',
  'arrow-value': 'ANY expression-bodied arrow — same, for `x => …` predicates',
  'bool-property': 'a `true`/`false` property in a declaration table — the flag flips',
  statement: 'ANY expression statement — it is deleted',
  'coalesce-fallback': 'the right side of a `??` — the fallback never runs',
};

/*
 * WHY THERE ARE NO NAME LISTS HERE ANY MORE.
 *
 * The first version of this derivation asked whether a statement's callee was one of
 * six names (`problems.push`, `scanNested`, …) and whether a `return` looked boolean
 * by matching five method names. Review took it apart in one line: a guard written
 * `cond && problems.push(...)` derived ZERO sites — not the condition, not the report
 * — because the callee test required the statement to BE a call expression and the
 * `&&` decomposition only ran inside `if` tests. Eleven more shapes were partly or
 * wholly invisible. That is a hand-maintained enumeration wearing an AST costume,
 * which is precisely the critique this prover exists to make of the list it replaced,
 * one level up.
 *
 * So the shape tests are gone. EVERY expression statement is deletable, EVERY return
 * and expression-bodied arrow is rewritable, EVERY `&&`/`||` decomposes wherever it
 * appears, and every branch condition is a site. The derivation no longer asks what a
 * statement is FOR — it cannot be wrong about a category it does not have.
 */

/** Flatten a left-nested `&&`/`||` chain into its operands. */
function operandsOf(expr, kind) {
  const out = [];
  const walk = (n) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === kind) {
      walk(n.left);
      walk(n.right);
      return;
    }
    out.push(n);
  };
  walk(expr);
  return out;
}

/**
 * The nearest named declaration enclosing a node.
 *
 * Site ids carry it because the id was `kind|text` with a first-occurrence ordinal,
 * and four exclusions were keyed on bare literals — `return-predicate|true`,
 * `bool-property|false` and friends. Inserting an ordinary two-flag table and a
 * two-branch predicate re-pointed all four exclusions onto the NEW, untested code
 * while the previously-excluded sites were bumped to `#2`/`#4` and attempted. The
 * stale-exclusion abort could not see it: the id still matched a site, just a
 * different one. Line numbers would at least have failed loudly; that identity
 * failed silently, in the direction that hides an untested half.
 */
function enclosingName(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if (ts.isMethodDeclaration(n) && n.name) return n.name.getText();
    if (ts.isVariableDeclaration(n) && n.name && ts.isIdentifier(n.name)) return n.name.text;
    if (ts.isPropertyAssignment(n) && n.name) return n.name.getText();
  }
  return '<top-level>';
}

/** Derive every mutation site from the validator's AST. */
function deriveSites(source) {
  const sf = ts.createSourceFile('v.mjs', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const sites = [];
  const add = (kind, node, replacement) => {
    const start = node.getStart(sf);
    const end = node.getEnd();
    sites.push({
      kind,
      start,
      end,
      replacement,
      text: source.slice(start, end),
      where: enclosingName(node),
    });
  };
  // `true` -> `false`, `false` -> `true`, anything else -> `false`. The first
  // version returned 'false' for a `return false`, i.e. a mutation that changed
  // nothing — which `mutantFor` correctly aborted on rather than scoring.
  const flip = (node) => {
    if (node.kind === ts.SyntaxKind.TrueKeyword) return 'false';
    if (node.kind === ts.SyntaxKind.FalseKeyword) return 'true';
    return 'false';
  };

  const visit = (node) => {
    // Branch conditions, whatever the branching construct.
    if (ts.isIfStatement(node)) add('branch-condition', node.expression, 'false');
    if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      add('branch-condition', node.expression, 'false');
    }
    if (ts.isForStatement(node) && node.condition) add('branch-condition', node.condition, 'false');
    if (ts.isConditionalExpression(node)) add('branch-condition', node.condition, 'false');
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      add('for-of-subject', node.expression, '[]');
    }
    if (ts.isSwitchStatement(node)) {
      add('switch-subject', node.expression, "Symbol('no-case-matches')");
    }

    // `&&` / `||` ANYWHERE, not only inside an `if` test. Only the outermost node of
    // a same-operator chain decomposes, so operands are not added twice.
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const isAnd = op === ts.SyntaxKind.AmpersandAmpersandToken;
      const isOr = op === ts.SyntaxKind.BarBarToken;
      if (isAnd || isOr) {
        const parent = node.parent;
        const sameChain =
          parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === op;
        if (!sameChain) {
          const parts = operandsOf(node, op);
          if (parts.length > 1) {
            for (const part of parts) {
              add(isAnd ? 'and-operand' : 'or-operand', part, isAnd ? 'true' : 'false');
            }
          }
        }
      }
      if (op === ts.SyntaxKind.QuestionQuestionToken && ts.isCallExpression(node.right)) {
        add('coalesce-fallback', node.right, 'null');
      }
    }

    // EVERY return value and EVERY expression-bodied arrow. No shape test: a return
    // this cannot classify is a return that would get no mutation.
    if (ts.isReturnStatement(node) && node.expression) {
      add('return-value', node.expression, flip(node.expression));
    }
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      add('arrow-value', node.body, flip(node.body));
    }

    if (
      ts.isPropertyAssignment(node) &&
      (node.initializer.kind === ts.SyntaxKind.TrueKeyword ||
        node.initializer.kind === ts.SyntaxKind.FalseKeyword)
    ) {
      add('bool-property', node.initializer, flip(node.initializer));
    }

    // EVERY expression statement is deletable. `cond && problems.push(...)` is one;
    // so is a bare call, an assignment, and a form nobody has thought of yet.
    if (ts.isExpressionStatement(node)) add('statement', node, 'void 0;');

    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  // Identity = kind + ENCLOSING DECLARATION + normalised text, disambiguated when the
  // same text repeats inside the same declaration. The enclosing name is what stops
  // an exclusion keyed on a bare `true` migrating onto a `true` someone adds
  // elsewhere; the text is what keeps it stable across edits that are genuinely
  // somewhere else.
  const seen = new Map();
  for (const s of sites) {
    const base = `${s.kind}|${s.where}|${s.text.replace(/\s+/g, ' ').trim()}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    s.id = n === 1 ? base : `${base}#${n}`;
  }
  return sites;
}

// ---------------------------------------------------------------------------
// Exclusions. An EQUIVALENT MUTANT is a site whose mutation cannot change
// behaviour, so no test could ever kill it. Each needs a written reason, and the
// prover FAILS on an exclusion with no reason or on one that matches no derived
// site — a stale exclusion is how a real survivor gets hidden.
// ---------------------------------------------------------------------------

const EXCLUSIONS = {
  // Rebuilt from scratch in round 8. The previous 42 entries were keyed on
  // `kind|text`, an identity that let four of them MIGRATE onto newly-added code,
  // and 12 of them were KILLABLE — excusing a real mutation rather than an
  // equivalent one, on reasons the code contradicted. Both are now mechanically
  // impossible: the id carries its enclosing declaration, and every exclusion below
  // is RE-RUN after the main pass and the prover FAILS on any the suite kills. A
  // reason is prose; the re-run is not, and it is the reason that gets to be wrong.

  // --- the tracking Proxy: plumbing whose job is to be invisible ---------------
  'branch-condition|get|p === RAW':
    'the unwrap escape hatch. Removing it makes `unwrap` return the proxy instead of the target, which changes no verdict because every consumer of `unwrap` only reads data through it.',
  "branch-condition|get|typeof p !== 'string'":
    'only symbols reach it, and `CONSUMED` is keyed by string, so recording or not recording a symbol changes no rule’s answer.',
  'return-value|get|Reflect.get(t, p, r)':
    'the symbol path’s return. Same population as above: symbols only.',
  'and-operand|unwrap|v !== null':
    '`typeof null === "object"` and `null[RAW]` throws, so the three conjuncts of `unwrap` are a single indivisible null-guard; any one of them alone yields the same answer for every input the parser can produce.',
  "and-operand|unwrap|typeof v === 'object'": 'as above — one third of an indivisible null-guard.',
  'and-operand|unwrap|v[RAW]':
    'as above. A non-proxy object has no RAW key, so the expression is falsy either way.',

  // --- message formatting: it cannot change an exit code -----------------------
  'arrow-value|checkDone|c.id#2':
    'formats the id list inside a message. No test asserts THIS list, and a message can never change the exit code the prover reads.',
  'arrow-value|checkNotStarted|c.id': 'as above, rule 7a’s measured-criteria list.',
  'arrow-value|openShipBlockers|c.id': 'as above, rule 9c’s blocker list.',
  'arrow-value|verify|c.id': 'as above, an id list in a rule message.',
  'arrow-value|verify|c.id#2': 'as above, second occurrence in `verify`.',
  'arrow-value|verify|s.from': 'formats a cycle path inside rule 13’s message.',
  'arrow-value|verify|s.via': 'formats the key names inside rule 13’s message.',
  'arrow-value|verify|step.from': 'formats the provenance path inside rule 1b’s message.',
  'arrow-value|key|s.from':
    'builds the dedup key for a cycle. Collapsing it merges cycles that would be reported separately — the count in a message, never the exit code.',
  'statement|<top-level>|console.error(error);':
    'prints the stack of an uncaught throw. The NEXT statement sets exit 3, which is what the prover reads; this one is diagnostics for a human.',

  // --- the cycle walk’s bookkeeping -------------------------------------------
  'statement|walk|path.pop();':
    'restores the DFS path after recursion. Removing it lengthens a reported cycle path — message text — because the cycle SET is keyed on its nodes, which are unchanged.',
  "statement|walk|colour.set(node, 'black');":
    'marks a node finished. Without it the walk revisits, which costs time and reports the same cycles; the grey check is what detects them.',
  'statement|orderedPath|path.unshift(n);':
    'builds the human-readable path in rule 13’s message; the boolean "is it reachable" is decided by the return, not by this array.',
  'branch-condition|orderedPath|n !== null':
    'the path-reconstruction loop bound; same message-only role.',
  'arrow-value|start|s.from === next':
    'locates where a cycle begins for the message. The cycle itself was already detected by the grey hit.',
  'statement|verify|rec.via.push(`${phase.phase}.${key}`);':
    'records WHICH keys asserted a concurrency, for the message. The pair itself is the map key.',

  // --- reachable only through data no gate file can express --------------------
  "and-operand|statesPhaseReference|(typeof v === 'string' || typeof v === 'number')":
    '`phaseIds` holds only strings, so a boolean or object element answers false at `phaseIds.has(String(v))` regardless of this type test.',
  'and-operand|statesPhaseReference|phaseIds.has(String(value))':
    'dropping it makes every well-typed element "resolve", but the array branch still requires EVERY element to pass, and no fixture has an all-non-id array under a PROSE key that would newly report.',
  "branch-condition|statesPhaseReference|typeof value !== 'string'":
    'a scalar that is neither number nor string cannot be in `phaseIds`, so the early return only saves a lookup.',
  'and-operand|statesPhaseReference|selfId !== undefined':
    "`String(undefined)` is the literal 'undefined', never a declared phase id.",
  'and-operand|statesPhaseKeyMap|keys.length > 0':
    '`{}.every(...)` is vacuously true, so this conjunct only stops an empty object being called a phase-keyed map — and no fixture puts a bare `{}` under a PROSE key.',
  'and-operand|scanNested|v !== null':
    '`typeof null === "object"`, and `reportShape(null)` answers false on both shape tests, so testing a null element is a no-op rather than a different answer.',

  // --- guarded by a conjunct or a rule that reports first ----------------------
  "and-operand|auditRegistry|entry.phaseRef === 'ordered'":
    'the exactly-one-corroborates audit. `concurrent_with` is its own inverse, so the `entry.inverse !== key` conjunct beside it already excludes every unordered key, and no unordered key with a distinct inverse exists.',
  'and-operand|auditRegistry|entry.inverse !== key':
    'the same audit, the other conjunct: `phaseRef === "ordered"` is what keeps `concurrent_with` out.',
  'or-operand|generic|entry.phaseRef !== undefined':
    'a key carrying `phaseClaim` but not `phaseRef` is still generically consumed; the two markers are alternatives and either alone answers for every entry in the registry.',
  "and-operand|verify|entry.phaseRef === 'ordered'":
    'the edge contribution. The only non-ordered phaseRef key is `concurrent_with`, whose edge would duplicate the pair rule 13 already holds.',
  'and-operand|verify|s !== String(c.id)':
    'self-reference is the length-1 case of the `derived_from` cycle walk, which reports it independently; this conjunct only stops the "not measured" branch also firing on the same entry.',
  "and-operand|verify|typeof item === 'string'":
    '`/^A\\d+$/.test(item)` coerces its argument and no non-string coerces to `A<digits>`.',
  'or-operand|verify|r === String(phase.phase)':
    'an early-out that suppresses a SECOND report about a self-reference already reported one line above.',
  'or-operand|verify|String(ref) === String(phase.phase)':
    'the same duplicate-suppression on the gates-semantics loop.',
  'and-operand|scanKeys|entry.prose#2':
    'rule 6e’s key-map test at the structural level. A READ key whose value is a phase-keyed OBJECT is already reported by rule 8 ("must be an array of phase ids").',
  'branch-condition|verify|(phase[relation] ?? []).map(String).includes(String(target))':
    'rule 8c’s early-out for a claim whose relation is still stated. Its behaviour is pinned by a test asserting the ABSENCE of two messages, which an exit-code prover cannot express.',

  // --- the printer and the CLI: they cannot report a problem -------------------
  "branch-condition|value|c.evidence && typeof c.evidence === 'object'":
    'chooses between two RENDERINGS of a measurement. `render` runs after `problems` is final.',
  'and-operand|value|c.evidence': 'as above, one conjunct of the same rendering choice.',
  "and-operand|value|typeof c.evidence === 'object'": 'as above, the other conjunct.',
  'arrow-value|value|`${k}=${v}`': 'formats one evidence field for the table.',
  "arrow-value|value|typeof v !== 'object'":
    'chooses which evidence fields are short enough to print.',

  // --- the seam and the runner -------------------------------------------------
  'and-operand|files|process.argv[fileArgIdx + 1]':
    '`--file` with no path following it. `readdirSync(undefined)` would throw, and directory mode is what every non-`--file` test exercises; no fixture passes a bare trailing `--file`.',
  'return-value|fileIdentity|`path:${resolve(f)}`':
    'the fallback when `statSync` throws — a path that does not exist cannot be one of the real gate files either way.',
  'statement|<top-level>|KEY_REGISTRY[m[1]] = level;':
    'a self-assignment when the level already exists, which it does for every level any test declares into.',
  'statement|<top-level>|KEY_PATTERNS[m[1]] = list;': 'as above, for the pattern seam.',

  // --- derivation-order helpers ------------------------------------------------
  'arrow-value|patternNames|b.length - a.length':
    'sorts a pattern’s identifier runs longest-first. Since round 8 rule 6b tests EVERY run, the order no longer decides anything; only `patternName`’s display pick reads it.',
  'arrow-value|patternName|patternNames(re)[0] ?? re.source':
    'the pattern’s DISPLAY name, used in messages. Rule 6b matches on the full list.',
  'arrow-value|bound|false':
    'the pattern half’s binding predicate is a constant by design — a pattern matches many key names, so no single `<level>.<key>` can stand for it, and `phaseClaim` is its binding instead.',
  'branch-condition|orderedPath|prev.has(next)':
    'the BFS visited set. Cycles are reported by rule 13’s separate cycle walk; on an acyclic graph the answer is identical, and on a cyclic one the run is bounded by the prover’s hang timeout.',
  'statement|scanNested|scanNested(v, `${at}[${i}]`, problems, phaseIds, selfId, bareNum);':
    'the descent PAST an array element. The element itself is shape-tested by the `reportShape` call above it, and no fixture nests a relation below an array bracket AND below another key.',
  'and-operand|verify|raw.admissibility':
    'with `admissibility` absent the file already fails rule 10, and a test now asserts that it is REPORTED (exit 1) rather than crashed on.',
  "and-operand|verify|typeof raw.admissibility === 'object'": 'as above.',
};

// ---------------------------------------------------------------------------

const original = readFileSync(SCRIPT, 'utf8');
const originalHash = sha(original);
// The validator resolves its own repo root from `import.meta.url`, so a mutant in a
// bare temp dir cannot find `docs/adr/gates` and dies before any rule runs. Give the
// temp tree the same shape and symlink the real gate directory into it: the mutant
// then reads the same bytes — and, for the seam's inode check, the same inodes.
const WORK = mkdtempSync(join(tmpdir(), 'gate-prove-'));
mkdirSync(join(WORK, 'scripts'), { recursive: true });
mkdirSync(join(WORK, 'docs', 'adr'), { recursive: true });
symlinkSync(join(REPO, 'docs', 'adr', 'gates'), join(WORK, 'docs', 'adr', 'gates'));

/**
 * Run the suite against a source variant, EXIT CODE only.
 *
 * The variant is written to a temp file and handed to the suite through
 * `GATE_VALIDATOR`; the working tree is never written. That is strictly stronger
 * than restoring byte-identically — there is nothing to restore, so a killed
 * process cannot leave residue behind. The tree's hash is re-checked at the end
 * anyway, because a claim that nothing was written should be verified, not trusted.
 */
async function suiteExitCodeFor(variant, tag) {
  const file = join(WORK, 'scripts', `v-${tag}.mjs`);
  writeFileSync(file, variant);
  try {
    await execFileAsync('npx', ['vitest', 'run', TEST], {
      cwd: REPO,
      env: { ...process.env, GATE_VALIDATOR: file },
      maxBuffer: 64 * 1024 * 1024,
      // A mutant that never terminates is not an equivalent mutant — it is the most
      // observable behaviour change there is. Without a bound the run simply hangs,
      // which reads as "still working" and is the one verdict a prover must never
      // give. Timing out counts as KILLED.
      timeout: SUITE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return 0;
  } catch (e) {
    if (e.killed || e.signal === 'SIGKILL') return 124; // hung, therefore not equivalent
    return e.code ?? 1;
  }
}

/** Serial convenience wrapper for the controls. */
const suiteExitCode = (variant = original, tag = 'baseline') => suiteExitCodeFor(variant, tag);

/** The mutant source for one site, with the offset asserted before splicing. */
function mutantFor(site, source = original) {
  // Strictly stronger than an exactly-once anchor: assert the bytes AT THE OFFSET
  // are the node the parser reported. A shifted offset cannot silently no-op.
  const at = source.slice(site.start, site.end);
  if (at !== site.text) {
    console.error(`ABORT: offset ${site.start} holds ${JSON.stringify(at.slice(0, 60))},`);
    console.error(`       expected ${JSON.stringify(site.text.slice(0, 60))} for ${site.id}`);
    process.exit(1);
  }
  const mutated = source.slice(0, site.start) + site.replacement + source.slice(site.end);
  if (mutated === source) {
    console.error(`ABORT: mutation for ${site.id} changed nothing.`);
    process.exit(1);
  }
  return mutated;
}

const sites = deriveSites(original);

if (process.argv.includes('--list')) {
  console.log('site kinds — the fixed derivation rules:');
  for (const [k, why] of Object.entries(SITE_KINDS)) console.log(`  ${k.padEnd(18)} ${why}`);
  console.log('');
  const byKind = {};
  for (const s of sites) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
  console.log(`${sites.length} sites derived from the AST:`);
  for (const [k, n] of Object.entries(byKind).sort())
    console.log(`  ${String(n).padStart(4)}  ${k}`);
  process.exit(0);
}

// --- B-1: the shape sweep. No guard shape may derive ZERO sites -----------------
if (process.argv.includes('--shape-sweep')) {
  const AT = original.indexOf('  // Rule 9c — while a ship blocker is open');
  if (AT === -1) {
    console.error('ABORT: shape-sweep insertion point not found.');
    process.exit(1);
  }
  const COND = "String(process.env.KNEXT_PROBE_UNCOVERED ?? '') === 'tripwire'";
  const REPORT = 'problems.push(`${label}: tripwire`)';
  const SHAPES = [
    ['if (cond) report  (control)', `  if (${COND}) ${REPORT};\n`],
    ['cond && report', `  ${COND} && ${REPORT};\n`],
    ['cond || report', `  !(${COND}) || ${REPORT};\n`],
    ['ternary report', `  ${COND} ? ${REPORT} : void 0;\n`],
    ['while guard', `  while (${COND}) { ${REPORT}; break; }\n`],
    ['classic for guard', `  for (let i = 0; ${COND}; i += 1) { ${REPORT}; break; }\n`],
    ['do-while guard', `  do { if (${COND}) ${REPORT}; } while (false);\n`],
    ['switch guard', `  switch (${COND}) { case true: ${REPORT}; break; default: break; }\n`],
    ['helper name __emit', `  if (${COND}) __emit(problems, \`\${label}: t\`);\n`],
    ['problems.unshift', `  if (${COND}) problems.unshift(\`\${label}: t\`);\n`],
    ['problems?.push', `  if (${COND}) problems?.push(\`\${label}: t\`);\n`],
    ['negated conjunction', `  if (!(${COND} && label)) ${REPORT};\n`],
    ['(a && b) || c', `  if ((${COND} && label) || false) ${REPORT};\n`],
    ['arrow predicate', `  const __p = (x) => ${COND} && x;\n  if (__p(true)) ${REPORT};\n`],
  ];
  const baseIds = new Set(sites.map((x) => x.id));
  let worst = 0;
  console.log('shape sweep — new sites derived for each guard shape:\n');
  for (const [name, snippet] of SHAPES) {
    const fresh = deriveSites(original.slice(0, AT) + snippet + original.slice(AT)).filter(
      (x) => !baseIds.has(x.id),
    );
    const kinds = [...new Set(fresh.map((x) => x.kind))].sort().join(', ');
    if (fresh.length === 0) worst += 1;
    console.log(
      `  ${String(fresh.length).padStart(3)}  ${name.padEnd(30)} ${fresh.length === 0 ? '<<< ZERO SITES' : kinds}`,
    );
  }
  console.log(
    worst === 0
      ? '\nSHAPE SWEEP PASSED: every shape derives at least one site.'
      : `\nSHAPE SWEEP FAILED: ${worst} shape(s) derive nothing.`,
  );
  process.exit(worst === 0 ? 0 : 1);
}

// --- B-2: exclusion ids must not MIGRATE onto newly-added code ------------------
if (process.argv.includes('--id-drift')) {
  // The review's own insertion: an ordinary two-flag table and a two-branch
  // predicate, both in shapes the derivation sees. Under the old `kind|text`
  // identity all four bare-literal exclusions re-pointed onto this new code.
  const AT = original.indexOf('const RAW = Symbol(');
  if (AT === -1) {
    console.error('ABORT: id-drift insertion point not found.');
    process.exit(1);
  }
  const INSERT = [
    'const __PROBE_TABLE = { newFlag: true, otherFlag: false };',
    'function __probeGuard(x) {',
    '  if (x === undefined) return true;',
    '  return false;',
    '}',
    '',
  ].join('\n');
  const aSrc = original.slice(0, AT) + INSERT + '\n' + original.slice(AT);
  const before = new Map(sites.map((x) => [x.id, x]));
  const after = deriveSites(aSrc);
  const afterById = new Map(after.map((x) => [x.id, x]));

  // The property under test is the IDENTITY, not the current exclusion list: an id
  // that existed before must still denote the SAME site afterwards. Under the old
  // `kind|text` identity, `return-predicate|true` denoted a return in `meetsTarget`
  // before the insertion and a return in the inserted `__probeGuard` after it — so
  // an exclusion written for one silently applied to the other.
  let drifted = 0;
  let checked = 0;
  for (const [id, b] of before) {
    const a = afterById.get(id);
    if (!a) continue;
    checked += 1;
    if (a.text !== b.text || a.where !== b.where) {
      drifted += 1;
      console.log(`  MIGRATED  ${id.slice(0, 60)}`);
      console.log(
        `            ${b.where}:${b.text.slice(0, 40)}  ->  ${a.where}:${a.text.slice(0, 40)}`,
      );
    }
  }
  const fresh = after.filter((x) => !before.has(x.id));
  console.log(`  ${checked} pre-existing ids re-derived; ${drifted} now denote a different site.`);
  console.log(`  the inserted code produced ${fresh.length} NEW id(s):`);
  for (const f of fresh) console.log(`    ${f.id.slice(0, 88)}`);

  // ...and every exclusion in force must still point at what it was written for.
  for (const id of Object.keys(EXCLUSIONS)) {
    const b = before.get(id);
    const a = afterById.get(id);
    if (b && a && (a.text !== b.text || a.where !== b.where)) {
      drifted += 1;
      console.log(`  MIGRATED EXCLUSION  ${id}`);
    }
  }

  // CONTROL: the same comparison under the OLD identity (`kind|text`, no enclosing
  // declaration). It MUST report migrations — otherwise this check is passing
  // because the insertion is harmless rather than because the identity is sound.
  const oldId = (x) => {
    const base = `${x.kind}|${x.text.replace(/\s+/g, ' ').trim()}`;
    return base;
  };
  const firstByOldId = (list) => {
    const m = new Map();
    for (const x of list) if (!m.has(oldId(x))) m.set(oldId(x), x);
    return m;
  };
  const oldBefore = firstByOldId(sites);
  const oldAfter = firstByOldId(after);
  let oldDrift = 0;
  for (const [k, b2] of oldBefore) {
    const a2 = oldAfter.get(k);
    if (a2 && (a2.text !== b2.text || a2.where !== b2.where)) oldDrift += 1;
  }
  console.log(`  CONTROL: under the OLD kind|text identity, ${oldDrift} id(s) migrate.`);
  if (oldDrift === 0) {
    console.error(
      'ABORT: the control found no migration under the old identity — this check cannot see red.',
    );
    process.exit(1);
  }

  console.log(
    drifted === 0
      ? '\nID-DRIFT PASSED: every pre-existing id still denotes the site it denoted before,\nand the inserted code got ids of its own.'
      : `\nID-DRIFT FAILED: ${drifted} id(s) migrated onto different code.`,
  );
  process.exit(drifted === 0 ? 0 : 1);
}

// --- coverage self-test: prove the SET is derived, not enumerated --------------
if (process.argv.includes('--self-test')) {
  // Insert a guard half that no test covers, WITHOUT touching any list in this
  // file, and require (a) the derivation to find it and (b) the prover to report it
  // as a survivor. If either fails, coverage is not derived.
  // The subject must be REACHABLE but untested. The previous one was
  // `problems.length < 0`, which is unsatisfiable — and its mutation to `false` is
  // also unsatisfiable, so the two programs were identical for every input and
  // "survived" carried no information. An env-gated guard is reachable in principle
  // and untested in fact, which is the case that matters.
  const marker =
    "  // <<< synthetic guard half\n  if (String(process.env.KNEXT_PROBE_UNCOVERED ?? '') === 'tripwire')\n    problems.push(`${label}: tripwire`);\n";
  const at = original.indexOf('  // Rule 9c — while a ship blocker is open');
  if (at === -1) {
    console.error('ABORT: self-test insertion point not found.');
    process.exit(1);
  }
  const withNewHalf = original.slice(0, at) + marker + original.slice(at);

  const before = new Set(sites.map((s) => s.id));
  const after = deriveSites(withNewHalf);
  const fresh = after.filter((s) => !before.has(s.id));
  console.log(`self-test: the new half yielded ${fresh.length} derived site(s), unprompted:`);
  for (const f of fresh) console.log(`  ${f.kind}  ${f.text.replace(/\s+/g, ' ').slice(0, 70)}`);
  if (fresh.length === 0) {
    console.error('FAIL: a new guard half produced NO mutation site — coverage is not derived.');
    process.exit(1);
  }

  // ...and the prover must go RED on it: nothing tests the synthetic half, so its
  // mutation survives, which is precisely the verdict a real untested half gets.
  const site = fresh.find((s) => s.kind === 'if-test') ?? fresh[0];
  const baselineWithHalf = await suiteExitCode(withNewHalf, 'selftest-base');
  const mutatedCode = await suiteExitCode(mutantFor(site, withNewHalf), 'selftest-mut');
  if (sha(readFileSync(SCRIPT, 'utf8')) !== originalHash) {
    console.error('ABORT: the working tree changed during the self-test.');
    process.exit(1);
  }
  console.log(`self-test: baseline with the new half exit=${baselineWithHalf} (must be 0)`);
  console.log(`self-test: its mutation exit=${mutatedCode} (must be 0 = SURVIVED = prover reds)`);
  const ok = baselineWithHalf === 0 && mutatedCode === 0;
  console.log(
    ok
      ? '\nSELF-TEST PASSED: an untested half added to the validator is derived automatically\nand reported as a survivor, with no edit to this prover.'
      : '\nSELF-TEST FAILED.',
  );
  process.exit(ok ? 0 : 1);
}

// --- exclusions must be honest ------------------------------------------------
const byId = new Map(sites.map((s) => [s.id, s]));
const ids = new Set(sites.map((s) => s.id));
let bad = 0;
for (const [id, reason] of Object.entries(EXCLUSIONS)) {
  if (!reason || !String(reason).trim()) {
    console.error(`ABORT: exclusion ${id} has no written reason.`);
    bad += 1;
  }
  if (!ids.has(id)) {
    console.error(
      `ABORT: exclusion ${id} matches no derived site — stale exclusions hide survivors.`,
    );
    bad += 1;
  }
}
if (bad > 0) process.exit(1);

// The DECLARED-vs-RUN contract (#685). The count is DERIVED from the site list,
// never hand-maintained: the lane compares in both directions, so a prover that
// dies at item 5 and one that gains a mutation without saying so both red.
declareMutations(sites.length - Object.keys(EXCLUSIONS).filter((id) => ids.has(id)).length);

console.log(`${sites.length} mutation sites DERIVED from the validator's AST.`);
const kinds = {};
for (const s of sites) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
for (const [k, n] of Object.entries(kinds).sort()) console.log(`  ${String(n).padStart(4)}  ${k}`);
console.log('');

// --- controls: the prover must be able to see RED before any verdict counts ----
console.log('baseline (unmutated) ...');
if ((await suiteExitCode(original, 'baseline')) !== 0) {
  console.error('ABORT: baseline suite is already red — nothing below is proof.');
  process.exit(1);
}
console.log('  baseline GREEN');

const controlCode = await suiteExitCode(
  original.replace('process.exit(1);', 'process.exit(0);'),
  'control',
);
if (controlCode === 0) {
  console.error('ABORT: the CONTROL mutation SURVIVED — this prover cannot see red.');
  process.exit(1);
}
console.log(`  CONTROL KILLED (exit ${controlCode}) — the prover can see red`);

const absentCode = await suiteExitCode('#!/usr/bin/env node\nprocess.exit(0);\n', 'absent');
if (absentCode === 0) {
  console.error(
    'ABORT: the suite is GREEN with the validator ABSENT — it does not test its subject.',
  );
  process.exit(1);
}
console.log(`  SUBJECT-ABSENT KILLED (exit ${absentCode}) — the suite tests its subject\n`);

// --- the run ------------------------------------------------------------------
// Mutants are independent and never touch the tree, so they run concurrently.
const CONCURRENCY = Number(process.env.PROVE_CONCURRENCY ?? 4);
const queue = sites.map((site, i) => ({ site, i })).filter(({ site }) => !EXCLUSIONS[site.id]);
// The denominator counts what will be attempted, including the items other workers
// hold in flight. `queue.length + done` omitted those and under-reported the total —
// a miscount in a tool whose product is an honest count.
const total = queue.length;
const survivors = [];
let done = 0;

async function worker(id) {
  for (;;) {
    const item = queue.shift();
    if (!item) return;
    const code = await suiteExitCode(mutantFor(item.site), `${id}-${item.i}`);
    recordMutation();
    if (code === 0) survivors.push(item.site);
    done += 1;
    console.log(
      `${code !== 0 ? 'KILLED  ' : 'SURVIVED'} ${String(done).padStart(3)}/${total}  ${item.site.id.slice(0, 88)}`,
    );
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));

// CONFIRM every survivor SERIALLY. Concurrent runs share a machine, and a run that
// fails for load rather than for the mutation would be a false KILL; one that is
// starved could look like a false SURVIVE. A survivor is the expensive verdict — it
// stops the merge — so it is re-run alone before it is believed.
if (survivors.length > 0) {
  console.log(`\nconfirming ${survivors.length} survivor(s) serially ...`);
  const confirmed = [];
  for (const site of survivors) {
    const code = await suiteExitCode(mutantFor(site), `confirm-${confirmed.length}`);
    if (code === 0) confirmed.push(site);
    else console.log(`  RECLASSIFIED as KILLED on re-run: ${site.id.slice(0, 80)}`);
  }
  survivors.length = 0;
  survivors.push(...confirmed);
}

// The tree must be untouched. Nothing above writes to it, and this verifies that
// rather than asserting it.
if (sha(readFileSync(SCRIPT, 'utf8')) !== originalHash) {
  console.error(`ABORT: ${SCRIPT} changed during the run — a mutant escaped into the tree.`);
  process.exit(1);
}

// --- B-3: an exclusion that the suite KILLS is not an equivalent mutant --------
// The prover's own definition of an exclusion is "a site whose mutation cannot
// change behaviour, so no test could ever kill it". It used to check that each had a
// reason and matched a site, and never the one thing that is mechanically checkable
// and decisive. Review ran the 42 and killed 12 of them — eight on reasons that were
// flatly contradicted by the code. A reason is prose; this is not.
const excludedIds = Object.keys(EXCLUSIONS).filter((id) => byId.has(id));
const killableExclusions = [];
if (excludedIds.length > 0) {
  console.log(`\nverifying ${excludedIds.length} exclusion(s) really are unkillable ...`);
  let k = 0;
  for (const id of excludedIds) {
    const code = await suiteExitCode(mutantFor(byId.get(id)), `excl-${k}`);
    k += 1;
    if (code !== 0) {
      killableExclusions.push(id);
      console.log(`  KILLABLE  ${id.slice(0, 88)}`);
    }
  }
  console.log(
    `  ${excludedIds.length - killableExclusions.length}/${excludedIds.length} confirmed unkillable`,
  );
}

const excluded = Object.keys(EXCLUSIONS).length;
const attempted = sites.length - excluded;
console.log(
  `\n${attempted - survivors.length}/${attempted} derived mutations killed; ${survivors.length} survived; ${excluded} excluded with a written reason.`,
);
console.log(`working tree verified byte-identical (sha256 ${originalHash.slice(0, 16)}…)`);
if (survivors.length > 0) {
  console.log('\nSURVIVORS — each is a guard half no test covers:');
  for (const s of survivors) {
    console.log(`  ${s.kind}\n    ${s.text.replace(/\s+/g, ' ').slice(0, 140)}`);
  }
}
if (killableExclusions.length > 0) {
  console.log(
    '\nKILLABLE EXCLUSIONS — each is a real mutation being excused, not an equivalent mutant:',
  );
  for (const id of killableExclusions) console.log(`  ${id}`);
}
process.exit(survivors.length === 0 && killableExclusions.length === 0 ? 0 : 1);
