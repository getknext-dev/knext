import { afterEach, describe, expect, it } from 'vitest';
import { isObservabilityAuthorized, observabilityToken } from './auth';

/**
 * P1.1 (obs-pages plan) / ADR-0038 — the /observability route group is
 * auth-gated, fail-closed. This mirrors the timing-safe Bearer contract of
 * apps/file-manager/src/app/api/cache/invalidate/auth.ts.
 */

const ORIGINAL = process.env.OBSERVABILITY_TOKEN;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.OBSERVABILITY_TOKEN;
  } else {
    process.env.OBSERVABILITY_TOKEN = ORIGINAL;
  }
});

describe('observability auth (fail-closed)', () => {
  it('denies when no token is configured (unset ⇒ deny-all)', () => {
    delete process.env.OBSERVABILITY_TOKEN;
    expect(observabilityToken()).toBeUndefined();
    expect(isObservabilityAuthorized('Bearer whatever', observabilityToken())).toBe(false);
  });

  it('denies an empty-string token (fail-closed)', () => {
    process.env.OBSERVABILITY_TOKEN = '';
    expect(observabilityToken()).toBeUndefined();
    expect(isObservabilityAuthorized('Bearer ', observabilityToken())).toBe(false);
  });

  it('denies a missing Authorization header even when a token is set', () => {
    expect(isObservabilityAuthorized(null, 's3cret')).toBe(false);
    expect(isObservabilityAuthorized(undefined, 's3cret')).toBe(false);
  });

  it('denies a non-Bearer scheme', () => {
    expect(isObservabilityAuthorized('Basic s3cret', 's3cret')).toBe(false);
  });

  it('denies a wrong token (and a length mismatch)', () => {
    expect(isObservabilityAuthorized('Bearer wrong', 's3cret')).toBe(false);
    expect(isObservabilityAuthorized('Bearer s3cretbutlonger', 's3cret')).toBe(false);
  });

  it('allows the exact configured Bearer token', () => {
    process.env.OBSERVABILITY_TOKEN = 's3cret';
    expect(isObservabilityAuthorized('Bearer s3cret', observabilityToken())).toBe(true);
  });
});
