/**
 * The honest denominator, generated rather than borrowed from a second runner
 * (#884, #871).
 *
 * vitest's one remaining job was the DENOMINATOR: it enumerated every source
 * file under `COVERAGE_INCLUDE`, so a file NO test imports showed at 0% and
 * dragged the percentage down. bun reports only files a test actually loaded, so
 * on its own it silently drops untested files from the denominator — the exact
 * "measures less, so it's green" dishonesty this gate exists to prevent.
 *
 * `generateDenominator` restores that enumeration deterministically and with no
 * second runner: given the source file list, it returns a zero-hit entry (over
 * the file's code lines) for each one NOT already present in the merged bun
 * report. A TYPE-ONLY file (interfaces / type aliases / `import type`) is
 * skipped: it transpiles to no runtime JS, so a coverage provider instruments
 * zero lines of it and it never sat in vitest's denominator either — counting
 * its physical lines would DEPRESS coverage for a file no tool measures, the
 * mirror of the inflation this guards.
 *
 * PURE by design: the caller supplies the enumerated `files` list (in
 * `scripts/check-coverage.mjs`, from `git ls-files`). Keeping the process spawn
 * OUT of this shared `scripts/lib` helper is what lets it be unit-tested and
 * MUTATION-PROVEN in isolation (`tests/coverage-denominator.test.ts`) — and it
 * satisfies the prover-lane rule that a `scripts/lib` helper does not spawn.
 *
 * Runs under plain `node` in CI before anything is BUILT (it imports the
 * `typescript` devDependency via `isTypeOnly`, present after install).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COVERAGE_EXCLUDE, COVERAGE_INCLUDE } from './coverage-policy.mjs';
import { codeLineNumbers, isTypeOnly, matchesGlob } from './lcov.mjs';

/**
 * Zero-hit denominator entries for every enumerable source file not in `have`.
 *
 * @param {string} repoRoot  root the `files` paths are relative to (for reading)
 * @param {string[]} files   repo-relative source paths (already enumerated)
 * @param {Map<string, import('./lcov.mjs').FileCoverage>} have  files already measured
 * @returns {Array<[string, import('./lcov.mjs').FileCoverage]>}
 */
export function generateDenominator(repoRoot, files, have) {
  const entries = [];
  for (const path of files) {
    if (!COVERAGE_INCLUDE.some((g) => matchesGlob(path, g))) continue;
    if (COVERAGE_EXCLUDE.some((g) => matchesGlob(path, g))) continue;
    if (have.has(path)) continue;
    let src;
    try {
      src = readFileSync(resolve(repoRoot, path), 'utf8');
    } catch {
      continue;
    }
    // Type-only files instrument to zero lines — see the module header. Skipping
    // them is the load-bearing direction (#884): a RUNTIME file must NEVER be
    // dropped, or it silently escapes the denominator and coverage rises.
    if (isTypeOnly(src)) continue;
    // Keyed by the REAL line numbers (#1248), so the honest-denominator
    // classifier reads the source line behind each record. The count is
    // unchanged, so the raw percentage is too.
    const lineNos = codeLineNumbers(src);
    if (lineNos.length === 0) continue;
    entries.push([
      path,
      {
        lines: new Map(lineNos.map((n) => [n, 0])),
        fnFound: 0,
        fnHit: 0,
        fnNames: new Map(),
      },
    ]);
  }
  return entries;
}
