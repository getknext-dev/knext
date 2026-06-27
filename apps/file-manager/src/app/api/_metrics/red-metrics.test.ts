import { describe, expect, it } from 'vitest';
import { httpRequestDuration, httpRequestsTotal, observeHttpRequest, register } from './registry';

/**
 * Server-side RED metrics (observability P0).
 *
 * Without a server-side request rate / error / duration triplet the
 * availability + latency SLIs in docs/observability/slos.md cannot be
 * computed from the scrape. These tests assert the series are registered and
 * that a single observation emits the labeled samples.
 */

describe('server-side RED metrics', () => {
  it('registers the request counter and duration histogram', async () => {
    const out = await register.metrics();
    expect(out).toContain('kn_next_http_requests_total');
    expect(out).toContain('kn_next_http_request_duration_seconds');
  });

  it('exposes the metric instances for the request path to wire into', () => {
    expect(httpRequestsTotal).toBeDefined();
    expect(httpRequestDuration).toBeDefined();
  });

  it('observeHttpRequest emits a labeled request count + duration sample', async () => {
    observeHttpRequest({
      method: 'GET',
      route: '/dashboard',
      status: 200,
      durationSeconds: 0.123,
    });
    const out = await register.metrics();
    // status_class is bucketed (2xx) — never the raw status code (cardinality).
    expect(out).toMatch(/kn_next_http_requests_total\{[^}]*status_class="2xx"[^}]*\}/);
    expect(out).toMatch(/method="GET"/);
    expect(out).toMatch(/route="\/dashboard"/);
    // The duration histogram recorded a sample (count series present).
    expect(out).toContain('kn_next_http_request_duration_seconds_count');
  });

  it('maps a 5xx response to the error status_class', async () => {
    observeHttpRequest({
      method: 'POST',
      route: '/api/upload',
      status: 503,
      durationSeconds: 2.5,
    });
    const out = await register.metrics();
    expect(out).toMatch(/kn_next_http_requests_total\{[^}]*status_class="5xx"[^}]*\}/);
  });

  it('keeps cardinality bounded: status label is a class, not a raw code', async () => {
    observeHttpRequest({
      method: 'GET',
      route: '/',
      status: 404,
      durationSeconds: 0.01,
    });
    const out = await register.metrics();
    // No raw 3-digit status code should appear as a label value.
    expect(out).not.toMatch(/status="404"/);
    expect(out).toMatch(/status_class="4xx"/);
  });
});
