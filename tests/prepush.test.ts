import { describe, expect, it } from 'bun:test';
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
});
