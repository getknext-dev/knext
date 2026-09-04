import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';

/**
 * The slow-dependency discrimination instrument (cold-start ledger row 3).
 *
 * Row 3's residual stall (~1 in 8 cold cycles, ~2.4 s) is compatible with THREE
 * readings — PG pool first-connect delay, cache lazy-connect TCP delay, or a
 * slow-but-inside-budget cache ready-check — and the app emits nothing that
 * tells them apart. This module is the emitter those readings are discriminated
 * with: one structured line per slow dependency operation, naming the dep.
 *
 * Both halves are asserted everywhere, because a threshold guard that only
 * proves "it logs" is half a guard: a slow op MUST emit exactly one line, and a
 * fast one MUST emit none.
 */

type WarnSpy = ReturnType<typeof mock>;

const lines = (warn: WarnSpy): string[] => warn.mock.calls.map((c: unknown[]) => String(c[0]));

const slowLines = (warn: WarnSpy): string[] =>
  lines(warn).filter((l) => l.startsWith('[slow-dep] '));

const parse = (line: string): Record<string, unknown> =>
  JSON.parse(line.slice('[slow-dep] '.length));

describe('@getknext/lib slow-dep emitter', () => {
  let warn: WarnSpy;

  beforeEach(() => {
    warn = mock();
    spyOn(console, 'warn').mockImplementation(warn as unknown as typeof console.warn);
    delete process.env.SLOW_DEP_LOG_MS;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.SLOW_DEP_LOG_MS;
  });

  it('emits exactly ONE structured line when the duration exceeds the threshold', async () => {
    const { logSlowDep } = await import('../slow-dep');

    const emitted = logSlowDep('pg', 'pool.query', 2412);

    expect(emitted).toBe(true);
    const found = slowLines(warn);
    expect(found).toHaveLength(1);
    expect(parse(found[0])).toMatchObject({
      dep: 'pg',
      op: 'pool.query',
      durationMs: 2412,
      thresholdMs: 500,
    });
  });

  it('emits NOTHING when the duration is at or below the threshold (the other half)', async () => {
    const { logSlowDep } = await import('../slow-dep');

    expect(logSlowDep('pg', 'pool.query', 12)).toBe(false);
    // Exactly at the threshold is not "exceeds".
    expect(logSlowDep('pg', 'pool.query', 500)).toBe(false);

    expect(slowLines(warn)).toHaveLength(0);
  });

  it('honours SLOW_DEP_LOG_MS, read at call time (both halves around the new threshold)', async () => {
    const { logSlowDep } = await import('../slow-dep');
    process.env.SLOW_DEP_LOG_MS = '50';

    expect(logSlowDep('redis-connect', 'client.connect', 40)).toBe(false);
    expect(logSlowDep('redis-connect', 'client.connect', 60)).toBe(true);

    const found = slowLines(warn);
    expect(found).toHaveLength(1);
    expect(parse(found[0])).toMatchObject({ thresholdMs: 50, durationMs: 60 });
  });

  it('falls back to the 500 ms default when SLOW_DEP_LOG_MS is junk or non-positive', async () => {
    const { slowDepThresholdMs } = await import('../slow-dep');

    process.env.SLOW_DEP_LOG_MS = 'not-a-number';
    expect(slowDepThresholdMs()).toBe(500);
    process.env.SLOW_DEP_LOG_MS = '0';
    expect(slowDepThresholdMs()).toBe(500);
    process.env.SLOW_DEP_LOG_MS = '-1';
    expect(slowDepThresholdMs()).toBe(500);
  });

  it('names all three ledger readings as distinct dep classes', async () => {
    const { logSlowDep } = await import('../slow-dep');

    logSlowDep('pg', 'pool.connect', 9000);
    logSlowDep('redis-connect', 'client.connect', 9000);
    logSlowDep('redis-ready', 'ready-check', 9000);

    expect(slowLines(warn).map((l) => parse(l).dep)).toEqual([
      'pg',
      'redis-connect',
      'redis-ready',
    ]);
  });

  it('NEVER logs credentials or a DSN — the dep class, not the target URL', async () => {
    const { logSlowDep } = await import('../slow-dep');

    logSlowDep('pg', 'pool.query', 9000, {
      // Anything URL-shaped is dropped, whatever a future caller passes.
      dsn: 'postgres://app:s3cr3t@pggw-apps.scale-zero-pg.svc.cluster.local.:5432/fm',
      target: 'redis://:hunter2@redis.default.svc.cluster.local.:6379',
      role: 'writer',
    });

    const found = slowLines(warn);
    expect(found).toHaveLength(1);
    expect(found[0]).not.toContain('s3cr3t');
    expect(found[0]).not.toContain('hunter2');
    expect(found[0]).not.toContain('://');
    // The safe context survives — the line is still useful.
    expect(parse(found[0])).toMatchObject({ role: 'writer' });
  });

  it('is a single line — a log pipeline must never see a multi-line record', async () => {
    const { logSlowDep } = await import('../slow-dep');

    logSlowDep('pg', 'pool.query', 9000, { note: 'a\nb' });

    const found = slowLines(warn);
    expect(found).toHaveLength(1);
    expect(found[0].includes('\n')).toBe(false);
  });

  it('never lets an emit failure escape into the dependency path (fail-open)', async () => {
    const { logSlowDep } = await import('../slow-dep');
    warn.mockImplementation(() => {
      throw new Error('log pipeline is on fire');
    });

    expect(() => logSlowDep('pg', 'pool.query', 9000)).not.toThrow();
  });
});
