import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Deliberately a cross-package RELATIVE import: `@getknext/lib`'s copy is
// internal (no public subpath, so no public-API change), and this test exists
// precisely to hold the two copies to one behaviour.
import * as lib from '../../../../packages/lib/src/redis/quiet';
import * as app from './redis-quiet';

/**
 * Two copies, one behaviour — the drift guard for the quiet-client pair.
 *
 * The emitter pair got a parity guard and this pair did not, and the asymmetry
 * was backwards: the duplicated `sanitize()` IS the DSN-stripping security
 * control, and this very PR found it to be **decoration in both copies at once**
 * — they were broken together and fixed together only because someone edited
 * both by hand. A one-copy fix is exactly the drift mode, and "secrets never in
 * logs" is non-negotiable (`.claude/rules/security.md`), so the copy that
 * carries a security invariant is the one that most needs the guard.
 *
 * Parity is asserted on BEHAVIOUR, not on file bytes: the two files differ in
 * comments on purpose, and a byte comparison would red on a comment edit while
 * staying blind to a semantic change made in identical prose.
 */

/** Drive one copy's listener with `errors` and capture what it logged. */
function emitThrough(
  attach: (client: never, tag: string) => void,
  tag: string,
  errors: unknown[],
): string[] {
  const listeners: ((...a: unknown[]) => void)[] = [];
  const client = {
    on(event: string, fn: (...a: unknown[]) => void) {
      if (event === 'error') listeners.push(fn);
      return this;
    },
    connect: () => Promise.resolve(),
  };
  const logged: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args.map((a) => String(a)).join(' '));
  });
  try {
    attach(client as never, tag);
    for (const err of errors) for (const fn of listeners) fn(err);
  } finally {
    spy.mockRestore();
  }
  return logged;
}

/** The inputs that matter: a plain error, a DSN-bearing one, an odd one. */
const ERROR_CASES: { name: string; errors: unknown[] }[] = [
  {
    name: 'a coded connect timeout',
    errors: [Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })],
  },
  {
    name: 'a DSN inside the message (the security control)',
    errors: [
      Object.assign(
        new Error('connect ETIMEDOUT redis://:hunter2@redis.default.svc.cluster.local.:6379'),
        { code: 'ETIMEDOUT' },
      ),
    ],
  },
  {
    name: 'userinfo without a scheme',
    errors: [new Error('auth failed for app:s3cr3t@10.0.0.5:6379')],
  },
  {
    name: 'the same class four times (suppression)',
    errors: Array.from({ length: 4 }, () =>
      Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    ),
  },
  {
    name: 'two different classes',
    errors: [
      Object.assign(new Error('a'), { code: 'ETIMEDOUT' }),
      Object.assign(new Error('b'), { code: 'ECONNREFUSED' }),
    ],
  },
  { name: 'an error with neither code nor name-ish class', errors: [{}] },
  { name: 'a very long message', errors: [new Error('x'.repeat(500))] },
];

describe('redis-quiet parity — the app copy and the lib copy must not drift', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(ERROR_CASES)('logs byte-identical lines for $name', ({ errors }) => {
    const appLines = emitThrough(app.attachQuietErrorListener, 'parity', errors);
    const libLines = emitThrough(lib.attachQuietErrorListener, 'parity', errors);

    expect(appLines).toEqual(libLines);
    // Not vacuous in the silent-by-design cases: at least one line, and no
    // secret survives in either copy.
    expect(appLines.length).toBeGreaterThan(0);
    for (const line of [...appLines, ...libLines]) {
      expect(line).not.toContain('hunter2');
      expect(line).not.toContain('s3cr3t');
      expect(line).not.toContain('://');
    }
  });

  it('produces the same option shape', () => {
    const appOpts = app.quietRedisOptions();
    const libOpts = lib.quietRedisOptions();

    expect(Object.keys(appOpts).sort()).toEqual(Object.keys(libOpts).sort());
    for (const key of Object.keys(appOpts)) {
      if (typeof appOpts[key] === 'function') continue;
      expect(appOpts[key]).toEqual(libOpts[key]);
    }
    // The three properties #802 is about, asserted by value in both copies.
    expect(appOpts.lazyConnect).toBe(true);
    expect(libOpts.lazyConnect).toBe(true);
  });

  it('agrees on the retry strategy at every attempt count, including give-up', () => {
    const appRetry = app.quietRedisOptions().retryStrategy as (t: number) => number | null;
    const libRetry = lib.quietRedisOptions().retryStrategy as (t: number) => number | null;

    const appCurve = Array.from({ length: 12 }, (_, i) => appRetry(i + 1));
    const libCurve = Array.from({ length: 12 }, (_, i) => libRetry(i + 1));

    expect(appCurve).toEqual(libCurve);
    // Both must actually give up somewhere in that range — a curve of all
    // numbers would be "identical" and still unbounded.
    expect(appCurve).toContain(null);
  });

  it('agrees on which client states are re-dialled, both halves', () => {
    const probe = (ensure: (c: never) => void, status: string): number => {
      let calls = 0;
      ensure({
        status,
        on: () => undefined,
        connect: () => {
          calls += 1;
          return Promise.resolve();
        },
      } as never);
      return calls;
    };

    for (const status of ['end', 'close', 'ready', 'connecting', 'wait']) {
      expect(probe(app.ensureDialable, status)).toBe(probe(lib.ensureDialable, status));
    }
    // And the split is the one #802 needs, not "never" or "always".
    expect(probe(app.ensureDialable, 'end')).toBe(1);
    expect(probe(app.ensureDialable, 'ready')).toBe(0);
    expect(probe(lib.ensureDialable, 'end')).toBe(1);
    expect(probe(lib.ensureDialable, 'ready')).toBe(0);
  });
});
