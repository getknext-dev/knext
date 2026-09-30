import { describe, expect, it } from 'bun:test';
import { attempt } from '../scripts/upgrade-e2e/traffic-monitor.mjs';

/**
 * Unit tests for the operator upgrade-under-load e2e's traffic driver
 * (#1668/#1671, round 3) — specifically that it sends the Host header
 * Kourier's routing needs when driving traffic through the
 * kourier-internal port-forward (see traffic-monitor.mjs's docblock and
 * run.sh's resolve_app_host). Pure — fetch is injected, no network.
 */
describe('attempt', () => {
  it('sends the Host header when one is provided', async () => {
    let capturedInit: RequestInit | undefined;
    const fakeFetch = async (_url, init) => {
      capturedInit = init;
      return new Response(null, { status: 200 });
    };
    const result = await attempt('http://127.0.0.1:18080', 'app.ns.example.com', fakeFetch);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(capturedInit.headers).toEqual({ Host: 'app.ns.example.com' });
  });

  it('sends no Host header when none is provided', async () => {
    let capturedInit: RequestInit | undefined;
    const fakeFetch = async (_url, init) => {
      capturedInit = init;
      return new Response(null, { status: 200 });
    };
    await attempt('http://127.0.0.1:18080', undefined, fakeFetch);
    expect(capturedInit.headers).toEqual({});
  });

  it('treats a non-2xx/3xx status as not ok, but still a real response', async () => {
    const fakeFetch = async () => new Response(null, { status: 503 });
    const result = await attempt('http://127.0.0.1:18080', 'app.ns.example.com', fakeFetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it('treats a connection error as not ok, with the error message as status', async () => {
    const fakeFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await attempt('http://127.0.0.1:18080', 'app.ns.example.com', fakeFetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('ECONNREFUSED');
  });
});
