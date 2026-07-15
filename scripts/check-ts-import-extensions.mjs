#!/usr/bin/env node
/**
 * check-ts-import-extensions.mjs — deterministic guard for the TS5097 main-red
 * class (#289).
 *
 * Under `moduleResolution: bundler` (used by @knext/core), `tsc --noEmit`
 * rejects an explicit `.ts`/`.tsx`/`.mts`/`.cts` import extension with TS5097
 * (`allowImportingTsExtensions` is off). Vitest resolves such specifiers at
 * runtime, so the offending test can run green locally while the post-merge
 * `Typecheck @knext/core` gate goes red — turning the default branch red for
 * every open PR (the PR #285 → #288 incident).
 *
 * This guard FAILS FAST (author/PR time) on any RELATIVE import specifier that
 * ends in a TypeScript extension. It uses the TypeScript compiler's AST — NOT a
 * regex — so it inspects only genuine module specifiers (static
 * import/export … from, side-effect import, dynamic import(), and `import(...)`
 * type nodes). It NEVER matches text inside string literals or comments, so it
 * does not false-positive on filesystem-path STRINGS such as
 * `resolve(dir, "src/x.ts")` / `readFileSync(".../foo.ts")`, nor on `.ts` text
 * embedded in test-fixture strings (e.g. a test that builds the source
 * `import("../x.ts")` as a string to write to a temp file).
 *
 * Usage:
 *   node scripts/check-ts-import-extensions.mjs [--quiet] [path ...]
 *     path  a file or directory. Directories are scanned recursively for
 *           .ts/.tsx/.mts/.cts sources (node_modules/dist/.next/coverage
 *           skipped). With no paths, defaults to packages/kn-next/src.
 *   --quiet  suppress the success line; offenders are always printed.
 *
 * Exit 0 = clean, 1 = at least one forbidden extension found.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DEFAULT_DIR = join(REPO_ROOT, 'packages', 'kn-next', 'src');

const SOURCE_EXT = /\.(?:ts|tsx|mts|cts)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.open-next', 'coverage', '.turbo']);

/** A relative specifier that must be resolved without a TS extension. */
function isForbiddenSpecifier(spec) {
  return spec.startsWith('.') && SOURCE_EXT.test(spec);
}

/**
 * Parse `src` with the TypeScript scanner and return every forbidden import
 * specifier as { spec, line }. Only genuine module specifiers are considered —
 * string-literal contents and comments are never matched.
 */
export function findTsExtensionImports(src, fileName = 'input.tsx') {
  const sf = ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    // .tsx keeps JSX-capable parsing; harmless for plain .ts sources.
    ts.ScriptKind.TSX,
  );
  const hits = [];

  const record = (specNode) => {
    if (specNode && ts.isStringLiteralLike(specNode)) {
      const spec = specNode.text;
      if (isForbiddenSpecifier(spec)) {
        const { line } = sf.getLineAndCharacterOfPosition(specNode.getStart(sf));
        hits.push({ spec, line: line + 1 });
      }
    }
  };

  const visit = (node) => {
    // static: import … from "x";  export … from "x";
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      record(node.moduleSpecifier);
    }
    // dynamic: import("x")  (CallExpression with the import keyword)
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      record(node.arguments[0]);
    }
    // type position: import("x").Foo
    else if (ts.isImportTypeNode(node) && node.argument) {
      if (ts.isLiteralTypeNode(node.argument)) {
        record(node.argument.literal);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return hits.sort((a, b) => a.line - b.line);
}

/** Recursively collect TS source files under a directory. */
function collectFiles(target) {
  const st = statSync(target);
  if (st.isFile()) return [target];
  const out = [];
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...collectFiles(join(target, entry.name)));
    } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
      out.push(join(target, entry.name));
    }
  }
  return out;
}

function main(argv) {
  const args = argv.slice(2);
  const quiet = args.includes('--quiet');
  const paths = args.filter((a) => a !== '--quiet');
  const targets = paths.length > 0 ? paths : [DEFAULT_DIR];

  const files = [];
  for (const p of targets) files.push(...collectFiles(resolve(p)));

  const offenders = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const { spec, line } of findTsExtensionImports(src, file)) {
      offenders.push({ file, spec, line });
    }
  }

  if (offenders.length > 0) {
    process.stderr.write(
      `TS5097 guard: forbidden TypeScript import extension(s) found ` +
        `(remove the .ts/.tsx/.mts/.cts extension — moduleResolution:bundler ` +
        `rejects them under tsc --noEmit):\n`,
    );
    for (const { file, spec, line } of offenders) {
      const rel = file.startsWith(REPO_ROOT) ? file.slice(REPO_ROOT.length + 1) : file;
      process.stderr.write(`  ${rel}:${line}  import "${spec}"\n`);
    }
    process.exit(1);
  }

  if (!quiet) {
    process.stdout.write(
      `TS5097 guard: OK — no .ts/.tsx import extensions in ${files.length} file(s).\n`,
    );
  }
  process.exit(0);
}

// Only run when invoked directly (allow importing findTsExtensionImports).
if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv);
}
