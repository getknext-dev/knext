import { describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { runtimeAnchor } from '../runtime-anchor';

/**
 * #2758 — `runtimeAnchor()` replaces `createRequire(import.meta.url)` so a webpack
 * build cannot bake the build machine's path into the server chunk. It must give a
 * REAL, resolvable location when the engine reports one, never leak engine-global
 * state it touched to get it, and degrade to the working directory (never throw)
 * when the engine reports nothing.
 */
describe('runtimeAnchor', () => {
  it('names the real file this code runs from, which resolves the lib’s own dependencies', () => {
    const anchor = runtimeAnchor();
    expect(anchor).toMatch(/runtime-anchor(\.test)?\.ts$|^file:\/\//);
    // The whole point: a require made from it finds a dependency the lib declares.
    expect(typeof createRequire(anchor).resolve('ioredis')).toBe('string');
  });

  it('restores Error.prepareStackTrace and Error.stackTraceLimit', () => {
    const prepare = (_e: Error, sites: unknown[]) => sites;
    const savedPrepare = Error.prepareStackTrace;
    const savedLimit = Error.stackTraceLimit;
    try {
      Error.prepareStackTrace = prepare as typeof Error.prepareStackTrace;
      Error.stackTraceLimit = 7;
      runtimeAnchor();
      expect(Error.prepareStackTrace).toBe(prepare as typeof Error.prepareStackTrace);
      expect(Error.stackTraceLimit).toBe(7);
    } finally {
      Error.prepareStackTrace = savedPrepare;
      Error.stackTraceLimit = savedLimit;
    }
  });

  it('does not depend on the caller’s stackTraceLimit (a limit of 0 must not force the fallback)', () => {
    const savedPrepare = Error.prepareStackTrace;
    const savedLimit = Error.stackTraceLimit;
    try {
      Error.stackTraceLimit = 0;
      const anchor = runtimeAnchor();
      expect(anchor).not.toBe(`${process.cwd()}/`);
    } finally {
      Error.prepareStackTrace = savedPrepare;
      Error.stackTraceLimit = savedLimit;
    }
  });
});
