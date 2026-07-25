import { beforeEach, describe, expect, it } from 'vitest';
import { observeWebVital, register } from '../../api/_metrics/registry';
import { CORE_WEB_VITALS, computeVitalsSummary } from './vitals';

/**
 * P1.1 (obs-pages plan) / ADR-0038 — the Web Vitals page reads the app's OWN
 * in-process prom-client registry (the kn_next_web_vitals_* histograms ingested
 * via POST /api/rum). No Prometheus, no external dependency.
 */

beforeEach(() => {
  register.resetMetrics();
});

describe('computeVitalsSummary', () => {
  it('reports one row per Core Web Vital in a stable order', async () => {
    const rows = await computeVitalsSummary();
    expect(rows.map((r) => r.metric)).toEqual(['LCP', 'INP', 'CLS', 'FCP', 'TTFB']);
    expect(CORE_WEB_VITALS).toEqual(['LCP', 'INP', 'CLS', 'FCP', 'TTFB']);
  });

  it('reports zero samples and null p75 when nothing has been ingested', async () => {
    const rows = await computeVitalsSummary();
    for (const row of rows) {
      expect(row.count).toBe(0);
      expect(row.p75).toBeNull();
    }
  });

  it('computes p75 and sample count from ingested LCP samples', async () => {
    // 4 identical samples in bucket (1000, 2000]; rank = 0.75*4 = 3 ⇒
    // interpolate 1000 + (2000-1000)*(3-0)/(4-0) = 1750ms.
    for (let i = 0; i < 4; i++) {
      observeWebVital({ metric: 'LCP', route: '/dashboard', rating: 'good', value: 1200 });
    }
    const lcp = (await computeVitalsSummary()).find((r) => r.metric === 'LCP');
    expect(lcp).toBeDefined();
    expect(lcp?.count).toBe(4);
    expect(lcp?.p75).toBeCloseTo(1750, 5);
    expect(lcp?.unit).toBe('ms');
  });

  it('aggregates across route/rating label sets for a single p75', async () => {
    observeWebVital({ metric: 'CLS', route: '/', rating: 'good', value: 0.03 });
    observeWebVital({ metric: 'CLS', route: '/dashboard', rating: 'poor', value: 0.03 });
    const cls = (await computeVitalsSummary()).find((r) => r.metric === 'CLS');
    expect(cls?.count).toBe(2);
    expect(cls?.unit).toBe('');
    expect(cls?.p75).not.toBeNull();
  });
});
