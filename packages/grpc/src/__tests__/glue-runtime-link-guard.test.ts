/**
 * Guard: a spec that mocks `@getknext/grpc/runtime` AND imports generated glue
 * from a scratch dir must make that specifier resolve with
 * `linkWorkspaceRuntime`. A bare `mock.module` passes only while
 * `packages/grpc/dist` is absent (Bun keys the mock to the dist path once it
 * exists), so the spec's result would depend on which test built dist first.
 * Scans the specs, so a new one cannot forget the link.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = import.meta.dir;
const MOCKS_RUNTIME = /mock\.module\(\s*['"]@getknext\/grpc\/runtime['"]/;
const SCRATCH = /\b(emptyDir|copyFixtureZone|mkdtempSync)\(/;

function violations(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(
      ([, src]) =>
        MOCKS_RUNTIME.test(src) && SCRATCH.test(src) && !/\blinkWorkspaceRuntime\(/.test(src),
    )
    .map(([name]) => name);
}

describe('scratch glue specs link the workspace runtime', () => {
  it('flags a spec that mocks the runtime in a scratch dir without the link', () => {
    const bad = `mock.module('@getknext/grpc/runtime', () => r);\nconst d = emptyDir('x');`;
    expect(violations({ 'bad.test.ts': bad })).toEqual(['bad.test.ts']);
    expect(violations({ 'ok.test.ts': `${bad}\nlinkWorkspaceRuntime(d);` })).toEqual([]);
  });

  it('every spec in this directory obeys it', () => {
    const files: Record<string, string> = {};
    for (const f of readdirSync(DIR).filter((n) => n.endsWith('.test.ts'))) {
      if (f === 'glue-runtime-link-guard.test.ts') continue;
      files[f] = readFileSync(join(DIR, f), 'utf8');
    }
    expect(Object.keys(files).length).toBeGreaterThan(10);
    expect(violations(files)).toEqual([]);
  });
});
