'use client';

import { usePathname } from 'next/navigation';
import { useReportWebVitals } from 'next/web-vitals';
import { ALLOWED_METRICS } from '../app/api/rum/validate';

/**
 * WebVitalsReporter (#94) — client beacon for Core Web Vitals.
 *
 * Collects LCP/INP/CLS/FCP/TTFB via Next's useReportWebVitals and POSTs each to
 * the same-origin /api/rum ingest route. Privacy-light + opt-in:
 *   - Gated on NEXT_PUBLIC_RUM_ENABLED (default OFF — nothing is sent unless the
 *     operator/config turns it on).
 *   - Optional client sampling via NEXT_PUBLIC_RUM_SAMPLE_RATE (0..1, default 1).
 *   - Sends the LIVE pathname only — never a session/user id. The SERVER maps
 *     the pathname to a bounded route-template label (see api/rum/validate).
 *
 * Transport: navigator.sendBeacon (survives page unload) with a fetch+keepalive
 * fallback. Mount once in the root layout body.
 */

const RUM_ENDPOINT = '/api/rum';

// Single source of truth for the metric allow-list lives in ./api/rum/validate
// (the server independently re-enforces it). Anything else is ignored client-side.
const REPORTED_METRICS = new Set<string>(ALLOWED_METRICS);

function rumEnabled(): boolean {
  return process.env.NEXT_PUBLIC_RUM_ENABLED === 'true';
}

function sampleRate(): number {
  const raw = process.env.NEXT_PUBLIC_RUM_SAMPLE_RATE;
  if (!raw) return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

export default function WebVitalsReporter() {
  const pathname = usePathname();

  useReportWebVitals((metric) => {
    if (!rumEnabled()) return;
    if (!REPORTED_METRICS.has(metric.name)) return;
    // Client-side sampling — coarse load reduction; the server is still the
    // authority on shape and cardinality.
    if (Math.random() >= sampleRate()) return;

    const body = JSON.stringify({
      metric: metric.name,
      value: metric.value,
      rating: metric.rating,
      // Live pathname only. The server derives the bounded route-template label;
      // it never trusts a client-sent template.
      pathname: pathname ?? '/',
    });

    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        const blob = new Blob([body], { type: 'application/json' });
        navigator.sendBeacon(RUM_ENDPOINT, blob);
        return;
      }
    } catch {
      // fall through to fetch
    }

    // Fallback: fetch with keepalive so the request survives navigation.
    try {
      void fetch(RUM_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: true,
      });
    } catch {
      // RUM is best-effort; never throw into the app.
    }
  });

  return null;
}
