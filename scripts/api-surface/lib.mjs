/**
 * #1669 — public API type-surface report for the publishable @getknext/*
 * packages (core, lib, db).
 *
 * WHY THIS SHAPE: `public-api-surface.test.ts` (PK5/#286) already proves the
 * *subpath* surface — which import paths exist. It does not look inside a
 * subpath: renaming an exported symbol, or narrowing a parameter/property
 * type within an already-public subpath, passes that check untouched. This
 * module closes that gap by generating the actual exported TYPE TEXT for
 * each public subpath (via the TypeScript compiler API's `TypeChecker` —
 * `typescript` is already a root devDependency, no new dependency added) and
 * diffing it against a checked-in baseline. Any diff — a rename, a narrowed
 * type, or an unreviewed addition — means the checked-in report is stale and
 * the check fails until a human regenerates and commits it
 * (`node scripts/api-surface/generate.mjs`), the same "generated file must
 * match, updating it is part of the PR" discipline the repo already uses for
 * the 3-way public-API-subpath contract.
 *
 * ROUND 2 (review fix): `checker.getExportsOfModule` — not a single-file
 * `.d.ts` emit — is what makes this TRANSITIVE. An entry's `.d.ts` emit only
 * shows its OWN top-level declarations; `@getknext/lib`'s `.` entry
 * (`src/index.ts`) is six `export * from './x'` statements, so a single-file
 * emit's own declaration text is nearly empty and a rename/narrowing inside
 * `redis/client.ts` (reached only via `export * from './redis/client'`)
 * would pass untouched. `getExportsOfModule` resolves every `export *` /
 * `export { X } from` re-export to its real target symbol, so the exported
 * NAME and its full type text are tracked wherever the symbol is actually
 * declared. Verified against `@getknext/lib`: `createRedisClient`,
 * `KnextRedisClient`, `ensureDialable` (all reached only through
 * `redis/client.ts` / `redis/quiet.ts`) are present in
 * `checker.getExportsOfModule` for `src/index.ts` even though none of them
 * is written there.
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
 * should typecheck + extract exported symbols from.
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
 * Deliberately uses TypeScript's DEFAULT (truncating) `typeToString`/
 * `signatureToString`, not `NoTruncation`: a handful of public entries reach
 * types from `next` (e.g. `NextConfig`, the webpack plugin graph inside it)
 * that are deep/self-referential enough to overflow the native call stack
 * under `NoTruncation` (measured: `@getknext/core/adapter`'s `NextAdapter`
 * signature — an uncatchable V8 crash, not a catchable `RangeError`). Bounded
 * truncation is what avoids the recursion in the first place, at the cost of
 * an ellipsis inside a handful of very deep external types this guard was
 * never going to fully expand anyway; this fallback ladder is defense in
 * depth for the (in practice unreached) case where even the default still
 * throws a catchable `RangeError` — it never masks a genuine surface change,
 * it only changes how deep the rendering goes.
 */
function safeTypeToString(checker, type, decl, flags) {
  try {
    return checker.typeToString(type, decl, flags);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    try {
      return checker.typeToString(type, decl);
    } catch (err2) {
      if (!(err2 instanceof RangeError)) throw err2;
      return checker.typeToString(type);
    }
  }
}

function safeSignatureToString(checker, sig, decl, flags) {
  try {
    return checker.signatureToString(sig, decl, undefined, flags);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    return checker.signatureToString(sig, decl);
  }
}

/**
 * Structurally prints one exported member: `name: <type text>` for a plain
 * value, or `name(<params>): <return>` per overload for a callable. Optional
 * properties/params carry a trailing `?`.
 */
function printMember(checker, symbol, contextNode) {
  const decl = symbol.declarations?.[0] ?? contextNode;
  const optional = (symbol.flags & ts.SymbolFlags.Optional) !== 0;
  const type = checker.getTypeOfSymbolAtLocation(symbol, decl);
  const callSignatures = type.getCallSignatures();
  if (callSignatures.length > 0) {
    return callSignatures
      .map(
        (sig) =>
          `${symbol.getName()}${safeSignatureToString(
            checker,
            sig,
            decl,
            ts.TypeFormatFlags.None,
          )}`,
      )
      .join('\n');
  }
  const typeText = safeTypeToString(
    checker,
    type,
    decl,
    ts.TypeFormatFlags.MultilineObjectLiterals,
  );
  return `${symbol.getName()}${optional ? '?' : ''}: ${typeText}`;
}

/**
 * Structural text for an exported symbol's own declared shape: a callable's
 * signature(s), a structural object type's member list (sorted by name, so
 * a renamed/narrowed member changes the diff wherever it is actually
 * declared, transitively resolved through `export *`), or a plain
 * `typeToString` for a primitive/union/intersection/literal type.
 */
/**
 * True when EVERY declaration of a (already alias-resolved, per
 * `getExportsOfModule`) symbol lives under `node_modules` — i.e. this
 * subpath re-exports a THIRD-PARTY type/value wholesale, rather than
 * declaring it in this repo. `@getknext/db/schema` re-exports drizzle's
 * pg-core builders verbatim (documented in its own `knext.publicApi.public`
 * entry) — deeply generic, mutually-recursive builder types that overflow
 * the native call stack under structural (`getProperties`) expansion
 * (measured: an uncatchable V8 crash, not a catchable `RangeError` — the
 * `safeTypeToString` ladder cannot save this one). Since it is upstream's
 * compat surface, not a narrowing WE could introduce, these are recorded by
 * name + origin package only, never structurally expanded.
 */
function isExternalDeclaration(symbol) {
  const decls = symbol.declarations ?? [];
  if (decls.length === 0) return false;
  return decls.every((d) => d.getSourceFile().fileName.includes('/node_modules/'));
}

/**
 * Resolves a `checker.getExportsOfModule` ALIAS symbol to its real target,
 * following a chain (`export { X as Y } from 'z'` re-exporting something
 * that is itself re-exported). `export * from` re-exports already come back
 * from `getExportsOfModule` as the real target symbol (its `.flags` show the
 * true kind — Function/Interface/etc, never Alias); named `export { X }
 * from` re-exports do NOT — the symbol keeps the `Alias` flag and its OWN
 * `.declarations` point at the local `ExportSpecifier`, not the target
 * (measured: `@getknext/db/extensions/pgvector.ts`'s
 * `export { cosineDistance, ... } from 'drizzle-orm'` — without this, the
 * exported name resolves to a LOCAL declaration node, so
 * `isExternalDeclaration` never fires and every drizzle-orm type reachable
 * from its signature prints as an absolute-path `import("/…/node_modules/…")`
 * reference instead of the collapsed external marker). The exported NAME
 * (what a consumer actually imports) is kept from the ORIGINAL symbol by the
 * caller; only the symbol used for type/declaration analysis is swapped.
 */
function resolveAliasTarget(checker, symbol) {
  let current = symbol;
  const seen = new Set();
  while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current);
    let next;
    try {
      next = checker.getAliasedSymbol(current);
    } catch {
      break;
    }
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

function originPackageOf(decl) {
  const fileName = decl.getSourceFile().fileName;
  // Split on the LAST `/node_modules/` boundary, not the first: bun's
  // node_modules layout hoists through an intermediate `.bun/<pkg>@<ver>/`
  // folder (`node_modules/.bun/drizzle-orm@.../node_modules/drizzle-orm/...`),
  // so matching the first boundary reports the meaningless `.bun` segment
  // instead of the real package (measured against this repo's actual
  // installed layout).
  const segments = fileName.split('/node_modules/');
  const last = segments[segments.length - 1].split('/');
  if (last[0]?.startsWith('@') && last.length > 1) {
    return `${last[0]}/${last[1]}`;
  }
  return last[0] ?? 'external';
}

/**
 * `exportedName` is the name a CONSUMER imports (from the original,
 * possibly-alias `getExportsOfModule` symbol — a named re-export can rename,
 * `export { X as Y }`); `symbol` is that symbol's fully alias-RESOLVED
 * target (see `resolveAliasTarget`), used for every declaration/kind/type
 * lookup below.
 */
function surfaceOfSymbol(checker, exportedName, symbol, contextNode) {
  const decl = symbol.declarations?.[0] ?? contextNode;
  if (isExternalDeclaration(symbol)) {
    return `external ${exportedName} (re-exported from ${originPackageOf(decl)} — upstream type, not structurally tracked; see this subpath's knext.publicApi entry)`;
  }
  const isTypeLike =
    (symbol.flags &
      (ts.SymbolFlags.Interface |
        ts.SymbolFlags.Class |
        ts.SymbolFlags.TypeAlias |
        ts.SymbolFlags.Enum)) !==
    0;
  const type = isTypeLike
    ? checker.getDeclaredTypeOfSymbol(symbol)
    : checker.getTypeOfSymbolAtLocation(symbol, decl);

  const callSignatures = type.getCallSignatures();
  if (callSignatures.length > 0 && !isTypeLike) {
    return callSignatures
      .map(
        (sig) =>
          `function ${exportedName}${safeSignatureToString(
            checker,
            sig,
            decl,
            ts.TypeFormatFlags.None,
          )}`,
      )
      .join('\n');
  }

  // Member enumeration ONLY for genuine object types (interfaces, classes,
  // object-literal-shaped type aliases, function/callable types). A string-
  // or number-LITERAL type alias (`type CacheProvider = "redis"`) is not
  // `TypeFlags.Object`, but `type.getProperties()` on it still returns every
  // inherited `String.prototype`/`Number.prototype` member (measured: this
  // blew the core/db reports up to 1000+/7000+ lines of `concat`/`replace`/
  // `padStart` noise for a single string-literal alias). Anything that is
  // not object-like falls straight through to the plain `typeToString`
  // branch below, which already renders literals/unions/intersections fully.
  const isObjectLike = (type.flags & ts.TypeFlags.Object) !== 0;
  const parts = [];
  if (isObjectLike) {
    const properties = type.getProperties();
    const constructSignatures = type.getConstructSignatures();
    for (const sig of callSignatures) {
      parts.push(`  ${safeSignatureToString(checker, sig, decl, ts.TypeFormatFlags.None)}`);
    }
    for (const sig of constructSignatures) {
      parts.push(`  new ${safeSignatureToString(checker, sig, decl, ts.TypeFormatFlags.None)}`);
    }
    for (const prop of properties) {
      parts.push(`  ${printMember(checker, prop, decl)}`);
    }
    parts.sort();
  }

  if (parts.length === 0) {
    // Primitive / union / intersection / literal (e.g. `type X = "a" | "b"`,
    // `type Y = A & B`) — typeToString already gives a full, deterministic
    // structural rendering for these.
    const typeText = safeTypeToString(checker, type, decl, ts.TypeFormatFlags.InTypeAlias);
    return `${kindOf(symbol)} ${exportedName} = ${typeText}`;
  }
  return `${kindOf(symbol)} ${exportedName} {\n${parts.join('\n')}\n}`;
}

function kindOf(symbol) {
  if (symbol.flags & ts.SymbolFlags.Interface) return 'interface';
  if (symbol.flags & ts.SymbolFlags.Class) return 'class';
  if (symbol.flags & ts.SymbolFlags.Enum) return 'enum';
  if (symbol.flags & ts.SymbolFlags.TypeAlias) return 'type';
  return 'const';
}

/**
 * The full, transitively-resolved exported surface of one entry source file:
 * every name `checker.getExportsOfModule` reports for it (following
 * `export *` / `export { X } from` chains to the real declaration, wherever
 * it lives), sorted by exported name, each rendered via `surfaceOfSymbol`.
 */
function extractEntrySurface(program, checker, sourceFile) {
  // Scoped to THIS file's syntactic + semantic diagnostics — deliberately not
  // `ts.getPreEmitDiagnostics(program, sourceFile)`, which also surfaces
  // program-GLOBAL diagnostics (e.g. a stale `types` compilerOptions entry
  // like `bun-types` vs the installed `@types/bun`) that have nothing to do
  // with this entry's own exported surface and would fail every package on
  // an unrelated environment/config issue.
  const errors = [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ].filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    const messages = errors
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      .join('\n');
    throw new Error(`type errors in ${sourceFile.fileName}:\n${messages}`);
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    throw new Error(`${sourceFile.fileName}: not a module (no exports found)`);
  }
  const exportsOfModule = checker
    .getExportsOfModule(moduleSymbol)
    .slice()
    .sort((a, b) => a.getName().localeCompare(b.getName()));
  const surface = exportsOfModule
    .map((raw) =>
      surfaceOfSymbol(checker, raw.getName(), resolveAliasTarget(checker, raw), sourceFile),
    )
    .join('\n\n');
  return normalizeAbsolutePaths(surface);
}

/**
 * Rewrites every `import("<absolute path>")` reference TypeScript's printer
 * emits for a type it cannot name in context — the round-3 review fix. Two
 * shapes, both made portable:
 *
 *  - a REPO-LOCAL absolute path (e.g. `@getknext/core`'s `validateConfig`
 *    referencing `config.ts`'s `KnativeNextConfig` from `cli/validate.ts`)
 *    becomes the REPO-RELATIVE path — identical text on any checkout.
 *  - a `node_modules` absolute path becomes just the package specifier
 *    (`<pkg>` or `<pkg>/<subpath>`), the same collapse `originPackageOf`
 *    already does for whole-symbol external re-exports, so a version bump's
 *    `.bun`/`.pnpm` store hash (`drizzle-orm@0.45.2+bc97d1609396e075`)
 *    doesn't leak into the report either.
 *
 * Without this, the checked-in baseline embeds the CONTRIBUTOR'S absolute
 * checkout path (measured: a git worktree under `.claude/worktrees/…`) —
 * `check.mjs` then fails with a pure path diff on every OTHER checkout,
 * including CI (`/home/runner/work/knext/knext`), and the path leaks into
 * the repo. `tests/api-surface-no-absolute-paths.test.ts` is the guard that
 * a future printed type can't reintroduce this.
 */
function normalizeAbsolutePaths(text) {
  return text.replace(/import\("([^"]+)"\)/g, (whole, importPath) => {
    const nmIdx = importPath.lastIndexOf('/node_modules/');
    if (nmIdx !== -1) {
      const rest = importPath.slice(nmIdx + '/node_modules/'.length);
      const segs = rest.split('/');
      const pkg = segs[0]?.startsWith('@') && segs.length > 1 ? `${segs[0]}/${segs[1]}` : segs[0];
      const subpath = segs.slice(segs[0]?.startsWith('@') ? 2 : 1).join('/');
      return `import("${pkg}${subpath ? `/${subpath}` : ''}")`;
    }
    if (importPath.startsWith(REPO_ROOT)) {
      const rel = importPath.slice(REPO_ROOT.length).replace(/^\/+/, '');
      return `import("${rel}")`;
    }
    return whole;
  });
}

/**
 * Builds one `ts.Program` (+ `TypeChecker`) for the package, reused across
 * every entry — the expensive part, typechecking the whole `src/`, happens
 * once — and returns a function that extracts one entry's transitively
 * resolved exported surface.
 */
function createSurfaceExtractor(pkgDir) {
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
    noEmit: true,
    skipLibCheck: true,
  };
  const program = ts.createProgram({ rootNames: parsed.fileNames, options });
  const checker = program.getTypeChecker();

  return function extractSurface(srcAbsPath) {
    const sourceFile = program.getSourceFile(srcAbsPath);
    if (!sourceFile) {
      throw new Error(`${pkgDir}: entry not found in program: ${srcAbsPath}`);
    }
    return extractEntrySurface(program, checker, sourceFile);
  };
}

/**
 * Generates the full type-surface report for one package: a single
 * deterministic text blob, one section per public subpath, sorted by
 * subpath.
 */
export function generatePackageReport(pkg) {
  const entries = publicEntries(pkg.dir);
  const extractSurface = createSurfaceExtractor(pkg.dir);
  const sections = entries
    .slice()
    .sort((a, b) => a.subpath.localeCompare(b.subpath))
    .map((entry) => {
      const header = `### ${entry.subpath}`;
      if (!entry.typed) {
        return `${header}\n(untyped JS export — no .d.ts; see public-api-surface.test.ts)`;
      }
      const surface = extractSurface(entry.srcAbsPath);
      return `${header}\n${surface}`;
    });
  const banner = [
    `# Public API type surface — ${pkg.name}`,
    '#',
    '# GENERATED by scripts/api-surface/generate.mjs — do not hand-edit.',
    '# A diff here means the public type surface changed: review it, then',
    '# regenerate + commit (`node scripts/api-surface/generate.mjs`).',
    '#',
    "# Transitively resolved: every export reachable from the subpath's",
    '# entry file, including through `export * from` re-exports, is',
    '# tracked wherever it is actually declared (checker.getExportsOfModule).',
    '',
  ].join('\n');
  const report = `${banner}${sections.join('\n\n')}\n`;
  // Fail LOUD here, not just in the standalone test — a generator that can
  // silently commit a contributor's home/worktree path is the round-3 defect.
  assertNoAbsolutePaths(report, pkg.name);
  return report;
}

/**
 * `/Users/…` (macOS), `/home/…` (Linux, incl. CI's `/home/runner/work/…`),
 * and `C:\…` (Windows) — plus a defensive direct check for THIS process's
 * own `REPO_ROOT`, in case a path reaches the report through some route
 * `normalizeAbsolutePaths` doesn't pattern-match (e.g. not wrapped in
 * `import("...")`). Exported so the standalone regression test
 * (`tests/api-surface-no-absolute-paths.test.ts`) checks the exact same rule
 * against the COMMITTED report files, not a re-implementation of it.
 */
export function assertNoAbsolutePaths(text, label) {
  const patterns = [/\/Users\//, /\/home\//, /[A-Za-z]:\\/, new RegExp(escapeRegExp(REPO_ROOT))];
  for (const re of patterns) {
    const match = text.match(re);
    if (match) {
      throw new Error(
        `${label}: found an absolute local path (\`${match[0]}\`) in the generated report — ` +
          'this leaks a contributor/CI checkout path and breaks the guard on every other machine.',
      );
    }
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function reportPath(pkg) {
  return path.join(REPO_ROOT, 'api-surface', `${pkg.reportName}.d.ts.report`);
}

/**
 * Exposed for the transitive-resolution fixture test
 * (`tests/api-surface-transitive-resolution.test.ts`): builds an isolated
 * `ts.Program` over caller-supplied in-memory-free temp source files (no
 * package.json / tsconfig.json needed) and extracts one entry's
 * transitively-resolved surface, exactly like `generatePackageReport` does
 * for the real packages.
 */
export function extractSurfaceForFiles(rootNames, entryAbsPath, compilerOptions) {
  const program = ts.createProgram({
    rootNames,
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
      ...compilerOptions,
    },
  });
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(entryAbsPath);
  if (!sourceFile) {
    throw new Error(`entry not found in program: ${entryAbsPath}`);
  }
  return extractEntrySurface(program, checker, sourceFile);
}
