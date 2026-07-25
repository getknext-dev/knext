import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OVERVIEW_QUERIES, PROMETHEUS_URL_ENV } from './_prom/query';

/**
 * P1.2 (obs-pages plan) / ADR-0038 — the /observability Overview (RED) page:
 *  - is auth-gated fail-closed (unauth ⇒ denied, no metric data / no fetch),
 *  - degrades gracefully: unconfigured Prometheus ⇒ a clear empty state naming
 *    the env var (and NO fetch); unreachable ⇒ an error state, page still 200s,
 *  - renders request-rate / 5xx error-% / p75 + p99 latency / in-flight from the
 *    seeded PromQL responses when authorized + configured,
 *  - references ONLY real knext_* metric names (parity vs adapters/metrics.ts),
 *  - is force-dynamic / never cached and never leaks the token into the HTML.
 */

const authHeader = vi.fn<() => string | null>(() => null);

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) => (name === 'authorization' ? authHeader() : null),
  }),
}));

const ORIGINAL_TOKEN = process.env.OBSERVABILITY_TOKEN;
const ORIGINAL_URL = process.env[PROMETHEUS_URL_ENV];
const TOKEN = 's3cret-observability-token';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function matrix(value: string): unknown {
  return {
    status: 'success',
    data: { resultType: 'matrix', result: [{ metric: {}, values: [[0, value]] }] },
  };
}

function vector(value: string): unknown {
  return {
    status: 'success',
    data: { resultType: 'vector', result: [{ metric: {}, value: [0, value] }] },
  };
}

/**
 * Route the seeded response by the PromQL. Order matters: the 5xx error-rate
 * query also mentions knext_http_requests_total, so it is matched first.
 */
function seededFetch(url: unknown): Response {
  const query = decodeURIComponent(String(url));
  if (query.includes('status_class="5xx"')) return jsonResponse(matrix('2.5')); // error %
  if (query.includes('0.75')) return jsonResponse(matrix('0.12')); // p75 seconds
  if (query.includes('0.99')) return jsonResponse(matrix('0.45')); // p99 seconds
  if (query.includes('inflight')) return jsonResponse(vector('3')); // in-flight
  return jsonResponse(matrix('12.3')); // request rate
}

beforeEach(() => {
  authHeader.mockReturnValue(`Bearer ${TOKEN}`);
  process.env.OBSERVABILITY_TOKEN = TOKEN;
  process.env[PROMETHEUS_URL_ENV] = 'http://prometheus.monitoring.svc:9090';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  if (ORIGINAL_TOKEN === undefined) delete process.env.OBSERVABILITY_TOKEN;
  else process.env.OBSERVABILITY_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_URL === undefined) delete process.env[PROMETHEUS_URL_ENV];
  else process.env[PROMETHEUS_URL_ENV] = ORIGINAL_URL;
});

async function renderPage(): Promise<string> {
  const mod = await import('./page');
  const el = await mod.default();
  return renderToStaticMarkup(el);
}

describe('overview page route config', () => {
  it('is force-dynamic (never cached)', async () => {
    const mod = await import('./page');
    expect(mod.dynamic).toBe('force-dynamic');
  });
});

describe('overview page auth gate (fail-closed)', () => {
  it('denies an unauthenticated request, leaks no data, and does NOT fetch', async () => {
    authHeader.mockReturnValue(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const html = await renderPage();

    expect(html).toMatch(/unauthorized|forbidden|denied/i);
    expect(html).not.toContain('12.3');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('denies when no token is configured, even with a Bearer header', async () => {
    delete process.env.OBSERVABILITY_TOKEN;
    authHeader.mockReturnValue('Bearer anything');
    const html = await renderPage();
    expect(html).toMatch(/unauthorized|forbidden|denied/i);
  });

  it('never renders the token into the HTML', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => seededFetch(u));
    const html = await renderPage();
    expect(html).not.toContain(TOKEN);
  });
});

describe('overview page degradation — unconfigured Prometheus', () => {
  it('renders a "not configured" empty state naming the env var, without fetching', async () => {
    delete process.env[PROMETHEUS_URL_ENV];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const html = await renderPage();

    expect(html).toMatch(/not configured|configure/i);
    expect(html).toContain(PROMETHEUS_URL_ENV);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('overview page degradation — unreachable Prometheus', () => {
  it('renders an error state but the page still renders (no crash)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));

    const html = await renderPage();

    expect(html).toMatch(/unavailable|unreachable|could not|error/i);
    // Page shell still rendered.
    expect(html.toLowerCase()).toContain('overview');
  });
});

describe('overview page authorized render (ok path)', () => {
  it('renders rate, 5xx error %, p75, p99 and in-flight from seeded PromQL', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => seededFetch(u));

    const html = await renderPage();

    expect(html).toContain('12.3'); // request rate (req/s)
    expect(html).toContain('2.5'); // 5xx error rate %
    expect(html).toContain('120'); // p75 = 0.12s -> 120 ms
    expect(html).toContain('450'); // p99 = 0.45s -> 450 ms
    expect(html).toContain('3'); // in-flight
  });

  it('links out to the Grafana dashboards (static, no iframe)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => seededFetch(u));
    const html = await renderPage();
    expect(html.toLowerCase()).toContain('grafana');
    expect(html).not.toContain('<iframe');
  });
});

describe('overview PromQL ↔ metrics.ts parity', () => {
  const METRICS_SRC = resolve(
    import.meta.dirname,
    '../../../../../packages/kn-next/src/adapters/metrics.ts',
  );

  const HISTOGRAM_SUFFIXES = ['_bucket', '_sum', '_count'];

  function exportedMetricNames(): Set<string> {
    const src = readFileSync(METRICS_SRC, 'utf8');
    const names = src.match(/"knext_[a-z_]+"/g) ?? [];
    return new Set(names.map((n) => n.replace(/"/g, '')));
  }

  function baseName(token: string): string {
    for (const suffix of HISTOGRAM_SUFFIXES) {
      if (token.endsWith(suffix)) return token.slice(0, -suffix.length);
    }
    return token;
  }

  it('every knext_* series referenced by an Overview query exists in metrics.ts', () => {
    const allowed = exportedMetricNames();
    expect(allowed.has('knext_http_requests_total')).toBe(true);

    const dangling: string[] = [];
    for (const promql of Object.values(OVERVIEW_QUERIES)) {
      const tokens = promql.match(/knext_[a-z_]+/g) ?? [];
      for (const token of tokens) {
        if (!allowed.has(baseName(token))) dangling.push(token);
      }
    }
    expect(dangling).toEqual([]);
  });

  it('references the three RED series (rate/latency/in-flight)', () => {
    const joined = Object.values(OVERVIEW_QUERIES).join(' ');
    expect(joined).toContain('knext_http_requests_total');
    expect(joined).toContain('knext_http_request_duration_seconds_bucket');
    expect(joined).toContain('knext_http_inflight_requests');
  });
});
