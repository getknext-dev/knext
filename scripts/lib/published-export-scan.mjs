/**
 * published-export-scan.mjs — no `__`-prefixed name may be reachable from a
 * PUBLISHED entry of an `@getknext/*` package (#936).
 *
 * WHAT IS SCANNED, AND WHY IT IS SCANNED RATHER THAN LISTED
 * ---------------------------------------------------------
 * `__setRedisClientForTests` and `__resetEnvForTests` shipped on
 * `@getknext/core/adapters/cache-handler` and repointed process-wide cache
 * state. The repo convention is that a `__`-prefixed export is a test seam, and
 * a test seam must never be part of a published surface. An enumerated list of
 * "the seams" is how the third one ships, so the question asked here is the
 * converse: starting from every file the package's `exports` map (and `main` /
 * `module` / `types`) points at, which names does a consumer reach, and does
 * any of them start with `__`?
 *
 * REACHABILITY, NOT TEXT. The names are read out of the BUILT artifact (`dist`),
 * because that is what ships and what a bundler may have re-shaped:
 *
 *   - `export { __x }`, `export { a as __x }`, and `export { __x as a }` — the
 *     last is the rename that would hide a seam from a name-only check, so a
 *     `__`-prefixed LOCAL name is a finding too, resolved through an
 *     `import { __x as y }` alias;
 *   - `export * from './chunk'` and `export * as ns from './chunk'` are FOLLOWED
 *     (relative files, workspace packages and third-party packages alike);
 *     `export { ns }` of an `import * as ns` is followed the same way;
 *   - CommonJS: `module.exports = { … }`, `exports.x =`, `module.exports.x =`,
 *     `Object.defineProperty / assign / defineProperties(exports, …)`,
 *     `module.exports = require('…')`;
 *   - `.d.ts` / `.d.mts` / `.d.cts` — a type-only seam is still a published seam;
 *   - object-literal default exports (`export default { __x }`).
 *
 * FAIL CLOSED. A construct this reader cannot interpret is a FINDING, never a
 * pass: a computed export name, a `module.exports = <call>`, a re-export of
 * something that does not resolve, a file that does not parse, a file that
 * cannot be read, an `exports` pattern (`./*`), an `exports` target that is
 * missing. A scanner that goes quiet when it cannot see is worse than none,
 * because it reads as a clean bill of health. Add support for the construct
 * (and a case in `tests/published-seam-export-scan.test.ts`) rather than
 * loosening this.
 *
 * WHAT THIS DOES NOT CLAIM. It reads export NAMES and the static re-export graph.
 * It does not follow `const y = __x; export { y }` (a value alias). The
 * convention it enforces is about the names a consumer can write.
 *
 * EXPORTED VALUES ARE OPENED (#2188). The keys of an exported object literal
 * (also one bound to an identifier that is then exported, nested objects, and
 * `Object.freeze({…})`), the static members of an exported class, and the same
 * for CommonJS (`module.exports = o`, `exports.ns = {…}`) are names a consumer
 * reaches as `ns.__k`, so they are findings. A default export whose value cannot
 * be resolved (a call, an imported binding) is unscannable, never clean. A
 * static key written as a bare reference (`static [entityKind]`) is taken to be
 * a symbol and skipped unless it is bound to a string literal in the file.
 * Not followed: members attached after the fact (`K.__x = 1`) and objects
 * exported from an imported binding (`import { o } from './x'; export { o }`).
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

/** The seam prefix. A `__`-prefixed export is a test seam by repo convention. */
export const SEAM_PREFIX = '__';

const DTS_RE = /\.d\.[cm]?ts$/;
const SCANNABLE_RE = /\.(?:[cm]?js|d\.[cm]?ts)$/;

/** @typedef {{ name: string, local?: string, file: string, via: string[] }} ExportEntry */
/** @typedef {{ file: string, reason: string }} ScanError */

/**
 * Parsing and resolution caches, shared across a whole run so a third-party
 * package re-exported by two entries is read once.
 *
 * @typedef {object} Ctx
 * @property {Map<string, ExportEntry[] | 'in-progress'>} memo
 * @property {ScanError[]} errors
 * @property {Map<string, { dir: string, json: any }>} workspace  package name -> its root
 * @property {string} resolveFrom  where bare specifiers are looked up from
 */

/** @returns {Ctx} */
export function createCtx({ resolveFrom, workspace = new Map() }) {
  return { memo: new Map(), errors: [], workspace, resolveFrom };
}

/** @param {Ctx} ctx @param {string} file @param {string} reason */
function fail(ctx, file, reason) {
  ctx.errors.push({ file, reason });
}

// ─── export-map enumeration ─────────────────────────────────────────────────

/**
 * Every file the package publishes as an ENTRY: each target of the `exports`
 * map under EVERY condition (not just the one a particular resolver would pick —
 * a seam parked behind `require` or `types` is still published), plus the legacy
 * `main` / `module` / `types` / `typings` fields.
 *
 * @param {any} pkgJson
 * @returns {{ entries: Array<{ subpath: string, target: string }>, problems: string[] }}
 */
export function enumerateEntries(pkgJson) {
  const entries = [];
  const problems = [];

  const walk = (subpath, node) => {
    if (node === null) return; // an explicitly BLOCKED subpath publishes nothing
    if (typeof node === 'string') {
      if (node.includes('*')) {
        problems.push(
          `${subpath}: an exports PATTERN (${node}) cannot be enumerated — expand it or extend the scanner`,
        );
        return;
      }
      entries.push({ subpath, target: node });
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(subpath, item);
      return;
    }
    if (node && typeof node === 'object') {
      for (const value of Object.values(node)) walk(subpath, value);
      return;
    }
    problems.push(`${subpath}: unrecognised exports value (${JSON.stringify(node)})`);
  };

  const exp = pkgJson.exports;
  if (exp !== undefined) {
    const keys = exp && typeof exp === 'object' && !Array.isArray(exp) ? Object.keys(exp) : [];
    const isSubpathMap = keys.length > 0 && keys.every((k) => k === '.' || k.startsWith('./'));
    if (isSubpathMap) {
      for (const [k, v] of Object.entries(exp)) {
        if (k.includes('*')) {
          problems.push(`${k}: an exports PATTERN key cannot be enumerated`);
          continue;
        }
        walk(k, v);
      }
    } else {
      walk('.', exp); // sugar: `"exports": "./x.js"` or a bare conditions object
    }
  }
  // `bin` files are executables, not an import surface, but a package with no
  // `exports` map lets a consumer deep-import any file — so they are read too.
  if (typeof pkgJson.bin === 'string') entries.push({ subpath: '(bin)', target: pkgJson.bin });
  else if (pkgJson.bin && typeof pkgJson.bin === 'object') {
    for (const [name, target] of Object.entries(pkgJson.bin)) {
      if (typeof target === 'string') entries.push({ subpath: `(bin ${name})`, target });
    }
  }
  for (const field of ['main', 'module', 'types', 'typings']) {
    if (typeof pkgJson[field] === 'string')
      entries.push({ subpath: `(${field})`, target: pkgJson[field] });
  }
  return { entries, problems };
}

// ─── module resolution ──────────────────────────────────────────────────────

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a RELATIVE specifier from `fromFile`. In a declaration file a `.js`
 * specifier means the sibling `.d.ts`, which is how tsup/tsc write them.
 */
function resolveRelative(fromFile, spec, types) {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [];
  const swap = (from, tos) => {
    if (base.endsWith(from))
      for (const to of tos) candidates.push(base.slice(0, -from.length) + to);
  };
  if (types) {
    swap('.js', ['.d.ts']);
    swap('.mjs', ['.d.mts']);
    swap('.cjs', ['.d.cts']);
    if (!SCANNABLE_RE.test(base)) candidates.push(`${base}.d.ts`, join(base, 'index.d.ts'));
    candidates.push(base);
  } else {
    candidates.push(base);
    if (!SCANNABLE_RE.test(base)) {
      candidates.push(`${base}.js`, `${base}.mjs`, `${base}.cjs`, join(base, 'index.js'));
    }
  }
  return candidates.find(isFile);
}

/** `pkg/sub` -> ['pkg', './sub'];  `@s/pkg/sub` -> ['@s/pkg', './sub'] */
function splitBare(spec) {
  const parts = spec.split('/');
  const nameLen = spec.startsWith('@') ? 2 : 1;
  const name = parts.slice(0, nameLen).join('/');
  const rest = parts.slice(nameLen).join('/');
  return [name, rest ? `./${rest}` : '.'];
}

/** Node's exports-condition walk: first key (in order) that is active wins. */
function pickExport(node, active) {
  if (node === null || node === undefined) return undefined;
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = pickExport(item, active);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  for (const [cond, value] of Object.entries(node)) {
    if (cond === 'default' || active.has(cond)) {
      const hit = pickExport(value, active);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

function findPackageDir(ctx, name, fromDir) {
  // node_modules first: an INSTALLED tarball (`--resolve-from <consumer dir>`)
  // must resolve its siblings to the installed bytes, not to the workspace copy.
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return ctx.workspace.get(name)?.dir;
}

/**
 * Resolve a BARE specifier to the file its exports map selects for this mode.
 * @returns {string | undefined}
 */
function resolveBare(ctx, fromFile, spec, types) {
  const [name, subpath] = splitBare(spec);
  const pkgDir = findPackageDir(ctx, name, ctx.resolveFrom ?? dirname(fromFile));
  if (!pkgDir) return undefined;
  let json;
  try {
    json = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
  const active = new Set(types ? ['types', 'import', 'node'] : ['import', 'node']);
  let target;
  if (json.exports !== undefined) {
    const exp = json.exports;
    const keys = exp && typeof exp === 'object' && !Array.isArray(exp) ? Object.keys(exp) : [];
    const isSubpathMap = keys.length > 0 && keys.every((k) => k === '.' || k.startsWith('./'));
    const node = isSubpathMap ? exp[subpath] : subpath === '.' ? exp : undefined;
    target = pickExport(node, active);
  } else if (subpath === '.') {
    target = (types ? (json.types ?? json.typings) : (json.module ?? json.main)) ?? 'index.js';
  } else {
    target = subpath;
  }
  if (target === undefined) return undefined;
  const abs = resolve(pkgDir, target);
  if (isFile(abs)) return abs;
  if (types) {
    const swapped = abs.replace(
      /\.[cm]?js$/,
      (m) => `.d.${m.endsWith('mjs') ? 'mts' : m.endsWith('cjs') ? 'cts' : 'ts'}`,
    );
    if (isFile(swapped)) return swapped;
  }
  return [`${abs}.js`, join(abs, 'index.js')].find(isFile);
}

/** @returns {{ file: string } | { skip: true } | { error: string }} */
function resolveSpecifier(ctx, fromFile, spec) {
  const types = DTS_RE.test(fromFile);
  if (spec.startsWith('node:') || builtinModules.includes(spec)) return { skip: true };
  if (spec.startsWith('.') || isAbsolute(spec)) {
    const hit = resolveRelative(fromFile, spec, types);
    return hit
      ? { file: hit }
      : { error: `cannot resolve relative module ${JSON.stringify(spec)}` };
  }
  const hit = resolveBare(ctx, fromFile, spec, types);
  return hit ? { file: hit } : { error: `cannot resolve package module ${JSON.stringify(spec)}` };
}

// ─── reading one module's exported names ────────────────────────────────────

function nameOf(node) {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

/** Binding-pattern identifiers: `const { a, b: [c] } = …` -> a, c */
function bindingNames(binding, out) {
  if (ts.isIdentifier(binding)) {
    out.push(binding.text);
    return;
  }
  for (const el of binding.elements) {
    if (ts.isOmittedExpression(el)) continue;
    bindingNames(el.name, out);
  }
}

const hasExport = (node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const hasDefault = (node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

const isIdent = (node, text) => ts.isIdentifier(node) && node.text === text;

function isModuleExports(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return isIdent(node.expression, 'module') && node.name.text === 'exports';
  }
  if (ts.isElementAccessExpression(node)) {
    return (
      isIdent(node.expression, 'module') &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'exports'
    );
  }
  return false;
}
const isExportsRoot = (node) => isIdent(node, 'exports') || isModuleExports(node);

/** `require('x')` -> 'x'  (a literal specifier only) */
function requireSpecifier(node) {
  if (
    ts.isCallExpression(node) &&
    isIdent(node.expression, 'require') &&
    node.arguments.length === 1 &&
    node.arguments[0] &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return node.arguments[0].text;
  }
  return undefined;
}

/**
 * Read the names `file` exports, following static re-export edges.
 *
 * @param {Ctx} ctx
 * @param {string} file absolute path
 * @returns {ExportEntry[]}
 */
export function readExports(ctx, file) {
  const memoised = ctx.memo.get(file);
  if (memoised === 'in-progress') return []; // an export-star cycle adds no new names
  if (memoised) return memoised;
  ctx.memo.set(file, 'in-progress');

  /** @type {ExportEntry[]} */
  const out = [];
  const add = (name, local) => out.push({ name, local, file, via: [file] });

  /** Merge another module's names under `prefix` (star: '' ; `export * as ns`: 'ns.'). */
  const merge = (spec, prefix, includeDefault) => {
    const r = resolveSpecifier(ctx, file, spec);
    if ('skip' in r) return;
    if ('error' in r) {
      fail(ctx, file, `${r.error} (re-exported by this file)`);
      return;
    }
    for (const e of readExports(ctx, r.file)) {
      if (!prefix && !includeDefault && e.name === 'default') continue;
      out.push({ ...e, name: prefix ? `${prefix}${e.name}` : e.name, via: [file, ...e.via] });
    }
  };

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    fail(ctx, file, `cannot read file: ${err instanceof Error ? err.message : String(err)}`);
    ctx.memo.set(file, out);
    return out;
  }
  if (!SCANNABLE_RE.test(file)) {
    fail(ctx, file, `unsupported module type (${file.split('.').pop()}) — cannot read its exports`);
    ctx.memo.set(file, out);
    return out;
  }

  const kind = DTS_RE.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = /** @type {{ parseDiagnostics?: unknown[] }} */ (/** @type {unknown} */ (sf))
    .parseDiagnostics;
  // `parseDiagnostics` is a compiler-internal field. If a TypeScript upgrade ever
  // renames it, "no diagnostics visible" must not read as "parsed cleanly".
  if (!Array.isArray(diagnostics)) {
    fail(ctx, file, 'cannot verify the file parsed: TypeScript no longer exposes parseDiagnostics');
    ctx.memo.set(file, out);
    return out;
  }
  if (diagnostics.length > 0) {
    fail(
      ctx,
      file,
      `does not parse (${diagnostics.length} syntax error(s)) — its exports cannot be read`,
    );
    ctx.memo.set(file, out);
    return out;
  }

  // import bookkeeping: namespace imports and `import { a as b }` aliases.
  /** @type {Map<string, string>} local -> specifier */
  const nsImports = new Map();
  /** @type {Map<string, string>} local -> imported name */
  const aliases = new Map();
  /** @type {Map<string, any>} top-level `const x = <init>` / function / class, for CJS resolution */
  const topLevel = new Map();
  for (const st of sf.statements) {
    if (
      ts.isImportDeclaration(st) &&
      st.importClause &&
      ts.isStringLiteralLike(st.moduleSpecifier)
    ) {
      const bindings = st.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings))
        nsImports.set(bindings.name.text, st.moduleSpecifier.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements)
          aliases.set(el.name.text, (el.propertyName ?? el.name).text);
      }
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) topLevel.set(d.name.text, d.initializer);
      }
    }
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name)
      topLevel.set(st.name.text, st);
  }

  /** Keys of an object literal as exports; `false` when it contains something unreadable. */
  const objectKeys = (obj, depth = 0, prefix = '') => {
    for (const prop of obj.properties) {
      if (ts.isSpreadAssignment(prop)) {
        const spec = requireSpecifier(prop.expression);
        if (spec !== undefined) {
          merge(spec, prefix, true);
          continue;
        }
        if (ts.isIdentifier(prop.expression) && depth < 4) {
          const init = topLevel.get(prop.expression.text);
          if (init && ts.isObjectLiteralExpression(init)) {
            objectKeys(init, depth + 1, prefix);
            continue;
          }
        }
        fail(
          ctx,
          file,
          `object spread of ${prop.expression.getText(sf)} — its keys cannot be read statically`,
        );
        continue;
      }
      const key = prop.name;
      if (key && ts.isComputedPropertyName(key)) {
        if (ts.isStringLiteralLike(key.expression)) add(`${prefix}${key.expression.text}`);
        else fail(ctx, file, `computed export key ${key.getText(sf)} cannot be read statically`);
        continue;
      }
      const n = nameOf(key);
      if (n === undefined) {
        fail(ctx, file, `unreadable export key ${key ? key.getText(sf) : '<none>'}`);
        continue;
      }
      add(`${prefix}${n}`);
      // `{ ns: { __k } }` — a seam one level down is still reachable as `x.ns.__k`.
      if (ts.isPropertyAssignment(prop))
        valueMembers(prop.initializer, `${prefix}${n}.`, depth + 1);
    }
  };

  /** Static members of a class are properties of the exported constructor. */
  const classStatics = (cls, prefix) => {
    for (const m of cls.members) {
      if (ts.isClassStaticBlockDeclaration(m)) {
        fail(ctx, file, 'a class static block — what it assigns cannot be read statically');
        continue;
      }
      const isStatic = (ts.getModifiers(m) ?? []).some(
        (x) => x.kind === ts.SyntaxKind.StaticKeyword,
      );
      if (!isStatic || !m.name) continue;
      if (ts.isComputedPropertyName(m.name)) {
        const ke = m.name.expression;
        if (ts.isStringLiteralLike(ke)) add(`${prefix}${ke.text}`);
        else if (ts.isIdentifier(ke) || ts.isPropertyAccessExpression(ke)) {
          // `static [entityKind]` / `static [Symbol.iterator]`: a bare reference is
          // a symbol key by convention (drizzle's tag), not a string a consumer
          // writes. A reference bound to a string literal here IS read.
          const bound = ts.isIdentifier(ke) ? topLevel.get(ke.text) : undefined;
          if (bound && ts.isStringLiteralLike(bound)) add(`${prefix}${bound.text}`);
        } else
          fail(ctx, file, `computed static member ${m.name.getText(sf)} cannot be read statically`);
        continue;
      }
      const n = nameOf(m.name);
      if (n !== undefined) add(`${prefix}${n}`);
    }
  };

  /**
   * The members reachable from an exported VALUE: object-literal keys (also when
   * the literal is bound to a top-level identifier) and class static members.
   * Returns whether the value was resolved to something readable; a caller that
   * requires an answer (a default export) fails closed on `false`.
   */
  const valueMembers = (expr, prefix, depth = 0) => {
    if (depth > 6) return false;
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isSatisfiesExpression(expr) ||
      ts.isNonNullExpression(expr)
    )
      return valueMembers(expr.expression, prefix, depth + 1);
    if (
      ts.isCallExpression(expr) &&
      ts.isPropertyAccessExpression(expr.expression) &&
      isIdent(expr.expression.expression, 'Object') &&
      ['freeze', 'seal'].includes(expr.expression.name.text) &&
      expr.arguments.length === 1 &&
      expr.arguments[0]
    )
      return valueMembers(expr.arguments[0], prefix, depth + 1);
    if (ts.isObjectLiteralExpression(expr)) {
      objectKeys(expr, depth, prefix);
      return true;
    }
    if (ts.isClassExpression(expr) || ts.isClassDeclaration(expr)) {
      classStatics(expr, prefix);
      return true;
    }
    if (ts.isIdentifier(expr)) {
      const init = topLevel.get(expr.text);
      return init ? valueMembers(init, prefix, depth + 1) : false;
    }
    return false;
  };

  /** Values that carry no keys a consumer could name. */
  const isInertValue = (expr) =>
    ts.isFunctionExpression(expr) ||
    ts.isArrowFunction(expr) ||
    ts.isFunctionDeclaration(expr) ||
    ts.isLiteralExpression(expr) ||
    ts.isTemplateExpression(expr) ||
    ts.isArrayLiteralExpression(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword;

  /** A name seen on an `exports` root: `exports.x`, `module.exports['x']`. */
  const exportsMember = (target) => {
    if (ts.isPropertyAccessExpression(target)) return target.name.text;
    if (ts.isElementAccessExpression(target)) {
      if (ts.isStringLiteralLike(target.argumentExpression)) return target.argumentExpression.text;
      fail(ctx, file, `computed export name ${target.getText(sf)} cannot be read statically`);
    }
    return undefined;
  };

  /** What `module.exports = <rhs>` exposes. */
  const moduleExportsValue = (rhs, depth = 0) => {
    if (ts.isParenthesizedExpression(rhs)) return moduleExportsValue(rhs.expression, depth);
    if (ts.isObjectLiteralExpression(rhs)) return objectKeys(rhs);
    if (ts.isClassExpression(rhs)) return classStatics(rhs, '');
    const spec = requireSpecifier(rhs);
    if (spec !== undefined) return merge(spec, '', true);
    if (
      ts.isFunctionExpression(rhs) ||
      ts.isArrowFunction(rhs) ||
      ts.isStringLiteralLike(rhs) ||
      ts.isNumericLiteral(rhs)
    ) {
      return;
    }
    if (ts.isIdentifier(rhs) && depth < 4) {
      const init = topLevel.get(rhs.text);
      if (init && ts.isFunctionDeclaration(init)) return;
      if (init && ts.isClassDeclaration(init)) return classStatics(init, '');
      if (init) return moduleExportsValue(init, depth + 1);
    }
    fail(
      ctx,
      file,
      `module.exports = ${rhs.getText(sf).slice(0, 60)} — its keys cannot be read statically`,
    );
  };

  const visitExportsUse = (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      if (isModuleExports(left)) {
        moduleExportsValue(node.right);
      } else if (
        (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) &&
        isExportsRoot(left.expression)
      ) {
        const n = exportsMember(left);
        if (n !== undefined) {
          add(n);
          valueMembers(node.right, `${n}.`);
        }
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const args = node.arguments;
      const touchesExports = args.some((a) => isExportsRoot(a));
      if (
        touchesExports &&
        ts.isPropertyAccessExpression(callee) &&
        isIdent(callee.expression, 'Object') &&
        callee.name.text === 'defineProperty'
      ) {
        const key = args[1];
        if (key && ts.isStringLiteralLike(key)) add(key.text);
        else fail(ctx, file, `Object.defineProperty on exports with a non-literal key`);
      } else if (
        touchesExports &&
        ts.isPropertyAccessExpression(callee) &&
        isIdent(callee.expression, 'Object') &&
        (callee.name.text === 'assign' || callee.name.text === 'defineProperties')
      ) {
        for (const a of args.slice(1)) {
          if (ts.isObjectLiteralExpression(a)) objectKeys(a);
          else fail(ctx, file, `Object.${callee.name.text} on exports with a non-literal source`);
        }
      } else if (touchesExports) {
        fail(
          ctx,
          file,
          `${callee.getText(sf)}(…) is handed the module's exports object — what it adds cannot be read statically`,
        );
      }
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isExportsRoot(node.initializer)
    ) {
      fail(
        ctx,
        file,
        'the exports object is aliased to a variable — later writes through it cannot be read',
      );
    }
    ts.forEachChild(node, visitExportsUse);
  };

  // Names declared inside an ambient namespace are all visible to a consumer.
  const namespaceMembers = (mod, prefix) => {
    const body = mod.body;
    if (!body) return;
    if (ts.isModuleBlock(body)) {
      for (const st of body.statements) topDeclared(st, prefix, true);
    } else if (ts.isModuleDeclaration(body)) {
      const n = nameOf(body.name);
      if (n !== undefined) {
        add(`${prefix}${n}`);
        namespaceMembers(body, `${prefix}${n}.`);
      }
    }
  };

  /** Exported declarations (modifier form). `ambient`: every member counts. */
  const topDeclared = (st, prefix, ambient) => {
    if (ts.isVariableStatement(st)) {
      if (!ambient && !hasExport(st)) return;
      const names = [];
      for (const d of st.declarationList.declarations) bindingNames(d.name, names);
      for (const n of names) add(`${prefix}${n}`);
      if (!ambient) {
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          if (d.initializer) valueMembers(d.initializer, `${prefix}${d.name.text}.`);
          if (d.type && ts.isTypeLiteralNode(d.type)) {
            for (const m of d.type.members) {
              const mn = m.name && nameOf(m.name);
              if (mn) add(`${prefix}${d.name.text}.${mn}`);
            }
          }
        }
      }
      return;
    }
    if (
      ts.isFunctionDeclaration(st) ||
      ts.isClassDeclaration(st) ||
      ts.isInterfaceDeclaration(st) ||
      ts.isTypeAliasDeclaration(st) ||
      ts.isEnumDeclaration(st)
    ) {
      if (!ambient && !hasExport(st)) return;
      if (!ambient && hasDefault(st)) {
        add('default');
        if (ts.isClassDeclaration(st)) classStatics(st, 'default.');
        return;
      }
      if (st.name) add(`${prefix}${st.name.text}`);
      if (!ambient && ts.isClassDeclaration(st) && st.name) classStatics(st, `${st.name.text}.`);
      return;
    }
    if (ts.isModuleDeclaration(st)) {
      if (!ambient && !hasExport(st)) return;
      const n = nameOf(st.name);
      if (n !== undefined) add(`${prefix}${n}`);
      namespaceMembers(st, `${prefix}${n ?? ''}.`);
      return;
    }
    if (ts.isImportEqualsDeclaration(st)) {
      if (ambient || hasExport(st)) add(`${prefix}${st.name.text}`);
    }
  };

  for (const st of sf.statements) {
    topDeclared(st, '', false);

    if (ts.isExportDeclaration(st)) {
      const spec =
        st.moduleSpecifier && ts.isStringLiteralLike(st.moduleSpecifier)
          ? st.moduleSpecifier.text
          : undefined;
      const clause = st.exportClause;
      if (!clause) {
        if (spec === undefined) fail(ctx, file, 'export * with a non-literal specifier');
        else merge(spec, '', false);
      } else if (ts.isNamespaceExport(clause)) {
        add(clause.name.text);
        if (spec === undefined) fail(ctx, file, 'export * as with a non-literal specifier');
        else merge(spec, `${clause.name.text}.`, true);
      } else {
        for (const el of clause.elements) {
          const exported = el.name.text;
          const local = (el.propertyName ?? el.name).text;
          if (spec === undefined && nsImports.has(local)) {
            // `import * as ns from './x'; export { ns }` — the whole namespace.
            add(exported, local);
            merge(/** @type {string} */ (nsImports.get(local)), `${exported}.`, true);
            continue;
          }
          add(exported, spec === undefined ? (aliases.get(local) ?? local) : local);
          if (spec === undefined) {
            const init = topLevel.get(local);
            if (init) valueMembers(init, `${exported}.`);
          }
        }
      }
    } else if (ts.isExportAssignment(st)) {
      if (st.isExportEquals) {
        moduleExportsValue(st.expression);
      } else {
        add('default');
        const expr = st.expression;
        if (ts.isIdentifier(expr) && nsImports.has(expr.text)) {
          merge(/** @type {string} */ (nsImports.get(expr.text)), 'default.', true);
        } else if (!valueMembers(expr, 'default.') && !isInertValue(expr)) {
          // `export default someCall()` / an imported binding: the value's keys
          // are a consumer's to name and this reader cannot see them.
          fail(
            ctx,
            file,
            `export default ${expr.getText(sf).slice(0, 60)} — its keys cannot be read statically`,
          );
        }
      }
    } else if (ts.isNamespaceExportDeclaration(st)) {
      add(st.name.text); // `export as namespace X` — a UMD global
    }
  }

  visitExportsUse(sf);

  ctx.memo.set(file, out);
  return out;
}

// ─── package-level scan ─────────────────────────────────────────────────────

/** @param {ExportEntry} e */
function isSeam(e) {
  return (
    e.name.split('.').some((p) => p.startsWith(SEAM_PREFIX)) ||
    (e.local ?? '').startsWith(SEAM_PREFIX)
  );
}

/**
 * Scan one package directory.
 *
 * @param {Ctx} ctx
 * @param {string} pkgDir
 * @returns {{ name: string, entries: Array<{subpath: string, file: string, exports: number}>, findings: Array<{ kind: 'seam-export' | 'unscannable', subpath?: string, file: string, name?: string, local?: string, via?: string[], reason?: string }> }}
 */
export function scanPackage(ctx, pkgDir) {
  const dir = resolve(pkgDir);
  const findings = [];
  let json;
  try {
    json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch (err) {
    return {
      name: dir,
      entries: [],
      findings: [
        {
          kind: 'unscannable',
          file: join(dir, 'package.json'),
          reason: `cannot read package.json: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
  const { entries: targets, problems } = enumerateEntries(json);
  for (const p of problems)
    findings.push({ kind: 'unscannable', file: join(dir, 'package.json'), reason: p });
  if (targets.length === 0) {
    findings.push({
      kind: 'unscannable',
      file: join(dir, 'package.json'),
      reason: 'no published entry found — a package that exposes nothing cannot be certified clean',
    });
  }

  const scanned = [];
  const seen = new Set();
  for (const { subpath, target } of targets) {
    // `import` and `default` conditions usually name the same file; report it once.
    if (seen.has(`${subpath}\0${target}`)) continue;
    seen.add(`${subpath}\0${target}`);
    const abs = resolve(dir, target);
    if (relative(dir, abs).startsWith('..') || relative(dir, abs).split(sep)[0] === '..') {
      findings.push({
        kind: 'unscannable',
        subpath,
        file: abs,
        reason: `entry ${target} points outside the package`,
      });
      continue;
    }
    if (!isFile(abs)) {
      findings.push({
        kind: 'unscannable',
        subpath,
        file: abs,
        reason: `entry ${target} does not exist — is the package built?`,
      });
      continue;
    }
    if (!SCANNABLE_RE.test(abs)) {
      // e.g. a `.json` or `.node` entry: no JS names to read, and nothing to hide a seam in.
      if (/\.(?:json|node|wasm)$/.test(abs)) continue;
      findings.push({
        kind: 'unscannable',
        subpath,
        file: abs,
        reason: `entry ${target} has an unsupported extension`,
      });
      continue;
    }
    const before = ctx.errors.length;
    const exports = readExports(ctx, abs);
    scanned.push({ subpath, file: abs, exports: exports.length });
    for (const e of exports) {
      if (isSeam(e)) {
        findings.push({
          kind: 'seam-export',
          subpath,
          file: abs,
          name: e.name,
          local: e.local,
          via: e.via,
        });
      }
    }
    // Errors raised while reading this entry's graph belong to this entry; errors
    // from a memoised earlier read were reported with the entry that first hit them.
    for (const err of ctx.errors.slice(before)) {
      findings.push({ kind: 'unscannable', subpath, file: err.file, reason: err.reason });
    }
  }
  return { name: json.name ?? dir, entries: scanned, findings };
}

/** Render a finding for a human; the CLI exits non-zero on ANY finding. */
export function describeFinding(f) {
  if (f.kind === 'seam-export') {
    const alias = f.local && f.local !== f.name ? ` (as ${f.name}, local ${f.local})` : '';
    const chain =
      f.via && f.via.length > 1 ? `\n      via ${f.via.map((p) => p).join(' -> ')}` : '';
    return `  [seam-export] ${f.subpath}: \`${f.name}\`${alias} is reachable from ${f.file}${chain}`;
  }
  return `  [unscannable] ${f.subpath ?? ''} ${f.file}: ${f.reason}`;
}
