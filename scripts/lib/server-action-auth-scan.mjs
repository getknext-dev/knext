/**
 * The Server Action / mutating-route authentication scan.
 *
 * WHY. `'use server'` makes every exported function a public POST endpoint, and
 * the mutating-endpoint audit only ever enumerated route handlers - so the
 * file-manager `uploadFile` action wrote object storage and Postgres with no
 * authentication next to a doc that said there were no such endpoints. This
 * scan makes the audit mechanical: a new Server Action or mutating route that
 * does not authenticate cannot merge.
 *
 * SCOPE. Every non-test source file under {@link SCAN_ROOTS} (`apps/` and the
 * app scaffold templates). Two kinds of surface:
 *   - ACTION   every function exported from a module-level `'use server'` file,
 *              and every function whose own body starts with `'use server'`.
 *   - ROUTE    every exported `POST` / `PUT` / `PATCH` / `DELETE` handler of an
 *              App Router `route.*` file, plus the `GET` of the files on
 *              {@link SENSITIVE_READS} (a read of audit rows is gated too).
 *
 * THE RULE. A surface passes only if its function body's FIRST effectful
 * statement is
 *
 *     if (!(await authorizeMutation(...)))  { return ...; }     // or throw
 *     if (!isAuthorized(...))               { return ...; }
 *
 * i.e. a negated call to an {@link AUTH_CALLS} name that is IMPORTED in the file,
 * whose consequent returns or throws, preceded only by inert statements
 * (declarations with no call, await or assignment in them). A write cannot run
 * before the check because nothing that calls anything can precede it. The
 * alternative - listing "write" sinks - is an enumeration, and the second sink
 * is how the check gets bypassed.
 *
 * FAIL, NEVER PASS, ON WHAT IT CANNOT READ: a file that does not parse, a route
 * method re-exported from another module, an `export *`, a handler assigned
 * from an identifier, an expression-bodied action, a non-function export of a
 * `'use server'` file, and a `pages/api` route are all violations - not skips.
 *
 * ALLOWLIST. {@link ALLOWLIST} is counted (the test pins its length), reasoned
 * (a reason is mandatory) and tight: an entry that matches no surface, or that
 * matches a surface which is in fact gated, is itself a violation, so the list
 * can only shrink by deleting entries and only grow by editing the pinned count.
 *
 * LIMIT. Name-based: it proves the check is present, imported and positioned
 * first, not that the imported function is correct (that is
 * `mutation-auth.test.ts` and `auth.test.ts`).
 *
 * The test is `tests/server-action-auth-scan.test.ts`; the mutation proof is
 * `scripts/mutation-prove-2532-server-action-auth.mjs`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where the scan looks: the apps and the scaffold's app templates. */
export const SCAN_ROOTS = ['apps', 'packages/kn-next/templates/app'];

/** The authentication calls that satisfy the rule (each must be imported). */
export const AUTH_CALLS = new Set(['authorizeMutation', 'isAuthorized']);

/** Route methods that change state. GET/HEAD/OPTIONS are out of scope by verb. */
export const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * GET handlers that read data which must not be public, so they are held to the
 * same gate as a mutation.
 */
export const SENSITIVE_READS = [
  {
    file: 'apps/file-manager/src/app/api/audit/route.ts',
    name: 'GET',
    reason: 'returns audit_logs rows',
  },
];

/**
 * Surfaces that are deliberately NOT gated. Pinned in length by the test. Every
 * entry needs a reason a reviewer can disagree with.
 */
export const ALLOWLIST = [
  {
    file: 'apps/file-manager/src/app/api/rum/route.ts',
    name: 'POST',
    reason:
      'Web Vitals beacon from the browser, which cannot carry a secret: a fixed-schema lossy ' +
      'aggregator that can only observe() pre-declared histograms (docs/security/mutating-endpoints.md, "RUM ingest").',
  },
  {
    file: 'apps/file-manager/src/app/knext-smoke/stream/page.tsx',
    name: 'echoAction',
    reason:
      "compat-smoke fixture: sets one cookie on the CALLER's own response and touches no " +
      'server-side state (no database, no cache, no module state).',
  },
  {
    file: 'apps/db-demo/src/app/actions.ts',
    name: 'postMessage',
    reason:
      'KNOWN DEBT, not an exception in principle: the db-demo guestbook writes a row with no ' +
      'authentication. Tracked by its own issue (see docs/security/mutating-endpoints.md); ' +
      'remove this entry when it is gated.',
  },
];

const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.turbo',
  '.output',
  'dist',
  'build',
  'coverage',
  '.git',
  '__tests__',
  '__fixtures__',
  'fixtures',
]);
const CODE_FILE = /\.(?:[cm]?[jt]sx?)(?:\.hbs)?$/;
const TEST_FILE = /\.(?:test|spec|selftest)\.[cm]?[jt]sx?$/;
const ROUTE_FILE = /(?:^|\/)route\.[cm]?[jt]sx?(?:\.hbs)?$/;
const PAGES_API = /(?:^|\/)pages\/api\//;

/** Files a scan reads, as repo-relative posix paths. */
export function listScanFiles(repoRoot = REPO_ROOT, roots = SCAN_ROOTS) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full);
      } else if (CODE_FILE.test(name) && !TEST_FILE.test(name)) {
        out.push(relative(repoRoot, full).split('\\').join('/'));
      }
    }
  };
  for (const root of roots) walk(resolve(repoRoot, root));
  return out;
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function scriptKindOf(file) {
  const bare = file.replace(/\.hbs$/, '');
  if (/\.tsx$/.test(bare)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(bare)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(bare)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parse(text, file) {
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindOf(file),
  );
  const diags = sf.parseDiagnostics ?? [];
  return { sf, diags };
}

const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

function hasModifier(node, kind) {
  return (ts.getModifiers?.(node) ?? node.modifiers ?? []).some((m) => m.kind === kind);
}

const isFunctionLike = (n) =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n);

/** The directive prologue of a block/source file: leading string-literal statements. */
function prologue(statements) {
  const out = [];
  for (const st of statements) {
    if (ts.isExpressionStatement(st) && ts.isStringLiteral(st.expression)) {
      out.push(st.expression.text);
    } else break;
  }
  return out;
}

function importedNames(sf) {
  const names = new Set();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const c = st.importClause;
    if (c.isTypeOnly) continue;
    if (c.name) names.add(c.name.text);
    const nb = c.namedBindings;
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) if (!el.isTypeOnly) names.add(el.name.text);
    } else if (nb && ts.isNamespaceImport(nb)) {
      names.add(nb.name.text);
    }
  }
  return names;
}

const unwrap = (e) => {
  let cur = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else if (ts.isAwaitExpression(cur)) cur = cur.expression;
    else if (ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
    else return cur;
  }
};

/** A statement that cannot have an effect: no call, await, new, assignment, delete. */
function isInert(node) {
  let inert = true;
  const visit = (n) => {
    if (!inert) return;
    if (
      ts.isCallExpression(n) ||
      ts.isNewExpression(n) ||
      ts.isAwaitExpression(n) ||
      ts.isTaggedTemplateExpression(n) ||
      ts.isDeleteExpression(n) ||
      ts.isYieldExpression(n) ||
      ts.isPostfixUnaryExpression(n) ||
      (ts.isPrefixUnaryExpression(n) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken ||
          n.operator === ts.SyntaxKind.MinusMinusToken)) ||
      (ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
    ) {
      inert = false;
      return;
    }
    // A nested function is only defined here, not run, so it is inert.
    if (isFunctionLike(n) && n !== node) return;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return inert;
}

/** `!<auth call>` (through parens / await), or undefined. */
function negatedAuthCall(expr, imported) {
  const e = ts.isParenthesizedExpression(expr) ? unwrap(expr) : expr;
  if (!ts.isPrefixUnaryExpression(e) || e.operator !== ts.SyntaxKind.ExclamationToken) {
    return undefined;
  }
  const call = unwrap(e.operand);
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return undefined;
  const name = call.expression.text;
  if (!AUTH_CALLS.has(name) || !imported.has(name)) return undefined;
  return name;
}

function refuses(statement) {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  if (ts.isBlock(statement)) {
    return statement.statements.some((s) => ts.isReturnStatement(s) || ts.isThrowStatement(s));
  }
  return false;
}

/**
 * Grade ONE function: `{ ok: true, call }` when its first effectful statement is
 * the refusing auth check, else `{ ok: false, why }`.
 */
export function gateVerdict(fn, imported) {
  if (!fn.body) return { ok: false, why: 'no body' };
  if (!ts.isBlock(fn.body)) {
    return { ok: false, why: 'expression-bodied: there is no statement to hold the auth check' };
  }
  const statements = fn.body.statements.slice(prologue(fn.body.statements).length);
  for (const st of statements) {
    if (ts.isIfStatement(st)) {
      const name = negatedAuthCall(st.expression, imported);
      if (name) {
        return refuses(st.thenStatement)
          ? { ok: true, call: name }
          : { ok: false, why: `\`if (!${name}(...))\` does not return or throw` };
      }
    }
    if (!isInert(st)) {
      return {
        ok: false,
        why: 'an effectful statement runs before any `if (!authorizeMutation(...) / !isAuthorized(...)) return/throw` check',
      };
    }
  }
  return {
    ok: false,
    why: 'no `if (!authorizeMutation(...) / !isAuthorized(...)) return/throw` check',
  };
}

/** The functions an exported initializer stands for, or undefined when unreadable. */
function handlerFunctions(init) {
  if (!init) return undefined;
  const e = unwrap(init);
  if (isFunctionLike(e)) return [e];
  if (ts.isCallExpression(e)) {
    const fns = e.arguments.map(unwrap).filter(isFunctionLike);
    return fns.length > 0 ? fns : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Surface collection
// ---------------------------------------------------------------------------

function topLevelBindings(sf) {
  const byName = new Map();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) byName.set(st.name.text, { fn: st });
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) byName.set(d.name.text, { init: d.initializer });
      }
    }
  }
  return byName;
}

/**
 * Collect every surface in one file.
 *
 * @returns {{ surfaces: Array<{id:string,file:string,name:string,kind:string,line:number,
 *   fns: any[]|undefined, unreadable?: string}>, problems: string[] }}
 */
export function collectSurfaces(text, file, { extraGetNames = [] } = {}) {
  const problems = [];
  const surfaces = [];
  const wantsAction = /['"]use server['"]/.test(text);
  const isRoute = ROUTE_FILE.test(file);
  const isPagesApi = PAGES_API.test(file);

  if (isPagesApi) {
    problems.push(`${file}: a pages/api route is not scanned; port it to an App Router route`);
  }
  if (!wantsAction && !isRoute) return { surfaces, problems };

  const { sf, diags } = parse(text, file);
  if (diags.length > 0) {
    const first = ts.flattenDiagnosticMessageText(diags[0].messageText, ' ');
    problems.push(`${file}: does not parse (${first}); cannot prove its actions/routes are gated`);
    return { surfaces, problems };
  }

  const add = (name, kind, node, fns, unreadable) =>
    surfaces.push({
      id: `${file}::${name}`,
      file,
      name,
      kind,
      line: lineOf(sf, node),
      fns,
      unreadable,
    });
  const bindings = topLevelBindings(sf);
  const seen = new Set();

  // --- module-level 'use server': every export is an action ----------------
  if (prologue(sf.statements).includes('use server')) {
    const addExport = (name, node, fns, why) => {
      add(name, 'action', node, fns, fns ? undefined : why);
      for (const f of fns ?? []) seen.add(f);
    };
    const resolveLocal = (local, node, exportedAs) => {
      const b = bindings.get(local);
      if (!b) {
        addExport(exportedAs, node, undefined, `export \`${local}\` is not a local declaration`);
      } else if (b.fn) {
        addExport(exportedAs, node, [b.fn]);
      } else {
        const fns = handlerFunctions(b.init);
        addExport(
          exportedAs,
          node,
          fns,
          `export \`${local}\` is not a function or a call wrapping one`,
        );
      }
    };
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && hasModifier(st, ts.SyntaxKind.ExportKeyword)) {
        const isDefault = hasModifier(st, ts.SyntaxKind.DefaultKeyword);
        addExport(st.name ? st.name.text : isDefault ? 'default' : '<anonymous>', st, [st]);
      } else if (ts.isVariableStatement(st) && hasModifier(st, ts.SyntaxKind.ExportKeyword)) {
        for (const d of st.declarationList.declarations) {
          const name = ts.isIdentifier(d.name) ? d.name.text : '<destructured>';
          const fns = handlerFunctions(d.initializer);
          addExport(name, d, fns, `export \`${name}\` is not a function or a call wrapping one`);
        }
      } else if (ts.isExportDeclaration(st)) {
        if (st.isTypeOnly) continue;
        if (st.moduleSpecifier) {
          problems.push(
            `${file}:${lineOf(sf, st)}: a 'use server' module re-exports from another module; its actions cannot be read here`,
          );
        } else if (st.exportClause && ts.isNamedExports(st.exportClause)) {
          for (const el of st.exportClause.elements) {
            if (el.isTypeOnly) continue;
            resolveLocal((el.propertyName ?? el.name).text, el, el.name.text);
          }
        } else {
          problems.push(`${file}:${lineOf(sf, st)}: unreadable export in a 'use server' module`);
        }
      } else if (ts.isExportAssignment(st)) {
        const e = unwrap(st.expression);
        if (ts.isIdentifier(e)) resolveLocal(e.text, st, 'default');
        else {
          const fns = handlerFunctions(e);
          addExport('default', st, fns, 'default export is not a function');
        }
      } else if (
        (ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) &&
        hasModifier(st, ts.SyntaxKind.ExportKeyword)
      ) {
        addExport(
          st.name?.text ?? '<anonymous>',
          st,
          undefined,
          "a class/enum export in a 'use server' module",
        );
      }
    }
  }

  // --- inline 'use server' functions ----------------------------------------
  const nameOfFunction = (fn) => {
    if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
    const p = fn.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
    return `<anonymous@${lineOf(sf, fn)}>`;
  };
  const visit = (n) => {
    if (
      isFunctionLike(n) &&
      n.body &&
      ts.isBlock(n.body) &&
      prologue(n.body.statements).includes('use server') &&
      !seen.has(n)
    ) {
      seen.add(n);
      add(nameOfFunction(n), 'action', n, [n]);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  // --- route handlers -------------------------------------------------------
  if (isRoute) {
    const wanted = new Set([...MUTATING_METHODS, ...extraGetNames]);
    const addRoute = (name, node, fns, why) => add(name, 'route', node, fns, fns ? undefined : why);
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name && wanted.has(st.name.text)) {
        if (hasModifier(st, ts.SyntaxKind.ExportKeyword)) addRoute(st.name.text, st, [st]);
      } else if (ts.isVariableStatement(st) && hasModifier(st, ts.SyntaxKind.ExportKeyword)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && wanted.has(d.name.text)) {
            addRoute(
              d.name.text,
              d,
              handlerFunctions(d.initializer),
              `\`${d.name.text}\` is not a function or a call wrapping one (an imported or aliased handler cannot be read)`,
            );
          }
        }
      } else if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
        if (st.exportClause && ts.isNamedExports(st.exportClause)) {
          for (const el of st.exportClause.elements) {
            if (!wanted.has(el.name.text) || el.isTypeOnly) continue;
            if (st.moduleSpecifier) {
              addRoute(
                el.name.text,
                el,
                undefined,
                `\`${el.name.text}\` is re-exported from another module`,
              );
            } else {
              const b = bindings.get((el.propertyName ?? el.name).text);
              const fns = b?.fn ? [b.fn] : handlerFunctions(b?.init);
              addRoute(
                el.name.text,
                el,
                fns,
                `\`${el.name.text}\` is not a readable local function`,
              );
            }
          }
        } else if (!st.exportClause) {
          problems.push(
            `${file}:${lineOf(sf, st)}: \`export *\` in a route module hides its methods`,
          );
        }
      }
    }
  }

  return { surfaces, problems };
}

/**
 * Grade one file's surfaces. Returns each with `gated` (true/false) and a `why`.
 *
 * @returns {{ surfaces: Array<{id:string,file:string,name:string,kind:string,line:number,
 *   gated:boolean, why?:string}>, problems: string[] }}
 */
export function scanSource(text, file, opts = {}) {
  const { surfaces, problems } = collectSurfaces(text, file, opts);
  const imported = surfaces.length > 0 ? importedNames(parse(text, file).sf) : new Set();
  const graded = surfaces.map((s) => {
    if (s.unreadable || !s.fns) {
      return { ...pick(s), gated: false, why: s.unreadable ?? 'unreadable handler' };
    }
    for (const fn of s.fns) {
      const v = gateVerdict(fn, imported);
      if (!v.ok) return { ...pick(s), gated: false, why: v.why };
    }
    return { ...pick(s), gated: true };
  });
  return { surfaces: graded, problems };
}

const pick = (s) => ({ id: s.id, file: s.file, name: s.name, kind: s.kind, line: s.line });

/**
 * Scan a tree.
 *
 * @param {string} repoRoot
 * @param {{roots?: string[], allowlist?: typeof ALLOWLIST, sensitiveReads?: typeof SENSITIVE_READS}} [opts]
 * @returns {{ surfaces: any[], violations: string[], scannedFiles: number }}
 */
export function scanTree(repoRoot = REPO_ROOT, opts = {}) {
  const roots = opts.roots ?? SCAN_ROOTS;
  const allowlist = opts.allowlist ?? ALLOWLIST;
  const sensitiveReads = opts.sensitiveReads ?? SENSITIVE_READS;
  const files = listScanFiles(repoRoot, roots);
  const violations = [];
  const surfaces = [];

  for (const file of files) {
    const text = readFileSync(resolve(repoRoot, file), 'utf8');
    const extraGetNames = sensitiveReads.filter((r) => r.file === file).map((r) => r.name);
    const r = scanSource(text, file, { extraGetNames });
    violations.push(...r.problems);
    surfaces.push(...r.surfaces);
  }

  const used = new Set();
  for (const s of surfaces) {
    const entry = allowlist.find((a) => a.file === s.file && a.name === s.name);
    if (entry) {
      used.add(entry);
      if (s.gated) {
        violations.push(
          `${s.id} (line ${s.line}) is on the allowlist but IS gated: remove the stale entry`,
        );
      }
      continue;
    }
    if (!s.gated) {
      violations.push(`${s.id} (line ${s.line}) is an unauthenticated ${s.kind}: ${s.why}`);
    }
  }
  for (const a of allowlist) {
    if (!a.reason || String(a.reason).trim().length < 20) {
      violations.push(`allowlist entry ${a.file}::${a.name} has no real reason`);
    }
    if (!used.has(a)) {
      violations.push(`allowlist entry ${a.file}::${a.name} matches no surface (stale)`);
    }
  }
  for (const r of sensitiveReads) {
    if (!surfaces.some((s) => s.file === r.file && s.name === r.name)) {
      violations.push(`sensitive read ${r.file}::${r.name} matches no handler (stale)`);
    }
  }
  return { surfaces, violations, scannedFiles: files.length };
}
