import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * uploadFile is a public POST endpoint (every export of a 'use server' module
 * is). These tests prove the two things the audit found wrong:
 *   1. an unauthenticated call is refused and NOTHING is written (no bucket,
 *      no object, no row, no cache churn);
 *   2. an upload never overwrites another file: the object key and the row name
 *      carry a generated id, and the client filename is validated.
 */
let incomingAuthorization: string | null = null;
mock.module('next/headers', () => ({
  headers: async () =>
    new Headers(incomingAuthorization ? { authorization: incomingAuthorization } : {}),
}));

const revalidateTag = mock((..._a: unknown[]) => {});
const revalidatePath = mock((..._a: unknown[]) => {});
mock.module('next/cache', () => ({ revalidateTag, revalidatePath }));

const bucketExists = mock(async (..._a: unknown[]) => true);
const makeBucket = mock(async (..._a: unknown[]) => {});
const putObject = mock(async (..._a: unknown[]) => {});
const query = mock(async (..._a: unknown[]) => ({ rows: [] }));
const getMinioClient = mock(() => ({ bucketExists, makeBucket, putObject }));
const getDbPool = mock(() => ({ query }));
mock.module('@getknext/lib/clients', () => ({ getDbPool, getMinioClient }));

const { uploadFile } = await import('./actions');

const TOKEN = 'upload-test-token';
const original = process.env.CACHE_INVALIDATE_TOKEN;
const writes = [bucketExists, makeBucket, putObject, query, revalidateTag, revalidatePath];

function upload(name: string, body = 'hello', token?: string): FormData {
  const fd = new FormData();
  fd.append('file', new File([body], name, { type: 'text/plain' }));
  if (token !== undefined) fd.append('token', token);
  return fd;
}

beforeEach(() => {
  process.env.CACHE_INVALIDATE_TOKEN = TOKEN;
  incomingAuthorization = null;
  for (const m of [...writes, getDbPool, getMinioClient]) m.mockClear();
});
afterEach(() => {
  if (original === undefined) delete process.env.CACHE_INVALIDATE_TOKEN;
  else process.env.CACHE_INVALIDATE_TOKEN = original;
});

function expectNothingTouched() {
  expect(getDbPool).not.toHaveBeenCalled();
  expect(getMinioClient).not.toHaveBeenCalled();
  for (const m of writes) expect(m).not.toHaveBeenCalled();
}

describe('uploadFile authentication', () => {
  it('refuses an unauthenticated upload and writes nothing', async () => {
    const result = await uploadFile(upload('victim.txt'));
    expect(result).toEqual({ error: 'Unauthorized' });
    expectNothingTouched();
  });

  it('refuses a wrong token (header and form) and writes nothing', async () => {
    incomingAuthorization = 'Bearer wrong';
    expect(await uploadFile(upload('victim.txt', 'x', 'wrong-too'))).toEqual({
      error: 'Unauthorized',
    });
    expectNothingTouched();
  });

  it('fails closed when the server has no token configured', async () => {
    delete process.env.CACHE_INVALIDATE_TOKEN;
    incomingAuthorization = `Bearer ${TOKEN}`;
    expect(await uploadFile(upload('victim.txt', 'x', TOKEN))).toEqual({ error: 'Unauthorized' });
    expectNothingTouched();
  });

  it('checks auth before even looking at the payload (no file -> still Unauthorized)', async () => {
    expect(await uploadFile(new FormData())).toEqual({ error: 'Unauthorized' });
    expectNothingTouched();
  });

  it('accepts the Bearer header', async () => {
    incomingAuthorization = `Bearer ${TOKEN}`;
    expect(await uploadFile(upload('ok.txt'))).toEqual({ success: true });
    expect(putObject).toHaveBeenCalledTimes(1);
  });

  it('accepts the token form field', async () => {
    expect(await uploadFile(upload('ok.txt', 'x', TOKEN))).toEqual({ success: true });
    expect(putObject).toHaveBeenCalledTimes(1);
  });
});

describe('uploadFile does not overwrite', () => {
  beforeEach(() => {
    incomingAuthorization = `Bearer ${TOKEN}`;
  });

  it('two uploads with the same filename get different object keys and row names', async () => {
    await uploadFile(upload('report.pdf', 'first'));
    await uploadFile(upload('report.pdf', 'second'));

    expect(putObject).toHaveBeenCalledTimes(2);
    const k1 = putObject.mock.calls[0][1] as string;
    const k2 = putObject.mock.calls[1][1] as string;
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe('report.pdf');
    expect(k1.endsWith('-report.pdf')).toBe(true);

    const inserts = query.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO files'));
    expect(inserts).toHaveLength(2);
    const n1 = (inserts[0][1] as unknown[])[0];
    const n2 = (inserts[1][1] as unknown[])[0];
    expect(n1).toBe(k1);
    expect(n2).toBe(k2);
    expect(n1).not.toBe(n2);
  });

  it('never upserts: no row is ever updated by name', async () => {
    await uploadFile(upload('report.pdf'));
    const sql = query.mock.calls.map((c) => String(c[0])).join('\n');
    expect(sql).not.toMatch(/ON CONFLICT/i);
    expect(sql).not.toMatch(/DO UPDATE/i);
  });

  it('records the object path under the assets bucket with the generated key', async () => {
    await uploadFile(upload('a.txt'));
    const key = putObject.mock.calls[0][1] as string;
    const insert = query.mock.calls.find((c) => String(c[0]).includes('INSERT INTO files'));
    expect((insert?.[1] as unknown[])[3]).toBe(`assets/${key}`);
  });

  it.each([
    '../../etc/passwd',
    'a/../../b.txt',
    '..\\..\\x',
    '..',
    '/abs',
  ])('refuses the path-traversal filename %j and writes nothing', async (name) => {
    const result = await uploadFile(upload(name));
    expect(result).toEqual({ error: 'Invalid file name' });
    expectNothingTouched();
  });
});
