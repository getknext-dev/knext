import { describe, expect, it } from 'bun:test';
import { GET } from './app/api/health/route';

// The knext operator's Knative readiness probe GETs /api/health. Without a
// 200 there, no revision of the docs site ever goes Ready.
describe('docs /api/health', () => {
  it('answers 200, uncached, without touching any dependency', async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
