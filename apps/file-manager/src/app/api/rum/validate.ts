/**
 * #94 RUM ingest — pure validation + label normalization.
 *
 * Security layer 3 (bounded label cardinality). The server NEVER trusts the
 * client for a Prometheus label:
 *   - metric ∈ closed allow-list {LCP,INP,CLS,FCP,TTFB}
 *   - rating ∈ closed allow-list {good,needs-improvement,poor}
 *   - route  = a route TEMPLATE the server maps the reported pathname to via a
 *     CLOSED known-route table; anything unmatched collapses to a single
 *     `other` bucket. Raw IDs/UUIDs/query strings can NEVER become labels.
 *
 * No user/session/IP/raw-URL ever enters a label. This keeps Prometheus
 * cardinality bounded regardless of what a browser sends.
 */

export const ALLOWED_METRICS = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] as const;
export type Metric = (typeof ALLOWED_METRICS)[number];

export const ALLOWED_RATINGS = ['good', 'needs-improvement', 'poor'] as const;
export type Rating = (typeof ALLOWED_RATINGS)[number];

const METRIC_SET: ReadonlySet<string> = new Set(ALLOWED_METRICS);
const RATING_SET: ReadonlySet<string> = new Set(ALLOWED_RATINGS);

export interface ParsedBeacon {
  metric: Metric;
  value: number;
  rating: Rating;
  pathname: string;
}

/**
 * Known route templates. Static routes map to themselves; dynamic prefixes map
 * to a fixed template. The OTHER bucket absorbs everything unknown so the label
 * set stays bounded.
 */
const STATIC_ROUTES: ReadonlySet<string> = new Set([
  '/',
  '/dashboard',
  '/users',
  '/audit',
  '/cache',
  '/cache-tests',
  '/setup',
]);

/** Dynamic prefixes: a path under this prefix collapses to the template. */
const DYNAMIC_PREFIXES: ReadonlyArray<{ prefix: string; template: string }> = [
  { prefix: '/cache-tests/', template: '/cache-tests/[slug]' },
];

export const OTHER_ROUTE = 'other';

/**
 * Maps a reported pathname to a bounded route-template label. Query strings are
 * stripped before matching so secrets/IDs in the query never leak into a label.
 */
export function routeTemplateFor(pathname: string): string {
  if (typeof pathname !== 'string' || pathname.length === 0) {
    return OTHER_ROUTE;
  }

  // Strip query + fragment — these may carry IDs/tokens and must never label.
  const qIdx = pathname.search(/[?#]/);
  const path = qIdx === -1 ? pathname : pathname.slice(0, qIdx);

  if (STATIC_ROUTES.has(path)) {
    return path;
  }

  for (const { prefix, template } of DYNAMIC_PREFIXES) {
    if (path.startsWith(prefix) && path.length > prefix.length) {
      return template;
    }
  }

  return OTHER_ROUTE;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parses + validates an untrusted beacon body. Returns a normalized
 * ParsedBeacon (only the four whitelisted fields) or null when anything is
 * missing, malformed, or outside an allow-list. Extra fields are dropped, never
 * carried through.
 */
export function parseBeacon(input: unknown): ParsedBeacon | null {
  if (!isPlainObject(input)) {
    return null;
  }

  const { metric, value, rating, pathname } = input;

  if (typeof metric !== 'string' || !METRIC_SET.has(metric)) {
    return null;
  }
  if (typeof rating !== 'string' || !RATING_SET.has(rating)) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  if (typeof pathname !== 'string' || pathname.length === 0) {
    return null;
  }

  return {
    metric: metric as Metric,
    value,
    rating: rating as Rating,
    pathname,
  };
}
