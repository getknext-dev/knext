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
 *      allowlist that cannot skip it: literals, `+`, grouping parens, the
 *      keywords that open the statement, and an identifier ONLY as the callee
 *      of a call / `new` (`new Error(`). A call, a property access, an optional
 *      chain, a conditional, a short-circuit, or an identifier that gets
 *      string-converted (`name + 'a'`, `${name}` — a Symbol or a throwing
 *      toString throws there) could skip the literal while the first line still
 *      counts as hit — so any of them blocks attribution.
 *   5. The statement STARTS ITS OWN BASIC BLOCK (#1268 review). JSC's count on a
 *      line is the count of ENTERING the basic block that holds it, not of
 *      running the statement: in `boom(); throw new Error('a' +\n 'b')` the
 *      throw's line reads hit although `boom()` always throws first. So the
 *      statement must be the first statement of a function / arrow / method /
 *      accessor body, of a constructor whose entry runs nothing (no instance or
 *      `accessor` fields, `#private` members, parameter properties or
 *      decorators — those run at entry in the SAME block), or of an `if`/`else`
 *      branch (or a braceless branch); or every statement between it and the
 *      nearest preceding `if` / `for` / `for…of` / `while` / `switch` / `try` must
 *      be one that cannot throw (a literal-only `const`/`let`/`var` — never
 *      `using`, whose disposability check throws — a function / type declaration,
 *      an empty statement). Each accepted owner and boundary is MEASURED on bun
 *      1.4.2 by the real-bun ground-truth test, one file per shape; a bare nested
 *      `{ }`, `using`, and a field-initializing constructor were measured NOT to
 *      be safe, so they are refused, as is anything unmeasured (a `case` clause,
 *      module top level, `for…in`, `do…while`, a loop body).
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
 * the two-report-merge reproduction, a REAL-bun ground-truth check (fixture
 * shapes run in separate bun processes whose outcome is known by construction —
 * independent of this module, it covers rules 3 and 5), and a repo-wide re-check
 * of rule 1 only, with TypeScript's scanner over each attributed line's text.
 */

import ts from 'typescript-api';

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

/**
 * Statements after which JSC starts a fresh basic block — each MEASURED on bun
 * 1.4.2 (an unreached statement right after it reads 0). Nothing unmeasured.
 */
const BLOCK_BOUNDARIES = new Set([
  K.IfStatement,
  K.ForStatement,
  K.ForOfStatement,
  K.WhileStatement,
  K.SwitchStatement,
  K.TryStatement,
]);

/**
 * Owners whose body block is entered as a fresh basic block (function entry),
 * each MEASURED on bun 1.4.2 in the real-bun ground-truth test. Parameter
 * defaults and destructuring were measured NOT to share the body's block (an
 * unrun body reads 0). A `Constructor` is NOT here: instance field initializers
 * and parameter properties run at constructor entry IN THE SAME block (measured:
 * `f = boom()` then a first-statement throw reads hit) — see `cleanConstructor`.
 */
const FUNCTION_LIKE = new Set([
  K.FunctionDeclaration,
  K.FunctionExpression,
  K.ArrowFunction,
  K.MethodDeclaration,
  K.GetAccessor,
  K.SetAccessor,
]);

/**
 * A constructor whose entry runs NOTHING before its body: no parameter
 * properties or parameter decorators, and every class member inert at
 * construction — a public method / accessor, a static member, a type-only
 * member, a `;`. Allowlist: an instance field (with or without initializer), an
 * `accessor` field, a `#private` member (brand install) or any decorator refuses.
 *
 * @param {ts.ConstructorDeclaration} ctor
 */
function cleanConstructor(ctor) {
  if (ctor.parameters.some((p) => (ts.getModifiers(p)?.length ?? 0) > 0 || ts.getDecorators(p))) {
    return false;
  }
  const cls = ctor.parent;
  if (!cls || !(ts.isClassDeclaration(cls) || ts.isClassExpression(cls))) return false;
  if (ts.getDecorators(cls)) return false;
  return cls.members.every((m) => {
    if (ts.canHaveDecorators(m) && ts.getDecorators(m)) return false;
    if (ts.isConstructorDeclaration(m) || ts.isSemicolonClassElement(m)) return true;
    if (ts.isIndexSignatureDeclaration(m)) return true;
    const mods = ts.canHaveModifiers(m) ? (ts.getModifiers(m) ?? []) : [];
    if (mods.some((x) => x.kind === K.StaticKeyword)) return true; // runs at definition
    if (m.name && ts.isPrivateIdentifier(m.name)) return false; // brand install at entry
    return ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m);
  });
}

/** Initializers that cannot throw: a literal, and nothing else. */
const INERT_INITIALIZERS = new Set([
  K.StringLiteral,
  K.NoSubstitutionTemplateLiteral,
  K.NumericLiteral,
  K.TrueKeyword,
  K.FalseKeyword,
  K.NullKeyword,
]);

/**
 * Can this statement NOT throw? Allowlist — anything unrecognised can.
 *
 * @param {ts.Statement} s
 */
function cannotThrow(s) {
  if (ts.isEmptyStatement(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) {
    return true;
  }
  if (ts.isFunctionDeclaration(s)) return s.body !== undefined; // hoisted; nothing runs here
  if (ts.isVariableStatement(s)) {
    // `using` / `await using` run a disposability check on the value, which THROWS
    // for a non-disposable (measured: `using u = 'str'` then a throw reads hit).
    // `NodeFlags.AwaitUsing` is `Const | Using`, so test the `Using` bit alone —
    // masking with `Using | AwaitUsing` would also refuse every `const`.
    if ((s.declarationList.flags & ts.NodeFlags.Using) !== 0) return false;
    return s.declarationList.declarations.every(
      (d) =>
        ts.isIdentifier(d.name) &&
        (d.initializer === undefined || INERT_INITIALIZERS.has(d.initializer.kind)),
    );
  }
  return false;
}

/**
 * Is `ifStmt` a branch owner of `node` (its then- or else-statement)?
 *
 * @param {ts.Node} ifStmt @param {ts.Node} node
 */
function isIfBranch(ifStmt, node) {
  return (
    ts.isIfStatement(ifStmt) && (ifStmt.thenStatement === node || ifStmt.elseStatement === node)
  );
}

/**
 * Rule 5: does `stmt` begin a basic block of its own, so that its first line's
 * count is the count of `stmt` starting to run — not of some earlier statement
 * in the same block that may have thrown?
 *
 * @param {ts.Statement} stmt
 */
function startsItsBasicBlock(stmt) {
  const parent = stmt.parent;
  if (isIfBranch(parent, stmt)) return true; // a braceless branch
  if (!parent || !ts.isBlock(parent)) return false; // module top level, `case`, …
  const idx = parent.statements.indexOf(stmt);
  for (let i = idx - 1; i >= 0; i--) {
    const prev = parent.statements[i];
    if (BLOCK_BOUNDARIES.has(prev.kind)) return true;
    if (!cannotThrow(prev)) return false;
  }
  // First runnable statement of its block: sound only where entering the block
  // is itself a block entry. A bare nested `{ }` is measured NOT to be one.
  const owner = parent.parent;
  if (owner !== undefined && ts.isConstructorDeclaration(owner)) return cleanConstructor(owner);
  return owner !== undefined && (FUNCTION_LIKE.has(owner.kind) || isIfBranch(owner, parent));
}

/** @param {ts.Node} n  is `n` the callee of a call or `new`? */
function isCallee(n) {
  const p = n.parent;
  return p !== undefined && (ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === n;
}

/** @param {ts.Node} n  is `n` a declared binding name (`const msg =`) — not a read? */
function isDeclaredName(n) {
  const p = n.parent;
  return p !== undefined && ts.isVariableDeclaration(p) && p.name === n;
}

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
    // An identifier only as a call / `new` CALLEE (`new Error(`). As an operand
    // it is string-converted — `sym + 'a'`, `${obj}` — and that conversion can
    // throw (a Symbol; a throwing toString/valueOf), skipping the literal.
    // This also refuses every ASSIGNMENT before the literal: its target is an
    // identifier (refused here) or a property / element access or a destructuring
    // pattern (none in PRECEDING_OK) — so `=` needs no check of its own. A separate
    // one was removed in the #1268 review because no fixture could observe it.
    if (n.kind === K.Identifier && !isCallee(n) && !isDeclaredName(n)) return false;
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
      if (!startsItsBasicBlock(stmt)) {
        good = false; // rule 5
        break;
      }
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
