/**
 * `testFiles` (R1, vinext-bun-failure-triage-2026-10-03) — the resolution
 * actually reaches run-tests.js, and a non-matching pattern can never fall
 * through to the full-suite glob.
 *
 * WHY THIS FILE EXISTS. A YAML-text guard (`compat-vinext-lane.test.ts`) can
 * assert the `testFiles` branch EXISTS and leaves the default `-g <shard>`
 * line untouched, but it cannot tell whether the branch actually narrows
 * execution. It did not: dispatch run 37133371831 passed bare substrings
 * ("turbopack-reports", "twoslash", "fallback-shells") straight through as
 * `run-tests.js` positional arguments, and `run-tests.js` (v16.2.0:279) only
 * treats a positional as an explicit test file when it matches
 * `/\.test\.(js|ts|tsx)/` — anything else is silently dropped, and the script
 * falls through to globbing `**\/*.test.{js,ts,tsx}` and selecting from
 * `NEXT_EXTERNAL_TESTS_FILTERS` instead. Every one of the 16 shards logged
 * "total: 789" (the whole corpus) and ran for over an hour, burning the
 * runner pool a rc.5 credential night needed.
 *
 * This file executes the ACTUAL step script (extracted from the workflow,
 * with `${{ matrix.shard }}` substituted to a literal — the only GHA
 * expression it contains) against a synthetic `test/` tree and a FAKE
 * `run-tests.js` that records its argv instead of running anything, so a
 * regression back to "pass the raw pattern through" or "let a zero-match
 * pattern fall through" reds here rather than being caught only on a live,
 * hour-long dispatch.
 */

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LANE = '.github/workflows/compat-vinext.yml';

const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Job {
  steps?: Step[];
}
interface Workflow {
  jobs?: Record<string, Job>;
}

function parse(): Workflow {
  // biome-ignore lint/suspicious/noExplicitAny: the workflow schema is not modelled here
  return (Bun as any).YAML.parse(read(LANE)) as Workflow;
}

const steps = (wf: Workflow): Step[] =>
  Object.values(wf.jobs ?? {}).flatMap((job) => job.steps ?? []);

/** The shard job's harness-invoking step, same selector as compat-vinext-lane.test.ts. */
function harnessStep(): Step {
  const found = steps(parse()).filter((s) => s.env?.NEXT_TEST_MODE === 'deploy');
  if (found.length !== 1) {
    throw new Error(`expected exactly one NEXT_TEST_MODE=deploy step, found ${found.length}`);
  }
  return found[0] as Step;
}

/** The step's `run:` text with its one GHA expression (`${{ matrix.shard }}`) made real bash. */
function harnessScript(shard = '1/16'): string {
  const run = harnessStep().run;
  if (!run) throw new Error('the harness step has no run: block');
  if (!/\$\{\{\s*matrix\.shard\s*\}\}/.test(run)) {
    throw new Error('expected ${{ matrix.shard }} in the harness step — selector or step drifted');
  }
  return run.replace(/\$\{\{\s*matrix\.shard\s*\}\}/g, shard);
}

/** A fake run-tests.js: records its argv to argv.json instead of running anything. */
const FAKE_RUN_TESTS_JS = `
const fs = require('fs');
fs.writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));
console.log('total:', process.argv.length - 2);
process.exit(0);
`;

/** A sandbox shaped like the harness step's cwd (next.js repo root): test/ + run-tests.js. */
function makeSandbox(testFiles: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinext-testfiles-filter-'));
  for (const rel of testFiles) {
    const abs = join(dir, 'test', rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, '// fixture\n');
  }
  writeFileSync(join(dir, 'run-tests.js'), FAKE_RUN_TESTS_JS);
  return dir;
}

function runHarness(
  dir: string,
  testFilesEnv: string,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bash', ['-c', harnessScript()], {
    cwd: dir,
    env: { ...process.env, TEST_FILES: testFilesEnv },
    encoding: 'utf8',
    timeout: 30000,
  });
  return { status: r.status, stdout: `${r.stdout}`, stderr: `${r.stderr}` };
}

const FIXTURES = [
  'e2e/app-dir/turbopack-reports/turbopack-reports.test.ts',
  'e2e/twoslash/index.test.ts',
  'e2e/app-dir/fallback-shells/fallback-shells.test.ts',
];

describe('testFiles resolution (R1) — run AS SHELL against a synthetic test/ tree', () => {
  it('resolves a bare substring to the REAL matching test file(s), never passes the raw substring through', () => {
    const dir = makeSandbox(FIXTURES);
    try {
      const r = runHarness(dir, 'turbopack-reports');
      expect(r.status, `harness step failed: ${r.stderr}`).toBe(0);
      const argv = JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8')) as string[];
      // The exact rc.1 regression: a raw substring reaching run-tests.js as a
      // positional (it would never match /\.test\.(js|ts|tsx)/, so run-tests.js
      // drops it and globs the whole corpus instead).
      expect(argv).not.toContain('turbopack-reports');
      expect(argv.some((a) => a.includes('turbopack-reports') && /\.test\.ts$/.test(a))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves MULTIPLE comma-separated patterns to their own real files, all in one run-tests.js invocation', () => {
    const dir = makeSandbox(FIXTURES);
    try {
      const r = runHarness(dir, 'turbopack-reports, twoslash');
      expect(r.status, `harness step failed: ${r.stderr}`).toBe(0);
      const argv = JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8')) as string[];
      expect(argv.some((a) => a.includes('turbopack-reports'))).toBe(true);
      expect(argv.some((a) => a.includes('twoslash'))).toBe(true);
      expect(argv).not.toContain('turbopack-reports');
      expect(argv).not.toContain('twoslash');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ABORTS before ever invoking run-tests.js when a pattern matches no file — no silent full-suite fallback', () => {
    const dir = makeSandbox(FIXTURES);
    try {
      const r = runHarness(dir, 'this-pattern-matches-nothing-xyz');
      expect(r.status, 'a zero-match pattern must abort the job (non-zero exit)').not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain('matched no file');
      // The proof that matters: the fake run-tests.js was never reached, so it
      // never wrote argv.json. If it HAD fallen through to the full-suite glob
      // (the actual rc.2 regression), run-tests.js would still have been
      // invoked — just with the wrong (empty/ignored) selection.
      expect(() => readFileSync(join(dir, 'argv.json'), 'utf8')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a zero-match pattern aborts even when EARLIER patterns in the same list matched — no partial silent fallback', () => {
    const dir = makeSandbox(FIXTURES);
    try {
      const r = runHarness(dir, 'turbopack-reports, this-pattern-matches-nothing-xyz');
      expect(r.status).not.toBe(0);
      expect(() => readFileSync(join(dir, 'argv.json'), 'utf8')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the unchanged default path (TEST_FILES empty) still invokes run-tests.js with -g <shard>, never a resolved file list', () => {
    const dir = makeSandbox(FIXTURES);
    try {
      const r = runHarness(dir, '');
      expect(r.status, `harness step failed: ${r.stderr}`).toBe(0);
      const argv = JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8')) as string[];
      expect(argv).toContain('-g');
      expect(argv).toContain('1/16');
      expect(argv.some((a) => a.endsWith('.test.ts'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
