import { describe, expect, it } from 'vitest';
import { createTokenBucketLimiter } from './rate-limit';

/**
 * #94 RUM ingest — security layer 4: a small in-process token bucket so the
 * ingest route is never an unbounded sink. The map of buckets is itself bounded
 * so a flood of distinct keys can't grow memory without limit.
 */

describe('createTokenBucketLimiter', () => {
  it('allows up to capacity then denies', () => {
    const now = 0;
    const limiter = createTokenBucketLimiter({
      capacity: 3,
      refillPerSecond: 0,
      maxKeys: 100,
      now: () => now,
    });
    expect(limiter.allow('k')).toBe(true);
    expect(limiter.allow('k')).toBe(true);
    expect(limiter.allow('k')).toBe(true);
    expect(limiter.allow('k')).toBe(false);
  });

  it('refills over time', () => {
    let now = 0;
    const limiter = createTokenBucketLimiter({
      capacity: 2,
      refillPerSecond: 1,
      maxKeys: 100,
      now: () => now,
    });
    expect(limiter.allow('k')).toBe(true);
    expect(limiter.allow('k')).toBe(true);
    expect(limiter.allow('k')).toBe(false);
    // Advance 1s → 1 token refilled.
    now += 1000;
    expect(limiter.allow('k')).toBe(true);
    expect(limiter.allow('k')).toBe(false);
  });

  it('keeps the bucket map bounded under a flood of distinct keys', () => {
    let now = 0;
    const limiter = createTokenBucketLimiter({
      capacity: 1,
      refillPerSecond: 0,
      maxKeys: 10,
      now: () => now,
    });
    for (let i = 0; i < 1000; i++) {
      limiter.allow(`key-${i}`);
      now += 1;
    }
    expect(limiter.size()).toBeLessThanOrEqual(10);
  });

  it('tracks separate buckets per key', () => {
    const now = 0;
    const limiter = createTokenBucketLimiter({
      capacity: 1,
      refillPerSecond: 0,
      maxKeys: 100,
      now: () => now,
    });
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
    // Different key has its own fresh bucket.
    expect(limiter.allow('b')).toBe(true);
  });
});
