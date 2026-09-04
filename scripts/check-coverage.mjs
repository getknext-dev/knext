#!/usr/bin/env node
/**
 * The coverage gate (#884) — merge both runners' lcov, then enforce the floors.
 *
 * ## Why this exists as a script
 *
 * The floors used to be `vitest.config.ts`'s. After the `vitest` -> `bun test`
 * migration vitest collects 3 test files out of 338, so it was checking a 77%
 * floor against a 1.37% measurement: the gate was still red-capable, but what it
 * measured had stopped being the suite. Neither runner can take the whole job:
 *
 *   - `scripts/bun-test.mjs` runs the suite but one PROCESS per test file (mock
 *     isolation, see its docstring), so it emits ~338 separate reports and bun's
 *     own threshold config has no per-path form;
 *   - vitest sees almost no tests but enumerates every source file, which is the
 *     only honest denominator available.
 *
 * So the gate is the MERGE of the two, and the floors live in
 * `scripts/lib/coverage-policy.mjs` — one definition, read by this script and by
 * `vitest.config.ts`.
 *
 * ## Fail-closed
 *
 * Missing input is a FAILURE, never a pass. A coverage gate that goes green when
 * it cannot find a report is precisely the "measures less, so it is green"
 * defect this replaced.
 *
 * Usage:
 *   node scripts/check-coverage.mjs                 # the standard two inputs
 *   node scripts/check-coverage.mjs --lcov=a.info --lcov=b.info
 *   node scripts/check-coverage.mjs --report-only    # print, never fail
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  activeMetricExceptions,
  assertEveryMetricAccountedFor,
  BUN_COVERAGE_DIR,
  COVERAGE_EXCLUDE,
  COVERAGE_INCLUDE,
  MERGED_LCOV,
  PER_PATH_THRESHOLDS,
  THRESHOLDS,
  VITEST_LCOV,
} from './lib/coverage-policy.mjs';
import { formatLcov, matchesGlob, mergeLcov, summarize } from './lib/lcov.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const reportOnly = argv.includes('--report-only');
const explicit = argv.filter((a) => a.startsWith('--lcov=')).map((a) => a.slice('--lcov='.length));

/** Every `.info` under a directory, recursively — bun writes one per test file. */
function lcovFilesUnder(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...lcovFilesUnder(full));
    else if (entry.endsWith('.info') && !entry.startsWith('.')) out.push(full);
  }
  return out;
}

const inputs = explicit.length
  ? explicit.map((p) => resolve(REPO_ROOT, p))
  : [
      ...lcovFilesUnder(resolve(REPO_ROOT, process.env.KNEXT_BUN_COVERAGE_DIR ?? BUN_COVERAGE_DIR)),
      ...(existsSync(resolve(REPO_ROOT, VITEST_LCOV)) ? [resolve(REPO_ROOT, VITEST_LCOV)] : []),
    ];

const missing = inputs.filter((p) => !existsSync(p));
if (missing.length > 0) {
  console.error(`coverage: named report(s) missing — ${missing.join(', ')}`);
  process.exit(1);
}
if (inputs.length === 0) {
  console.error(
    'coverage: no lcov reports found.\n' +
      `  expected per-file reports in ./${BUN_COVERAGE_DIR}/ (node scripts/bun-test.mjs --coverage)\n` +
      `  and ./${VITEST_LCOV} (vitest run --coverage).\n` +
      '  Refusing to pass on an absent measurement.',
  );
  process.exit(1);
}

const merged = mergeLcov(inputs.map((p) => readFileSync(p, 'utf8')));

/**
 * Restrict to the policy's file set BEFORE measuring.
 *
 * bun reports every file a test loaded — preloads, `tests/`, `apps/` — and those
 * are not what the floors describe. Applying the same include/exclude vitest
 * uses keeps one denominator rather than two.
 */
const scoped = new Map();
for (const [path, cov] of merged) {
  const included = COVERAGE_INCLUDE.some((g) => matchesGlob(path, g));
  const excluded = COVERAGE_EXCLUDE.some((g) => matchesGlob(path, g));
  if (included && !excluded) scoped.set(path, cov);
}

if (scoped.size === 0) {
  console.error(
    'coverage: the merged report contains no file matching the coverage policy.\n' +
      '  That is a broken pipeline, not 0% coverage. Refusing to report a number.',
  );
  process.exit(1);
}

const failures = [];

function check(label, summary, floors) {
  const rows = [];
  for (const [metric, floor] of Object.entries(floors)) {
    const found = metric === 'lines' ? summary.linesFound : summary.fnFound;
    const actual = metric === 'lines' ? summary.linesPct : summary.functionsPct;
    // An empty denominator is a BROKEN measurement, not a satisfied floor. A
    // gate that goes green because it found nothing to measure is the exact
    // failure #884 was filed about, so it reds instead.
    if (found === 0) {
      failures.push(`${label}: no ${metric} data in the merged report — the floor is unmeasurable`);
      rows.push(`    FAIL ${metric.padEnd(10)} no data (floor ${floor}%)`);
      continue;
    }
    const ok = actual >= floor;
    if (!ok) {
      failures.push(
        `${label}: ${metric} ${actual.toFixed(2)}% is below the ${floor}% floor` +
          ` (${metric === 'lines' ? `${summary.linesHit}/${summary.linesFound}` : `${summary.fnHit}/${summary.fnFound}`})`,
      );
    }
    rows.push(
      `    ${ok ? 'ok  ' : 'FAIL'} ${metric.padEnd(10)} ${actual.toFixed(2)}% (floor ${floor}%)`,
    );
  }
  console.log(
    `  ${label} — ${summary.fileCount} file(s), ${summary.linesHit}/${summary.linesFound} lines`,
  );
  for (const row of rows) console.log(row);
}

console.log(`\ncoverage — merged from ${inputs.length} lcov report(s)\n`);

// Every gated metric must have a floor or a LIVE dated exception (sprint 2,
// lane G). This THROWS rather than joining `failures`, and deliberately: an
// expired exception is not a coverage regression to report alongside the
// numbers, it is the gate no longer knowing what it is supposed to check. It
// also runs BEFORE the floors, so `--report-only` cannot carry an ungated metric
// past it — `--report-only` exists to soften a coverage DROP, never to soften
// the gate losing a metric entirely.
assertEveryMetricAccountedFor(THRESHOLDS, activeMetricExceptions());

check('global', summarize(scoped), THRESHOLDS);
for (const [glob, floors] of Object.entries(PER_PATH_THRESHOLDS)) {
  check(glob, summarize(scoped, glob), floors);
}

// The merged report is written out as a real artifact: codecov uploads it, and a
// human can read the same bytes the gate judged.
const mergedPath = resolve(REPO_ROOT, MERGED_LCOV);
mkdirSync(dirname(mergedPath), { recursive: true });
writeFileSync(mergedPath, formatLcov(scoped));
console.log(`\n  merged report written to ${MERGED_LCOV}`);

if (failures.length > 0) {
  console.error('\ncoverage gate FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    '\nFloors live in scripts/lib/coverage-policy.mjs. Raise coverage, not the exception:\n' +
      '  lowering a floor to go green is the failure mode #884 was filed about.',
  );
  if (!reportOnly) process.exit(1);
  console.error('\n(--report-only: reporting the failure without failing the run)');
} else {
  console.log('\ncoverage gate passed');
}
