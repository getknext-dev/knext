/**
 * #1669 — public API type-surface report for the publishable @getknext/*
 * packages (core, lib, db).
 *
 * WHY THIS SHAPE: `public-api-surface.test.ts` (PK5/#286) already proves the
 * *subpath* surface — which import paths exist. It does not look inside a
 * subpath: renaming an exported symbol, or narrowing a parameter/property
 * type within an already-public subpath, passes that check untouched. This
 * module closes that gap by generating the actual TYPE TEXT for each public
 * subpath (via the TypeScript compiler API's single-file declaration emit —
 * `typescript` is already a root devDependency, no new dependency added) and
 * diffing it against a checked-in baseline report. Any diff — a rename, a
 * narrowed type, or an unreviewed addition — means the checked-in report is
 * stale and the check fails until a human regenerates and commits it
 * (`node scripts/api-surface/generate.mjs`), the same "generated file must
 * match, updating it is part of the PR" discipline the repo already uses for
 * the 3-way public-API-subpath contract.
 *
 * SCOPE: the surface tracked is each public subpath's OWN declaration file,
 * emitted from source (`emitOnlyDtsFiles` restricted to that one
 * `ts.SourceFile` via `program.emit(sourceFile, ...)`), not a deep,
 * transitive rollup of every type it references. That is enough to catch a
 * renamed/removed top-level export or a narrowed inline type (the acceptance
 * criteria), and it is what keeps this cheap and deterministic: no bundling,
 * no network, one `ts.createProgram` per package reused across all its
 * entries.
 *
 * No network, no new dependency: uses the `typescript` package already
 * listed in the root package.json devDependencies.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/** The three publishable packages this guard covers (#1669). */
export const PACKAGES = [
  { name: '@getknext/core', dir: 'packages/kn-next', reportName: 'core' },
  { name: '@getknext/lib', dir: 'packages/lib', reportName: 'lib' },
  { name: '@getknext/db', dir: 'packages/db', reportName: 'db' },
];

/**
 * Reads a package's `knext.publicApi.public` subpaths and its `exports` map,
 * and derives, for each public subpath, the SOURCE entry file the guard
 * should type-check + emit `.d.ts` for.
 *
 * The derivation is mechanical, not a hand-maintained second list: the
 * `exports[subpath].types` dist path (`./dist/<rest>.d.ts`) maps 1:1 onto
 * `src/<rest>.ts` for every typed public subpath in this repo today (verified
 * against all three packages' exports maps). An entry with no `types` field
 * (e.g. `@getknext/core/adapters/cache-handler`, plain untyped JS) is
 * reported as `typed: false` — there is no type surface to track for it, and
 * `public-api-surface.test.ts` already guards that it keeps resolving to real
 * JS.
 */
export function publicEntries(pkgDir) {
  const absDir = path.resolve(REPO_ROOT, pkgDir);
  const pkg = JSON.parse(readFileSync(path.join(absDir, 'package.json'), 'utf8'));
  const publicSubpaths = pkg?.knext?.publicApi?.public;
  if (!Array.isArray(publicSubpaths) || publicSubpaths.length === 0) {
    throw new Error(`${pkgDir}: package.json is missing a non-empty knext.publicApi.public array`);
  }
  const exportsMap = pkg.exports ?? {};

  return publicSubpaths.map((subpath) => {
    const entry = exportsMap[subpath];
    if (entry === undefined) {
      throw new Error(`${pkgDir}: public subpath ${subpath} has no exports map entry`);
    }
    const typesTarget = typeof entry === 'object' && entry !== null ? entry.types : undefined;
    if (typeof typesTarget !== 'string') {
      return { subpath, typed: false };
    }
    const rest = typesTarget.replace(/^\.\/dist\//, '').replace(/\.d\.ts$/, '');
    const srcRelPath = `src/${rest}.ts`;
    return {
      subpath,
      typed: true,
      srcRelPath,
      srcAbsPath: path.join(absDir, srcRelPath),
    };
  });
}

/**
 * Builds one `ts.Program` for the package (reused across every entry — the
 * expensive part, typechecking the whole `src/`, happens once) and returns a
 * function that emits the single-file `.d.ts` text for one entry's source
 * file. `program.emit(sourceFile, writer, undefined, /*emitOnlyDtsFiles*​/ true)`
 * restricts TypeScript's emit to that one file (verified against
 * `packages/kn-next/src/config.ts`: emits exactly one output, that file's own
 * `.d.ts`, not the whole program) — it is the entry's OWN declaration text,
 * not a bundled rollup of everything it imports.
 */
function createDtsEmitter(pkgDir) {
  const absDir = path.resolve(REPO_ROOT, pkgDir);
  const configPath = path.join(absDir, 'tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      `${pkgDir}: failed to read tsconfig.json: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, absDir);
  const options = {
    ...parsed.options,
    noEmit: false,
    emitDeclarationOnly: true,
    declaration: true,
    declarationMap: false,
    skipLibCheck: true,
  };
  const program = ts.createProgram({ rootNames: parsed.fileNames, options });

  return function emitDts(srcAbsPath) {
    const sourceFile = program.getSourceFile(srcAbsPath);
    if (!sourceFile) {
      throw new Error(`${pkgDir}: entry not found in program: ${srcAbsPath}`);
    }
    let captured;
    const result = program.emit(
      sourceFile,
      (_fileName, text) => {
        captured = text;
      },
      undefined,
      /* emitOnlyDtsFiles */ true,
    );
    const errors = result.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
    if (errors.length > 0) {
      const messages = errors
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
        .join('\n');
      throw new Error(`${pkgDir}: type errors emitting ${srcAbsPath}:\n${messages}`);
    }
    if (captured === undefined) {
      throw new Error(
        `${pkgDir}: no .d.ts emitted for ${srcAbsPath} (unresolved / non-emitting entry)`,
      );
    }
    return normalizeDts(captured);
  };
}

/**
 * Normalizes emitted `.d.ts` text so the report is stable across machines and
 * unrelated to sourcemap comments: strips the `//# sourceMappingURL=` line
 * TypeScript would otherwise append (declarationMap is off above, so this is
 * defensive) and normalizes line endings.
 */
function normalizeDts(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !line.startsWith('//# sourceMappingURL='))
    .join('\n')
    .trimEnd();
}

/**
 * Generates the full type-surface report for one package: a single
 * deterministic text blob, one section per public subpath, sorted by
 * subpath.
 */
export function generatePackageReport(pkg) {
  const entries = publicEntries(pkg.dir);
  const emitDts = createDtsEmitter(pkg.dir);
  const sections = entries
    .slice()
    .sort((a, b) => a.subpath.localeCompare(b.subpath))
    .map((entry) => {
      const header = `### ${entry.subpath}`;
      if (!entry.typed) {
        return `${header}\n(untyped JS export — no .d.ts; see public-api-surface.test.ts)`;
      }
      const dts = emitDts(entry.srcAbsPath);
      return `${header}\n${dts}`;
    });
  const banner = [
    `# Public API type surface — ${pkg.name}`,
    '#',
    '# GENERATED by scripts/api-surface/generate.mjs — do not hand-edit.',
    '# A diff here means the public type surface changed: review it, then',
    '# regenerate + commit (`node scripts/api-surface/generate.mjs`).',
    '',
  ].join('\n');
  return `${banner}${sections.join('\n\n')}\n`;
}

export function reportPath(pkg) {
  return path.join(REPO_ROOT, 'api-surface', `${pkg.reportName}.d.ts.report`);
}
