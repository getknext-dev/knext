import { beforeEach, describe, expect, it } from 'vitest';
import { register } from '../_metrics/registry';
import { __resetRumLimiterForTests } from './rate-limit';
import { POST } from './route';

/**
 * #94 RUM ingest route.
 *
 * Security posture (the central tension): a browser beacon can't carry the
 * Bearer secret, yet it mutates metric state. It is NOT a public write
 * primitive because (1) same-origin/cluster-local, (2) fixed-schema lossy
 * aggregator — can only observe() a closed set of histograms, (3) server
 * enforces bounded label cardinality, (4) rate-limit + size cap + strict shape.
 */

function postReq(body: unknown, opts: { raw?: string } = {}): Request {
  const payload = opts.raw ?? JSON.stringify(body);
  return new Request('http://localhost/api/rum', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  });
}

async function countFor(series: string, route: string, rating: string): Promise<number> {
  const out = await register.metrics();
  const re = new RegExp(
    `${series}_count\\{[^}]*route="${route.replace(/[/[\]]/g, '\\$&')}"[^}]*rating="${rating}"[^}]*\\}\\s+(\\d+)`,
  );
  const m = out.match(re);
  return m ? Number(m[1]) : 0;
}

describe('POST /api/rum', () => {
  beforeEach(() => {
    __resetRumLimiterForTests();
  });

  it('records a valid beacon into the histogram and returns 204', async () => {
    const before = await countFor('kn_next_web_vitals_lcp', '/dashboard', 'good');
    const res = await POST(
      postReq({ metric: 'LCP', value: 1500, rating: 'good', pathname: '/dashboard' }),
    );
    expect(res.status).toBe(204);
    const after = await countFor('kn_next_web_vitals_lcp', '/dashboard', 'good');
    expect(after).toBe(before + 1);
  });

  it('returns 400 for malformed JSON and records nothing', async () => {
    const before = await countFor('kn_next_web_vitals_lcp', '/dashboard', 'good');
    const res = await POST(postReq(null, { raw: '{not json' }));
    expect(res.status).toBe(400);
    const after = await countFor('kn_next_web_vitals_lcp', '/dashboard', 'good');
    expect(after).toBe(before);
  });

  it('returns 400 for a disallowed metric (EVIL) — no new series', async () => {
    const res = await POST(postReq({ metric: 'EVIL', value: 1, rating: 'good', pathname: '/' }));
    expect(res.status).toBe(400);
    const out = await register.metrics();
    expect(out).not.toContain('evil');
  });

  it('maps an unknown pathname to the "other" route bucket, never a raw URL label', async () => {
    const before = await countFor('kn_next_web_vitals_lcp', 'other', 'good');
    const res = await POST(
      postReq({
        metric: 'LCP',
        value: 900,
        rating: 'good',
        pathname: '/x/550e8400-e29b-41d4-a716-446655440000?token=secret',
      }),
    );
    expect(res.status).toBe(204);
    const after = await countFor('kn_next_web_vitals_lcp', 'other', 'good');
    expect(after).toBe(before + 1);
    const out = await register.metrics();
    expect(out).not.toContain('550e8400');
    expect(out).not.toContain('token=secret');
  });

  it('returns 413 when the payload exceeds the size cap', async () => {
    const huge = 'x'.repeat(20_000);
    const res = await POST(
      postReq({ metric: 'LCP', value: 1, rating: 'good', pathname: `/${huge}` }),
    );
    expect(res.status).toBe(413);
  });

  it('rate-limits a flood with 429', async () => {
    let lastStatus = 0;
    for (let i = 0; i < 500; i++) {
      const res = await POST(
        postReq({ metric: 'CLS', value: 0.01, rating: 'good', pathname: '/' }),
      );
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});
