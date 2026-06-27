import { describe, expect, it } from 'vitest';
import { register } from './registry';

/**
 * RED metrics route coverage (observability completion — GAP 1).
 *
 * #142 wired `withRedMetrics` ONLY onto /api/health, so the latency/error SLIs
 * and the KnextHighErrorRate alert were effectively blind to real traffic. This
 * test asserts the meaningful API route handlers are wrapped, so invoking them
 * populates the server-side RED series (kn_next_http_requests_total /
 * kn_next_http_request_duration_seconds) with the bounded {app, route} labels.
 *
 * It exercises the REAL exported handlers (not observeHttpRequest directly), so
 * it fails until the route modules actually wrap their handlers.
 */

// Each entry: import the route module, call its handler, and the bounded route
// label we expect to see in the scrape afterwards. Handlers that read no body
// and don't touch a backend on the failure/early path are chosen so the test
// stays hermetic.
async function scrape(): Promise<string> {
  return register.metrics();
}

function hasRouteSample(out: string, route: string): boolean {
  const escaped = route.replace(/[/]/g, '\\/');
  const re = new RegExp(
    `kn_next_http_requests_total\\{[^}]*app="[^"]+"[^}]*route="${escaped}"[^}]*\\}`,
  );
  return re.test(out);
}

describe('RED metrics route coverage (GAP 1)', () => {
  it('records a RED sample for GET /api/cache-stats', async () => {
    const mod = await import('../cache-stats/route');
    const res = await mod.GET();
    expect(res).toBeInstanceOf(Response);
    const out = await scrape();
    expect(hasRouteSample(out, '/api/cache-stats')).toBe(true);
  });

  it('records a RED sample for GET /api/metrics', async () => {
    const mod = await import('../metrics/route');
    const res = await mod.GET();
    expect(res).toBeInstanceOf(Response);
    const out = await scrape();
    expect(hasRouteSample(out, '/api/metrics')).toBe(true);
  });

  it('records a RED sample for POST /api/cache/invalidate (unauthorized path is still counted)', async () => {
    const mod = await import('../cache/invalidate/route');
    // No Bearer token configured / supplied → handler returns 401. The wrapper
    // must still record the request without altering that behavior.
    const req = new Request('http://localhost/api/cache/invalidate', { method: 'POST' });
    const res = await mod.POST(req);
    expect(res.status).toBe(401);
    const out = await scrape();
    expect(hasRouteSample(out, '/api/cache/invalidate')).toBe(true);
  });

  it('records a RED sample for POST /api/rum and preserves its 400-on-malformed behavior', async () => {
    const mod = await import('../rum/route');
    const req = new Request('http://localhost/api/rum', {
      method: 'POST',
      body: 'not-json',
    });
    const res = await mod.POST(req);
    // Behavior preserved: malformed body → 400 (the wrapper must not change it).
    expect(res.status).toBe(400);
    const out = await scrape();
    expect(hasRouteSample(out, '/api/rum')).toBe(true);
  });

  it('uses a BOUNDED route pattern label, never a raw URL/query string', async () => {
    const out = await scrape();
    // The label must be the matched path template, so no query/host fragments.
    expect(out).not.toMatch(/route="http:/);
    expect(out).not.toMatch(/route="[^"]*\?[^"]*"/);
  });
});
