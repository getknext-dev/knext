import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeWebVital, register } from '../../api/_metrics/registry';

/**
 * P1.1 (obs-pages plan) / ADR-0038 — the /observability/web-vitals page:
 *  - is auth-gated fail-closed (unauth ⇒ denied, no metric data leaks),
 *  - renders the five Core Web Vitals p75 + sample counts from the app's own
 *    registry when authorized,
 *  - is force-dynamic / never cached.
 */

const authHeader = vi.fn<() => string | null>(() => null);

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) => (name === 'authorization' ? authHeader() : null),
  }),
}));

const ORIGINAL = process.env.OBSERVABILITY_TOKEN;

beforeEach(() => {
  register.resetMetrics();
  authHeader.mockReturnValue(null);
  process.env.OBSERVABILITY_TOKEN = 's3cret';
});

afterEach(() => {
  vi.clearAllMocks();
  if (ORIGINAL === undefined) delete process.env.OBSERVABILITY_TOKEN;
  else process.env.OBSERVABILITY_TOKEN = ORIGINAL;
});

async function renderPage(): Promise<string> {
  const mod = await import('./page');
  const el = await mod.default();
  return renderToStaticMarkup(el);
}

describe('web-vitals page route config', () => {
  it('is force-dynamic (never cached)', async () => {
    const mod = await import('./page');
    expect(mod.dynamic).toBe('force-dynamic');
  });
});

describe('web-vitals page auth gate (fail-closed)', () => {
  it('denies an unauthenticated request and leaks no metric data', async () => {
    observeWebVital({ metric: 'LCP', route: '/dashboard', rating: 'good', value: 1200 });
    authHeader.mockReturnValue(null);
    const html = await renderPage();
    expect(html.toLowerCase()).not.toContain('p75');
    expect(html).not.toContain('kn_next_web_vitals');
    expect(html).toMatch(/unauthorized|forbidden|denied/i);
  });

  it('denies when no token is configured, even with a Bearer header', async () => {
    delete process.env.OBSERVABILITY_TOKEN;
    authHeader.mockReturnValue('Bearer anything');
    const html = await renderPage();
    expect(html).toMatch(/unauthorized|forbidden|denied/i);
  });
});

describe('web-vitals page authorized render', () => {
  it('renders the five vitals names, p75 values and sample counts', async () => {
    for (let i = 0; i < 4; i++) {
      observeWebVital({ metric: 'LCP', route: '/dashboard', rating: 'good', value: 1200 });
    }
    observeWebVital({ metric: 'INP', route: '/', rating: 'good', value: 150 });
    authHeader.mockReturnValue('Bearer s3cret');

    const html = await renderPage();
    for (const name of ['LCP', 'INP', 'CLS', 'FCP', 'TTFB']) {
      expect(html).toContain(name);
    }
    // p75 for the seeded LCP samples (see vitals.test) ≈ 1750ms.
    expect(html).toContain('1750');
    // Sample count for LCP is 4.
    expect(html).toMatch(/>4</);
  });
});
