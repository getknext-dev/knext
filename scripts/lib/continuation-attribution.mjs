/**
 * Continuation-line attribution for the honest line % (#1262, ADR-0057 Amendment 1).
 *
 * ## The artifact
 *
 * `scripts/bun-test.mjs` runs one bun process per test file, and the gate merges
 * their lcov reports by summing hits. A process that imports a module WITHOUT
 * running a branch emits `DA:<n>,0` for every line of it — including the 2nd+
 * physical lines of a `+`-joined multi-line string literal. A process that DOES
 * run the branch emits NO record for (some of) those continuation lines, only
 * for the statement's first line. The sum keeps the 0, so the line reads
 * uncovered forever even though the statement runs, and no test can raise it.
 * The honest classifier (`executable-lines.mjs`) rightly keeps these lines: they
 * ARE expressions.
 *
 * ## The rule
 *
 * A line that is PURELY a string-literal continuation takes its hit count from
 * the first line of its enclosing statement. It applies only after the merge,
 * only to the honest number, only to a line whose merged count is 0, and never
 * adds a record the reports did not carry. A line qualifies only if ALL hold:
 *
 *   1. Every token STARTING on the line is a string literal (`'…'`, `"…"`, or a
 *      backtick literal with no substitution), a binary `+`, or a closer
 *      (`)` `,` `;`) — and at least one is a literal. A call, an identifier, a
 *      `${…}` substitution, a `?`/`:`, a `&&`, anything else: not attributed.
 *   2. Each literal on the line reaches its statement only through a `+` chain,
 *      grouping parens, the ARGUMENTS of a call or `new`, or a variable
 *      initializer, and the statement is a `return`, `throw`, expression
 *      statement or variable statement. A conditional, a short-circuit, an
 *      arrow body, a template substitution, an assignment operator: not attributed.
 *   3. The statement is the first thing on its own line — so that line's hit
 *      count is the statement's, not some earlier `if (x)` sharing the line.
 *   4. Everything the statement evaluates BEFORE the literal is from an
 *      allowlist that cannot skip it: literals, identifiers, template
 *      substitutions of those, `+`, grouping parens, and the keywords that open
 *      the statement. A call, a property access, an optional chain, a
 *      conditional or a short-circuit before it could throw or branch away
 *      from the literal while the first line still counts as hit — so any of
 *      them blocks attribution.
 *
 * ## The invariant (load-bearing)
 *
 * Never mark a line covered if it contains anything that could independently
 * fail to run. Every check is an ALLOWLIST: an unrecognised construct fails the
 * check and the line keeps its 0. Keeping a 0 is always acceptable; hiding an
 * uncovered expression is not. A source that cannot be read or parsed is not
 * analysed at all — every record is carried over unchanged.
 *
 * `tests/coverage-continuation-attribution.test.ts` holds the tricky fixtures,
 * the two-report-merge reproduction, and a repo-wide scan against an independent
 * oracle (TypeScript's scanner over each attributed line's text).
 */

import ts from 'typescript';

const K = ts.SyntaxKind;

const LITERALS = new Set([K.StringLiteral, K.NoSubstitutionTemplateLiteral]);

/** Tokens allowed to START on an attributable line (closers carry no operation). */
const LINE_TOKENS = new Set([
  K.StringLiteral,
  K.NoSubstitutionTemplateLiteral,
  K.PlusToken,
  K.CloseParenToken,
  K.CommaToken,
  K.SemicolonToken,
]);

/** Statements whose first line's hit count is the attribution source. */
const ANCHOR_STATEMENTS = new Set([
  K.ReturnStatement,
  K.ThrowStatement,
  K.ExpressionStatement,
  K.VariableStatement,
]);

/**
 * Node and token kinds allowed to be evaluated BEFORE the literal inside its
 * statement. None of them can throw in a way a string literal after them would
 * not share, and none of them branches.
 */
const PRECEDING_OK = new Set([
  K.StringLiteral,
  K.NoSubstitutionTemplateLiteral,
  K.NumericLiteral,
  K.TemplateExpression,
  K.TemplateHead,
  K.TemplateMiddle,
  K.TemplateTail,
  K.TemplateSpan,
  K.Identifier,
  K.ParenthesizedExpression,
  K.BinaryExpression, // its operator token must itself be in this set: `+` only
  K.SyntaxList,
  K.PlusToken,
  K.OpenParenToken,
  K.CloseParenToken,
  K.CommaToken,
  K.EqualsToken,
  K.ReturnKeyword,
  K.ThrowKeyword,
  K.NewKeyword,
  K.ConstKeyword,
  K.LetKeyword,
  K.VarKeyword,
  K.VariableDeclarationList,
  K.VariableDeclaration,
]);

/** @param {ts.Node} n */
function isPlusBinary(n) {
  return ts.isBinaryExpression(n) && n.operatorToken.kind === K.PlusToken;
}

/**
 * Climb from a literal to its anchor statement through the allowed parents
 * only (rule 2). Returns the statement, or null when any step is not allowed.
 *
 * @param {ts.Node} lit
 * @returns {ts.Statement | null}
 */
function anchorStatement(lit) {
  let node = lit;
  for (;;) {
    const parent = node.parent;
    if (!parent) return null;
    if (isPlusBinary(parent) || ts.isParenthesizedExpression(parent)) {
      node = parent;
      continue;
    }
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      // Only an ARGUMENT position — the callee is evaluated, not continued.
      if (!parent.arguments?.includes(/** @type {ts.Expression} */ (node))) return null;
      node = parent;
      continue;
    }
    if (ts.isVariableDeclaration(parent)) {
      if (parent.initializer !== node) return null;
      const list = parent.parent;
      if (!list || !ts.isVariableDeclarationList(list) || !list.parent) return null;
      if (!ts.isVariableStatement(list.parent)) return null;
      return list.parent;
    }
    if (ANCHOR_STATEMENTS.has(parent.kind)) return /** @type {ts.Statement} */ (parent);
    return null;
  }
}

/**
 * Rule 4: is everything the statement evaluates before `lit` from the allowlist?
 *
 * @param {ts.Node} stmt
 * @param {ts.Node} lit
 * @param {ts.SourceFile} sf
 */
function nothingRiskyBefore(stmt, lit, sf) {
  const litStart = lit.getStart(sf);
  /** @param {ts.Node} n @returns {boolean} */
  const ok = (n) => {
    if (n === lit) return true;
    const start = n.getStart(sf);
    const end = n.getEnd();
    if (start >= litStart) return true; // evaluated after the literal — irrelevant
    if (end > litStart) {
      // An ANCESTOR of the literal: its kind was vetted by the climb; vet what it
      // evaluates before the literal (the callee, the left operand, the keyword).
      return n.getChildren(sf).every(ok);
    }
    // Entirely BEFORE the literal. A BinaryExpression passes the kind check, but
    // its operator token is vetted like every other token: only `+` is allowed.
    if (!PRECEDING_OK.has(n.kind)) return false;
    // `=` only as a declaration's initializer — never an assignment expression.
    if (n.kind === K.EqualsToken && !ts.isVariableDeclaration(n.parent)) return false;
    return n.getChildren(sf).every(ok);
  };
  // The statement itself is an ancestor — start from its children.
  return stmt.getChildren(sf).every(ok);
}

/**
 * Map every attributable continuation line to its anchor line.
 *
 * @param {string} src
 * @param {string} fileName  used only for the script kind (`.tsx` → TSX)
 * @returns {{ ok: boolean, anchors: Map<number, number> }}  1-based line → 1-based anchor line
 */
export function continuationAnchors(src, fileName) {
  const kind = /\.[cm]?tsx$/.test(fileName)
    ? ts.ScriptKind.TSX
    : /\.[cm]?jsx?$/.test(fileName)
      ? ts.ScriptKind.JSX
      : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = /** @type {{ parseDiagnostics?: unknown[] }} */ (/** @type {unknown} */ (sf))
    .parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) return { ok: false, anchors: new Map() };

  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line;

  /** Tokens starting on each 0-based line. @type {Map<number, ts.Node[]>} */
  const tokensByLine = new Map();
  /** @param {ts.Node} node */
  const collect = (node) => {
    if (node.kind >= K.FirstJSDocNode && node.kind <= K.LastJSDocNode) return;
    const kids = node.getChildren(sf);
    if (kids.length === 0) {
      if (node.kind === K.EndOfFileToken) return;
      const start = node.getStart(sf);
      if (node.getEnd() <= start) return; // zero-width (an empty SyntaxList)
      const line = lineOf(start);
      const list = tokensByLine.get(line);
      if (list) list.push(node);
      else tokensByLine.set(line, [node]);
      return;
    }
    for (const k of kids) collect(k);
  };
  collect(sf);

  const starts = sf.getLineStarts();
  /** @type {Map<number, number>} */
  const anchors = new Map();
  for (const [line, tokens] of tokensByLine) {
    // Rule 1: only literals, `+` and closers start on this line, and a literal does.
    if (!tokens.every((t) => LINE_TOKENS.has(t.kind))) continue;
    if (tokens.some((t) => t.kind === K.PlusToken && !isPlusBinary(t.parent))) continue;
    const literals = tokens.filter((t) => LITERALS.has(t.kind));
    if (literals.length === 0) continue;

    let anchorLine = -1;
    let good = true;
    for (const lit of literals) {
      const stmt = anchorStatement(lit); // rule 2
      if (!stmt) {
        good = false;
        break;
      }
      const stmtStart = stmt.getStart(sf);
      const sLine = lineOf(stmtStart);
      // Rule 3: the statement is the first thing on its (earlier) line.
      if (sLine >= line || src.slice(starts[sLine], stmtStart).trim() !== '') {
        good = false;
        break;
      }
      // Every literal on the line must share one anchor.
      if (anchorLine !== -1 && anchorLine !== sLine) {
        good = false;
        break;
      }
      anchorLine = sLine;
      if (!nothingRiskyBefore(stmt, lit, sf)) {
        good = false; // rule 4
        break;
      }
    }
    if (good) anchors.set(line + 1, anchorLine + 1);
  }
  return { ok: true, anchors };
}

/**
 * Attribute every 0-hit pure continuation line from its anchor line.
 *
 * Never mutates its input, never adds a record, and only ever raises a 0 to the
 * anchor line's merged count (so an anchor that never ran attributes nothing).
 * A file whose source cannot be read or parsed is carried over unchanged.
 *
 * @param {Map<string, import('./lcov.mjs').FileCoverage>} files  (the honest map)
 * @param {(path: string) => string | null} readSource
 * @returns {{ files: Map<string, import('./lcov.mjs').FileCoverage>, attributed: number }}
 */
export function attributeContinuations(files, readSource) {
  const out = new Map();
  let attributed = 0;
  for (const [path, cov] of files) {
    const lines = new Map(cov.lines);
    const src = readSource(path);
    const res = src === null ? { ok: false, anchors: new Map() } : continuationAnchors(src, path);
    if (res.ok) {
      for (const [line, anchor] of res.anchors) {
        if (lines.get(line) !== 0) continue; // no record, or already hit
        const hits = lines.get(anchor) ?? 0;
        if (hits > 0) {
          lines.set(line, hits);
          attributed++;
        }
      }
    }
    out.set(path, { ...cov, lines });
  }
  return { files: out, attributed };
}
