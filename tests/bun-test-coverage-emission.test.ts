/**
 * `scripts/bun-test.mjs --coverage` must EMIT something the gate can merge (#884).
 *
 * The runner spawns one process per test file, so `--coverage` produces one
 * report per file. Before this, those reports were printed as text and thrown
 * away, and the runner's own docstring claimed the opposite of what the code did
 * ("applied once, to the whole set").
 *
 * Two facts here were measured, not assumed, and both are load-bearing:
 *   - bun writes `lcov.info` into ONE directory per process, so parallel spawns
 *     sharing a directory overwrite each other;
 *   - `coverageDir` in `bunfig.toml` SILENTLY overrides `--coverage-dir`, so the
 *     per-spawn directory only works while that key is absent.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BUN_COVERAGE_DIR } from '../scripts/lib/coverage-policy.mjs';

const REPO_ROOT = resolve(import.meta.dir, '..');

test('the per-file coverage pile is git-ignored', () => {
  const ignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
  expect(ignore.split('\n').map((l) => l.trim())).toContain(`${BUN_COVERAGE_DIR}/`);
});

describe('bunfig.toml', () => {
  test('sets no coverageDir — it silently overrides --coverage-dir', () => {
    // Measured on bun 1.4.0: with `coverageDir = "coverage"` present, a spawn
    // passing `--coverage-dir=cov-probe` writes to `coverage/` anyway and
    // reports no error. Every spawn then races on one `lcov.info`.
    const bunfig = readFileSync(join(REPO_ROOT, 'bunfig.toml'), 'utf8');
    const active = bunfig
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    expect(active).not.toMatch(/coverageDir\s*=/);
  });

  test('sets no coverageThreshold — the floor is the merged gate’s, not per-file', () => {
    // A global threshold applied to a single file is meaningless, and it is what
    // blocked per-file isolation in the first place. `scripts/check-coverage.mjs`
    // owns the floors now.
    const bunfig = readFileSync(join(REPO_ROOT, 'bunfig.toml'), 'utf8');
    const active = bunfig
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    expect(active).not.toMatch(/coverageThreshold\s*=/);
  });
});

describe('scripts/bun-test.mjs', () => {
  test('its docstring describes the per-file coverage it actually produces', () => {
    const src = readFileSync(join(REPO_ROOT, 'scripts', 'bun-test.mjs'), 'utf8');
    // The wrong claim, verbatim, must be gone.
    expect(src).not.toMatch(/applied once, to the whole set/);
    expect(src).toMatch(/lcov/i);
  });

  test('--coverage writes one lcov per test file, in its own directory', () => {
    // Redirected: this file is itself in the suite, so a nested run writing to
    // the real pile would wipe an outer `--coverage` run's reports mid-flight.
    const dir = mkdtempSync(join(tmpdir(), 'knext-buncov-'));
    const res = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts', 'bun-test.mjs'),
        '--coverage',
        'tests/lcov-merge.test.ts',
        'tests/blank-non-code.test.ts',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, KNEXT_BUN_COVERAGE_DIR: dir } },
    );

    expect(res.status).toBe(0);

    expect(existsSync(dir)).toBe(true);
    const reports = readdirSync(dir).filter((f) => f.endsWith('.info'));
    // Two files in, two reports out — no clobber.
    expect(reports.length).toBeGreaterThanOrEqual(2);
    for (const r of reports) {
      expect(readFileSync(join(dir, r), 'utf8')).toMatch(/^SF:/m);
    }
  });
});
