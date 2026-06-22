import { describe, expect, it } from 'vitest';
import { ALLOWED_METRICS, ALLOWED_RATINGS, parseBeacon, routeTemplateFor } from './validate';

/**
 * #94 RUM ingest — pure validation/normalization.
 *
 * Security layer 3 (bounded label cardinality): the server NEVER trusts the
 * client for a label. metric/rating come from CLOSED allow-lists; route is a
 * TEMPLATE the server maps the reported pathname to (closed known-route table;
 * unmatched → single `other` bucket — IDs/UUIDs/query never become labels).
 */

describe('parseBeacon', () => {
  it('parses a valid beacon', () => {
    const out = parseBeacon({
      metric: 'LCP',
      value: 1234.5,
      rating: 'good',
      pathname: '/dashboard',
    });
    expect(out).toEqual({
      metric: 'LCP',
      value: 1234.5,
      rating: 'good',
      pathname: '/dashboard',
    });
  });

  it('returns null when a required field is missing', () => {
    expect(parseBeacon({ metric: 'LCP', value: 1, rating: 'good' })).toBeNull();
    expect(parseBeacon({ value: 1, rating: 'good', pathname: '/' })).toBeNull();
    expect(parseBeacon({ metric: 'LCP', rating: 'good', pathname: '/' })).toBeNull();
  });

  it('returns null for a non-finite or negative value', () => {
    expect(
      parseBeacon({ metric: 'LCP', value: Number.NaN, rating: 'good', pathname: '/' }),
    ).toBeNull();
    expect(parseBeacon({ metric: 'LCP', value: -5, rating: 'good', pathname: '/' })).toBeNull();
    expect(
      parseBeacon({
        metric: 'LCP',
        value: Number.POSITIVE_INFINITY,
        rating: 'good',
        pathname: '/',
      }),
    ).toBeNull();
  });

  it('rejects a disallowed metric (EVIL) and accepts LCP', () => {
    expect(parseBeacon({ metric: 'EVIL', value: 1, rating: 'good', pathname: '/' })).toBeNull();
    expect(parseBeacon({ metric: 'LCP', value: 1, rating: 'good', pathname: '/' })).not.toBeNull();
  });

  it('rejects a disallowed rating', () => {
    expect(parseBeacon({ metric: 'LCP', value: 1, rating: 'amazing', pathname: '/' })).toBeNull();
  });

  it('ignores/rejects extra unexpected fields rather than passing them through', () => {
    const out = parseBeacon({
      metric: 'LCP',
      value: 1,
      rating: 'good',
      pathname: '/',
      userId: 'attacker',
      sessionId: 'leak',
    });
    // Either rejected, or normalized so the extra keys are dropped — never carried.
    if (out) {
      expect(out).not.toHaveProperty('userId');
      expect(out).not.toHaveProperty('sessionId');
    }
  });

  it('returns null for non-object input', () => {
    expect(parseBeacon(null)).toBeNull();
    expect(parseBeacon('string')).toBeNull();
    expect(parseBeacon(42)).toBeNull();
  });

  it('exposes all five Core Web Vitals in the metric allow-list', () => {
    expect([...ALLOWED_METRICS].sort()).toEqual(['CLS', 'FCP', 'INP', 'LCP', 'TTFB']);
  });

  it('exposes the three standard ratings', () => {
    expect([...ALLOWED_RATINGS].sort()).toEqual(['good', 'needs-improvement', 'poor']);
  });
});

describe('routeTemplateFor', () => {
  it('maps a known dynamic path to its template', () => {
    expect(routeTemplateFor('/cache-tests/123')).toBe('/cache-tests/[slug]');
    expect(routeTemplateFor('/cache-tests/on-demand')).toBe('/cache-tests/[slug]');
  });

  it('maps known static routes to themselves', () => {
    expect(routeTemplateFor('/')).toBe('/');
    expect(routeTemplateFor('/dashboard')).toBe('/dashboard');
    expect(routeTemplateFor('/users')).toBe('/users');
    expect(routeTemplateFor('/cache-tests')).toBe('/cache-tests');
  });

  it('maps an unknown / UUID path to the single "other" bucket', () => {
    expect(routeTemplateFor('/x/550e8400-e29b-41d4-a716-446655440000')).toBe('other');
    expect(routeTemplateFor('/totally/unknown/deep/path')).toBe('other');
  });

  it('strips query strings before matching (query never becomes a label)', () => {
    expect(routeTemplateFor('/dashboard?token=secret&id=99')).toBe('/dashboard');
  });

  it('produces a BOUNDED set of templates over many distinct raw paths', () => {
    const templates = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      templates.add(routeTemplateFor(`/cache-tests/item-${i}`));
      templates.add(routeTemplateFor(`/unknown/${i}/page`));
    }
    // 1000s of raw paths must collapse to a tiny fixed set.
    expect(templates.size).toBeLessThanOrEqual(3);
  });
});
