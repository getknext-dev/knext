import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
    const steps = [
      ['first (fails)', 'node', ['-e', 'process.exit(3)']],
      ['second (must still run)', 'node', ['-e', 'console.log("RAN-SECOND")']],
    ];
    const r = spawnSync('node', [resolve(root, 'scripts/prepush.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, PREPUSH_STEPS_JSON: JSON.stringify(steps) },
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('RAN-SECOND');
    expect(r.stderr).toContain('first (fails)');
  });

  it('behaviour: all gates passing exits 0', () => {
    const steps = [['ok', 'node', ['-e', '0']]];
    const r = spawnSync('node', [resolve(root, 'scripts/prepush.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, PREPUSH_STEPS_JSON: JSON.stringify(steps) },
    });
    expect(r.status).toBe(0);
  });
});
