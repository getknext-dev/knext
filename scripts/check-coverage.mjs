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
 * `enumerateSourceFiles()` (the `git ls-files` spawn) + `generateDenominator`
 * (the pure filter, in `scripts/lib/coverage-denominator.mjs`) restore that
 * enumeration deterministically and with no second runner: they list the
 * `COVERAGE_INCLUDE \ COVERAGE_EXCLUDE` files and, for any not already present in
 * the merged bun report, inject a zero-hit entry over its code lines — SKIPPING
 * type-only files, which a coverage provider instruments as zero lines. That
 * over-counts an untested file's lines slightly versus a provider's
 * executable-line notion, but only ever LOWERS the percentage — the safe
 * direction for a floor — and keeps the invariant that adding an untested file
 * cannot raise coverage.
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
import { attributeContinuations } from './lib/continuation-attribution.mjs';
import { generateDenominator } from './lib/coverage-denominator.mjs';
import {
  activeMetricExceptions,
  assertEveryMetricAccountedFor,
  BUN_COVERAGE_DIR,
  COVERAGE_EXCLUDE,
  COVERAGE_INCLUDE,
  HONEST_PER_PATH_THRESHOLDS,
  HONEST_THRESHOLDS,
  MERGED_LCOV,
  PER_PATH_THRESHOLDS,
  THRESHOLDS,
} from './lib/coverage-policy.mjs';
import { honestCoverage } from './lib/executable-lines.mjs';
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
  : lcovFilesUnder(resolve(REPO_ROOT, process.env.KNEXT_BUN_COVERAGE_DIR ?? BUN_COVERAGE_DIR));

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

/**
 * Enumerate the tracked source files for the denominator. The spawn lives HERE,
 * in the script, rather than in the `scripts/lib` helper — the prover-lane audit
 * forbids a shared lib helper from spawning, and keeping `generateDenominator`
 * pure is also what makes it unit-testable. Fail-closed: an unreachable
 * enumeration is a FAILURE, never a pass — a shrunken denominator reads as higher
 * coverage, the exact dishonesty this gate prevents.
 */
function enumerateSourceFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z', 'packages'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\0')
      .filter(Boolean);
  } catch {
    console.error('coverage: could not enumerate source files for the denominator (git ls-files).');
    process.exit(1);
  }
}

// Reinstate vitest's old denominator role deterministically (see
// `scripts/lib/coverage-denominator.mjs`): enumerate the source files and fold
// in a 0% entry for any the bun suite never loaded. Only in the disk-scan mode —
// an explicit `--lcov=` run controls its own inputs.
if (!explicit.length) {
  for (const [path, cov] of generateDenominator(REPO_ROOT, enumerateSourceFiles(), merged)) {
    merged.set(path, cov);
  }
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

/**
 * The HONEST line number (#1248, ADR-0057), gated alongside the raw one — never
 * instead of it.
 *
 * bun emits `DA` records on blank lines, comments, lone braces and type-only
 * syntax (in practice: inside any function a given test process never ran, and
 * the per-process union keeps them). `honestCoverage` drops only those records,
 * classified by the TypeScript parser with executable as the default, so an
 * uncovered executable line always stays in this denominator. A file whose
 * source cannot be read or parsed is kept WHOLE — it can only lower this number.
 */
function readSource(path) {
  try {
    return readFileSync(resolve(REPO_ROOT, path), 'utf8');
  } catch {
    return null;
  }
}
const classified = honestCoverage(scoped, readSource);
/**
 * Continuation attribution (#1262, ADR-0057 Amendment 1): a line that is PURELY a
 * string-literal / `+` continuation takes its hit from its statement's first line,
 * because a bun process that runs the statement emits no record for it while one
 * that only imports the module emits a 0 the merge keeps. Honest number only; a
 * line carrying anything that could independently fail to run is never touched.
 */
const continuation = attributeContinuations(classified.files, readSource);
const honest = { ...classified, files: continuation.files };
const noiseTotal = Object.values(honest.noise).reduce((a, b) => a + b, 0);
console.log(
  `\n  honest line denominator — ${noiseTotal} non-executable DA record(s) excluded ` +
    `(${
      Object.entries(honest.noise)
        .sort((a, b) => b[1] - a[1])
        .map(([cls, n]) => `${cls} ${n}`)
        .join(', ') || 'none'
    })` +
    (honest.unclassified.length
      ? `; ${honest.unclassified.length} file(s) unreadable/unparseable, kept whole`
      : '') +
    `; ${continuation.attributed} pure string-continuation line(s) attributed from their statement`,
);
check('global (honest lines)', summarize(honest.files), HONEST_THRESHOLDS);
for (const [glob, floors] of Object.entries(HONEST_PER_PATH_THRESHOLDS)) {
  check(`${glob} (honest lines)`, summarize(honest.files, glob), floors);
}

// `--per-file`: the honest uncovered-line count per file, largest first — the
// input for sizing a coverage batch by real reachable gain, not by noise.
if (argv.includes('--per-file')) {
  const rows = [];
  for (const [path, cov] of honest.files) {
    const raw = /** @type {import('./lib/lcov.mjs').FileCoverage} */ (scoped.get(path));
    let rawMiss = 0;
    for (const h of raw.lines.values()) if (h === 0) rawMiss++;
    let miss = 0;
    for (const h of cov.lines.values()) if (h === 0) miss++;
    rows.push({ path, miss, found: cov.lines.size, rawMiss, rawFound: raw.lines.size });
  }
  rows.sort((a, b) => b.miss - a.miss);
  console.log('\n  per-file (honest uncovered / honest lines | raw uncovered / raw lines):');
  for (const r of rows.filter((x) => x.rawMiss > 0)) {
    console.log(
      `    ${String(r.miss).padStart(5)}/${r.found} | ${r.rawMiss}/${r.rawFound}  ${r.path}`,
    );
  }
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
