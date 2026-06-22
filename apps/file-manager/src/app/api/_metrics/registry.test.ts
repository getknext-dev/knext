import { describe, expect, it } from 'vitest';
import { observeWebVital, register } from './registry';

/**
 * #94 — shared prom-client registry extracted from the metrics route.
 * Web Vitals histograms register here so they merge automatically into
 * register.metrics() exposed on /api/metrics.
 */

describe('shared metrics registry', () => {
  it('exposes the existing bytecode-cache series', async () => {
    const out = await register.metrics();
    expect(out).toContain('kn_next_startup_duration_seconds');
    expect(out).toContain('kn_next_bytecode_cache_files_total');
  });

  it('observeWebVital records into a bounded histogram', async () => {
    observeWebVital({
      metric: 'LCP',
      route: '/dashboard',
      rating: 'good',
      value: 1200,
    });
    const out = await register.metrics();
    // A per-metric histogram exists and recorded the labeled sample.
    expect(out).toContain('kn_next_web_vitals_lcp');
    expect(out).toMatch(/kn_next_web_vitals_lcp[^\n]*route="\/dashboard"/);
    expect(out).toMatch(/rating="good"/);
  });

  it('routes each metric name to its own histogram', async () => {
    observeWebVital({ metric: 'CLS', route: '/', rating: 'good', value: 0.05 });
    observeWebVital({ metric: 'INP', route: '/', rating: 'poor', value: 600 });
    const out = await register.metrics();
    expect(out).toContain('kn_next_web_vitals_cls');
    expect(out).toContain('kn_next_web_vitals_inp');
  });
});
