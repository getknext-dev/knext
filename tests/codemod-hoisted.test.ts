/**
 * `vi.hoisted(fn)` must become `(fn)()`, not `(fn)` (#871).
 *
 * The codemod's header documented the right transform and its implementation
 * did half of it: `src.replace(/vi\.hoisted\(/g, '(')` stripped the wrapper and
 * never appended the call. So
 *
 *   const netFault = vi.hoisted(() => ({ failAfter: -1, opened: [] }));
 *
 * became a FUNCTION, and every later `netFault.opened` read `undefined` on a
 * function object. It did not fail at the conversion, or at import — it failed
 * much later as a TypeError inside a socket event handler, which reads like a
 * bug in the code under test rather than in the tool that rewrote the test.
 *
 * Twelve files use `vi.hoisted`, so this was going to happen twelve times.
 */
import { describe, expect, it } from 'vitest';
import { callHoisted } from '../scripts/codemod-vitest-to-bun.mjs';

describe('callHoisted (#871)', () => {
  it('CALLS the hoisted factory rather than leaving it a function', () => {
    // The whole defect in one assertion: the result must evaluate to the value,
    // not to something you could still call.
    const out = callHoisted('const a = vi.hoisted(() => ({ n: 1 }));');
    expect(out).toBe('const a = (() => ({ n: 1 }))();');
    expect(eval(`(${out.slice('const a = '.length, -1)})`)).toEqual({ n: 1 });
  });

  it('finds the matching paren through nested parens in the argument', () => {
    // A regex ending at the first `)` would cut `(x + 1)` in half and emit
    // syntactically broken source — which at least fails loudly, unlike the
    // original bug.
    const out = callHoisted('const a = vi.hoisted(() => ({ f: (x) => (x + 1) }));');
    expect(out).toBe('const a = (() => ({ f: (x) => (x + 1) }))();');
  });

  it('ignores parens inside strings and comments', () => {
    // Blanking non-code before counting depth is why this works. A naive
    // counter sees the `)` in the string literal and closes early.
    const out = callHoisted('const a = vi.hoisted(() => new Map([["k", "v)"]]));');
    expect(out).toBe('const a = (() => new Map([["k", "v)"]]))();');
  });

  it('rewrites every occurrence, not just the first', () => {
    const out = callHoisted('const a = vi.hoisted(() => 1);\nconst b = vi.hoisted(() => 2);');
    expect(out).not.toContain('vi.hoisted');
    expect(out.match(/\)\(\)/g)).toHaveLength(2);
  });

  it('leaves source without vi.hoisted untouched', () => {
    const src = 'const a = 1; // mentions vi.hoisted in prose only\n';
    expect(callHoisted(src)).toBe(src);
  });

  it('refuses unbalanced source rather than emitting something broken', () => {
    // A half-transform that still parses is the worst outcome: it converts
    // cleanly and fails somewhere unrelated at runtime, which is exactly the
    // shape of the bug this file exists for.
    expect(() => callHoisted('const a = vi.hoisted(() => 1;')).toThrow(/unbalanced/);
  });
});
