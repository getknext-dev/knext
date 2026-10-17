import { describe, expect, it } from 'bun:test';
import { isAuthorized } from './auth';

const TOKEN = 's3cr3t-invalidate-token';

describe('cache-invalidate auth (B1 — no unauthenticated mutating endpoint)', () => {
  it('FAILS CLOSED: nothing is authorized when no token is configured', () => {
    expect(isAuthorized(`Bearer ${TOKEN}`, undefined)).toBe(false);
    expect(isAuthorized(`Bearer ${TOKEN}`, '')).toBe(false);
  });

  it('authorizes a correct Bearer token', () => {
    expect(isAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('rejects a wrong token', () => {
    expect(isAuthorized('Bearer wrong-token', TOKEN)).toBe(false);
  });

  it('rejects a missing / malformed Authorization header', () => {
    expect(isAuthorized(null, TOKEN)).toBe(false);
    expect(isAuthorized('', TOKEN)).toBe(false);
    expect(isAuthorized(TOKEN, TOKEN)).toBe(false); // no "Bearer " prefix
    expect(isAuthorized('Basic xyz', TOKEN)).toBe(false);
  });

  it('rejects a wrong token of the SAME length (the compare is by content, not length)', () => {
    const sameLength = 'x'.repeat(TOKEN.length);
    expect(sameLength).toHaveLength(TOKEN.length);
    expect(isAuthorized(`Bearer ${sameLength}`, TOKEN)).toBe(false);
    // One character off at the end is the case a prefix or length check lets through.
    expect(isAuthorized(`Bearer ${TOKEN.slice(0, -1)}X`, TOKEN)).toBe(false);
  });

  it('rejects a token of different length (no timing-leak shortcut to true)', () => {
    expect(isAuthorized('Bearer short', TOKEN)).toBe(false);
    expect(isAuthorized(`Bearer ${TOKEN}extra`, TOKEN)).toBe(false);
  });
});
