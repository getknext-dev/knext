import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { observeWebVital, register } from '../../api/_metrics/registry';
import { NO_DATA } from '../_ui/format';

/**
 * P1.1 (obs-pages plan) / ADR-0038 — the /observability/web-vitals page:
 *  - is auth-gated fail-closed (unauth ⇒ denied, no metric data leaks),
 *  - renders the five Core Web Vitals p75 + sample counts from the app's own
 *    registry when authorized,
 *  - is force-dynamic / never cached.
 */

// #525: `unauthorized()` is gated on the flag Next's compiler sets from
// `experimental.authInterrupts`; vitest does not run that compiler, so mirror
// it. `_ui/access-denied.test.tsx` asserts the app really enables the flag.
process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS = '1';

const authHeader = mock<() => string | null>(() => null);

mock.module('next/headers', () => ({
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
  jest.clearAllMocks();
  if (ORIGINAL === undefined) delete process.env.OBSERVABILITY_TOKEN;
  else process.env.OBSERVABILITY_TOKEN = ORIGINAL;
});

async function renderPage(): Promise<string> {
  const mod = await import('./page');
  const el = await mod.default();
  return renderToStaticMarkup(el);
}

/**
 * #525 — a denied request must raise Next's 401 access-fallback, so the HTTP
 * STATUS is 401 instead of a 200 whose body claims 401. The literal's
 * correspondence to Next's own value is pinned in `_ui/access-denied.test.tsx`.
 */
const UNAUTHORIZED_DIGEST = 'NEXT_HTTP_ERROR_FALLBACK;401';

/** The digest of the denial, or a description of the page that failed to deny. */
async function denialDigest(): Promise<string | undefined> {
  return renderPage().then(
    (html) => `rendered a 200 instead of denying: ${html.slice(0, 120)}`,
    (error: { digest?: string }) => error.digest,
  );
}

describe('web-vitals page route config', () => {
  it('is force-dynamic (never cached)', async () => {
    const mod = await import('./page');
    expect(mod.dynamic).toBe('force-dynamic');
  });
});

describe('web-vitals page auth gate (fail-closed)', () => {
  it('denies with a real 401 and leaks no metric data', async () => {
    observeWebVital({ metric: 'LCP', route: '/dashboard', rating: 'good', value: 1200 });
    authHeader.mockReturnValue(null);
    expect(await denialDigest()).toBe(UNAUTHORIZED_DIGEST);
  });

  it('denies with a real 401 when no token is configured, even with a Bearer header', async () => {
    delete process.env.OBSERVABILITY_TOKEN;
    authHeader.mockReturnValue('Bearer anything');
    expect(await denialDigest()).toBe(UNAUTHORIZED_DIGEST);
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

  it('marks vitals with no samples using the shared "no data yet" marker (#516)', async () => {
    // Nothing observed for CLS/FCP/TTFB in this fresh registry.
    authHeader.mockReturnValue('Bearer s3cret');

    const html = await renderPage();

    // The three pages must agree: an absent p75 is NEVER a bare dash (which
    // reads like a measured zero).
    expect(html).toContain(NO_DATA);
    expect(html).not.toMatch(/>\s*[—–-]\s*</);
  });
});
