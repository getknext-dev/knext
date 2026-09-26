#!/usr/bin/env node
/**
 * compat-window-fingerprint.mjs — the COMPAT-WINDOW FINGERPRINT (S1, #545).
 *
 * v1.0 is gated on "14 consecutive scheduled node-lane runs with the harness
 * unchanged". Nothing recorded what "unchanged" meant, so the guarantee was
 * unfalsifiable: the window would be policed by a human reading a log they also
 * wrote. This script makes it checkable — it emits a deterministic digest over
 * the FROZEN SET, recorded per scheduled run, so a mid-window change is
 * detectable from the log rather than from memory.
 *
 * THE FROZEN SET (docs/adr/0039, decision D-1 of docs/SPRINT_2.md) has two
 * halves, and both must be in the digest:
 *
 *   harness — .github/workflows/test-e2e-deploy.yml, the scripts/e2e-* lifecycle
 *             scripts the reference harness shells out to, and the deploy-tests
 *             manifest that selects what runs.
 *   packed  — the `@getknext/*` tarballs the workflow packs and installs into
 *             every fixture, each covered IN FULL. This is THE ADAPTER UNDER
 *             TEST. A fingerprint that covers only the harness would go
 *             unchanged across a night that tested different code — the exact
 *             silent failure this exists to prevent — so an empty or
 *             non-@getknext packed set is a hard error, never a quietly-omitted
 *             component.
 *
 * "IN FULL" is literal and load-bearing: `dist/cli/**` and the shared
 * `dist/chunk-*.js` are INSIDE the digest. `packages/kn-next/package.json` has
 * `files: ["dist"]` and `bin: ./dist/cli/kn-next.js`, so the CLI ships in the
 * tarball under test, and 8 of the 9 chunks `dist/cli/*` references are shared
 * with non-CLI dist files — a path-prefix filter could not separate them even if
 * we wanted one, because a CLI change perturbing a shared chunk rotates its
 * hashed filename and rewrites import specifiers in adapter entries too.
 * A CLI change therefore RESETS the window. What
 * `scripts/adapter-import-closure.mjs` proves is a different claim — that the
 * adapter never *executes* CLI code, which makes `src/cli/` review-safe, not
 * window-safe. Do not conflate the two (ADR-0039, corrected on PR #574).
 *
 * SUITE PROVENANCE is RECORDED, NOT FROZEN. `NEXTJS_REF` is a git TAG resolved
 * fresh each night and that checkout supplies `run-tests.js` and the suite
 * itself, so a retag moves what "green" means under a stable fingerprint. The
 * resolved commit + the `next` tarball digest are written into the artifact and
 * deliberately kept OUT of the digest: a legitimate suite bump should be a
 * visible decision, not a silent window reset.
 *
 * SCANNED, NOT ENUMERATED. The roots below are directories + patterns, not a
 * file list: a newly-added `scripts/e2e-*.sh`, a second manifest lane, or a
 * fourth packed package moves the digest with no edit here. An enumerated list
 * is how the second file gets missed.
 *
 * NOT in the frozen set: `scripts/compat-smoke.mjs` and `ci.yml` — a DIFFERENT
 * gate, PR-time and app-side. Confusing the two is the likeliest way to widen
 * this scope by accident.
 *
 * PER-CELL WORKFLOW ENTRY (#1294). The harness has exactly one `harness` file
 * entry — the workflow that EXECUTED — but which *file* that is depends on the
 * lane: the node and bun (turbopack) cells run from `test-e2e-deploy.yml`, the
 * vinext cells from `compat-vinext.yml`. Before this, the entry was hardcoded
 * to `test-e2e-deploy.yml` for every lane, so an edit to `compat-vinext.yml`
 * never moved the vinext cells' fingerprint — the changed harness could carry
 * a 14-night window, which violates ADR-0056 D3. `--lane` selects the entry
 * from the ONE declared table (`CREDENTIAL_CELLS.workflowFile`,
 * `scripts/compat-window-audit.mjs`), so a new cell or a moved workflow file
 * cannot silently keep hashing the wrong bytes. Unset, `--lane` defaults to
 * `node` (`CREDENTIAL_LANE`) — the pre-#1294 behaviour, byte-identical.
 *
 * Usage:
 *   node scripts/compat-window-fingerprint.mjs \
 *     --repo-root . --tarballs-dir "$GITHUB_WORKSPACE/knext-tarballs" \
 *     [--lane node|bun|bun-vinext|...] \
 *     [--next-js-dir next.js] [--next-tarball next-prebuilt/next.tgz] \
 *     [--next-ref v16.2.0] \
 *     [--workflow-file knext-executing/.github/workflows/test-e2e-deploy.yml] \
 *     [--out compat-window-fingerprint.json] [--json] [--files]
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
// A REAL parser, not a hand-rolled tokenizer (#1294 round 5). Three
// successive rounds each found a new hole in a hand-written JS tokenizer
// (round 3: raw regex over untokenized source; round 4: no regex-literal
// state, then a staleness bug in the FIX for that; round 5: keywords like
// `return` treated as operands, and no template-literal awareness) — the
// review named it directly as the successive-round regression class this
// repo's own workflow docs warn about. `typescript` is already a root
// devDependency (used the same way by scripts/lib/parse-validity.mjs,
// executable-lines.mjs, continuation-attribution.mjs) and is resolved the
// same way here: a plain static import, so a missing package fails the
// whole module load loudly (Node's own `ERR_MODULE_NOT_FOUND`) rather than
// silently guessing — the workflow install step order is verified in
// tests/compat-window-fingerprint.test.ts and this file's own header notes.
import ts from 'typescript';
import { CREDENTIAL_CELLS, CREDENTIAL_LANE } from './compat-window-audit.mjs';

export const SCHEMA = 'knext.compat-window-fingerprint/v1';

/**
 * The frozen HARNESS roots that are the SAME for every cell — the shared half
 * of the digest (ADR-0056 D2 note: narrowing this per cell is an ADR-0039
 * scope change, left to the founder, not decided here). Each `dir` root is
 * SCANNED (recursively) and filtered by `match`, so the set grows with the
 * tree rather than with edits to this file. The per-lane WORKFLOW entry is
 * NOT here — see `workflowRootForLane` below (#1294).
 *
 * @type {{ kind: 'file' | 'dir', path: string, match?: RegExp }[]}
 */
export const HARNESS_ROOTS = [
  // The lifecycle scripts the reference harness invokes
  // (NEXT_TEST_DEPLOY_SCRIPT_PATH and friends) plus the preflight/summary/ledger
  // helpers the workflow runs around them. These are the ENTRY POINTS for the
  // import/source closure below (#1294 round 2) — not the whole frozen set by
  // themselves.
  { kind: 'dir', path: 'scripts', match: /^e2e-[^/]*\.(sh|mjs|cjs|js)$/, isClosureEntry: true },
  // The deploy-tests manifest(s): the exclude ledger that decides what the
  // night actually selected. A second lane manifest is picked up automatically.
  //
  // #1301 review round 1: EXCLUDES `deploy-tests-manifest.smoke.knext.json`
  // (the negative lookahead) — that manifest is read ONLY on a
  // workflow_dispatch `smoke=true` run (test-e2e-deploy.yml's
  // KNEXT_DEPLOY_MANIFEST decision), which by construction can never be a
  // credential or early-warning night (github.event.inputs is empty on every
  // `schedule` event). Before this exclusion, an edit to the smoke manifest —
  // which no credential night ever reads — moved every cell's fingerprint and
  // could spuriously "unfreeze" a banked window over a file with zero effect
  // on what a credential night actually selects.
  { kind: 'dir', path: 'test', match: /^deploy-tests-manifest\.(?!smoke\.)[^/]*\.json$/ },
];

/**
 * Local (`./…`/`../…`) import specifiers a JS file ACTUALLY imports, via a
 * REAL parser — never a hand-rolled tokenizer (#1294 round 5).
 *
 * Rounds 3 and 4 each found a new hole in a hand-written JS tokenizer: round
 * 3, a raw regex over UNtokenized source (a comment mentioning import-like
 * text hard-errored the whole fingerprint); round 4, no regex-literal state
 * at all (a regex containing a quote character got misread as a string
 * start), then a staleness bug in the FIX for that. Round 5's review named
 * the pattern directly — "each round has found a new hole in the hand-rolled
 * tokenizer, which is the successive-round regression class" — and found two
 * more: `isRegexPosition` treated JS KEYWORDS (`return`, `typeof`, …) as
 * operands (so `return /'/.test(s)` mis-scanned exactly like the round-4
 * bug), and nested TEMPLATE LITERAL interpolation (`` `${a ? `'` : ""}` ``)
 * was never modelled at all. A hand tokenizer cannot be patched into
 * soundness one review at a time; a REAL parser handles all of this by
 * construction, because it is not guessing.
 *
 * Extracts specifiers from: `import … from '…'`, `export … from '…'`, bare
 * `import '…'`, `require('…')`, and dynamic `import('…')` — anywhere in the
 * file, at any nesting depth, via a full AST walk (`ts.forEachChild`).
 *
 * FAILS CLOSED on a NON-LITERAL specifier (round 5: "fail closed on
 * non-literal specifiers that could be relative"): `require(x)`,
 * `import(\`./${x}\`)`, `require(cond ? './a' : './b')` are all hard errors.
 * A computed specifier MIGHT be relative — silently skipping it (as
 * `ts.isStringLiteralLike` naturally would, by just finding no specs there)
 * would reopen exactly the "silently unfrozen dependency" failure mode this
 * whole mechanism exists to close, just moved one layer up. Deliberately
 * scoped to bare `require(`/`import(` — `require.resolve(x)` is a RESOLVE
 * call, not a module load that adds a dependency to this closure (and the
 * real corpus already has one: `scripts/e2e-preflight.mjs`'s
 * `require.resolve(ADAPTER_SUBPATH)`, a non-literal argument that must NOT
 * trip this check).
 *
 * @param {string} src
 * @param {string} absPath used for the parser's `fileName` and error text
 * @returns {string[]} every relative (`./…`/`../…`) specifier found
 */
function jsLocalImportSpecifiers(src, absPath) {
  // `ts.createSourceFile` is ERROR-TOLERANT by design (it powers editor
  // tooling, which must produce SOME AST for a file mid-edit) — an
  // unterminated string or regex does not throw, it recovers a best-effort
  // parse. That is the right behaviour for an editor and the wrong one here:
  // silently walking a recovered-but-wrong AST is exactly the "guess instead
  // of refusing" failure mode this whole mechanism exists to close. So parse
  // TWICE: once via `transpileModule` (the same syntax-only check
  // `scripts/lib/parse-validity.mjs` already uses elsewhere in this repo)
  // purely to FAIL CLOSED on any syntax error, then the real walk below.
  const syntaxErrors = ts
    .transpileModule(src, {
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
    })
    .diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (syntaxErrors.length > 0) {
    const first = ts.flattenDiagnosticMessageText(syntaxErrors[0].messageText, ' ');
    throw new Error(
      `compat-window fingerprint: ${absPath} does not parse as JavaScript: ${first}. A file that cannot be parsed cannot be scanned for dependencies — refusing to guess (#1294 round 5).`,
    );
  }

  const sourceFile = ts.createSourceFile(
    absPath,
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.JS,
  );

  /** @type {string[]} */
  const specs = [];

  const isDynamicImportCall = (node) =>
    ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;

  // ── aliased require / createRequire / module.require / import.meta.require
  // (#1316, hardened #1388 review) ─────────────────────────────────────────
  // A call whose callee is LITERALLY the identifier `require` is not the
  // only way to reach a relative path. Real JS idioms defeat a literal-name
  // check on purpose or by accident, and every one previously returned []
  // SILENTLY — a closure file reaching a relative path through any of them
  // dropped straight out of the frozen set with no error at all, the same
  // "silently unfrozen dependency" failure mode #1294 round 5 closed for
  // non-literal specifiers:
  //
  //   const r = require; r('./x');                          // plain alias
  //   import { createRequire as cr } from 'node:module';     // ALIASED import
  //   const req = cr(import.meta.url); req('./x');
  //   const a = require; const b = a; b('./x');               // TWO-LEVEL alias
  //   require.call(null, './x'); req.call(null, './x');       // .call/.apply/.bind
  //   module.require('./x');
  //   import.meta.require('./x');                             // Bun-specific
  //
  // `require`/`module.require` (and any NAME transitively aliased to one of
  // them) resolve against the FILE'S OWN directory — same base this scanner
  // already assumes — so calling one directly is handled exactly like a bare
  // `require()` call once spotted. `createRequire(...)` (or any name
  // transitively aliased to `createRequire` ITSELF, e.g. an import alias),
  // however, binds a NEW require function resolved against WHATEVER BASE URL
  // its caller supplied — almost always NOT this file's directory — so a
  // relative-looking literal reached through a createRequire-DERIVED name
  // cannot be safely resolved; it fails closed rather than guess wrong. A
  // createRequire-derived function used only for `.resolve()` calls (the one
  // real-corpus case today, scripts/e2e-preflight.mjs) is left alone —
  // `.resolve()`/`.cache` were never treated as a module load even for plain
  // `require`. ANY OTHER property access on a tracked name — `.call`,
  // `.apply`, `.bind`, or anything else — fails closed: none of those are
  // resolvable as "not a module load" the way `.resolve`/`.cache` are, and
  // guessing they're harmless is exactly the failure mode this exists to
  // close. `import.meta.require(...)` (Bun) is Bun-specific and its
  // resolution base is not this scanner's file-relative model either — it
  // ALWAYS fails closed, unconditionally, never tracked as an alias target.
  //
  // First pass: three Sets of tracked NAMES, resolved to a FIXPOINT so a
  // chain of plain aliases (`const a = require; const b = a;`) is followed
  // however deep it goes, not just one hop.
  //   requireLikeNames         — calling this resolves relative to the FILE'S
  //                               OWN directory (seeded with 'require').
  //   createRequireFnNames     — this IS the createRequire factory itself,
  //                               under whatever local name (seeded with
  //                               'createRequire'; import aliasing adds more).
  //   createRequireDerivedNames — the RESULT of calling a createRequireFnNames
  //                               member — resolves against a caller-supplied,
  //                               untrusted-by-this-scanner base.
  const requireLikeNames = new Set(['require']);
  const createRequireFnNames = new Set(['createRequire']);
  const createRequireDerivedNames = new Set();
  // Names bound to the `node:module` NAMESPACE OBJECT itself (not a specific
  // export of it) — `import * as mod from 'node:module'`, `import mod from
  // 'node:module'`, or `const mod = require('node:module')`. A COMPUTED
  // (bracket) access on one of these with a non-literal key can reach
  // `createRequire`/`require` (or anything else on the namespace) without
  // ever using a string literal this scanner could compare against, so it
  // is invisible to every literal-key check above it (#1388/#1392 review;
  // techdebt-3 round).
  const nodeModuleBindingNames = new Set();
  // #1388 round 5 — STRING-TO-KEY channels. A non-literal computed key on a
  // global object (`globalThis['req'+'uire']`) or on `process`
  // (`process[k]` → getBuiltinModule) names ANY property through a string
  // this scanner cannot read, so enumerating spellings of `require` can
  // never close it. Seeded with the ambient roots; the alias fixpoint below
  // grows it (`const g = globalThis`, `const { process: p } = globalThis`).
  const ambientRootNames = new Set(['globalThis', 'global', 'self', 'window', 'process']);
  // Locals bound to a `getBuiltinModule(...)` RESULT (`const fs =
  // process.getBuiltinModule('fs')`) — a non-literal key on one reaches any
  // export of that builtin.
  const builtinModuleResultNames = new Set();
  // #1388 round 5 — STRING-TO-CODE channels. `eval` and `Function` turn a
  // string into code, and that string can spell `require` any way it likes
  // (`eval('req'+'uire')`, `new Function('return require')()`). No AST check
  // can read a computed string, so ANY reference to either identifier —
  // callee, indirect `(0, eval)`, `globalThis.eval`, a `{ eval: true }`
  // option key (worker_threads) — fails closed.
  const STRING_CODE_IDENTIFIERS = new Set(['eval', 'Function']);
  // A LITERAL bracket key naming one of these reaches the same place as the
  // identifier would — `x['eval']` has no Identifier node for the check above.
  const BRACKET_TRACKED_KEYS = new Set([
    'require',
    'createRequire',
    ...STRING_CODE_IDENTIFIERS,
    'getBuiltinModule',
    'constructor',
  ]);
  const isVmSpecifierText = (text) => text === 'vm' || text === 'node:vm';

  const isNodeModuleSpecifierText = (text) => text === 'node:module' || text === 'module';

  /** `X.getBuiltinModule` or a bare `getBuiltinModule` — the callee of a getBuiltinModule call. */
  const isGetBuiltinModuleCallee = (expr) =>
    (ts.isIdentifier(expr) && expr.text === 'getBuiltinModule') ||
    (ts.isPropertyAccessExpression(expr) && expr.name.text === 'getBuiltinModule');
  const isGetBuiltinModuleCall = (node) =>
    ts.isCallExpression(node) && isGetBuiltinModuleCallee(node.expression);
  const unwrapParens = (node) => {
    let n = node;
    while (ts.isParenthesizedExpression(n)) n = n.expression;
    return n;
  };
  /**
   * An expression that evaluates to an ambient root (a global object or
   * `process`): a tracked identifier, or a chain of ambient-root-NAMED
   * property accesses on one (`globalThis.process`, `global['globalThis']`).
   */
  const isAmbientRootExpr = (node) => {
    const n = unwrapParens(node);
    if (ts.isIdentifier(n)) return ambientRootNames.has(n.text);
    if (ts.isPropertyAccessExpression(n)) {
      return ambientRootNames.has(n.name.text) && isAmbientRootExpr(n.expression);
    }
    if (
      ts.isElementAccessExpression(n) &&
      n.argumentExpression &&
      ts.isStringLiteralLike(n.argumentExpression)
    ) {
      return ambientRootNames.has(n.argumentExpression.text) && isAmbientRootExpr(n.expression);
    }
    return false;
  };
  const isBuiltinModuleResultExpr = (node) => {
    const n = unwrapParens(node);
    return (
      isGetBuiltinModuleCall(n) || (ts.isIdentifier(n) && builtinModuleResultNames.has(n.text))
    );
  };
  /** `Symbol.for(<string literal>)` — a registry symbol. */
  const isSymbolForLiteralCall = (node) => {
    const n = unwrapParens(node);
    return (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === 'Symbol' &&
      n.expression.name.text === 'for' &&
      n.arguments.length === 1 &&
      ts.isStringLiteralLike(n.arguments[0])
    );
  };
  // #1388 round 6 (d) — `const K = Symbol.for('knext.lib.x')`. ADR-0027
  // MANDATES this seam shape in packages/lib (a `globalThis` slot keyed by a
  // registry symbol). A SYMBOL key can never name `require`/`eval`/`Function`
  // (those are string-keyed), so it is exempt from every non-literal-key rule.
  // Only a `const` binding counts — a `let`/`var` can be re-assigned a string.
  const symbolForKeyNames = new Set();
  const collectSymbolForKeys = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isSymbolForLiteralCall(node.initializer) &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      symbolForKeyNames.add(node.name.text);
    }
    ts.forEachChild(node, collectSymbolForKeys);
  };
  collectSymbolForKeys(sourceFile);
  /**
   * A key a static scan can read: a string/number literal, or a registry
   * symbol (`Symbol.for(<literal>)`, inline or const-bound — #1388 round 6
   * (d)). Anything else names a property through a value.
   */
  const isLiteralKey = (expr) =>
    !!expr &&
    (ts.isStringLiteralLike(expr) ||
      ts.isNumericLiteral(expr) ||
      isSymbolForLiteralCall(expr) ||
      (ts.isIdentifier(expr) && symbolForKeyNames.has(expr.text)));
  /**
   * The STRING a key expression statically evaluates to, if it is built only
   * from literals (`'constr' + 'uctor'`) — else undefined. Lets a concatenated
   * key be compared against the tracked names instead of slipping past a
   * literal-only comparison (#1388 round 6 (b)).
   */
  const foldStringKey = (node) => {
    const n = unwrapParens(node);
    if (ts.isStringLiteralLike(n) || ts.isNumericLiteral(n)) return n.text;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = foldStringKey(n.left);
      const r = foldStringKey(n.right);
      return l === undefined || r === undefined ? undefined : l + r;
    }
    return undefined;
  };
  // #1388 round 6 (a) — REFLECTIVE channels. Handed a global object (or a
  // getBuiltinModule() result), each of these reaches any property of it —
  // `require`, `getBuiltinModule`, `eval` — through a key no scan can read,
  // exactly like the bracket form round 5 closed.
  const REFLECTIVE_APIS = new Map([
    ['Reflect', new Set(['get', 'getOwnPropertyDescriptor', 'ownKeys'])],
    [
      'Object',
      new Set([
        'getOwnPropertyDescriptor',
        'getOwnPropertyDescriptors',
        'getOwnPropertyNames',
        'entries',
        'values',
        'keys',
        'assign',
      ]),
    ],
  ]);
  /** The reflective API a call's callee names (`Reflect.get`, `Object['entries']`), or undefined. */
  const reflectiveApiName = (call) => {
    if (!ts.isCallExpression(call)) return undefined;
    const callee = unwrapParens(call.expression);
    let base;
    let member;
    if (ts.isPropertyAccessExpression(callee)) {
      base = callee.expression;
      member = callee.name.text;
    } else if (ts.isElementAccessExpression(callee) && callee.argumentExpression) {
      base = callee.expression;
      member = foldStringKey(callee.argumentExpression);
    }
    if (!base || member === undefined || !ts.isIdentifier(base)) return undefined;
    return REFLECTIVE_APIS.get(base.text)?.has(member) ? `${base.text}.${member}` : undefined;
  };
  /** The reflective APIs whose SECOND argument is a property key on the first. */
  const KEYED_REFLECTIVE_APIS = new Set([
    'Reflect.get',
    'Reflect.getOwnPropertyDescriptor',
    'Object.getOwnPropertyDescriptor',
  ]);
  // #1388 round 6 (b) — `fn.constructor` IS `Function`, and every function
  // (and `Object`, `Array`, …) carries it. Names bound to a function-valued
  // expression are tracked so a non-literal key on one fails closed.
  const WELL_KNOWN_CONSTRUCTORS = new Set([
    'Object',
    'Function',
    'Array',
    'String',
    'Number',
    'Boolean',
    'Symbol',
    'BigInt',
    'Promise',
    'Map',
    'Set',
    'WeakMap',
    'WeakSet',
    'Date',
    'RegExp',
    'Error',
    'Proxy',
    'Reflect',
    'URL',
    'Buffer',
  ]);
  const functionishNames = new Set();
  /** `Object.getPrototypeOf(...)` / `Reflect.getPrototypeOf(...)` — a prototype object. */
  const isGetPrototypeOfCall = (n) =>
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    ts.isIdentifier(n.expression.expression) &&
    (n.expression.expression.text === 'Object' || n.expression.expression.text === 'Reflect') &&
    n.expression.name.text === 'getPrototypeOf';
  /** An expression evaluating to a function or a prototype object — one hop from `Function`. */
  const isFunctionishExpr = (node) => {
    const n = unwrapParens(node);
    return (
      ts.isArrowFunction(n) ||
      ts.isFunctionExpression(n) ||
      ts.isClassExpression(n) ||
      isGetPrototypeOfCall(n) ||
      (ts.isPropertyAccessExpression(n) &&
        (n.name.text === 'prototype' || n.name.text === '__proto__')) ||
      (ts.isElementAccessExpression(n) &&
        !!n.argumentExpression &&
        (foldStringKey(n.argumentExpression) === 'prototype' ||
          foldStringKey(n.argumentExpression) === '__proto__')) ||
      (ts.isIdentifier(n) && (functionishNames.has(n.text) || WELL_KNOWN_CONSTRUCTORS.has(n.text)))
    );
  };
  const collectFunctionishDeclarations = (node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      functionishNames.add(node.name.text);
    }
    ts.forEachChild(node, collectFunctionishDeclarations);
  };
  collectFunctionishDeclarations(sourceFile);

  // Import aliasing (`import { createRequire as cr } from 'node:module'`)
  // and node:module namespace/default bindings: one pass — an import
  // specifier/clause's local name is a fresh binding, never itself the RHS
  // of another import, so this never needs to iterate.
  const collectImportAliases = (node) => {
    if (ts.isImportSpecifier(node)) {
      const importedName = (node.propertyName ?? node.name).text;
      if (importedName === 'createRequire') createRequireFnNames.add(node.name.text);
    } else if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      isNodeModuleSpecifierText(node.moduleSpecifier.text) &&
      node.importClause
    ) {
      const clause = node.importClause;
      if (clause.name) nodeModuleBindingNames.add(clause.name.text); // default import
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        nodeModuleBindingNames.add(clause.namedBindings.name.text); // `import * as mod`
      }
    }
    ts.forEachChild(node, collectImportAliases);
  };
  collectImportAliases(sourceFile);

  // Alias-chain fixpoint: `const X = <tracked-name>` (plain reference) or
  // `const X = <createRequireFnNames-member>(...)` (a fresh createRequire
  // call) grows the tracked sets; repeat until a full pass adds nothing, so
  // `const a = require; const b = a; const c = b;` tracks all three, not
  // just `a`.
  let grew = true;
  while (grew) {
    grew = false;
    const pass = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        isFunctionishExpr(node.initializer) &&
        !functionishNames.has(node.name.text)
      ) {
        // #1388 round 6 (b) — `const f = () => 0`, `const p = Object.getPrototypeOf(f)`, `const g = f`.
        functionishNames.add(node.name.text);
        grew = true;
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const name = node.name.text;
        const init = node.initializer;
        if (ts.isIdentifier(init)) {
          const initName = init.text;
          if (requireLikeNames.has(initName) && !requireLikeNames.has(name)) {
            requireLikeNames.add(name);
            grew = true;
          }
          if (createRequireFnNames.has(initName) && !createRequireFnNames.has(name)) {
            createRequireFnNames.add(name);
            grew = true;
          }
          if (createRequireDerivedNames.has(initName) && !createRequireDerivedNames.has(name)) {
            createRequireDerivedNames.add(name);
            grew = true;
          }
          if (nodeModuleBindingNames.has(initName) && !nodeModuleBindingNames.has(name)) {
            nodeModuleBindingNames.add(name);
            grew = true;
          }
          if (ambientRootNames.has(initName) && !ambientRootNames.has(name)) {
            ambientRootNames.add(name);
            grew = true;
          }
          if (builtinModuleResultNames.has(initName) && !builtinModuleResultNames.has(name)) {
            builtinModuleResultNames.add(name);
            grew = true;
          }
        } else if (isAmbientRootExpr(init) && !ambientRootNames.has(name)) {
          // `const p = globalThis.process` — an alias through a property chain.
          ambientRootNames.add(name);
          grew = true;
        } else if (isGetBuiltinModuleCall(init) && !builtinModuleResultNames.has(name)) {
          builtinModuleResultNames.add(name);
          grew = true;
        } else if (
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          createRequireFnNames.has(init.expression.text) &&
          !createRequireDerivedNames.has(name)
        ) {
          createRequireDerivedNames.add(name);
          grew = true;
        } else if (
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          requireLikeNames.has(init.expression.text) &&
          init.arguments[0] &&
          ts.isStringLiteralLike(init.arguments[0]) &&
          isNodeModuleSpecifierText(init.arguments[0].text) &&
          !nodeModuleBindingNames.has(name)
        ) {
          // `const mod = require('node:module')` — binds the whole
          // namespace object, not a specific export.
          nodeModuleBindingNames.add(name);
          grew = true;
        }
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        isAmbientRootExpr(node.initializer)
      ) {
        // `const { process: p } = globalThis` — a DESTRUCTURED ambient root.
        for (const el of node.name.elements) {
          const key = el.propertyName ?? el.name;
          const keyText =
            ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
          if (
            keyText !== undefined &&
            ambientRootNames.has(keyText) &&
            ts.isIdentifier(el.name) &&
            !ambientRootNames.has(el.name.text)
          ) {
            ambientRootNames.add(el.name.text);
            grew = true;
          }
        }
      }
      ts.forEachChild(node, pass);
    };
    pass(sourceFile);
  }

  const failClosed = (node, reason) => {
    const { line: lineNumber } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    throw new Error(
      `compat-window fingerprint: ${absPath}:${lineNumber + 1} ${reason} — refusing to guess whether it reaches a relative path (#1316/#1388).`,
    );
  };

  /** `<tracked-name>.resolve(...)` — a RESOLVE, never a module load. */
  const isResolveCall = (node) =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    (requireLikeNames.has(node.expression.expression.text) ||
      createRequireFnNames.has(node.expression.expression.text) ||
      createRequireDerivedNames.has(node.expression.expression.text)) &&
    node.expression.name.text === 'resolve';
  /** The ONLY two property names a tracked identifier may be accessed by without failing closed. */
  const isAllowedPropertyAccessBase = (node) =>
    !!node.parent &&
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.expression === node &&
    (node.parent.name.text === 'resolve' || node.parent.name.text === 'cache');
  const isModuleDotRequireCall = (node) =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'module' &&
    node.expression.name.text === 'require';
  /** `import.meta.require(...)` — Bun-specific; ALWAYS fails closed. */
  const isImportMetaRequireCall = (node) =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isMetaProperty(node.expression.expression) &&
    node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.expression.name.text === 'meta' &&
    node.expression.name.text === 'require';
  const isRequireLikeCall = (node) =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    requireLikeNames.has(node.expression.text);
  const isCreateRequireDerivedCall = (node) =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    createRequireDerivedNames.has(node.expression.text);
  const isCreateRequireFnCall = (node) =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    createRequireFnNames.has(node.expression.text);
  // `import { createRequire } from 'node:module'` (and the default/namespace/
  // aliased forms) bind a NAME, but the binding site itself never reaches a
  // relative path — only a later CALL can. Only the import SPECIFIER's name
  // is exempt here; every other reference is still governed by the checks
  // below.
  const isImportBindingName = (node) =>
    !!node.parent &&
    ((ts.isImportSpecifier(node.parent) &&
      (node.parent.name === node || node.parent.propertyName === node)) ||
      (ts.isImportClause(node.parent) && node.parent.name === node) ||
      (ts.isNamespaceImport(node.parent) && node.parent.name === node));
  /**
   * The RHS of `const Y = X` (a plain reference alias) or the LHS binding
   * name of `const X = require`/`createRequire(...)` — both exempt; tracked
   * by the fixpoint pass above. Requires the declared NAME to be a plain
   * Identifier, not a BindingPattern (round-4 finding): without that,
   * `const { createRequire } = mod;` — a DESTRUCTURE, not a plain alias —
   * matched here too (`node.parent.initializer === node` is true regardless
   * of what `node.parent.name` is), silently exempting an extraction shape
   * the fixpoint pass above never actually tracks.
   */
  const isAliasDeclarationSite = (node) =>
    !!node.parent &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name) &&
    (node.parent.initializer === node || node.parent.name === node);
  /**
   * `<anything>['require']` / `<anything>['createRequire']` (or any other
   * computed access whose string-literal key names a require-like or
   * createRequire fn/derived NAME this scanner knows about) — a computed
   * (bracket) property access. This scanner only ever resolves literal
   * `.name` property access (`.resolve`, `.cache`, `module.require`); a
   * bracket access never reaches the identifier-reference branch at all
   * (its key is a StringLiteral, not an Identifier node), so without this
   * check it is invisible to every rule above — not exempted, just never
   * seen (#1392 review round).
   */
  const isTrackedBracketPropertyAccess = (node) =>
    ts.isElementAccessExpression(node) &&
    !!node.argumentExpression &&
    BRACKET_TRACKED_KEYS.has(foldStringKey(node.argumentExpression));
  /**
   * A computed key this scanner cannot evaluate at all — neither a literal /
   * registry symbol (`isLiteralKey`) nor a constant-foldable string
   * (`foldStringKey`, compared against the tracked names separately).
   */
  const isUnknownKey = (expr) => !!expr && !isLiteralKey(expr) && foldStringKey(expr) === undefined;
  /**
   * #1388 round 6 (a') — a global object used as a VALUE: anywhere other than
   * the base of a property/element access, an alias or destructuring
   * declaration (both tracked above), a `typeof` operand, an equality
   * comparison, or the right side of `in`. Handed to anything else — a
   * helper, an aliased `Reflect.get`, `Object.assign`, a spread — any
   * property of it is reachable through a key no scan can read.
   */
  const isDeclarationOrLabelName = (node) => {
    const p = node.parent;
    if (!p || ts.isShorthandPropertyAssignment(p)) return false; // `{ process }` is a VALUE reference
    return p.name === node || p.propertyName === node;
  };
  const EQUALITY_OPERATORS = new Set([
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
  ]);
  const isAmbientRootEscape = (node) => {
    if (
      !(
        ts.isIdentifier(node) ||
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node) ||
        ts.isParenthesizedExpression(node)
      )
    ) {
      return false;
    }
    if (ts.isIdentifier(node) && isDeclarationOrLabelName(node)) return false;
    if (!isAmbientRootExpr(node)) return false;
    const p = node.parent;
    if (!p || ts.isParenthesizedExpression(p)) return false; // judged at the outer paren
    if (
      (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) &&
      p.expression === node
    ) {
      return false;
    }
    if (
      ts.isVariableDeclaration(p) &&
      p.initializer === node &&
      (ts.isIdentifier(p.name) || ts.isObjectBindingPattern(p.name))
    ) {
      return false;
    }
    if (ts.isTypeOfExpression(p)) return false;
    if (ts.isBinaryExpression(p)) {
      if (EQUALITY_OPERATORS.has(p.operatorToken.kind)) return false;
      if (p.operatorToken.kind === ts.SyntaxKind.InKeyword && p.right === node) return false;
    }
    return true;
  };
  const DATA_OR_BLOB_URL = /^\s*(data|blob):/i;
  /**
   * `await import('node:module')` used INLINE, as the base of a further
   * access, with no name ever bound to it at all — e.g.
   * `(await import('node:module'))[k](...)`. Every other node:module check
   * in this file keys off a tracked IDENTIFIER (`nodeModuleBindingNames`);
   * this expression form has none, so without recognising it directly it
   * is invisible even to the checks below (round-4 finding).
   */
  const isInlineNodeModuleDynamicImport = (node) => {
    // `(await import('node:module'))[k]` parenthesizes the AwaitExpression
    // — unwrap any ParenthesizedExpression wrapper before checking, or this
    // never matches at all (the ElementAccessExpression's `.expression` is
    // the ParenthesizedExpression, never the AwaitExpression directly).
    let unwrapped = node;
    while (ts.isParenthesizedExpression(unwrapped)) unwrapped = unwrapped.expression;
    return (
      ts.isAwaitExpression(unwrapped) &&
      ts.isCallExpression(unwrapped.expression) &&
      unwrapped.expression.expression.kind === ts.SyntaxKind.ImportKeyword &&
      !!unwrapped.expression.arguments[0] &&
      ts.isStringLiteralLike(unwrapped.expression.arguments[0]) &&
      isNodeModuleSpecifierText(unwrapped.expression.arguments[0].text)
    );
  };
  /** Either a tracked node:module-bound identifier OR the inline `await import('node:module')` expression form above — the two bases `isNonLiteralElementAccessOnModuleBinding` and the strict createRequire-only check below both need to recognise. */
  const isNodeModuleNamespaceExpr = (node) =>
    (ts.isIdentifier(node) && nodeModuleBindingNames.has(node.text)) ||
    isInlineNodeModuleDynamicImport(node);
  /**
   * A COMPUTED (bracket) access on a node:module NAMESPACE expression
   * (a tracked identifier — `import * as mod`, `import mod`, `const mod =
   * require('node:module')` — OR the inline `await import(...)` form above)
   * whose key is NOT a string literal — e.g. `const k = 'createRequire';
   * mod[k](...)`. The key can't be compared against
   * 'require'/'createRequire' at all, so without this check it is invisible
   * to `isTrackedBracketPropertyAccess` above AND to every literal-name
   * check — not exempted, just never seen (techdebt-3 round; round 4 widened
   * the base to also cover the inline-import form).
   */
  const isNonLiteralElementAccessOnModuleBinding = (node) =>
    ts.isElementAccessExpression(node) &&
    isNodeModuleNamespaceExpr(node.expression) &&
    !!node.argumentExpression &&
    !ts.isStringLiteralLike(node.argumentExpression);
  /**
   * The bare `module` identifier (Node's implicit CJS binding) used in any
   * form other than the base of `module.require(...)` or
   * `module.exports`/`module.exports = ...` — e.g. `const m = module;`,
   * which defeats the LITERAL `module.require`/`module.exports` checks by
   * aliasing the base object first (techdebt-3 round). `module` is never
   * added to any of the tracked-name sets above, so without this it is
   * invisible to every check in this file.
   */
  const isModuleIdentifierAllowedUse = (node) =>
    !!node.parent &&
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.expression === node &&
    (node.parent.name.text === 'require' || node.parent.name.text === 'exports');
  /**
   * `module` used as a PROPERTY-NAME LABEL, never a value reference to the
   * ambient CJS binding — `{ module: 1 }` (an object-literal key) or
   * `o.module` (a property access NAMED "module" on some unrelated object).
   * Both are syntactically an Identifier with text `module`, but neither
   * ever REFERENCES the actual `module` global, so the identifier check
   * below must not fire on them (round-4 finding — the check previously
   * matched by TEXT alone, with no regard for whether the identifier was in
   * label position or value position).
   */
  const isModulePropertyNameLabel = (node) =>
    !!node.parent &&
    ((ts.isPropertyAssignment(node.parent) && node.parent.name === node) ||
      (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
      (ts.isMethodDeclaration(node.parent) && node.parent.name === node) ||
      ((ts.isImportSpecifier(node.parent) || ts.isExportSpecifier(node.parent)) &&
        (node.parent.name === node || node.parent.propertyName === node)));
  /**
   * `module.require` — `require` as a property NAME (not the base) — is
   * exempt ONLY when it is the callee of a DIRECT call, `module.require(
   * ...)`. Round-4 finding: the previous version of this check matched the
   * property NAME's text alone, with no regard for whether the access was
   * actually being CALLED — so `const r = module.require;` (the value
   * taken, never invoked) and `module.require.call(...)` (chained through
   * `.call`, never a direct call) both slipped through as if they were
   * `module.require('./x')` itself.
   */
  const isModuleRequirePropertyNameOfDirectCall = (node) =>
    !!node.parent &&
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.name === node &&
    node.text === 'require' &&
    ts.isIdentifier(node.parent.expression) &&
    node.parent.expression.text === 'module' &&
    !!node.parent.parent &&
    ts.isCallExpression(node.parent.parent) &&
    node.parent.parent.expression === node.parent;
  /**
   * A node:module-bound identifier used as anything OTHER than the base of
   * a DIRECT `.createRequire(...)` call — round-4 finding: the checks so
   * far only caught specific shapes (bracket access, literal or not); any
   * OTHER use — destructuring (`const { createRequire } = mod`, including
   * a renamed destructure), `Reflect.get(mod, 'createRequire')`, an
   * undocumented internal (`mod._load`), or referencing `.createRequire`
   * without calling it — was simply never examined, since none of them
   * reach the identifier-reference branch the way a bare property access
   * does. This closes the general case rather than adding one shape at a
   * time.
   */
  const isNodeModuleBindingAllowedUse = (node) =>
    !!node.parent &&
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.expression === node &&
    node.parent.name.text === 'createRequire' &&
    !!node.parent.parent &&
    ts.isCallExpression(node.parent.parent) &&
    node.parent.parent.expression === node.parent;

  /** @param {ts.Node} node @param {ts.Node} callOrDeclNode */
  const addSpecifier = (node, callOrDeclNode) => {
    if (ts.isStringLiteralLike(node)) {
      if (DATA_OR_BLOB_URL.test(node.text)) {
        // #1388 round 6 (c) — the module's code IS the URL, never a file.
        failClosed(
          callOrDeclNode,
          'imports from a `data:` or `blob:` URL — the loaded code is carried in the specifier itself, never a file this scanner can hash',
        );
      }
      specs.push(node.text);
      return;
    }
    const { line: lineNumber } = sourceFile.getLineAndCharacterOfPosition(
      callOrDeclNode.getStart(sourceFile),
    );
    throw new Error(
      `compat-window fingerprint: ${absPath}:${lineNumber + 1} references a module with a NON-LITERAL specifier. It might be a relative path, and guessing whether it is one is exactly what this refuses to do — rewrite it as a literal string, or hand-declare the dependency (CREDENTIAL_CELLS.extraFiles) (#1294 round 5).`,
    );
  };

  /** @param {ts.Node} node */
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      addSpecifier(node.moduleSpecifier, node);
    } else if (isImportMetaRequireCall(node)) {
      // Bun-specific; its resolution base is not this scanner's file-relative
      // model. Unconditional — never resolved, never tracked as an alias
      // target, regardless of the argument.
      failClosed(
        node,
        'calls import.meta.require(), a Bun-specific form this scanner never resolves',
      );
    } else if (ts.isIdentifier(node) && STRING_CODE_IDENTIFIERS.has(node.text)) {
      // Any position, including a property name (`globalThis.eval`) or an
      // object key — see STRING_CODE_IDENTIFIERS.
      failClosed(
        node,
        `references the \`${node.text}\` identifier — code built from a string can reach require/node:module under a spelling no static scan can read`,
      );
    } else if (ts.isPropertyAccessExpression(node) && node.name.text === 'constructor') {
      // `(() => {}).constructor` IS `Function` (or AsyncFunction) — the same
      // string-to-code channel reached without naming it.
      failClosed(
        node,
        'accesses `.constructor` — on a function that is `Function` itself, a string-to-code channel no static scan can read',
      );
    } else if (
      ts.isStringLiteralLike(node) &&
      isVmSpecifierText(node.text) &&
      !!node.parent &&
      (((ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) &&
        node.parent.moduleSpecifier === node) ||
        (ts.isCallExpression(node.parent) && node.parent.arguments[0] === node))
    ) {
      // node:vm evaluates strings as code — the same channel as eval.
      failClosed(
        node,
        'imports node:vm — it evaluates strings as code, which can reach require/node:module under a spelling no static scan can read',
      );
    } else if (
      ts.isIdentifier(node) &&
      node.text === 'getBuiltinModule' &&
      !(
        node.parent &&
        ((ts.isCallExpression(node.parent) && node.parent.expression === node) ||
          (ts.isPropertyAccessExpression(node.parent) &&
            node.parent.name === node &&
            !!node.parent.parent &&
            ts.isCallExpression(node.parent.parent) &&
            node.parent.parent.expression === node.parent))
      )
    ) {
      failClosed(
        node,
        'references `getBuiltinModule` in a form this scanner does not track — only a direct `process.getBuiltinModule(<literal>)` call is recognised',
      );
    } else if (
      isGetBuiltinModuleCall(node) &&
      !(node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]))
    ) {
      failClosed(
        node,
        'calls getBuiltinModule() with a non-literal argument — this scanner cannot determine which builtin it loads',
      );
    } else if (isGetBuiltinModuleCall(node) && isNodeModuleSpecifierText(node.arguments[0].text)) {
      // node:module reached WITHOUT an import — every createRequire/_load
      // path on it is untracked. Fail closed on the call itself, however
      // the result is used.
      failClosed(
        node,
        'calls getBuiltinModule() for node:module — its createRequire/_load reach relative paths this scanner cannot resolve',
      );
    } else if (
      ts.isElementAccessExpression(node) &&
      !isLiteralKey(node.argumentExpression) &&
      isAmbientRootExpr(node.expression)
    ) {
      failClosed(
        node,
        'uses a non-literal computed (bracket) property access on a global object (globalThis/global/self/window/process, or an alias of one) — the key can name require, eval or getBuiltinModule under any spelling',
      );
    } else if (
      ts.isElementAccessExpression(node) &&
      !isLiteralKey(node.argumentExpression) &&
      isBuiltinModuleResultExpr(node.expression)
    ) {
      failClosed(
        node,
        'uses a non-literal computed (bracket) property access on a getBuiltinModule() result — this scanner cannot determine which export is accessed',
      );
    } else if (
      ts.isBindingElement(node) &&
      node.propertyName &&
      ts.isComputedPropertyName(node.propertyName) &&
      !isLiteralKey(node.propertyName.expression) &&
      ts.isObjectBindingPattern(node.parent) &&
      ts.isVariableDeclaration(node.parent.parent) &&
      !!node.parent.parent.initializer &&
      (isAmbientRootExpr(node.parent.parent.initializer) ||
        isBuiltinModuleResultExpr(node.parent.parent.initializer))
    ) {
      // `const { [k]: r } = globalThis` — the destructuring form of a
      // non-literal bracket key.
      failClosed(
        node,
        `uses a non-literal computed (bracket) property access on ${isAmbientRootExpr(node.parent.parent.initializer) ? 'a global object' : 'a getBuiltinModule() result'} (via a computed destructuring key)`,
      );
    } else if (
      reflectiveApiName(node) &&
      node.arguments.some((a) => isAmbientRootExpr(a) || isBuiltinModuleResultExpr(a))
    ) {
      // #1388 round 6 (a) — the reflective spelling of a non-literal bracket key.
      const onBuiltin = !node.arguments.some((a) => isAmbientRootExpr(a));
      failClosed(
        node,
        `passes ${onBuiltin ? 'a getBuiltinModule() result' : 'a global object (globalThis/global/self/window/process, or an alias of one)'} to the reflective API \`${reflectiveApiName(node)}\` — it reaches any property, including require/eval/getBuiltinModule, by a key no static scan can read`,
      );
    } else if (
      KEYED_REFLECTIVE_APIS.has(reflectiveApiName(node)) &&
      node.arguments[1] &&
      BRACKET_TRACKED_KEYS.has(foldStringKey(node.arguments[1])) &&
      // a node:module binding keeps its own, more specific, message below
      !(node.arguments[0] && isNodeModuleNamespaceExpr(node.arguments[0]))
    ) {
      // #1388 round 6 (b) — `Reflect.get(fnProto, 'constructor')` is `fnProto.constructor`.
      failClosed(
        node,
        `names the tracked key \`${foldStringKey(node.arguments[1])}\` through the reflective API \`${reflectiveApiName(node)}\` — the same channel as a literal \`.${foldStringKey(node.arguments[1])}\` access`,
      );
    } else if (
      KEYED_REFLECTIVE_APIS.has(reflectiveApiName(node)) &&
      node.arguments[0] &&
      isFunctionishExpr(node.arguments[0]) &&
      isUnknownKey(node.arguments[1])
    ) {
      failClosed(
        node,
        `passes a non-literal key on a function or prototype through the reflective API \`${reflectiveApiName(node)}\` — the key can name \`constructor\`, which is \`Function\``,
      );
    } else if (isResolveCall(node)) {
      // Never treated as a dependency — do not descend into its argument.
    } else if (isTrackedBracketPropertyAccess(node)) {
      failClosed(
        node,
        `uses a computed (bracket) property access on a tracked name (\`${foldStringKey(node.argumentExpression)}\`) — this scanner only resolves literal \`.name\` property access`,
      );
    } else if (
      ts.isElementAccessExpression(node) &&
      isUnknownKey(node.argumentExpression) &&
      isFunctionishExpr(node.expression)
    ) {
      // #1388 round 6 (b) — `fn[k]` with k === 'constructor' is `Function`.
      failClosed(
        node,
        'uses a non-literal computed (bracket) property access on a function or prototype — the key can name `constructor`, which is `Function`, a string-to-code channel',
      );
    } else if (isAmbientRootEscape(node)) {
      failClosed(
        node,
        'uses a global object (globalThis/global/self/window/process, or an alias of one) as a value — handed to a helper, an aliased reflective API or a spread, any property of it (require, eval, getBuiltinModule) is reachable by a key no static scan can read',
      );
    } else if (isNonLiteralElementAccessOnModuleBinding(node)) {
      const baseDescription = ts.isIdentifier(node.expression)
        ? `\`${node.expression.text}\`, a name bound to node:module`
        : 'an inline `await import(...)` of node:module';
      failClosed(
        node,
        `uses a non-literal computed (bracket) property access on ${baseDescription} — this scanner cannot determine which export is accessed`,
      );
    } else if (
      ts.isIdentifier(node) &&
      node.text === 'module' &&
      !isModulePropertyNameLabel(node) &&
      !isModuleIdentifierAllowedUse(node)
    ) {
      failClosed(
        node,
        'references the `module` identifier in a form this scanner does not track (only `module.require(...)`/`module.exports` are recognised)',
      );
    } else if (
      ts.isIdentifier(node) &&
      nodeModuleBindingNames.has(node.text) &&
      !isImportBindingName(node) &&
      !isAliasDeclarationSite(node) &&
      !isNodeModuleBindingAllowedUse(node)
    ) {
      failClosed(
        node,
        `uses a name bound to node:module in a form this scanner does not track — only a direct \`.createRequire(...)\` call is recognised (destructuring, Reflect.get, an internal like ._load, or referencing .createRequire without calling it all fail closed here)`,
      );
    } else if (isModuleDotRequireCall(node) || isRequireLikeCall(node)) {
      // Same resolution base as a bare `require()` — handle identically.
      const arg = /** @type {ts.CallExpression} */ (node).arguments[0];
      if (arg) {
        addSpecifier(arg, node);
      } else {
        failClosed(
          node,
          `calls ${isModuleDotRequireCall(node) ? 'module.require()' : 'a require-like function'} with no argument`,
        );
      }
    } else if (isCreateRequireDerivedCall(node)) {
      // A createRequire()-derived function resolves against a DIFFERENT base
      // than this file's own directory (whatever base its caller supplied).
      // A relative-looking literal reached through it cannot be safely
      // resolved by this scanner's file-relative model — fail closed. A
      // literal that is clearly NOT relative (a bare package specifier, the
      // one real-corpus shape) carries no such ambiguity and is left alone.
      const arg = /** @type {ts.CallExpression} */ (node).arguments[0];
      if (!arg) {
        failClosed(node, 'calls a createRequire()-derived function with no argument');
      } else if (!ts.isStringLiteralLike(arg)) {
        failClosed(node, 'calls a createRequire()-derived function with a non-literal specifier');
      } else if (DATA_OR_BLOB_URL.test(arg.text)) {
        addSpecifier(arg, node); // fails closed — #1388 round 6 (c)
      } else if (/^\.\.?\//.test(arg.text)) {
        failClosed(
          node,
          `calls a createRequire()-derived function with the relative-looking specifier '${arg.text}', whose resolution base is NOT this file's own directory`,
        );
      }
      // else: a bare specifier via a createRequire-derived name — no ambiguity, skip.
    } else if (isCreateRequireFnCall(node) && !ts.isVariableDeclaration(node.parent)) {
      // `createRequire(...)` (or an aliased import of it) invoked inline /
      // chained / passed around rather than bound to a tracked local — e.g.
      // `createRequire(u)('./x')`. There is no name to have collected in the
      // alias pass, so this can only be caught here, at the call site itself.
      failClosed(
        node,
        'calls createRequire() (or an alias of it) without binding it to a tracked local (e.g. chained or passed directly)',
      );
    } else if (
      ts.isIdentifier(node) &&
      (requireLikeNames.has(node.text) ||
        createRequireFnNames.has(node.text) ||
        createRequireDerivedNames.has(node.text)) &&
      !isImportBindingName(node) &&
      !isAliasDeclarationSite(node) &&
      !isAllowedPropertyAccessBase(node) &&
      !(node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node) &&
      // `module.require` — `require` (and ONLY the literal name `require`)
      // as the PROPERTY NAME of a DIRECT call, not merely the base. The
      // call site itself is handled by isModuleDotRequireCall; this is just
      // the generic child-walk revisiting the same identifier node.
      // Narrowly scoped to the text `require` (#1392 review round): this
      // used to exempt ANY tracked name used as a property name, so
      // `m.createRequire(...)`, `mod.createRequire`, and
      // `require('node:module').createRequire` all slipped through
      // unexamined — `createRequire` as a property name is not
      // `module.require` and must still fail closed. Round 4: the exemption
      // ALSO used to ignore whether the access was actually CALLED — so
      // `const r = module.require;` (the value taken) and
      // `module.require.call(...)` (chained through `.call`) both slipped
      // through too. Now requires isModuleRequirePropertyNameOfDirectCall,
      // which checks the grandparent is a CallExpression directly invoking
      // `module.require` itself.
      !isModuleRequirePropertyNameOfDirectCall(node)
    ) {
      // A reference to a tracked require-like/createRequire name that is none
      // of: the direct callee of a call (handled above), the base of a
      // `.resolve`/`.cache` property access (left alone, as before), the RHS
      // of a tracked plain-alias declaration or the LHS binding name of one
      // (both tracked by the fixpoint pass above), or an import specifier's
      // binding site. Anything else — `.call`/`.apply`/`.bind`, passed as an
      // argument, assigned to an object property, used in a ternary, etc. —
      // is an untracked way to get at it this scanner cannot follow.
      failClosed(
        node,
        `references \`${node.text}\` in a form this scanner does not track (not a direct call, \`.resolve\`/\`.cache\` access, or a plain alias declaration)`,
      );
    } else if (isDynamicImportCall(node)) {
      const arg = /** @type {ts.CallExpression} */ (node).arguments[0];
      if (arg) {
        addSpecifier(arg, node);
      } else {
        failClosed(node, 'calls import() with no argument');
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specs.filter((raw) => /^\.\.?\//.test(raw));
}

/**
 * Extract this file's DIRECT local dependencies — never third-party or
 * `node:`/bare-specifier imports, only files inside the repo (#1294 round 2).
 *
 * WHY A CLOSURE, NOT A DIRECTORY PATTERN: `scripts/e2e-preflight.mjs` imports
 * `./lib/knext-closure.mjs` and `./lib/workspace-protocol.mjs` — neither
 * carries the `e2e-` prefix a directory-pattern root (`scripts/lib` matched
 * only `e2e-*`) would need to see them, so editing either left the fingerprint
 * unchanged: the same gap class the original #1294 fix closed for
 * `e2e-state-snapshot.sh`, just one level less naming-convention-dependent.
 * SCANNING is only honest when it reaches everything a script actually
 * executes, not everything that happens to be named like it does.
 *
 * @param {string} absPath
 * @returns {string[]} resolved absolute paths of files this one directly
 *   `import`s / `require`s / dynamic-`import()`s (JS) or `source`s / `.`s (sh)
 */
function directLocalDeps(absPath) {
  const src = readFileSync(absPath, 'utf8');
  const dir = dirname(absPath);
  /** @type {string[]} */
  const specs = [];

  if (/\.(mjs|cjs|js)$/.test(absPath)) {
    specs.push(...jsLocalImportSpecifiers(src, absPath));
  } else {
    // Shell: `. "${SCRIPT_DIR}/lib/x.sh"` / `source "${SCRIPT_DIR}/lib/x.sh"`.
    // The `${VAR}/` prefix is always the SCRIPT'S OWN directory by convention
    // here (`SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`), so
    // it resolves the same as a relative import — strip it, resolve from `dir`.
    const shPatterns = [
      /^\s*\.\s+"\$\{[A-Z_]+\}\/([^"]+)"/gm,
      /^\s*source\s+"\$\{[A-Z_]+\}\/([^"]+)"/gm,
    ];
    for (const re of shPatterns) {
      for (const m of src.matchAll(re)) specs.push(`./${m[1]}`);
    }
  }

  /** @type {string[]} */
  const resolved = [];
  for (const spec of specs) {
    const base = join(dir, spec);
    const candidates = /\.[a-z]+$/.test(spec)
      ? [base]
      : [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`];
    const hit = candidates.find((c) => existsSync(c));
    if (!hit) {
      throw new Error(
        `compat-window fingerprint: ${relative(process.cwd(), absPath)} references "${spec}", which does not resolve to a real file. A dependency the frozen set cannot see is a hole in the freeze scope (#1294).`,
      );
    }
    resolved.push(resolve(hit));
  }
  return resolved;
}

/**
 * BFS the import/source closure from a set of entry files (#1294 round 2).
 * Returns every file TRANSITIVELY reached, entries included, deduplicated.
 *
 * @param {string[]} entryAbsPaths
 * @returns {string[]} absolute paths, entries + everything they reach
 */
function closureFrom(entryAbsPaths) {
  const seen = new Set(entryAbsPaths);
  const queue = [...entryAbsPaths];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const dep of directLocalDeps(current)) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return [...seen];
}

/**
 * The lane's frozen WORKFLOW file, `.github/workflows/<basename>` — the one
 * `harness` entry whose SOURCE is per-cell (#1294). Reads the single declared
 * table (`CREDENTIAL_CELLS`, `scripts/compat-window-audit.mjs`) rather than
 * re-declaring the mapping here, so a cell added there cannot be forgotten
 * here. An unknown lane, or a known lane with no workflow wired yet
 * (`workflowFile: null` — node×vinext today), is a hard error: silently
 * falling back to SOME workflow would fingerprint bytes that did not run.
 *
 * @param {string} lane
 * @returns {{ kind: 'file', path: string }}
 */
export function workflowRootForLane(lane) {
  const cell = CREDENTIAL_CELLS.find((c) => c.lane === lane);
  if (!cell) {
    throw new Error(
      `compat-window fingerprint: unknown lane "${lane}". Known lanes: ${CREDENTIAL_CELLS.map((c) => c.lane).join(', ')}.`,
    );
  }
  if (!cell.workflowFile) {
    throw new Error(
      `compat-window fingerprint: lane "${lane}" has no workflowFile wired in CREDENTIAL_CELLS yet — it cannot be fingerprinted until its credential workflow lands.`,
    );
  }
  return { kind: 'file', path: `.github/workflows/${cell.workflowFile}` };
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Recursively list files under `dir`, as paths relative to `dir`, sorted. */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  const visit = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(current, entry.name);
      if (entry.isDirectory()) visit(abs, rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  visit(dir, '');
  return out.sort();
}

/**
 * One digest line per frozen file. The executable bit is part of the identity:
 * a lifecycle script that loses `+x` changes what the night ran.
 */
function line(component, path, absolute) {
  const mode = statSync(absolute).mode & 0o111 ? 'x' : '-';
  return `${component}\t${path}\t${mode}\t${sha256(readFileSync(absolute))}`;
}

/**
 * @param {string} repoRoot
 * @param {string} lane — selects the per-cell workflow entry (#1294),
 *   `workflowRootForLane`.
 * @param {{ workflowFile?: string | null }} [opts]
 *   `workflowFile` — ADR-0039 Amendment 1 (ADR-0056). A credential night checks
 *   out an RC tag, but GitHub runs the DEFAULT BRANCH's workflow file. The
 *   workflow entry must hash the bytes that ran, so they are read from here (a
 *   sparse checkout of `github.workflow_sha`). The entry's path LABEL is
 *   unchanged, so identical bytes give a byte-identical digest. A given but
 *   missing file is a hard error, never a fallback to the checkout's copy.
 *
 * Exported (#1302): this is the ONE declared derivation of "which files a
 * credential night's harness actually executes" — CREDENTIAL_CELLS'
 * `workflowFile`/`extraFiles` plus the real import/source closure, scanned,
 * never hand-enumerated. `scripts/compat-credential-freeze-guard.mjs` reuses
 * it directly (one lane at a time, unioned across every wired-or-not cell
 * that HAS a workflow file) to derive the frozen-file set a PR must not
 * silently move while a credential window is live, rather than re-declaring
 * a second, driftable file list.
 */
export function collectHarness(repoRoot, lane, opts = {}) {
  const roots = [workflowRootForLane(lane), ...HARNESS_ROOTS];
  /** @type {{ component: string, path: string, line: string }[]} */
  const entries = [];
  const addedAbs = new Set();
  /** @type {string[]} entry points for the import/source closure (#1294 round 2) */
  const closureEntries = [];

  const addEntry = (path, abs) => {
    if (addedAbs.has(abs)) return;
    addedAbs.add(abs);
    entries.push({ component: 'harness', path, line: line('harness', path, abs) });
  };

  for (const root of roots) {
    const override = root.kind === 'file' && opts.workflowFile ? resolve(opts.workflowFile) : null;
    const abs = override ?? resolve(repoRoot, root.path);
    if (root.kind === 'file') {
      if (!existsSync(abs)) {
        throw new Error(
          override
            ? `compat-window fingerprint: --workflow-file ${override} is missing. The executing workflow is part of the frozen set; refusing to fall back to the checkout's copy, which did not run (docs/adr/0039 Amendment 1).`
            : `compat-window fingerprint: frozen harness file ${root.path} is missing. A root that resolves to nothing silently shrinks the frozen set — fix the path or amend the freeze scope (docs/adr/0039).`,
        );
      }
      addEntry(root.path, abs);
      continue;
    }
    if (!existsSync(abs)) {
      throw new Error(`compat-window fingerprint: frozen harness root ${root.path}/ is missing`);
    }
    const matched = walk(abs).filter((rel) => (root.match ? root.match.test(rel) : true));
    if (matched.length === 0) {
      throw new Error(
        `compat-window fingerprint: frozen harness root ${root.path}/ matched ZERO files for ${root.match}. An empty root is a fingerprint over nothing.`,
      );
    }
    for (const rel of matched) {
      const fileAbs = resolve(join(abs, rel));
      addEntry(`${root.path}/${rel}`, fileAbs);
      if (root.isClosureEntry) closureEntries.push(fileAbs);
    }
  }

  // #1294 round 3: the DECLARED extras — files the lane's workflow EXECUTES
  // via subprocess (`node knext/scripts/X.mjs` in a `run:` step) or READS
  // directly (a JSON pin), which the import/source closure cannot discover
  // on its own because nothing in the top-level closure-entry scripts
  // references them. `CREDENTIAL_CELLS[lane].extraFiles` is the one declared
  // table this reads. Fed into `closureEntries` BELOW, not added directly:
  // round 4 found that a declared extra can itself import something —
  // `compat-run-ledger.mjs` imports `./compat-credential-ref.mjs` — and a
  // direct `addEntry` (no closure walk) left that transitive import unfrozen
  // even on lanes that declare the ledger script but not the credential-ref
  // one. An extra is exactly as much an entry point as a top-level `e2e-*`
  // script, so it gets the SAME treatment: one closure walk, not two
  // half-mechanisms with different reach.
  const cell = CREDENTIAL_CELLS.find((c) => c.lane === lane);
  for (const relPath of cell?.extraFiles ?? []) {
    const abs = resolve(repoRoot, relPath);
    if (!existsSync(abs)) {
      throw new Error(
        `compat-window fingerprint: lane "${lane}" declares extraFiles entry "${relPath}" (CREDENTIAL_CELLS, scripts/compat-window-audit.mjs), which does not exist. A declared-but-missing file is a hole in the freeze scope (#1294).`,
      );
    }
    addEntry(relPath, abs);
    closureEntries.push(abs);
  }

  // #1294 round 2 (round 4: now ALSO covers the extras above): follow every
  // entry point's LOCAL import/require/import() (JS) and source/`.` (sh)
  // chain, transitively, and freeze whatever it reaches — regardless of
  // filename convention. A directory-pattern root only sees files whose NAME
  // matches; a closure sees everything a script actually EXECUTES, which is
  // the honest claim "the harness is frozen" requires.
  // `scripts/e2e-preflight.mjs` importing `./lib/knext-closure.mjs` (no
  // `e2e-` prefix) is exactly the shape round 2 closed; `compat-run-
  // ledger.mjs` importing `./compat-credential-ref.mjs` (a declared EXTRA
  // importing another file) is the round-4 shape.
  for (const abs of closureFrom(closureEntries)) {
    addEntry(relative(repoRoot, abs), abs);
  }

  return entries;
}

function collectPacked(tarballsDir) {
  const dir = resolve(tarballsDir);
  if (!existsSync(dir)) {
    throw new Error(`compat-window fingerprint: --tarballs-dir ${tarballsDir} does not exist`);
  }
  const tarballs = readdirSync(dir)
    .filter((f) => f.endsWith('.tgz'))
    .sort();
  if (tarballs.length === 0) {
    throw new Error(
      `compat-window fingerprint: no *.tgz in ${tarballsDir}. The packed @getknext/* closure IS the adapter under test; a fingerprint that omits it would stay identical across a night that ran different code. Refusing to emit one.`,
    );
  }

  /** @type {{ component: string, path: string, line: string }[]} */
  const entries = [];
  /** @type {{ tarball: string, name: string, version: string, files: number, sha256: string }[]} */
  const packages = [];

  for (const tarball of tarballs) {
    const stage = mkdtempSync(join(tmpdir(), 'knext-cwfp-'));
    try {
      // Hash the tarball's CONTENTS, never its bytes: gzip embeds an mtime and
      // pnpm pack is not bit-reproducible, so a byte digest would churn nightly
      // and the window would never hold for reasons that are not code changes.
      execFileSync('tar', ['xzf', join(dir, tarball), '-C', stage]);
      const pkgRoot = existsSync(join(stage, 'package')) ? join(stage, 'package') : stage;
      const manifestPath = join(pkgRoot, 'package.json');
      if (!existsSync(manifestPath)) {
        throw new Error(
          `compat-window fingerprint: ${tarball} has no package.json — not an npm tarball`,
        );
      }
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@getknext/')) {
        throw new Error(
          `compat-window fingerprint: ${tarball} packs "${manifest.name}", not an @getknext/* package. The packed set is the adapter under test; a foreign tarball means the pack step drifted.`,
        );
      }

      const files = walk(pkgRoot);
      const pkgLines = files.map((rel) => {
        const path = `${manifest.name}@${manifest.version}/${rel}`;
        return { component: 'packed', path, line: line('packed', path, join(pkgRoot, rel)) };
      });
      entries.push(...pkgLines);
      packages.push({
        tarball,
        name: manifest.name,
        version: manifest.version,
        files: files.length,
        sha256: sha256(pkgLines.map((e) => e.line).join('\n')),
      });
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  return { entries, packages };
}

/**
 * Suite provenance — RECORDED, NEVER DIGESTED.
 *
 * The nightly resolves `NEXTJS_REF` (a git TAG) fresh, and that checkout is the
 * compat suite itself. Recording the resolved commit + the `next` tarball digest
 * makes a retag visible in the log; folding them into the fingerprint would make
 * every legitimate suite bump a silent window reset instead of a decision.
 *
 * A SUPPLIED path that cannot be read is a hard error — recording `null` for a
 * path someone asked us to record would be a fingerprint that quietly forgets.
 *
 * @param {{ nextJsDir?: string | null, nextTarball?: string | null, nextRef?: string | null }} options
 */
function collectSuiteProvenance({ nextJsDir, nextTarball, nextRef }) {
  /** @type {string | null} */
  let nextJsCommit = null;
  if (nextJsDir) {
    if (!existsSync(nextJsDir)) {
      throw new Error(`compat-window fingerprint: --next-js-dir ${nextJsDir} does not exist`);
    }
    nextJsCommit = execFileSync('git', ['-C', nextJsDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  }

  /** @type {string | null} */
  let nextTarballSha256 = null;
  /** @type {number | null} */
  let nextTarballBytes = null;
  if (nextTarball) {
    if (!existsSync(nextTarball)) {
      throw new Error(`compat-window fingerprint: --next-tarball ${nextTarball} does not exist`);
    }
    const bytes = readFileSync(nextTarball);
    nextTarballSha256 = sha256(bytes);
    nextTarballBytes = bytes.length;
  }

  return {
    // Stated in the artifact so a reader cannot mistake these for frozen fields.
    frozen: false,
    note: 'Recorded, not frozen: a suite retag or a next-tarball change does NOT reset the 14-night window. It is a visible decision, made here rather than silently.',
    nextRef: nextRef ?? null,
    nextJsCommit,
    nextTarballSha256,
    nextTarballBytes,
  };
}

/**
 * The observed-runtime component (#1147, window-bun-lane.md rule 4).
 *
 * The bun lane's result is BUILD-DEPENDENT: Bun ≤1.3.14 is deterministically red
 * on the documented edge-fetch / not-found-invariant files, stable 1.4.0 is
 * green, and a canary that ALSO reported `1.4.0` was red — so the version STRING
 * is not a sufficient freeze key. The frozen key is the observed `bun --version`
 * TOGETHER WITH `bun --revision` (the build hash). Folding it into the digest
 * makes any Bun build move restart the streak via the audit's rule-1
 * (fingerprint-identical) check, rather than a human eyeballing it.
 *
 * CRITICAL: this is STRICTLY ADDITIVE. The node lane passes no runtime identity,
 * so `runtimeVersion` and `runtimeRevision` are both absent there, `runtime` is
 * `null`, and the digest string is byte-identical to the pre-#1147 formula — the
 * live node streak is never reset by this code path.
 *
 * @param {{ runtimeVersion?: string | null, runtimeRevision?: string | null }} options
 * @returns {string | null} a `sha256:…` component, or null when no identity was supplied
 */
function collectRuntimeComponent({ runtimeVersion, runtimeRevision }) {
  const version = runtimeVersion == null || runtimeVersion === '' ? null : runtimeVersion;
  const revision = runtimeRevision == null || runtimeRevision === '' ? null : runtimeRevision;
  if (version === null && revision === null) return null;
  // Both halves in the digested line, each labelled, so the identity is legible
  // in the artifact and neither half can be silently dropped.
  return `sha256:${sha256(`version\t${version ?? ''}\nrevision\t${revision ?? ''}`)}`;
}

/**
 * @param {{ repoRoot: string, tarballsDir: string, nextJsDir?: string | null, nextTarball?: string | null, nextRef?: string | null, runtimeVersion?: string | null, runtimeRevision?: string | null, workflowFile?: string | null, lane?: string }} options
 */
export function computeFingerprint({
  repoRoot,
  tarballsDir,
  nextJsDir,
  nextTarball,
  nextRef,
  runtimeVersion,
  runtimeRevision,
  workflowFile,
  // #1294: which cell's workflow entry to hash. Defaults to `CREDENTIAL_LANE`
  // ('node') — the pre-#1294 caller never passed this, and 'node' resolves to
  // the same `test-e2e-deploy.yml` entry the un-lane-aware formula always used,
  // so an un-migrated caller's digest is byte-identical.
  lane = CREDENTIAL_LANE,
}) {
  const harness = collectHarness(repoRoot, lane, { workflowFile });
  const { entries: packed, packages } = collectPacked(tarballsDir);

  const harnessLines = harness.map((e) => e.line).sort();
  const packedLines = packed.map((e) => e.line).sort();
  /** @type {{ harness: string, packed: string, runtime?: string }} */
  const components = {
    harness: `sha256:${sha256(harnessLines.join('\n'))}`,
    packed: `sha256:${sha256(packedLines.join('\n'))}`,
  };

  // The digest string. The `runtime` line is APPENDED only when an identity was
  // supplied (the bun lane), so the node lane's digest is unchanged from the
  // original `${SCHEMA}\n${harness}\n${packed}\n` formula — byte for byte.
  const runtimeComponent = collectRuntimeComponent({ runtimeVersion, runtimeRevision });
  let digestInput = `${SCHEMA}\n${components.harness}\n${components.packed}\n`;
  if (runtimeComponent !== null) {
    components.runtime = runtimeComponent;
    digestInput += `runtime\t${runtimeComponent}\n`;
  }
  const fingerprint = `sha256:${sha256(digestInput)}`;

  return {
    schema: SCHEMA,
    fingerprint,
    components,
    // Outside `fingerprint` by construction: it is derived from `components`
    // only, so nothing under `recorded` can move the digest.
    recorded: {
      suite: collectSuiteProvenance({ nextJsDir, nextTarball, nextRef }),
      // Recorded verbatim (as well as folded) so the observed build is legible
      // in the artifact without re-deriving it from the opaque component hash.
      // On the node lane both are null and nothing is folded.
      runtime: {
        version: runtimeVersion == null || runtimeVersion === '' ? null : runtimeVersion,
        revision: runtimeRevision == null || runtimeRevision === '' ? null : runtimeRevision,
        frozen: runtimeComponent !== null,
      },
    },
    counts: { harness: harness.length, packed: packed.length },
    packages,
    files: [...harness, ...packed].map((e) => ({ component: e.component, path: e.path })),
  };
}

/* c8 ignore start — CLI wrapper */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(`--${name}`);
  const arg = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
  };

  const repoRoot = resolve(arg('repo-root', process.cwd()));
  const tarballsDir = arg('tarballs-dir', null);
  if (!tarballsDir) {
    console.error(
      'compat-window fingerprint: --tarballs-dir is REQUIRED (the packed adapter is half the frozen set)',
    );
    process.exit(2);
  }

  let result;
  try {
    result = computeFingerprint({
      repoRoot,
      tarballsDir,
      // Recorded, not frozen — see collectSuiteProvenance().
      nextJsDir: arg('next-js-dir', null),
      nextTarball: arg('next-tarball', null),
      nextRef: arg('next-ref', null),
      // #1147 (window-bun-lane.md rule 4): the OBSERVED Bun build. Absent on the
      // node lane → nothing folded, node digest unchanged.
      runtimeVersion: arg('runtime-version', null),
      runtimeRevision: arg('runtime-revision', null),
      // ADR-0039 Amendment 1: the workflow file that EXECUTED (github.workflow_sha).
      workflowFile: arg('workflow-file', null),
      // #1294: which cell's workflow entry to hash — defaults to CREDENTIAL_LANE.
      lane: arg('lane', CREDENTIAL_LANE),
    });
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const payload = flag('files') ? result : { ...result, files: undefined };
  const out = arg('out', null);
  if (out) {
    writeFileSync(resolve(out), `${JSON.stringify(result, null, 2)}\n`);
  }
  if (flag('json')) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`compat-window fingerprint: ${result.fingerprint}`);
    console.log(`  harness ${result.components.harness} (${result.counts.harness} files)`);
    console.log(`  packed  ${result.components.packed} (${result.counts.packed} files)`);
    for (const p of result.packages) {
      console.log(`    ${p.name}@${p.version} ${p.sha256} (${p.files} files)`);
    }
    const suite = result.recorded.suite;
    console.log(
      '  suite provenance (RECORDED, not frozen — a bump here does not reset the window):',
    );
    console.log(`    next ref            ${suite.nextRef ?? 'n/a'}`);
    console.log(`    next.js checkout    ${suite.nextJsCommit ?? 'n/a'}`);
    console.log(`    next tarball sha256 ${suite.nextTarballSha256 ?? 'n/a'}`);
    const runtime = result.recorded.runtime;
    if (runtime.frozen) {
      console.log('  observed Bun build (FROZEN — folded into the digest, #1147 rule 4):');
      console.log(`    bun --version   ${runtime.version ?? 'n/a'}`);
      console.log(`    bun --revision  ${runtime.revision ?? 'n/a'}`);
    } else {
      console.log('  runtime identity: none (node lane — nothing folded)');
    }
    if (out) console.log(`  written to ${relative(process.cwd(), resolve(out))}`);
  }
}
/* c8 ignore stop */
