/**
 * `vi.mock(spec, async (importOriginal) => …)` -> bun (#871).
 *
 * bun's `mock.module` factory takes no arguments, so `importOriginal` is
 * undefined and eight files died with "importOriginal is not a function".
 *
 * The transform is not the obvious one, and that is the point of testing it:
 * every simpler version fails, and each fails differently.
 *
 *   - `await import(spec)` inside the factory DEADLOCKS — the mock is already
 *     registered, so the import re-enters it. The file hangs with no output.
 *   - Holding the namespace and spreading it inside the factory copies the
 *     MOCK, because bun mutates the namespace in place.
 *
 * So the module must be imported AND spread before `mock.module` runs.
 */
import { describe, expect, it } from 'vitest';
import { liftImportOriginal } from '../scripts/codemod-vitest-to-bun.mjs';

describe('liftImportOriginal (#871)', () => {
  it('captures and SPREADS the real module before the mock is registered', () => {
    const out = liftImportOriginal(
      `mock.module('../a', async (importOriginal) => ({ ...(await importOriginal<object>()), b: 1 }));`,
    );
    // Spread at capture time — a bare `await import(...)` reference would still
    // resolve to the mock once bun mutates the namespace.
    expect(out).toContain("const __knextReal1 = { ...(await import('../a')) };");
    expect(out).toContain('...__knextReal1');
    // The capture must precede the registration, or it captures the mock.
    expect(out.indexOf('__knextReal1 =')).toBeLessThan(out.indexOf('mock.module('));
    expect(out).not.toContain('importOriginal');
  });

  it('handles the un-generic form too', () => {
    const out = liftImportOriginal(
      `mock.module('../a', async (importOriginal) => ({ ...(await importOriginal()) }));`,
    );
    expect(out).toContain('...__knextReal1');
    expect(out).not.toContain('importOriginal');
  });

  it('gives each call site its own binding', () => {
    const out = liftImportOriginal(
      `mock.module('../a', async (importOriginal) => ({ ...(await importOriginal()) }));\n` +
        `mock.module('../b', async (importOriginal) => ({ ...(await importOriginal()) }));`,
    );
    expect(out).toContain('__knextReal1');
    expect(out).toContain('__knextReal2');
    expect(out).toContain("import('../a')");
    expect(out).toContain("import('../b')");
  });

  it('leaves mock.module calls that do not use importOriginal alone', () => {
    const src = `mock.module('../a', () => ({ b: 1 }));`;
    expect(liftImportOriginal(src)).toBe(src);
  });

  it('finds the matching paren through nested calls in the factory body', () => {
    // A regex stopping at the first `)` would cut the factory in half and emit
    // source that does not parse.
    const out = liftImportOriginal(
      `mock.module('../a', async (importOriginal) => ({ ...(await importOriginal()), f: mock(() => fn(1)) }));`,
    );
    expect(out).toContain('f: mock(() => fn(1))');
    expect(out.endsWith('}));')).toBe(true);
  });

  it('is not fooled by a string or comment mentioning importOriginal', () => {
    const src = `// importOriginal is gone\nmock.module('../a', () => ({ b: '(importOriginal)' }));`;
    expect(liftImportOriginal(src)).toBe(src);
  });
});
