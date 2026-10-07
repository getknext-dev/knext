/**
 * The vinext compat lane must build fixtures with `__NEXT_TEST_MODE=e2e`.
 *
 * Next.js's deploy tests assert test-only client request metadata (for example
 * the `next-test-fetch-priority` header). vinext compiles that in only when
 * `__NEXT_TEST_MODE` is set AT BUILD. The deploy shard sets `NEXT_TEST_MODE`
 * (no underscores) only, so without this the fixture build omits the header and
 * app-prefetch/prefetching fails. vinext's own deploy suite fixed the same gap
 * by exporting `__NEXT_TEST_MODE: e2e` (cloudflare/vinext#2875).
 *
 * Knext-internal harness change: it touches no shipped bytes.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const raw = readFileSync(resolve(repoRoot, 'scripts/e2e-deploy-vinext.sh'), 'utf8');
const code = raw
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

describe('vinext lane __NEXT_TEST_MODE', () => {
  it('exports __NEXT_TEST_MODE=e2e before the vite build runs', () => {
    const exportAt = code.indexOf('export __NEXT_TEST_MODE=e2e');
    const buildAt = code.indexOf('npx --no-install vite build');
    expect(exportAt).toBeGreaterThan(-1);
    expect(buildAt).toBeGreaterThan(-1);
    expect(exportAt).toBeLessThan(buildAt);
    expect(code.split('export __NEXT_TEST_MODE=e2e').length).toBe(2);
  });
});
