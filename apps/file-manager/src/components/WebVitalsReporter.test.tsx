import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #94 — client Web Vitals reporter.
 *
 * Gated on NEXT_PUBLIC_RUM_ENABLED (default OFF). When enabled it beacons each
 * Core Web Vital to the same-origin /api/rum route, sending the live `pathname`
 * (never a template — the SERVER derives the bounded route label).
 *
 * We capture the callback passed to useReportWebVitals and invoke it manually.
 */

let reportFn: ((metric: { name: string; value: number; rating: string }) => void) | null = null;

vi.mock('next/web-vitals', () => ({
  useReportWebVitals: (fn: (m: { name: string; value: number; rating: string }) => void) => {
    reportFn = fn;
  },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}));

import WebVitalsReporter from './WebVitalsReporter';

describe('WebVitalsReporter', () => {
  let sendBeacon: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    reportFn = null;
    sendBeacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', {
      value: sendBeacon,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_RUM_ENABLED = undefined;
    process.env.NEXT_PUBLIC_RUM_SAMPLE_RATE = undefined;
    vi.restoreAllMocks();
  });

  it('does not beacon when RUM is disabled (default off)', () => {
    process.env.NEXT_PUBLIC_RUM_ENABLED = undefined;
    render(<WebVitalsReporter />);
    // When disabled, either the hook callback is a no-op or never reports.
    reportFn?.({ name: 'LCP', value: 1200, rating: 'good' });
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it('beacons a Web Vital to /api/rum when enabled', () => {
    process.env.NEXT_PUBLIC_RUM_ENABLED = 'true';
    process.env.NEXT_PUBLIC_RUM_SAMPLE_RATE = '1';
    render(<WebVitalsReporter />);
    expect(reportFn).toBeTypeOf('function');

    reportFn?.({ name: 'LCP', value: 1234, rating: 'good' });

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, payload] = sendBeacon.mock.calls[0];
    expect(url).toBe('/api/rum');
    // payload is a Blob (sendBeacon). Parse it.
    const text =
      typeof payload === 'string' ? payload : ((payload as { __json?: string }).__json ?? '');
    // happy-dom Blob may not expose text() synchronously; assert shape loosely.
    expect(String(url)).toContain('/api/rum');
    void text;
  });

  it('sends the live pathname, not a route template', async () => {
    process.env.NEXT_PUBLIC_RUM_ENABLED = 'true';
    process.env.NEXT_PUBLIC_RUM_SAMPLE_RATE = '1';
    render(<WebVitalsReporter />);
    reportFn?.({ name: 'CLS', value: 0.02, rating: 'good' });
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const payload = sendBeacon.mock.calls[0][1] as Blob;
    const body = await payload.text();
    const parsed = JSON.parse(body);
    expect(parsed.pathname).toBe('/dashboard');
    expect(parsed.metric).toBe('CLS');
    expect(parsed.rating).toBe('good');
  });
});
