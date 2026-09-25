/**
 * The honest line denominator (#1248, ADR-0057).
 *
 * bun's lcov emits a `DA` record for lines that hold no executable code — blank
 * lines, comments, lone closing braces, type-annotation continuations, the
 * inside of a multi-line template literal. Measured on this tree, those records
 * are a large share of the "uncovered" lines, so the raw line % mostly measures
 * formatting. This module classifies every source line with the TypeScript
 * PARSER — never a regex — so `scripts/check-coverage.mjs` can report a second,
 * honest line % over executable lines only, alongside the raw one.
 *
 * ## The invariant (load-bearing — read before changing anything here)
 *
 * A line that carries ANY executable token stays in the denominator. The design
 * is a whitelist of noise with a default of "executable": every token counts as
 * executable unless it is positively identified as one of
 *
 *   - type-only syntax TypeScript erases (a type annotation, an interface, a
 *     type alias, `import type`, a `declare`, an overload signature, the `as` /
 *     `satisfies` keyword and its type, an `implements` clause, a type-parameter
 *     list and its angle brackets, the `:` that introduces an annotation);
 *   - a CLOSING delimiter or separator (`}` `)` `]` `,` `;`), or an OPENING one
 *     that begins no runtime operation (a block's `{`, a grouping `(`, a
 *     parameter list's `(`). An opener that DOES begin one — an object or array
 *     literal, a call's argument list, an element access, a computed key — is
 *     executable.
 *
 * A line with no token STARTING on it is blank, comment-only, or the
 * continuation of a multi-line token (a template literal's middle). Any token
 * kind this module does not recognise falls through to "executable". So an
 * unknown construct can only ever KEEP noise, never hide code. Keeping noise is
 * always acceptable; hiding code is not.
 *
 * Fail-closed in the same direction: a source that cannot be read, or that has
 * parse errors, is not classified at all — every one of its DA records is kept.
 *
 * `tests/coverage-executable-lines.test.ts` holds the tricky-case fixture and a
 * repo-wide differential scan against an independent oracle (TypeScript's own
 * emitted JS + source map): no line this module calls noise may emit runtime JS.
 */

import ts from 'typescript';

/** @typedef {'executable' | 'type-only' | 'punctuation' | 'continuation' | 'comment' | 'blank'} LineClass */

const K = ts.SyntaxKind;

/** Closers and separators — never the carrier of a runtime operation. */
const CLOSERS = new Set([
  K.CloseBraceToken,
  K.CloseParenToken,
  K.CloseBracketToken,
  K.CommaToken,
  K.SemicolonToken,
]);

/** Openers — noise unless `opensRuntimeOperation` says otherwise. */
const OPENERS = new Set([K.OpenBraceToken, K.OpenParenToken, K.OpenBracketToken]);

/** Parent kinds whose opening delimiter itself begins a runtime operation. */
const RUNTIME_OPENER_PARENTS = new Set([
  K.ObjectLiteralExpression,
  K.ArrayLiteralExpression,
  K.CallExpression,
  K.NewExpression,
  K.ElementAccessExpression,
  K.ComputedPropertyName,
  K.ObjectBindingPattern,
  K.ArrayBindingPattern,
  K.ArrowFunction,
]);

/**
 * Is `node` a whole subtree TypeScript erases?
 *
 * @param {ts.Node} node
 * @returns {boolean}
 */
function isErasedSubtree(node) {
  switch (node.kind) {
    case K.InterfaceDeclaration:
    case K.TypeAliasDeclaration:
    case K.TypeParameter:
    case K.IndexSignature:
      return true;
    case K.HeritageClause:
      return /** @type {ts.HeritageClause} */ (node).token === K.ImplementsKeyword;
    case K.ImportDeclaration:
      return /** @type {ts.ImportDeclaration} */ (node).importClause?.isTypeOnly === true;
    case K.ExportDeclaration:
      return /** @type {ts.ExportDeclaration} */ (node).isTypeOnly === true;
    case K.ImportEqualsDeclaration:
      return /** @type {ts.ImportEqualsDeclaration} */ (node).isTypeOnly === true;
    case K.FunctionDeclaration:
    case K.MethodDeclaration:
    case K.Constructor:
      // An overload / abstract signature has no body and emits nothing.
      return /** @type {ts.FunctionLikeDeclaration} */ (node).body === undefined;
    case K.Parameter: {
      const name = /** @type {ts.ParameterDeclaration} */ (node).name;
      return ts.isIdentifier(name) && name.text === 'this';
    }
    default:
      break;
  }
  if (hasModifier(node, K.DeclareKeyword)) return true;
  if (node.kind === K.PropertyDeclaration && hasModifier(node, K.AbstractKeyword)) return true;
  if (node.kind === K.ExpressionWithTypeArguments) {
    // Erased ONLY inside a heritage clause that is itself type-only
    // (`implements`, an interface's `extends`). Two runtime shapes share this
    // node kind and must stay: a class `extends B` expression, and a TS 4.7+
    // instantiation expression used as a value (`box<string>;`, `[box<number>]`)
    // — TypeScript emits `box` for both. Only the type ARGUMENTS are erased,
    // and they are TypeNodes of their own.
    const clause = node.parent;
    if (!clause || !ts.isHeritageClause(clause)) return false;
    return !(
      clause.token === K.ExtendsKeyword &&
      (ts.isClassDeclaration(clause.parent) || ts.isClassExpression(clause.parent))
    );
  }
  if (node.kind >= K.FirstToken && node.kind <= K.LastToken) {
    // A keyword LEAF (`string`, `void`, …) is a type only in a TYPE SLOT. The
    // same token kind can be a runtime operator: `void p` is a VoidExpression
    // whose `void` keyword `ts.isTypeNode` also answers true for.
    return ts.isTypeNode(node) && inTypeSlot(node);
  }
  return ts.isTypeNode(node);
}

/**
 * Does `node` occupy a TYPE position of its parent — the parent is itself a
 * type, or holds `node` as its `.type`, a type argument, or a type parameter?
 *
 * @param {ts.Node} node
 */
function inTypeSlot(node) {
  const parent = /** @type {any} */ (node.parent);
  if (!parent) return false;
  if (ts.isTypeNode(parent) && parent.kind !== K.ExpressionWithTypeArguments) return true;
  if (parent.type === node) return true;
  if (parent.typeArguments?.includes(node)) return true;
  return parent.typeParameters?.includes(node) === true;
}

/** @param {ts.Node} node @param {ts.SyntaxKind} kind */
function hasModifier(node, kind) {
  const mods = /** @type {{ modifiers?: ts.NodeArray<ts.ModifierLike> }} */ (node).modifiers;
  return mods?.some((m) => m.kind === kind) === true;
}

/** Is this node a SyntaxList of type parameters / type arguments only? */
function isTypeList(node) {
  if (node.kind !== K.SyntaxList) return false;
  const kids = node.getChildren();
  return (
    kids.length > 0 &&
    kids.every((c) => c.kind === K.CommaToken || c.kind === K.TypeParameter || isErasedSubtree(c))
  );
}

/**
 * Classify every line of a TypeScript/TSX source.
 *
 * @param {string} src
 * @param {string} fileName  used only for the script kind (`.tsx` → TSX)
 * @returns {{ ok: boolean, classes: LineClass[] }}  `classes[i]` is line `i + 1`
 */
export function classifyLines(src, fileName) {
  const kind = /\.[cm]?tsx$/.test(fileName)
    ? ts.ScriptKind.TSX
    : /\.[cm]?jsx?$/.test(fileName)
      ? ts.ScriptKind.JSX
      : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind);
  // Parse errors mean the tree may not reflect the code — refuse to classify.
  const diagnostics = /** @type {{ parseDiagnostics?: unknown[] }} */ (/** @type {unknown} */ (sf))
    .parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) return { ok: false, classes: [] };

  const lineCount = sf.getLineStarts().length;
  const runtime = new Uint8Array(lineCount);
  const typeOnly = new Uint8Array(lineCount);
  const punct = new Uint8Array(lineCount);
  const inToken = new Uint8Array(lineCount);
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line;

  /** Mark the lines a multi-line token spans after its first. */
  const markSpan = (from, to) => {
    const a = lineOf(from);
    const b = lineOf(to);
    for (let l = a + 1; l <= b; l++) inToken[l] = 1;
  };

  /**
   * @param {ts.Node} node
   * @param {boolean} erased  inside an erased (type-only) subtree
   */
  const visit = (node, erased) => {
    if (node.kind >= K.FirstJSDocNode && node.kind <= K.LastJSDocNode) return;
    const nowErased = erased || isErasedSubtree(node);
    const kids = node.getChildren(sf);
    if (kids.length === 0) {
      leaf(node, nowErased);
      return;
    }
    kids.forEach((child, i) => {
      let childErased = nowErased;
      if (!childErased) {
        // The `:` that introduces a type annotation.
        if (child.kind === K.ColonToken && kids[i + 1] !== undefined && kids[i + 1] === node.type) {
          childErased = true;
        }
        // `as` / `satisfies` — the keyword; the type after it is a TypeNode.
        if (
          (child.kind === K.AsKeyword && node.kind === K.AsExpression) ||
          (child.kind === K.SatisfiesKeyword && node.kind === K.SatisfiesExpression)
        ) {
          childErased = true;
        }
        // The `<` / `>` around a type-parameter or type-argument list.
        if (
          (child.kind === K.LessThanToken && kids[i + 1] && isTypeList(kids[i + 1])) ||
          (child.kind === K.GreaterThanToken && i > 0 && isTypeList(kids[i - 1]))
        ) {
          childErased = true;
        }
      }
      visit(child, childErased);
    });
  };

  /** @param {ts.Node} tok @param {boolean} erased */
  const leaf = (tok, erased) => {
    if (tok.kind === K.EndOfFileToken) return;
    let start = tok.getStart(sf);
    const end = tok.getEnd();
    // A zero-width leaf (an EMPTY SyntaxList, e.g. the members of `{}`) holds no
    // source text, so there is nothing on any line for it to carry.
    if (end <= start) return;
    if (tok.kind === K.JsxText) {
      // JSX text has no trivia; its meaningful start is its first non-space.
      const text = src.slice(start, end);
      const first = text.search(/\S/);
      if (first === -1) return; // whitespace-only JSX text emits nothing
      start += first;
    }
    if (end > start) markSpan(start, end - 1);
    const line = lineOf(start);
    if (erased) {
      typeOnly[line] = 1;
      return;
    }
    if (CLOSERS.has(tok.kind)) {
      punct[line] = 1;
      return;
    }
    if (OPENERS.has(tok.kind) && !opensRuntimeOperation(tok)) {
      punct[line] = 1;
      return;
    }
    // Default: EXECUTABLE. An unrecognised token can only keep noise.
    runtime[line] = 1;
  };

  visit(sf, false);

  const starts = sf.getLineStarts();
  /** @type {LineClass[]} */
  const classes = [];
  for (let l = 0; l < lineCount; l++) {
    if (runtime[l]) classes.push('executable');
    else if (typeOnly[l]) classes.push('type-only');
    else if (punct[l]) classes.push('punctuation');
    else {
      const text = src.slice(starts[l], l + 1 < lineCount ? starts[l + 1] : src.length);
      if (text.trim() === '') classes.push('blank');
      else if (inToken[l]) classes.push('continuation');
      else classes.push('comment');
    }
  }
  return { ok: true, classes };
}

/**
 * Does this opening delimiter itself begin a runtime operation?
 *
 * `{` of an object literal builds an object; `[` of an array literal builds an
 * array or, on an element access, reads one; `(` of a call's argument list IS
 * the call. A block's `{`, a grouping `(`, or a parameter list's `(` do not.
 *
 * @param {ts.Node} tok
 */
function opensRuntimeOperation(tok) {
  const parent = tok.parent;
  if (!parent) return true; // unknown context — keep it
  if (!RUNTIME_OPENER_PARENTS.has(parent.kind)) return false;
  if (parent.kind === K.CallExpression || parent.kind === K.NewExpression) {
    // Only the argument-list `(`; the callee has its own tokens.
    return tok.kind === K.OpenParenToken;
  }
  return true;
}

/** @param {string} cls */
export function isExecutableClass(cls) {
  return cls === 'executable';
}

/**
 * Filter a merged coverage map down to DA records on executable lines.
 *
 * Never mutates its input. A file whose source cannot be read or parsed is
 * carried over UNCHANGED (all DA records kept) and named in `unclassified`, and
 * a DA line past the end of the source is kept — both fail toward noise.
 *
 * @param {Map<string, import('./lcov.mjs').FileCoverage>} merged
 * @param {(path: string) => string | null} readSource
 * @returns {{
 *   files: Map<string, import('./lcov.mjs').FileCoverage>,
 *   noise: Record<string, number>,
 *   unclassified: string[],
 * }}
 */
export function honestCoverage(merged, readSource) {
  const files = new Map();
  /** @type {Record<string, number>} */
  const noise = {};
  const unclassified = [];
  for (const [path, cov] of merged) {
    const src = readSource(path);
    const res = src === null ? { ok: false, classes: [] } : classifyLines(src, path);
    if (!res.ok) {
      unclassified.push(path);
      files.set(path, { ...cov, lines: new Map(cov.lines) });
      continue;
    }
    const lines = new Map();
    for (const [lineNo, hits] of cov.lines) {
      const cls = res.classes[lineNo - 1];
      if (cls === undefined || isExecutableClass(cls)) {
        lines.set(lineNo, hits);
      } else {
        noise[cls] = (noise[cls] ?? 0) + 1;
      }
    }
    files.set(path, { ...cov, lines });
  }
  return { files, noise, unclassified };
}
