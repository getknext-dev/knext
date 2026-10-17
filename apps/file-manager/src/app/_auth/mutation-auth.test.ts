import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * authorizeMutation: the one check every state-changing Server Action in the
 * file-manager runs before it touches storage, the database or the cache.
 * Same credential and same fail-closed rule as the cache routes.
 */
let incomingAuthorization: string | null = null;
mock.module('next/headers', () => ({
  headers: async () =>
    new Headers(incomingAuthorization ? { authorization: incomingAuthorization } : {}),
}));

const { authorizeMutation } = await import('./mutation-auth');

const TOKEN = 'test-admin-token';
const original = process.env.CACHE_INVALIDATE_TOKEN;

beforeEach(() => {
  process.env.CACHE_INVALIDATE_TOKEN = TOKEN;
  incomingAuthorization = null;
});
afterEach(() => {
  if (original === undefined) delete process.env.CACHE_INVALIDATE_TOKEN;
  else process.env.CACHE_INVALIDATE_TOKEN = original;
});

function form(token?: string): FormData {
  const fd = new FormData();
  if (token !== undefined) fd.append('token', token);
  return fd;
}

describe('authorizeMutation', () => {
  it('refuses a caller that presents nothing', async () => {
    expect(await authorizeMutation(form())).toBe(false);
    expect(await authorizeMutation()).toBe(false);
  });

  it('refuses a wrong Bearer header and a wrong form token', async () => {
    incomingAuthorization = 'Bearer nope';
    expect(await authorizeMutation(form('also-nope'))).toBe(false);
  });

  it('accepts the Bearer header', async () => {
    incomingAuthorization = `Bearer ${TOKEN}`;
    expect(await authorizeMutation(form())).toBe(true);
  });

  it('accepts the token form field (the browser path)', async () => {
    expect(await authorizeMutation(form(TOKEN))).toBe(true);
  });

  it('fails closed when no token is configured, even if the caller sends one', async () => {
    delete process.env.CACHE_INVALIDATE_TOKEN;
    incomingAuthorization = 'Bearer anything';
    expect(await authorizeMutation(form('anything'))).toBe(false);
    process.env.CACHE_INVALIDATE_TOKEN = '';
    expect(await authorizeMutation(form(''))).toBe(false);
  });

  it('does not accept an empty form token as a match for an empty configured token', async () => {
    process.env.CACHE_INVALIDATE_TOKEN = '';
    expect(await authorizeMutation(form(''))).toBe(false);
  });
});
