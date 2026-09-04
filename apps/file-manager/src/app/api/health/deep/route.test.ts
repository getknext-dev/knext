import { beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * #338 — /api/health/deep is the DEEP dependency-reachability endpoint used for
 * observability/alerting only (never wired to a Knative probe). It classifies a
 * scale-to-zero DB that refuses the connection as `waking` (200, transient), and
 * a reachable-but-erroring DB as `down` (503).
 *
 * ## What this file mocks, and why it changed (#871)
 *
 * It used to mock `@getknext/lib/clients` and drive a fake `pool.query`, so the
 * real `checkDeepHealth` computed the verdict. That worked under vitest only
 * because `vitest.config.ts` ALIASES `@getknext/lib/*` to the lib's SOURCE, so
 * the specifier this file mocks and the relative `../clients` that
 * `@getknext/lib/health` imports internally resolved to the same module.
 *
 * bun has no such alias. The lib's internal import is a different module from
 * the package subpath, so the mock did not intercept it: the real `getDbPool`
 * ran, dialled a real Postgres, and every case timed out into the `waking`
 * verdict. One case asserts `waking`, so it PASSED — for entirely the wrong
 * reason — while the other failed. A green test that never exercised its
 * subject is the more expensive half of that.
 *
 * So the seam moved up to the one this route actually depends on:
 * `checkDeepHealth` itself. That is also the honest scope. The route's job is
 * mapping a verdict onto an HTTP status; the classification of a refused
 * connection belongs to `@getknext/lib`, and is tested there
 * (`packages/lib/src/__tests__/health.test.ts`) against the real implementation.
 */

const checkDeepHealth = mock<() => Promise<unknown>>();
mock.module('@getknext/lib/health', () => ({ checkDeepHealth }));

describe('GET /api/health/deep (observability) — #338', () => {
  beforeEach(() => {
    checkDeepHealth.mockReset();
  });

  it('scale-to-zero DB refusing the connection ⇒ 200 waking (transient, not a fault)', async () => {
    checkDeepHealth.mockResolvedValue({
      status: 'waking',
      checks: { postgres: 'waking', redis: 'up' },
    });

    const { GET } = await import('./route');
    const res = await GET();

    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text()).status).toBe('waking');
  });

  it('reachable-but-erroring DB ⇒ 503 down (genuine fault)', async () => {
    checkDeepHealth.mockResolvedValue({
      status: 'down',
      checks: { postgres: 'down', redis: 'up' },
    });

    const { GET } = await import('./route');
    const res = await GET();

    expect(res.status).toBe(503);
    expect(JSON.parse(await res.text()).status).toBe('down');
  });

  it('healthy ⇒ 200 ok — the other half, so 200 is not just the default', async () => {
    // Without this, a route that returned 200 unconditionally would pass the
    // first case and fail only the second, which reads as one broken branch
    // rather than as a status mapping that does not exist.
    checkDeepHealth.mockResolvedValue({
      status: 'ok',
      checks: { postgres: 'up', redis: 'up' },
    });

    const { GET } = await import('./route');
    const res = await GET();

    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text()).status).toBe('ok');
  });
});
