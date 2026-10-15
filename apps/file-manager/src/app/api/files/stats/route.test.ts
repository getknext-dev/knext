import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * GET /api/files/stats: the file-manager's `'use cache'` example. The directive
 * itself only means something inside a Next/vinext build (that is what the
 * platform e2e proves on a cluster, against the shared Redis store); here the
 * function's own contract is pinned: what it tags, what it returns, and that a
 * database failure is NOT turned into a value (a cached zero would be served
 * to every pod until the tag is invalidated).
 */

const cacheTag = mock((..._tags: string[]) => {});
const cacheLife = mock((_profile: string) => {});
mock.module('next/cache', () => ({ cacheTag, cacheLife }));
mock.module('next/server', () => ({ connection: async () => {} }));

let rows: Record<string, unknown>[] = [];
let fail = false;
const query = mock(async (_sql: string) => {
  if (fail) throw new Error('connection refused');
  return { rows };
});
mock.module('@getknext/lib/clients', () => ({ getDbPool: () => ({ query }) }));

const { GET } = await import('./route');
const { FILE_STATS_TAG, getFileStats } = await import('./file-stats');

const HERE = import.meta.dir;
const APP = join(HERE, '../../../../..');

beforeEach(() => {
  cacheTag.mockClear();
  cacheLife.mockClear();
  query.mockClear();
  rows = [{ count: 2, total_bytes: '300' }];
  fail = false;
});

describe('getFileStats', () => {
  it("is a 'use cache' function (the directive is the body's first statement)", () => {
    const src = readFileSync(join(HERE, 'file-stats.ts'), 'utf8');
    expect(src).toMatch(
      /export async function getFileStats\(\)[^{]*\{\s*'use cache';\s*cacheTag\('files', FILE_STATS_TAG\);/,
    );
  });

  it('tags the entry with the upload tag and its own tag', async () => {
    await getFileStats();
    expect(FILE_STATS_TAG).toBe('file-stats');
    expect(cacheTag).toHaveBeenCalledWith('files', 'file-stats');
    expect(cacheLife).toHaveBeenCalledTimes(1);
  });

  it('returns the count, the total bytes and when it was computed', async () => {
    const before = Date.now();
    const s = await getFileStats();
    expect(s.count).toBe(2);
    expect(s.totalBytes).toBe(300);
    expect(Date.parse(s.computedAt)).toBeGreaterThanOrEqual(before - 1);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('throws on a database failure instead of returning a value to cache', async () => {
    fail = true;
    await expect(getFileStats()).rejects.toThrow('connection refused');
  });
});

describe('GET /api/files/stats', () => {
  it('serves the stats as JSON, never stored by a shared HTTP cache', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({ count: 2, totalBytes: 300 });
    expect(typeof body.computedAt).toBe('string');
  });

  it('answers 503 when the database is unreachable', async () => {
    fail = true;
    const res = await GET();
    expect(res.status).toBe(503);
  });
});

describe('next.config.ts', () => {
  const cfg = readFileSync(join(APP, 'next.config.ts'), 'utf8');

  it("turns the 'use cache' directive on without Cache Components", () => {
    expect(cfg).toMatch(/experimental:\s*\{[\s\S]*useCache:\s*true/);
    // Cache Components would forbid the route segment configs the app uses.
    expect(cfg).not.toMatch(/^\s*cacheComponents:\s*true/m);
  });
});
