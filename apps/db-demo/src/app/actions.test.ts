import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * postMessage is a public POST endpoint (every export of a 'use server' module
 * is). It must refuse every caller without the write token, fail closed when the
 * token is not configured, and write nothing when it refuses.
 */
let incomingAuthorization: string | null = null;
mock.module('next/headers', () => ({
  headers: async () =>
    new Headers(incomingAuthorization ? { authorization: incomingAuthorization } : {}),
}));

const revalidatePath = mock((..._a: unknown[]) => {});
mock.module('next/cache', () => ({ revalidatePath }));

const addMessage = mock(async (..._a: unknown[]) => {});
mock.module('@/db/queries', () => ({ addMessage }));

const { postMessage } = await import('./actions');

const TOKEN = 'db-demo-test-token';
const original = process.env.DB_DEMO_WRITE_TOKEN;

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

beforeEach(() => {
  process.env.DB_DEMO_WRITE_TOKEN = TOKEN;
  incomingAuthorization = null;
  addMessage.mockClear();
  revalidatePath.mockClear();
});
afterEach(() => {
  if (original === undefined) delete process.env.DB_DEMO_WRITE_TOKEN;
  else process.env.DB_DEMO_WRITE_TOKEN = original;
});

describe('postMessage authentication', () => {
  it('refuses an unauthenticated post and writes nothing', async () => {
    await expect(postMessage(form({ author: 'a', body: 'hello' }))).rejects.toThrow('Unauthorized');
    expect(addMessage).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('refuses a wrong token (header and form) and writes nothing', async () => {
    incomingAuthorization = 'Bearer wrong';
    await expect(
      postMessage(form({ author: 'a', body: 'hello', token: 'also-wrong' })),
    ).rejects.toThrow('Unauthorized');
    expect(addMessage).not.toHaveBeenCalled();
  });

  it('fails closed when the server has no token configured', async () => {
    delete process.env.DB_DEMO_WRITE_TOKEN;
    incomingAuthorization = `Bearer ${TOKEN}`;
    await expect(postMessage(form({ body: 'hello', token: TOKEN }))).rejects.toThrow(
      'Unauthorized',
    );
    expect(addMessage).not.toHaveBeenCalled();
  });

  it('writes for the form token', async () => {
    await postMessage(form({ author: ' Ada ', body: ' hi ', token: TOKEN }));
    expect(addMessage).toHaveBeenCalledWith({ author: 'Ada', body: 'hi' });
    expect(revalidatePath).toHaveBeenCalledWith('/');
  });

  it('writes for the Bearer header', async () => {
    incomingAuthorization = `Bearer ${TOKEN}`;
    await postMessage(form({ body: 'hi' }));
    expect(addMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps the old behaviour for an authorized empty body (nothing persisted)', async () => {
    await postMessage(form({ body: '  ', token: TOKEN }));
    expect(addMessage).not.toHaveBeenCalled();
  });
});
