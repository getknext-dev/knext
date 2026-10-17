import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * /setup creates tables and seeds data. It used to do that on a plain GET, so a
 * crawler, a link prefetch or a cross-site <img> could trigger it with no
 * credential. Now a GET only renders a form; the work is a Server Action (a POST)
 * that refuses every caller without the admin token and touches nothing first.
 */
let incomingAuthorization: string | null = null;
mock.module('next/headers', () => ({
  headers: async () =>
    new Headers(incomingAuthorization ? { authorization: incomingAuthorization } : {}),
}));

const redirect = mock((..._a: unknown[]) => {});
mock.module('next/navigation', () => ({ redirect }));

const query = mock(async (sql: string) =>
  String(sql).includes('COUNT') ? { rows: [{ count: '0' }] } : { rows: [] },
);
const getDbPool = mock(() => ({ query }));
mock.module('@getknext/lib/clients', () => ({ getDbPool }));

const { runSetup } = await import('./actions');
const { default: SetupPage } = await import('./page');

const TOKEN = 'setup-test-token';
const original = process.env.CACHE_INVALIDATE_TOKEN;

function form(token?: string): FormData {
  const fd = new FormData();
  if (token !== undefined) fd.append('token', token);
  return fd;
}

beforeEach(() => {
  process.env.CACHE_INVALIDATE_TOKEN = TOKEN;
  incomingAuthorization = null;
  for (const m of [redirect, query, getDbPool]) m.mockClear();
});
afterEach(() => {
  if (original === undefined) delete process.env.CACHE_INVALIDATE_TOKEN;
  else process.env.CACHE_INVALIDATE_TOKEN = original;
});

function expectNothingTouched() {
  expect(getDbPool).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
  expect(redirect).not.toHaveBeenCalled();
}

describe('GET /setup (the page) is read-only', () => {
  it('renders without touching the database, with or without a query string', async () => {
    await SetupPage({ searchParams: Promise.resolve({}) });
    await SetupPage({ searchParams: Promise.resolve({ done: '1' }) });
    await SetupPage({ searchParams: Promise.resolve({ failed: '1' }) });
    expect(getDbPool).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('runSetup (the POST) authentication', () => {
  it('refuses an unauthenticated call and writes nothing', async () => {
    await expect(runSetup(form())).rejects.toThrow('Unauthorized');
    expectNothingTouched();
  });

  it('refuses a wrong token and writes nothing', async () => {
    incomingAuthorization = 'Bearer wrong';
    await expect(runSetup(form('also-wrong'))).rejects.toThrow('Unauthorized');
    expectNothingTouched();
  });

  it('fails closed when the server has no token configured', async () => {
    delete process.env.CACHE_INVALIDATE_TOKEN;
    incomingAuthorization = `Bearer ${TOKEN}`;
    await expect(runSetup(form(TOKEN))).rejects.toThrow('Unauthorized');
    expectNothingTouched();
  });

  it('creates the tables for the right token, then redirects to the read-only result', async () => {
    await runSetup(form(TOKEN));
    const sql = query.mock.calls.map((c) => String(c[0])).join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS files');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS users');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS audit_logs');
    expect(redirect).toHaveBeenCalledWith('/setup?done=1');
  });

  it('accepts the Bearer header too', async () => {
    incomingAuthorization = `Bearer ${TOKEN}`;
    await runSetup(form());
    expect(redirect).toHaveBeenCalledWith('/setup?done=1');
  });
});
