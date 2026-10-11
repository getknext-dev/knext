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

  it('recognises the message text when a driver drops the code', () => {
    expect(isConnectionRefused(new Error('connect ECONNREFUSED 10.0.0.1:5432'))).toBe(true);
    expect(isConnectionRefused(new Error('Connection refused'))).toBe(true);
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

describe('isScaleToZeroDatabase — the gateway host, nothing else', () => {
  it('matches the scale-zero-pg gateway host labels', () => {
    expect(
      isScaleToZeroDatabase('postgres://u:p@pggw.scale-zero-pg.svc.cluster.local.:55432/postgres'),
    ).toBe(true);
    expect(isScaleToZeroDatabase('postgres://u:p@pggw.scale-zero-pg.svc:55432/postgres')).toBe(
      true,
    );
  });

  it('never matches a bring-your-own host, a lookalike, or a path/userinfo mention', () => {
    expect(isScaleToZeroDatabase('postgres://u:p@db.example.com:5432/app')).toBe(false);
    expect(isScaleToZeroDatabase('postgres://u:p@db.example.com:5432/scale-zero-pg.svc')).toBe(
      false,
    );
    expect(isScaleToZeroDatabase('postgres://scale-zero-pg.svc@db.example.com/app')).toBe(false);
    expect(isScaleToZeroDatabase('postgres://u:p@evilscale-zero-pg.svc.example.com/app')).toBe(
      false,
    );
    expect(isScaleToZeroDatabase('not a url')).toBe(false);
    expect(isScaleToZeroDatabase(undefined)).toBe(false);
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
