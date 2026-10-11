#!/usr/bin/env node
/**
 * scan-published-seams.mjs — exit non-zero if ANY `__`-prefixed name is
 * reachable from a published entry of an `@getknext/*` package (#936).
 *
 * Reads the BUILT `dist` of every publishable package (a workspace package with
 * no `"private": true`), starting from the files its `exports` map points at.
 * The reader lives in `scripts/lib/published-export-scan.mjs`; read its header
 * for what is and is not covered. Run it after the lib -> db -> core builds.
 *
 *   node scripts/scan-published-seams.mjs
 *   node scripts/scan-published-seams.mjs --package <dir> [--package <dir>…] [--resolve-from <dir>]
 *
 * `--package` points the scan at one package directory (for example an
 * extracted `npm pack` tarball); `--resolve-from` is where bare specifiers
 * (`export * from 'drizzle-orm'`) are looked up, since an extracted tarball
 * has no `node_modules`.
 *
 * Exit codes: 0 clean; 1 a seam is exported OR something could not be read
 * (fail closed); 2 bad usage.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCtx, describeFinding, scanPackage } from './lib/published-export-scan.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every workspace package under packages/, as `{ dir, json }`. */
function workspacePackages(root) {
  const out = [];
  const base = join(root, 'packages');
  for (const name of readdirSync(base)) {
    try {
      const dir = join(base, name);
      out.push({ dir, json: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) });
    } catch {
      // not a package directory
    }
  }
  return out;
}

/**
 * @param {string[]} argv
 * @param {string} [root] the repo root whose `packages/` is the workspace
 * @returns {number} the process exit code
 */
export function main(argv, root = REPO_ROOT) {
  const packages = [];
  let resolveFrom;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--package' && argv[i + 1]) packages.push(resolve(argv[++i]));
    else if (a === '--resolve-from' && argv[i + 1]) resolveFrom = resolve(argv[++i]);
    else {
      console.error(`scan-published-seams: unknown argument ${JSON.stringify(a)}`);
      return 2;
    }
  }

  const workspace = new Map();
  for (const p of workspacePackages(root)) if (p.json.name) workspace.set(p.json.name, p);

  const targets =
    packages.length > 0
      ? packages
      : [...workspace.values()].filter((p) => p.json.private !== true).map((p) => p.dir);
  if (targets.length === 0) {
    console.error('scan-published-seams: no publishable package found — refusing to report clean');
    return 1;
  }

  const ctx = createCtx({ resolveFrom, workspace });
  let failed = false;
  for (const dir of targets) {
    const result = scanPackage(ctx, dir);
    const entryCount = result.entries.length;
    const exportCount = result.entries.reduce((n, e) => n + e.exports, 0);
    if (result.findings.length > 0) {
      failed = true;
      console.error(`${result.name}: ${result.findings.length} finding(s)`);
      for (const f of result.findings) console.error(describeFinding(f));
    } else {
      console.log(
        `${result.name}: ${entryCount} entries, ${exportCount} exported names, no \`__\` seam`,
      );
    }
  }
  if (failed) {
    console.error(
      '\nA `__`-prefixed export is a test seam and must not be published. Move it to the ' +
        'unpublished test-seams entry, or — for an `unscannable` finding — make the construct readable. ' +
        'An unreadable construct is a failure, never a pass.',
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
