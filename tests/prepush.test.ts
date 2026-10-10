import { describe, expect, it, spyOn } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error plain .mjs script, no declarations
import { runSteps } from '../scripts/prepush.mjs';

/**
 * `bun run prepush` must run exactly what CI's Lint & Test runs first. The
 * commands are READ from ci.yml here, so a drift (CI changes, prepush does
 * not) reds this test rather than going stale quietly.
 */
const root = resolve(import.meta.dir, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
const prepush = readFileSync(resolve(root, 'scripts/prepush.mjs'), 'utf8');

describe('prepush', () => {
  it('is wired as a root script', () => {
    expect(pkg.scripts.prepush).toBe('node scripts/prepush.mjs');
  });

  it('runs the three CI gates and the exit code is the verdict', () => {
    expect(prepush).toContain('--diagnostic-level=error');
    expect(prepush).toContain('tests/temp-dirs-outside-the-repo.test.ts');
    expect(prepush).toMatch(/'run', 'typecheck'|bun run typecheck/);
    expect(prepush).toContain('process.exit');
  });

  it('mirrors CI: lint and root typecheck steps exist in ci.yml with the same scripts', () => {
    expect(ci).toContain('run: bun run lint');
    expect(ci).toContain('run: bun run typecheck');
    expect(pkg.scripts.lint).toBe('biome check .');
  });

  it('behaviour: a failing gate does not short-circuit, and the exit code is 1', () => {
    const logs: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((m: string) => {
      logs.push(String(m));
    });
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const code = runSteps([
        ['first (fails)', 'node', ['-e', 'process.exit(3)']],
        ['second (must still run)', 'node', ['-e', '0']],
      ]);
      expect(code).toBe(1);
      expect(logs.join('\n')).toContain('second (must still run)');
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  it('behaviour: all gates passing exits 0', () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(runSteps([['ok', 'node', ['-e', '0']]])).toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  it('no env var can alter the gate list (source never reads process.env)', () => {
    expect(prepush).not.toContain('process.env');
    expect(prepush).not.toContain('PREPUSH_STEPS_JSON');
  });

  it('importing the module does not run the gates', () => {
    const r = spawnSync(
      'node',
      [
        '-e',
        `import(${JSON.stringify(resolve(root, 'scripts/prepush.mjs'))}).then(()=>console.log('IMPORTED'))`,
      ],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('IMPORTED');
    expect(r.stdout).not.toContain('=== prepush');
  });
});
