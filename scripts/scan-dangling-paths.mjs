#!/usr/bin/env node
/**
 * Find repo-relative paths that tracked files reference but that no longer exist.
 *
 * This is the debt that migrations leave behind and that nothing else catches.
 * A comment naming a deleted file is harmless prose; a guard that READS one is a
 * broken test that only fires when someone runs it; a workflow step that names
 * one is a red lane discovered in CI. They look identical in a grep, so this
 * separates them by asking a simpler question — does the path exist?
 *
 * It is deliberately conservative. Only strings that look like real repo paths
 * are considered: they must contain a `/`, start with a known top-level
 * directory, and carry a file extension. Prose like "the standalone-seam-alive
 * guard" is not a path and is not reported; `packages/kn-next/src/gone.ts` is.
 *
 * Exit code is 0 unless `--verify` is passed, so it can be read before it is
 * enforced.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** `packages/foo/src/x.ts` -> `packages/foo`; used for package-relative refs. */
function packageRootOf(file) {
  const parts = file.split('/');
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : '.';
}

const verify = process.argv.includes('--verify');
const repoRoot = process.cwd();

const TOP_LEVEL = ['packages', 'apps', 'scripts', 'tests', 'examples', 'turbo', 'docs', '.github'];
const PATH_RE = new RegExp(
  `\\b(?:${TOP_LEVEL.map((d) => d.replace('.', '\\.')).join('|')})\\/[A-Za-z0-9._\\-/]*\\.[A-Za-z0-9]{1,6}\\b`,
  'g',
);

/** Files whose own content is about paths that intentionally do not exist. */
const IGNORE_FILES = ['scripts/scan-dangling-paths.mjs', 'docs/benchmarks/bun-test-remaining.txt'];

const tracked = execFileSync('git', ['ls-files'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .filter(Boolean);

const trackedSet = new Set(tracked);
const SCANNABLE = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|md|sh|hbs|go|toml|Dockerfile)$/;

const findings = new Map();

for (const file of tracked) {
  if (IGNORE_FILES.includes(file)) continue;
  if (!SCANNABLE.test(file) && !file.endsWith('Dockerfile')) continue;

  let content;
  try {
    if (statSync(join(repoRoot, file)).size > 2 * 1024 * 1024) continue;
    content = readFileSync(join(repoRoot, file), 'utf8');
  } catch {
    continue;
  }

  for (const match of content.matchAll(PATH_RE)) {
    const ref = match[0];
    // A reference resolves if it exists relative to the repo root OR relative to
    // the referring file's own directory OR relative to its package root.
    //
    // Without the last two this reports nonsense: `packages/scale-zero-pg`'s
    // README says `docs/operations.md`, meaning ITS docs directory, and the
    // repo-root reading calls that dangling. 123 findings collapsed to a
    // fraction once relative resolution was added — a scanner that cries wolf
    // is worse than none, because the real ones get skimmed past.
    const candidates = [
      join(repoRoot, ref),
      join(repoRoot, dirname(file), ref),
      join(repoRoot, packageRootOf(file), ref),
    ];
    if (trackedSet.has(ref) || candidates.some((c) => existsSync(c))) continue;
    // A path inside a template's rendered output, or a glob, is not a claim
    // about this repo's tree.
    if (ref.includes('*') || ref.includes('{{')) continue;
    if (!findings.has(ref)) findings.set(ref, new Set());
    findings.get(ref).add(file);
  }
}

const sorted = [...findings.entries()].sort((a, b) => b[1].size - a[1].size);

console.log(`scanned ${tracked.length} tracked files`);
console.log(`  ${sorted.length} referenced path(s) do not exist\n`);

for (const [ref, referrers] of sorted) {
  console.log(`  ${ref}`);
  for (const r of [...referrers].sort().slice(0, 6)) console.log(`      <- ${r}`);
  if (referrers.size > 6) console.log(`      <- ...and ${referrers.size - 6} more`);
}

if (verify && sorted.length > 0) {
  console.error(`\n${sorted.length} dangling path reference(s)`);
  process.exit(1);
}
