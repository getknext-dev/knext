import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

/**
 * #525 — the observability denial path: ONE shared component, and a response
 * status that matches the text it renders.
 *
 * Two guarantees are asserted here:
 *  1. **No re-inlined copies.** The check SCANS every `page.tsx` under
 *     `app/observability/` rather than enumerating the known pages, so a NEW
 *     auth-gated page that hand-rolls its own denial markup fails this test
 *     instead of quietly becoming copy number five.
 *  2. **The status is real.** `denyObservabilityAccess()` raises Next's
 *     `unauthorized()` access-fallback, which makes the HTTP response a 401 —
 *     it no longer renders "401" inside a 200.
 */

/**
 * `unauthorized()` is gated on the flag Next's compiler sets from
 * `experimental.authInterrupts`; vitest does not run that compiler, so mirror it
 * here. That the app really enables the flag is asserted below, so this stub
 * cannot drift from the shipped config.
 */
process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS = '1';

const OBSERVABILITY_DIR = resolve(import.meta.dirname, '..');
const SHARED_MODULE = resolve(import.meta.dirname, 'access-denied.tsx');

/** Every `page.tsx` under app/observability/, found by walking — never listed. */
function observabilityPages(dir = OBSERVABILITY_DIR): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) found.push(...observabilityPages(path));
    else if (entry.name === 'page.tsx') found.push(path);
  }
  return found;
}

/** Pages behind the observability auth gate — the ones this contract binds. */
function authGatedPages(): { path: string; source: string }[] {
  return observabilityPages()
    .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
    .filter(({ source }) => source.includes('isObservabilityAuthorized'));
}

describe('shared observability AccessDenied (#525)', () => {
  it('finds the auth-gated pages at all (a zero-page scan must not pass)', () => {
    // Green-by-skip guard (#408): an empty walk would make every scan below
    // vacuously true, so the scan asserts it actually found pages.
    expect(authGatedPages().length).toBeGreaterThanOrEqual(4);
  });

  it('leaves ZERO inline denial copies — every gated page uses the shared one', () => {
    const offenders: string[] = [];
    for (const { path, source } of authGatedPages()) {
      const inlineComponent = /function\s+AccessDenied\b/.test(source);
      const inlineMarkup = /Unauthorized|require a valid bearer token/i.test(source);
      if (inlineComponent || inlineMarkup) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it('routes every gated page through denyObservabilityAccess()', () => {
    const missing = authGatedPages()
      .filter(({ source }) => !source.includes('denyObservabilityAccess'))
      .map(({ path }) => path);
    expect(missing).toEqual([]);
  });

  it('keeps the denial markup in ONE file (the shared component)', () => {
    const shared = readFileSync(SHARED_MODULE, 'utf8');
    expect(shared).toMatch(/401/);
    expect(shared).toMatch(/Unauthorized/);
  });

  it('renders no token value and no internal detail', async () => {
    process.env.OBSERVABILITY_TOKEN = 's3cret-observability-token';
    const { AccessDenied } = await import('./access-denied');
    const html = renderToStaticMarkup(AccessDenied());
    expect(html).not.toContain('s3cret-observability-token');
    expect(html).not.toMatch(/OBSERVABILITY_TOKEN|prometheus|kubernetes|stack/i);
    expect(html).toContain('401');
  });
});

describe('the denied response carries a real 401 (#525)', () => {
  it('raises the SAME access-fallback Next itself uses for 401', async () => {
    const { denyObservabilityAccess } = await import('./access-denied');
    const { unauthorized } = await import('next/navigation');

    // Derive the expected digest from Next rather than hardcoding it, so a
    // change in Next's fallback encoding fails here instead of silently
    // asserting a stale constant.
    let nextDigest: string | undefined;
    try {
      unauthorized();
    } catch (error) {
      nextDigest = (error as { digest?: string }).digest;
    }
    expect(nextDigest).toBeDefined();
    expect(nextDigest).toMatch(/;401$/);
    // The per-page tests assert this literal; pinning the correspondence to
    // Next's own value HERE is what keeps them from asserting a stale constant.
    expect(nextDigest).toBe('NEXT_HTTP_ERROR_FALLBACK;401');

    let ourDigest: string | undefined;
    expect(() => denyObservabilityAccess()).toThrow();
    try {
      denyObservabilityAccess();
    } catch (error) {
      ourDigest = (error as { digest?: string }).digest;
    }
    expect(ourDigest).toBe(nextDigest);
  });

  it('is backed by an unauthorized.tsx that renders the shared component', () => {
    const source = readFileSync(resolve(OBSERVABILITY_DIR, 'unauthorized.tsx'), 'utf8');
    expect(source).toContain('AccessDenied');
    expect(source).toMatch(/_ui\/access-denied|\.\/_ui\/access-denied/);
  });

  it('enables experimental.authInterrupts, without which a denial 500s', () => {
    // `unauthorized()` throws E411 unless the app opts in. If this flag is ever
    // dropped, the denial path becomes a 500 — so it is a gate, not a comment.
    const config = readFileSync(resolve(OBSERVABILITY_DIR, '../../../next.config.ts'), 'utf8');
    expect(config).toMatch(/authInterrupts:\s*true/);
  });
});
