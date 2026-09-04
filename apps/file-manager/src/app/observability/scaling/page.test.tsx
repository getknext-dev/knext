import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { scanBunexecMetrics } from '../../../../../../packages/kn-next/src/adapters/metric-contract';
import { APP_NAME_ENV, PROMETHEUS_URL_ENV, scalingQueries } from '../_prom/query';
import { NO_DATA, UNAVAILABLE } from '../_ui/format';

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
 * P1.3 (obs-pages plan) / ADR-0038 — the /observability/scaling page (knext's
 * signature scale-to-zero page):
 *  - auth-gated fail-closed (unauth ⇒ denied, no metric data / no fetch),
 *  - degrades exactly like the Overview page: unconfigured Prometheus ⇒ a clear
 *    empty state naming the env var (and NO fetch); unreachable ⇒ an error state,
 *    the page still renders (never crashes / hangs),
 *  - renders replicas / cold-start rate + p50 + p99 / DB-wake by role from the
 *    seeded PromQL responses,
 *  - has a DISTINCT "requires kube-state-metrics" state when the cluster-provided
 *    replica series is absent — never a misleading "0 replicas",
 *  - marks absent samples with an explicit "no data yet" marker (never a bare
 *    dash that reads like a zero),
 *  - references ONLY real metric names (parity vs adapters/metrics.ts) and reuses
 *    the shipped scale-to-zero Grafana dashboard's PromQL shapes,
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

function matrix(...series: ReadonlyArray<{ metric?: Record<string, string>; value: string }>) {
  return {
    status: 'success',
    data: {
      resultType: 'matrix',
      result: series.map((s) => ({ metric: s.metric ?? {}, values: [[0, s.value]] })),
    },
  };
}

function vector(value: string) {
  return {
    status: 'success',
    data: { resultType: 'vector', result: [{ metric: {}, value: [0, value] }] },
  };
}

const EMPTY_MATRIX = { status: 'success', data: { resultType: 'matrix', result: [] } };
const EMPTY_VECTOR = { status: 'success', data: { resultType: 'vector', result: [] } };

interface SeedOptions {
  /** Simulate kube-state-metrics not being installed (replica series absent). */
  readonly kubeStateAbsent?: boolean;
  /** Simulate a fresh app that has not recorded any cold start yet. */
  readonly coldStartEmpty?: boolean;
}

function seededFetch(url: unknown, opts: SeedOptions = {}): Response {
  const raw = decodeURIComponent(String(url));
  const isInstant = raw.includes('/api/v1/query?');

  if (raw.includes('kube_deployment_status_replicas')) {
    if (opts.kubeStateAbsent) {
      return jsonResponse(isInstant ? EMPTY_VECTOR : EMPTY_MATRIX);
    }
    // A real Knative app has one Deployment PER REVISION, so the range query
    // returns several series while the instant `sum(...)` returns their total.
    return jsonResponse(
      isInstant
        ? vector('3')
        : matrix(
            { metric: { deployment: 'demo-00001-deployment' }, value: '2' },
            { metric: { deployment: 'demo-00002-deployment' }, value: '1' },
          ),
    );
  }
  if (raw.includes('knext_bunexec_http_inflight_requests')) {
    return jsonResponse(vector('7'));
  }
  if (raw.includes('knext_bunexec_startup_duration_seconds')) {
    // Gauge-derived startup panels (the dashboard's shapes): count / p50 / max.
    if (opts.coldStartEmpty) return jsonResponse(EMPTY_MATRIX);
    // Discriminate on space-free fragments: URLSearchParams encodes spaces as
    // '+', which decodeURIComponent does NOT turn back — 'count by' never
    // matches the raw query string.
    if (raw.includes('quantile')) return jsonResponse(matrix({ value: '1.2' }));
    if (raw.includes('max')) return jsonResponse(matrix({ value: '2.5' }));
    return jsonResponse(matrix({ value: '3' }));
  }
  if (raw.includes('knext_db_wake_duration_seconds')) {
    const p99 = raw.includes('0.99');
    return jsonResponse(
      matrix(
        { metric: { role: 'writer' }, value: p99 ? '0.64' : '0.08' },
        { metric: { role: 'reader' }, value: p99 ? '0.32' : '0.04' },
      ),
    );
  }
  if (raw.includes('knext_db_wake_total')) {
    return jsonResponse(
      matrix(
        { metric: { role: 'writer' }, value: '0.5' },
        { metric: { role: 'reader' }, value: '0.25' },
      ),
    );
  }
  return jsonResponse(EMPTY_MATRIX);
}

function mockFetch(opts: SeedOptions = {}) {
  return spyOnFetchImpl(async (u) => seededFetch(u, opts));
}

/** Every PromQL string this render actually sent to Prometheus. */
function sentQueries(spy: ReturnType<typeof mockFetch>): string[] {
  return spy.mock.calls.map((call) => {
    const url = new URL(String(call[0]));
    return url.searchParams.get('query') ?? '';
  });
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

describe('scaling page route config', () => {
  it('is force-dynamic (never cached)', async () => {
    const mod = await import('./page');
    expect(mod.dynamic).toBe('force-dynamic');
  });
});

describe('scaling page auth gate (fail-closed)', () => {
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

  it('never renders the token or the Prometheus URL into the HTML', async () => {
    mockFetch();
    const html = await renderPage();
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain('prometheus.monitoring.svc');
  });
});

describe('scaling page degradation — unconfigured Prometheus', () => {
  it('renders a "not configured" empty state naming the env var, without fetching', async () => {
    delete process.env[PROMETHEUS_URL_ENV];
    const fetchSpy = spyOn(globalThis, 'fetch');

    const html = await renderPage();

    expect(html).toMatch(/not configured|configure/i);
    expect(html).toContain(PROMETHEUS_URL_ENV);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('scaling page degradation — unreachable Prometheus', () => {
  it('renders an error state but the page still renders (no crash)', async () => {
    spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));

    const html = await renderPage();

    expect(html).toMatch(/unavailable|unreachable|could not|error/i);
    expect(html.toLowerCase()).toContain('cold');
  });
});

describe('scaling page authorized render (ok path)', () => {
  it('renders replicas, cold-start rate + p50/p99 and DB-wake by role', async () => {
    mockFetch();

    const html = await renderPage();

    // Assert on rendered VALUE cells — a bare toContain('3') / toContain('7')
    // matches almost any HTML (the code-review's "weak assertion" finding).
    expect(html).toContain('>3<'); // replicas (2 + 1 across revisions)
    expect(html).toContain('>3<'); // starts observed (gauge count)
    expect(html).toContain('>1200 ms<'); // startup p50 = 1.2s
    expect(html).toContain('>2500 ms<'); // startup max = 2.5s
    expect(html).toContain('writer');
    expect(html).toContain('reader');
    expect(html).toContain('>80 ms<'); // writer DB-wake p50 = 0.08s
    expect(html).toContain('>640 ms<'); // writer DB-wake p99 = 0.64s
    expect(html).toContain('>7<'); // current in-flight
  });

  it('reports the SAME replica count for "latest" and "now" (they cannot contradict)', async () => {
    mockFetch();

    const html = await renderPage();

    // The range query returns per-revision series (2 + 1); the instant query
    // returns the sum (3). Taking only the first series would render "2" next
    // to "3" — two numbers for one fact.
    const cells = [...html.matchAll(/Replicas \((latest|now)\)<\/td><td[^>]*>([^<]*)</g)].map(
      (m) => [m[1], m[2]] as const,
    );
    expect(cells).toEqual([
      ['latest', '3'],
      ['now', '3'],
    ]);
  });

  it('links out to the Grafana scale-to-zero dashboard (static, no iframe)', async () => {
    mockFetch();
    const html = await renderPage();
    expect(html.toLowerCase()).toContain('grafana');
    expect(html).not.toContain('<iframe');
  });
});

describe('scaling page — kube-state-metrics absent is a DISTINCT state', () => {
  it('says the replica panel REQUIRES kube-state-metrics instead of rendering a number', async () => {
    mockFetch({ kubeStateAbsent: true });

    const html = await renderPage();

    // Discriminating string: it exists ONLY in the absent branch. (A plain
    // /kube-state-metrics/i also matches the present-state provenance note, so
    // that assertion passed even with the branch deleted.)
    expect(html).toContain('requires kube-state-metrics');
    // And no replica VALUE is rendered at all — not a zero, not "no data yet".
    expect(html).not.toMatch(/Replicas \((latest|now)\)/);
    // The rest of the page (knext-owned series) still renders.
    expect(html).toContain('>3<'); // starts observed still renders
  });

  it('does NOT claim kube-state-metrics is missing when the series is present', async () => {
    mockFetch();
    const html = await renderPage();
    expect(html).not.toContain('requires kube-state-metrics');
  });

  it('labels the replica series as cluster-provided (provenance, per the dashboard)', async () => {
    mockFetch();
    const html = await renderPage();
    expect(html).toMatch(/kube-state-metrics/i);
  });
});

describe('scaling page — explicit "no data yet" marker (P1.2 follow-up)', () => {
  it('renders the no-data marker, not a bare dash, when a series has no samples', async () => {
    mockFetch({ coldStartEmpty: true });

    const html = await renderPage();

    expect(html).toContain(NO_DATA);
    // No rendered VALUE is a bare dash (a dash reads like a zero at a glance).
    expect(html).not.toMatch(/>\s*[—–-]\s*</);
  });

  it('still renders a real zero as a zero (not as the no-data marker)', () => {
    // A recorded 0 must be visually different from "never recorded".
    expect(NO_DATA).not.toMatch(/^0/);
  });
});

describe('scaling page — every query is scoped to THIS app (#516 review)', () => {
  it('never sends a cluster-wide query: every PromQL carries the app scope', async () => {
    const spy = mockFetch();

    await renderPage();

    const queries = sentQueries(spy);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.filter((q) => !q.includes(APP))).toEqual([]);
    expect(queries).toContain(scalingQueries(APP).replicas);
    expect(queries).toContain(scalingQueries(APP).currentReplicas);
  });

  it('renders a DISTINCT "scope unknown" state when KN_APP_NAME is unset — and does NOT fetch', async () => {
    delete process.env[APP_NAME_ENV];
    const fetchSpy = spyOn(globalThis, 'fetch');

    const html = await renderPage();

    // Honest: names the missing var, never falls back to a cluster-wide sum.
    expect(html).toContain(APP_NAME_ENV);
    expect(html).toMatch(/scope|identity/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(html).not.toMatch(/replicas \(latest\)/i);
  });

  it('treats an injection-shaped KN_APP_NAME as unknown scope (no PromQL built from it)', async () => {
    process.env[APP_NAME_ENV] = 'demo"} or on() up{';
    const fetchSpy = spyOn(globalThis, 'fetch');

    const html = await renderPage();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(html).not.toContain('or on()');
  });
});

describe('scaling page — startup panels (stability sprint D1)', () => {
  it('renders the gauge-derived startup rows and has NO warm-start ratio', async () => {
    // The warm-start ratio was REMOVED with its inputs: the entry emits a
    // per-pod startup gauge, not a cold-start counter, so the ratio is not
    // computable from the shipped scrape — a panel over a dead series would
    // render "no data yet" forever and read as a quiet system.
    mockFetch();

    const html = await renderPage();

    expect(html).toContain('Starts observed');
    expect(html).toMatch(/Startup p50/);
    expect(html).toMatch(/Startup max/);
    expect(html).not.toMatch(/warm start ratio/i);
  });
});

describe('scaling page — partial Prometheus failure ≠ no data', () => {
  it('marks the failed panel unavailable while healthy panels still render', async () => {
    spyOnFetchImpl(async (u) => {
      if (String(u).includes('knext_bunexec_startup_duration_seconds')) {
        throw new Error('connect ECONNREFUSED');
      }
      return seededFetch(u);
    });

    const html = await renderPage();

    // The failed series says so — it must NOT masquerade as "no data yet"
    // (absent data) nor as a measured zero. Checked on rendered VALUE cells:
    // the marker names may still appear in the explanatory prose.
    expect(html).toContain(`>${UNAVAILABLE}<`);
    expect(html).not.toContain(`>${NO_DATA}<`);
    expect(html).toMatch(/partial|some (panels|metrics)/i);
    // The panels that DID load still render.
    expect(html).toContain('80'); // writer DB-wake p50
    expect(html).toContain('7'); // in-flight
  });

  it('uses a marker distinct from the no-data marker', () => {
    expect(UNAVAILABLE).not.toBe(NO_DATA);
  });
});

describe('scaling PromQL ↔ metrics.ts + scale-to-zero dashboard parity', () => {
  const REPO_ROOT = resolve(import.meta.dirname, '../../../../../..');
  const METRICS_SRC = resolve(REPO_ROOT, 'packages/kn-next/src/adapters/metrics.ts');
  const RUNTIME_CONTRACT_TEMPLATE = resolve(
    REPO_ROOT,
    'packages/kn-next/templates/app/runtime-contract.mjs.hbs',
  );
  const DASHBOARD = resolve(
    REPO_ROOT,
    'packages/kn-next-operator/config/grafana/dashboards/scale-to-zero.json',
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

  /**
   * Dashboard exprs with ONLY the Grafana-specific placeholders resolved: the
   * `$app` template variable becomes the concrete app name and
   * `$__rate_interval` the page's fixed 5m window. Label selectors are compared
   * VERBATIM — stripping them (the pre-#516 behaviour) made this gate blind to
   * exactly the scoping bug it exists to catch.
   */
  const QUERIES = scalingQueries(APP);

  function dashboardQueries(): Set<string> {
    const json = readFileSync(DASHBOARD, 'utf8');
    const exprs = (JSON.parse(json) as { panels: { targets?: { expr?: string }[] }[] }).panels
      .flatMap((p) => p.targets ?? [])
      .map((t) => t.expr)
      .filter((e): e is string => typeof e === 'string');
    return new Set(exprs.map((e) => e.replace(/\$__rate_interval/g, '5m').replace(/\$app/g, APP)));
  }

  it('every knext_* series referenced by a Scaling query has a real emitter', () => {
    // Two emitter sets since D1: metrics.ts (the app-registry legacy series,
    // e.g. db-wake) and the entry template's knext_bunexec_* registrations
    // (the shipped :9091 scrape). A query outside BOTH is dangling.
    const allowed = exportedMetricNames();
    for (const name of scanBunexecMetrics(readFileSync(RUNTIME_CONTRACT_TEMPLATE, 'utf8')).keys()) {
      allowed.add(name);
    }
    expect(allowed.has('knext_bunexec_startup_duration_seconds')).toBe(true);
    expect(allowed.has('knext_db_wake_duration_seconds')).toBe(true);

    const dangling: string[] = [];
    for (const promql of Object.values(QUERIES)) {
      for (const token of promql.match(/knext_[a-z_]+/g) ?? []) {
        if (!allowed.has(baseName(token))) dangling.push(token);
      }
    }
    expect(dangling).toEqual([]);
  });

  it('reuses the shipped scale-to-zero dashboard PromQL shapes, SELECTORS INCLUDED', () => {
    const fromDashboard = dashboardQueries();
    const mirrored = [
      QUERIES.replicas,
      QUERIES.startsObserved,
      QUERIES.startupP50,
      QUERIES.startupMax,
      QUERIES.dbWakeRateByRole,
      QUERIES.dbWakeP50ByRole,
      QUERIES.dbWakeP99ByRole,
    ];
    const drifted = mirrored.filter((q) => !fromDashboard.has(q));
    expect(drifted).toEqual([]);
  });

  it('catches an UNSCOPED query — the gate is not blind to label selectors', () => {
    const fromDashboard = dashboardQueries();
    // The pre-fix, cluster-wide replica query must NOT satisfy the parity gate.
    expect(fromDashboard.has('sum by (deployment) (kube_deployment_status_replicas)')).toBe(false);
    expect(fromDashboard.has(QUERIES.replicas)).toBe(true);
  });

  it('uses the cluster-provided kube-state-metrics replica series for replicas', () => {
    expect(QUERIES.replicas).toContain('kube_deployment_status_replicas');
    expect(QUERIES.currentReplicas).toContain('kube_deployment_status_replicas');
  });
});
