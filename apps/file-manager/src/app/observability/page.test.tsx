import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { scanBunexecMetrics } from '../../../../../packages/kn-next/src/adapters/metric-contract';
import { APP_NAME_ENV, overviewQueries, PROMETHEUS_URL_ENV } from './_prom/query';
import { NO_DATA } from './_ui/format';

/**
 * bun's `typeof fetch` carries a `preconnect` property that a bare arrow does
 * not, so `spyOn(globalThis, 'fetch').mockImplementation(fn)` is not assignable
 * under `@types/bun`. Attaching the member beats casting: the callback's own
 * parameter and return types stay checked, so a genuinely wrong stub still errors.
 *
 * Written as a helper that REPLACES the call head rather than wrapping each
 * callback, because wrapping needs paren matching and these files are JSX — that
 * attempt produced `')' expected` and was reverted.
 */
const spyOnFetchImpl = (fn: (...a: Parameters<typeof fetch>) => Promise<Response>) =>
  spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(fn, { preconnect: globalThis.fetch.preconnect }),
  );

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

const ORIGINAL_TOKEN = process.env.OBSERVABILITY_TOKEN;
const ORIGINAL_URL = process.env[PROMETHEUS_URL_ENV];
const ORIGINAL_APP = process.env[APP_NAME_ENV];
const TOKEN = 's3cret-observability-token';
/** The app identity the operator injects as KN_APP_NAME. */
const APP = 'demo';

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
  process.env[APP_NAME_ENV] = APP;
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  if (ORIGINAL_TOKEN === undefined) delete process.env.OBSERVABILITY_TOKEN;
  else process.env.OBSERVABILITY_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_URL === undefined) delete process.env[PROMETHEUS_URL_ENV];
  else process.env[PROMETHEUS_URL_ENV] = ORIGINAL_URL;
  if (ORIGINAL_APP === undefined) delete process.env[APP_NAME_ENV];
  else process.env[APP_NAME_ENV] = ORIGINAL_APP;
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

describe('overview page route config', () => {
  it('is force-dynamic (never cached)', async () => {
    const mod = await import('./page');
    expect(mod.dynamic).toBe('force-dynamic');
  });
});

describe('overview page auth gate (fail-closed)', () => {
  it('denies with a real 401, leaks no data, and does NOT fetch', async () => {
    authHeader.mockReturnValue(null);
    const fetchSpy = spyOn(globalThis, 'fetch');

    expect(await denialDigest()).toBe(UNAUTHORIZED_DIGEST);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('denies with a real 401 when no token is configured, even with a Bearer header', async () => {
    delete process.env.OBSERVABILITY_TOKEN;
    authHeader.mockReturnValue('Bearer anything');
    expect(await denialDigest()).toBe(UNAUTHORIZED_DIGEST);
  });

  it('never renders the token into the HTML', async () => {
    spyOnFetchImpl(async (u) => seededFetch(u));
    const html = await renderPage();
    expect(html).not.toContain(TOKEN);
  });
});

describe('overview page degradation — unconfigured Prometheus', () => {
  it('renders a "not configured" empty state naming the env var, without fetching', async () => {
    delete process.env[PROMETHEUS_URL_ENV];
    const fetchSpy = spyOn(globalThis, 'fetch');

    const html = await renderPage();

    expect(html).toMatch(/not configured|configure/i);
    expect(html).toContain(PROMETHEUS_URL_ENV);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('overview page degradation — unreachable Prometheus', () => {
  it('renders an error state but the page still renders (no crash)', async () => {
    spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));

    const html = await renderPage();

    expect(html).toMatch(/unavailable|unreachable|could not|error/i);
    // Page shell still rendered.
    expect(html.toLowerCase()).toContain('overview');
  });
});

describe('overview page authorized render (ok path)', () => {
  it('renders rate, 5xx error %, p75, p99 and in-flight from seeded PromQL', async () => {
    spyOnFetchImpl(async (u) => seededFetch(u));

    const html = await renderPage();

    // Assert on rendered VALUE cells: a bare toContain('3') would match almost
    // any HTML (the code-review's "weak assertion" finding).
    expect(html).toContain('>12.30<'); // request rate (req/s)
    expect(html).toContain('>2.5 %<'); // 5xx error rate
    expect(html).toContain('>120 ms<'); // p75 = 0.12s
    expect(html).toContain('>450 ms<'); // p99 = 0.45s
    expect(html).toContain('>3<'); // in-flight
  });

  it('links out to the Grafana dashboards (static, no iframe)', async () => {
    spyOnFetchImpl(async (u) => seededFetch(u));
    const html = await renderPage();
    expect(html.toLowerCase()).toContain('grafana');
    expect(html).not.toContain('<iframe');
  });
});

describe('overview page — explicit "no data yet" marker (P1.2 sign-off follow-up)', () => {
  it('renders the no-data marker, not a bare dash, when a series has no samples', async () => {
    const empty = { status: 'success', data: { resultType: 'matrix', result: [] } };
    spyOnFetchImpl(async () => jsonResponse(empty));

    const html = await renderPage();

    expect(html).toContain(NO_DATA);
    // No rendered VALUE is a bare dash (a dash reads like a zero at a glance).
    expect(html).not.toMatch(/>\s*[—–-]\s*</);
  });
});

describe('overview page — every query is scoped to THIS app (#516 code review)', () => {
  it('never sends a cluster-wide RED query: every PromQL carries the app scope', async () => {
    const spy = spyOnFetchImpl(async (u) => seededFetch(u));

    await renderPage();

    const queries = spy.mock.calls.map(
      (call) => new URL(String(call[0])).searchParams.get('query') ?? '',
    );
    expect(queries.length).toBe(5);
    expect(queries.filter((q) => !q.includes(`{app=~"${APP}"`))).toEqual([]);
  });

  it('renders a DISTINCT "scope unknown" state when KN_APP_NAME is unset — and does NOT fetch', async () => {
    delete process.env[APP_NAME_ENV];
    const fetchSpy = spyOn(globalThis, 'fetch');

    const html = await renderPage();

    expect(html).toContain(APP_NAME_ENV);
    expect(html).toMatch(/scope|identity/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(html).not.toContain('12.3');
  });

  it('treats an injection-shaped KN_APP_NAME as unknown scope (no PromQL built from it)', async () => {
    process.env[APP_NAME_ENV] = 'demo"} or on() up{';
    const fetchSpy = spyOn(globalThis, 'fetch');

    const html = await renderPage();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(html).not.toContain('or on()');
  });
});

describe('overview PromQL ↔ metrics.ts parity', () => {
  const QUERIES = overviewQueries(APP);

  const METRICS_SRC = resolve(
    import.meta.dirname,
    '../../../../../packages/kn-next/src/adapters/metrics.ts',
  );
  const RUNTIME_CONTRACT_TEMPLATE = resolve(
    import.meta.dirname,
    '../../../../../packages/kn-next/templates/app/runtime-contract.mjs.hbs',
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

  it('every knext_* series referenced by an Overview query has a real emitter', () => {
    // The RED queries moved to the knext_bunexec_* family (stability sprint
    // D1) — the series the shipped :9091 scrape actually has. metrics.ts's
    // app-registry names remain allowed for the legacy series.
    const allowed = exportedMetricNames();
    for (const name of scanBunexecMetrics(readFileSync(RUNTIME_CONTRACT_TEMPLATE, 'utf8')).keys()) {
      allowed.add(name);
    }
    expect(allowed.has('knext_bunexec_http_requests_total')).toBe(true);

    const dangling: string[] = [];
    for (const promql of Object.values(QUERIES)) {
      const tokens = promql.match(/knext_[a-z_]+/g) ?? [];
      for (const token of tokens) {
        if (!allowed.has(baseName(token))) dangling.push(token);
      }
    }
    expect(dangling).toEqual([]);
  });

  it('references the three RED series (rate/latency/in-flight)', () => {
    const joined = Object.values(QUERIES).join(' ');
    expect(joined).toContain('knext_bunexec_http_requests_total');
    expect(joined).toContain('knext_bunexec_http_request_duration_seconds_bucket');
    expect(joined).toContain('knext_bunexec_http_inflight_requests');
  });
});
