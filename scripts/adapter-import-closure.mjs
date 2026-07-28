#!/usr/bin/env node
/**
 * adapter-import-closure.mjs — the adapter EXECUTION-CLOSURE guard (S1, #545).
 *
 * WHAT THIS PROVES, EXACTLY: the adapter never *executes* CLI code. That makes
 * `src/cli/` REVIEW-SAFE — a CLI defect cannot corrupt a compat result. It does
 * NOT make CLI changes WINDOW-safe: the compat-window digest hashes SHIPPED
 * BYTES, and `dist/cli/**` ships inside the tarball under test
 * (`files: ["dist"]` + `bin: ./dist/cli/kn-next.js`), so a CLI change resets the
 * window. An earlier draft of ADR-0039 conflated the two claims; do not
 * reintroduce that reading (corrected on PR #574).
 *
 * The claim is not free to keep true: packages/kn-next/package.json exports
 * `./internal/cli-validate` and `./internal/cli-shared` from `dist/cli/`, so one
 * import is all it would take to make the adapter execute CLI code.
 *
 * This module computes the closure from SOURCE (the built dist is not available
 * in a plain `pnpm install` tree) and reports any member under a `cli/`
 * directory — `src/cli/` for a relative import, `dist/cli/` for a self-referential
 * subpath export. It is deliberately conservative:
 *   • an unresolvable RELATIVE import throws rather than being skipped (a walker
 *     that silently drops what it cannot resolve is a permanently-green guard);
 *   • dynamic `import()` and `require()` count exactly like a static import —
 *     the runtime reaches them either way.
 *
 * Bare specifiers to OTHER packages (`next`, `node:*`) are not traversed: they
 * are not knext's code. Bare specifiers to the package's OWN name are resolved
 * through its `exports` map, which is precisely the drift path above.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const BUILTINS = new Set(builtinModules);

/** Extensions tried, in order, for an extensionless relative specifier. */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

/** Any file living under a `cli/` directory is CLI code the adapter must not execute. */
const CLI_DIR = /(^|\/)cli\//;

/**
 * @typedef {{ kind: string, file: string, specifier: string, detail: string }} ClosureViolation
 * @typedef {{ files: string[], externals: string[], violations: ClosureViolation[] }} ClosureResult
 */

/** Strip comments so a commented-out import never enters the closure. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every module specifier the file references, static or dynamic. */
function specifiersOf(source) {
  const code = stripComments(source);
  const found = new Set();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']/g,
  ];
  for (const re of patterns) {
    let m = re.exec(code);
    while (m !== null) {
      found.add(m[1]);
      m = re.exec(code);
    }
  }
  return [...found];
}

/** Resolve a relative specifier to a real file, or return null. */
function resolveRelative(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, ...EXTENSIONS.map((ext) => base + ext)];
  if (existsSync(base) && statSync(base).isDirectory()) {
    for (const ext of EXTENSIONS) candidates.push(join(base, `index${ext}`));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Walk an `exports` map entry down to its file target. */
function exportTarget(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    for (const key of ['import', 'default', 'require', 'node']) {
      if (key in entry) {
        const target = exportTarget(entry[key]);
        if (target) return target;
      }
    }
  }
  return null;
}

/**
 * Compute the adapter entry's transitive import closure.
 *
 * @param {string} entryFile absolute path to the adapter entry
 * @param {{ packageRoot: string }} options the package whose `exports` map self-references resolve through
 * @returns {ClosureResult}
 */
export function computeAdapterClosure(entryFile, { packageRoot }) {
  const pkgJsonPath = join(packageRoot, 'package.json');
  const pkg = existsSync(pkgJsonPath)
    ? JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
    : { name: undefined, exports: {} };
  const selfName = pkg.name;
  const exportsMap = pkg.exports ?? {};

  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const externals = [];
  /** @type {ClosureViolation[]} */
  const violations = [];
  const seen = new Set();
  const queue = [resolve(entryFile)];

  const flagIfCli = (memberPath, fromFile, specifier, kind) => {
    const rel = relative(packageRoot, memberPath).split('\\').join('/');
    if (CLI_DIR.test(rel)) {
      violations.push({
        kind,
        file: relative(packageRoot, fromFile).split('\\').join('/'),
        specifier,
        detail: `${relative(packageRoot, fromFile)} imports "${specifier}" → ${rel}, which is CLI code under a cli/ directory: the adapter must never EXECUTE the CLI (ADR-0039). Note this is the execution claim, not a freeze exclusion — dist/cli/** ships in the tarball and IS inside the compat-window digest`,
      });
    }
  };

  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);

    if (!existsSync(file)) {
      throw new Error(`adapter closure: ${file} does not exist`);
    }
    if (/\.json$/.test(file)) continue;

    const source = readFileSync(file, 'utf8');
    for (const specifier of specifiersOf(source)) {
      if (specifier.startsWith('node:') || BUILTINS.has(specifier)) continue;

      if (specifier.startsWith('.') || isAbsolute(specifier)) {
        const resolved = resolveRelative(file, specifier);
        if (!resolved) {
          throw new Error(
            `adapter closure: cannot resolve "${specifier}" from ${file}. A specifier the walker cannot resolve is silently dropped from the closure, which is how this guard goes permanently green — fix the import or teach the resolver.`,
          );
        }
        flagIfCli(resolved, file, specifier, 'relative-import');
        queue.push(resolved);
        continue;
      }

      // Self-referential subpath: `@getknext/core/internal/cli-validate` etc.
      if (selfName && (specifier === selfName || specifier.startsWith(`${selfName}/`))) {
        const subpath = specifier === selfName ? '.' : `.${specifier.slice(selfName.length)}`;
        const target = exportTarget(exportsMap[subpath]);
        if (target) {
          const targetPath = resolve(packageRoot, target);
          flagIfCli(targetPath, file, specifier, 'self-subpath-export');
        }
        externals.push(specifier);
        continue;
      }

      externals.push(specifier);
    }
  }

  return { files: files.sort(), externals: [...new Set(externals)].sort(), violations };
}

/* c8 ignore start — CLI wrapper */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
  };
  const packageRoot = resolve(arg('package-root', 'packages/kn-next'));
  const entry = resolve(arg('entry', join(packageRoot, 'src/adapters/next-adapter.ts')));
  const { files, violations } = computeAdapterClosure(entry, { packageRoot });
  console.log(`adapter closure: ${files.length} file(s) from ${relative(process.cwd(), entry)}`);
  for (const f of files) console.log(`  ${relative(packageRoot, f)}`);
  if (violations.length > 0) {
    for (const v of violations) console.error(`::error::${v.detail}`);
    process.exit(1);
  }
  console.log('no cli/ file in the adapter closure — the adapter executes no CLI code (ADR-0039)');
}
/* c8 ignore stop */
