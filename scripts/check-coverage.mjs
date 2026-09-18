#!/usr/bin/env node
/**
 * The coverage gate (#884) — measure the bun suite, then enforce the floors.
 *
 * ## Why this exists as a script
 *
 * The floors used to be `vitest.config.ts`'s. After the `vitest` -> `bun test`
 * migration (#871) vitest was collecting 3 test files out of 338, so it was
 * checking a 77% floor against a 1.37% measurement. vitest is now GONE — the
 * suite runs entirely under `bun test` — but bun's own threshold config has no
 * per-path form and, run one PROCESS per test file (mock isolation, see
 * `scripts/bun-test.mjs`), it emits ~338 separate reports. So this script merges
 * them and enforces the floors from `scripts/lib/coverage-policy.mjs`.
 *
 * ## The honest denominator, without vitest
 *
 * vitest's one remaining job was the DENOMINATOR: it enumerated every source
 * file under `COVERAGE_INCLUDE`, so a source file NO test imports showed up at
 * 0% and dragged the percentage down. bun reports only files a test actually
 * loaded, so on its own it would silently drop untested files from the
 * denominator — the exact "measures less, so it is green" dishonesty this gate
 * exists to prevent.
 *
 * `denominatorEntries()` restores that enumeration deterministically and with no
 * second runner: it lists the `COVERAGE_INCLUDE \ COVERAGE_EXCLUDE` files from
 * `git ls-files` and, for any not already present in the merged bun report,
 * injects a zero-hit entry over its code lines. That over-counts an untested
 * file's lines slightly versus a coverage provider's executable-line notion, but
 * only ever LOWERS the percentage — the safe direction for a floor — and keeps
 * the invariant that adding an untested file cannot raise coverage.
 *
 * ## Fail-closed
 *
 * Missing input is a FAILURE, never a pass. A coverage gate that goes green when
 * it cannot find a report is precisely the "measures less, so it is green"
 * defect this replaced.
 *
 * Usage:
 *   node scripts/check-coverage.mjs                 # scan coverage-bun/ + denominator
 *   node scripts/check-coverage.mjs --lcov=a.info --lcov=b.info   # explicit, no auto-denominator
 *   node scripts/check-coverage.mjs --report-only    # print, never fail
 */

import { execFileSync } from 'node:child_process';
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
} from './lib/coverage-policy.mjs';
import {
  countCodeLines,
  formatLcov,
  isTypeOnly,
  matchesGlob,
  mergeLcov,
  summarize,
} from './lib/lcov.mjs';

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
  : lcovFilesUnder(resolve(REPO_ROOT, process.env.KNEXT_BUN_COVERAGE_DIR ?? BUN_COVERAGE_DIR));

/**
 * The honest denominator, generated rather than borrowed from a second runner.
 *
 * Enumerate every `COVERAGE_INCLUDE \ COVERAGE_EXCLUDE` source file from
 * `git ls-files` and return a zero-hit coverage entry (over its code lines) for
 * each one NOT already present in `have`. Merged in, this reinstates vitest's
 * old role: an untested source file is counted at 0% and cannot vanish from the
 * denominator to inflate the percentage.
 *
 * Skipped in `--lcov=` mode: an explicit run is a controlled measurement (the
 * gate's own tests hand it synthetic paths), so it must not pull real repo files
 * into the denominator.
 *
 * @param {Map<string, import('./lib/lcov.mjs').FileCoverage>} have
 * @returns {Array<[string, import('./lib/lcov.mjs').FileCoverage]>}
 */
function denominatorEntries(have) {
  let listed;
  try {
    listed = execFileSync('git', ['ls-files', '-z', 'packages'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\0')
      .filter(Boolean);
  } catch {
    // Unreachable enumeration is a FAILURE, never a pass: a shrunken denominator
    // reads as higher coverage, the exact dishonesty this gate prevents.
    console.error('coverage: could not enumerate source files for the denominator (git ls-files).');
    process.exit(1);
  }
  const entries = [];
  for (const path of listed) {
    if (!COVERAGE_INCLUDE.some((g) => matchesGlob(path, g))) continue;
    if (COVERAGE_EXCLUDE.some((g) => matchesGlob(path, g))) continue;
    if (have.has(path)) continue;
    let src;
    try {
      src = readFileSync(resolve(REPO_ROOT, path), 'utf8');
    } catch {
      continue;
    }
    // A TYPE-ONLY file (only interfaces / type aliases / `import type`) transpiles
    // to no runtime JS, so a coverage provider instruments ZERO lines of it — it
    // never sat in vitest's denominator either. Counting its physical lines here
    // would over-count an untested file and dishonestly DEPRESS coverage, the
    // mirror of the inflation this generator prevents. Skip it (contributes 0),
    // exactly as v8 did. `config.ts` is the load-bearing case: 315 type-only lines
    // imported by ~40 tests, all `import type`, so no test ever loads it at runtime.
    if (isTypeOnly(src)) continue;
    const found = countCodeLines(src);
    if (found === 0) continue;
    entries.push([
      path,
      {
        lines: new Map(Array.from({ length: found }, (_, i) => [i + 1, 0])),
        fnFound: 0,
        fnHit: 0,
        fnNames: new Map(),
      },
    ]);
  }
  return entries;
}

const missing = inputs.filter((p) => !existsSync(p));
if (missing.length > 0) {
  console.error(`coverage: named report(s) missing — ${missing.join(', ')}`);
  process.exit(1);
}
if (inputs.length === 0) {
  console.error(
    'coverage: no lcov reports found.\n' +
      `  expected per-file reports in ./${BUN_COVERAGE_DIR}/ (node scripts/bun-test.mjs --coverage).\n` +
      '  Refusing to pass on an absent measurement.',
  );
  process.exit(1);
}

const merged = mergeLcov(inputs.map((p) => readFileSync(p, 'utf8')));

// Reinstate vitest's old denominator role deterministically: enumerate the
// source files and fold in a 0% entry for any the bun suite never loaded. Only
// in the disk-scan mode — an explicit `--lcov=` run controls its own inputs.
if (!explicit.length) {
  for (const [path, cov] of denominatorEntries(merged)) merged.set(path, cov);
}

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
