import { describe, expect, it } from 'bun:test';
import {
  acquireFailureObserverCount,
  isConnectionRefused,
  isScaleToZeroDatabase,
  observeAcquireFailures,
  reportAcquireFailure,
} from '../db/reachability';

describe('isConnectionRefused — only a definitive refusal', () => {
  it('recognises the node pg code and the Bun.SQL code', () => {
    expect(isConnectionRefused(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(
      isConnectionRefused(
        Object.assign(new Error('Failed to connect'), { code: 'ERR_POSTGRES_CONNECTION_REFUSED' }),
      ),
    ).toBe(true);
  });

  it('recognises a multi-address connect failure whose every attempt was refused', () => {
    const refused = (code: string) => Object.assign(new Error('x'), { code });
    const all = new AggregateError([refused('ECONNREFUSED'), refused('ECONNREFUSED')], 'connect');
    expect(isConnectionRefused(Object.assign(all, { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isConnectionRefused(all)).toBe(true);
    const mixed = new AggregateError([refused('ECONNREFUSED'), refused('ETIMEDOUT')], 'connect');
    expect(isConnectionRefused(mixed)).toBe(false);
  });

  it('is a CONNECT-phase verdict: message text alone never counts', () => {
    // The observer sees every failure on the writer pool, application queries
    // included, so prose that merely contains the words is not evidence.
    expect(isConnectionRefused(new Error('connect ECONNREFUSED 10.0.0.1:5432'))).toBe(false);
    expect(isConnectionRefused(new Error('Connection refused'))).toBe(false);
  });

  it('ignores a server-originated error even when it says "connection refused"', () => {
    // dblink / postgres_fdw: the DATABASE answered, and the failure it reports is
    // about a different server it tried to reach (SQLSTATE 08001).
    const serverSide = Object.assign(
      new Error('could not connect to server: Connection refused (ECONNREFUSED)'),
      { code: '08001', severity: 'ERROR' },
    );
    expect(isConnectionRefused(serverSide)).toBe(false);
    // Even an error that carries a refusal code is server-originated if the
    // driver marked it with a severity.
    expect(
      isConnectionRefused(
        Object.assign(new Error('x'), { code: 'ECONNREFUSED', severity: 'FATAL' }),
      ),
    ).toBe(false);
  });

  it('does not treat resets, DNS failures, timeouts or auth errors as a refusal', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH', '28P01']) {
      expect(isConnectionRefused(Object.assign(new Error('boom'), { code }))).toBe(false);
    }
    expect(isConnectionRefused(undefined)).toBe(false);
    expect(isConnectionRefused(null)).toBe(false);
    expect(isConnectionRefused('ECONNREFUSED')).toBe(false);
  });
});

describe('isScaleToZeroDatabase — the gateway, however it is spelled', () => {
  const dsn = (host: string) => `postgres://u:p@${host}:55432/postgres`;

  it('matches any DNS label equal to scale-zero-pg, short or fully qualified', () => {
    for (const host of [
      'pggw-apps.scale-zero-pg.svc.cluster.local.',
      'pggw.scale-zero-pg.svc',
      'pggw-apps.scale-zero-pg',
      'pggw-apps.scale-zero-pg.svc.corp.example',
      'scale-zero-pg',
    ]) {
      expect(isScaleToZeroDatabase(dsn(host), undefined)).toBe(true);
    }
  });

  it('matches the bare in-namespace gateway service names', () => {
    expect(isScaleToZeroDatabase(dsn('pggw'), undefined)).toBe(true);
    expect(isScaleToZeroDatabase(dsn('pggw-apps'), undefined)).toBe(true);
  });

  it('never matches a bring-your-own host, a lookalike, or a path/userinfo mention', () => {
    for (const host of [
      'db.example.com',
      'pggw.example.com',
      'evilscale-zero-pg.svc.example.com',
    ]) {
      expect(isScaleToZeroDatabase(dsn(host), undefined)).toBe(false);
    }
    expect(
      isScaleToZeroDatabase('postgres://u:p@db.example.com:5432/scale-zero-pg', undefined),
    ).toBe(false);
    expect(
      isScaleToZeroDatabase('postgres://scale-zero-pg.svc@db.example.com/app', undefined),
    ).toBe(false);
    expect(isScaleToZeroDatabase('not a url', undefined)).toBe(false);
    expect(isScaleToZeroDatabase(undefined, undefined)).toBe(false);
  });

  it('an explicit declaration wins over the host: true forces scale-to-zero', () => {
    // An IP, a pooler or an ExternalName alias in front of the gateway.
    for (const flag of ['true', 'TRUE', '1', 'yes', ' true ']) {
      expect(isScaleToZeroDatabase(dsn('10.0.0.7'), flag)).toBe(true);
      expect(isScaleToZeroDatabase(dsn('db.example.com'), flag)).toBe(true);
    }
  });

  it('an explicit declaration wins over the host: false forces bring-your-own', () => {
    for (const flag of ['false', 'FALSE', '0', 'no']) {
      expect(isScaleToZeroDatabase(dsn('pggw-apps.scale-zero-pg.svc'), flag)).toBe(false);
    }
  });

  it('an empty or unrecognised declaration falls back to the host', () => {
    for (const flag of [undefined, '', 'maybe']) {
      expect(isScaleToZeroDatabase(dsn('pggw.scale-zero-pg.svc'), flag)).toBe(true);
      expect(isScaleToZeroDatabase(dsn('db.example.com'), flag)).toBe(false);
    }
  });

  it('reads KNEXT_DB_SCALE_TO_ZERO from the environment by default', () => {
    const before = process.env.KNEXT_DB_SCALE_TO_ZERO;
    try {
      process.env.KNEXT_DB_SCALE_TO_ZERO = 'true';
      expect(isScaleToZeroDatabase(dsn('db.example.com'))).toBe(true);
      process.env.KNEXT_DB_SCALE_TO_ZERO = 'false';
      expect(isScaleToZeroDatabase(dsn('pggw.scale-zero-pg.svc'))).toBe(false);
    } finally {
      if (before === undefined) delete process.env.KNEXT_DB_SCALE_TO_ZERO;
      else process.env.KNEXT_DB_SCALE_TO_ZERO = before;
    }
  });
});

describe('acquire-failure observers', () => {
  it('delivers a report to every subscriber and stops after unsubscribe', () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    const stopA = observeAcquireFailures((e) => a.push(e));
    const stopB = observeAcquireFailures((e) => b.push(e));
    const err = new Error('x');
    reportAcquireFailure(err);
    stopA();
    reportAcquireFailure(err);
    stopB();
    expect(a).toEqual([err]);
    expect(b).toEqual([err, err]);
  });

  it('survives a second bundle copy of the module (state is anchored on globalThis)', async () => {
    // A query-string import evaluates the module body afresh — a separate copy
    // with its own module scope, as the standalone build produces.
    const copy = (await import(
      `../db/reachability.ts?copy=${Date.now()}`
    )) as typeof import('../db/reachability');
    const seen: unknown[] = [];
    const stop = observeAcquireFailures((e) => seen.push(e));
    const err = new Error('from the other copy');
    copy.reportAcquireFailure(err);
    stop();
    expect(seen).toEqual([err]);
    expect(copy.acquireFailureObserverCount()).toBe(acquireFailureObserverCount());
  });
});
