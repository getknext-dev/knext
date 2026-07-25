import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_NAME_ENV, PROMETHEUS_URL_ENV, scalingQueries } from '../_prom/query';
import { NO_DATA, UNAVAILABLE } from '../_ui/format';

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

const authHeader = vi.fn<() => string | null>(() => null);

vi.mock('next/headers', () => ({
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
    return jsonResponse(
      isInstant ? vector('3') : matrix({ metric: { deployment: 'demo' }, value: '3' }),
    );
  }
  if (raw.includes('knext_http_inflight_requests')) {
    return jsonResponse(vector('7'));
  }
  if (raw.includes('knext_http_requests_total')) {
    // Warm-start ratio: derived from cold starts vs served requests.
    return jsonResponse(matrix({ value: '97.5' }));
  }
  if (raw.includes('knext_coldstart_duration_seconds')) {
    if (opts.coldStartEmpty) return jsonResponse(EMPTY_MATRIX);
    return jsonResponse(matrix({ value: raw.includes('0.99') ? '2.5' : '1.2' }));
  }
  if (raw.includes('knext_coldstart_total')) {
    if (opts.coldStartEmpty) return jsonResponse(EMPTY_MATRIX);
    return jsonResponse(matrix({ value: '0.42' }));
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
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => seededFetch(u, opts));
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
  vi.restoreAllMocks();
  vi.clearAllMocks();
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

describe('scaling page route config', () => {
  it('is force-dynamic (never cached)', async () => {
    const mod = await import('./page');
    expect(mod.dynamic).toBe('force-dynamic');
  });
});

describe('scaling page auth gate (fail-closed)', () => {
  it('denies an unauthenticated request, leaks no data, and does NOT fetch', async () => {
    authHeader.mockReturnValue(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const html = await renderPage();

    expect(html).toMatch(/unauthorized|forbidden|denied/i);
    expect(html).not.toContain('0.42');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('denies when no token is configured, even with a Bearer header', async () => {
    delete process.env.OBSERVABILITY_TOKEN;
    authHeader.mockReturnValue('Bearer anything');
    const html = await renderPage();
    expect(html).toMatch(/unauthorized|forbidden|denied/i);
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
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const html = await renderPage();

    expect(html).toMatch(/not configured|configure/i);
    expect(html).toContain(PROMETHEUS_URL_ENV);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('scaling page degradation — unreachable Prometheus', () => {
  it('renders an error state but the page still renders (no crash)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));

    const html = await renderPage();

    expect(html).toMatch(/unavailable|unreachable|could not|error/i);
    expect(html.toLowerCase()).toContain('cold');
  });
});

describe('scaling page authorized render (ok path)', () => {
  it('renders replicas, cold-start rate + p50/p99 and DB-wake by role', async () => {
    mockFetch();

    const html = await renderPage();

    expect(html).toContain('3'); // replicas
    expect(html).toContain('0.42'); // cold starts /s
    expect(html).toContain('1200'); // cold-start p50 = 1.2s -> 1200 ms
    expect(html).toContain('2500'); // cold-start p99 = 2.5s -> 2500 ms
    expect(html).toContain('writer');
    expect(html).toContain('reader');
    expect(html).toContain('80'); // writer DB-wake p50 = 0.08s -> 80 ms
    expect(html).toContain('640'); // writer DB-wake p99 = 0.64s -> 640 ms
    expect(html).toContain('7'); // current in-flight
  });

  it('links out to the Grafana scale-to-zero dashboard (static, no iframe)', async () => {
    mockFetch();
    const html = await renderPage();
    expect(html.toLowerCase()).toContain('grafana');
    expect(html).not.toContain('<iframe');
  });
});

describe('scaling page — kube-state-metrics absent is a DISTINCT state', () => {
  it('says the replica panel requires kube-state-metrics instead of showing 0 replicas', async () => {
    mockFetch({ kubeStateAbsent: true });

    const html = await renderPage();

    expect(html).toMatch(/kube-state-metrics/i);
    expect(html).not.toMatch(/0\s*replicas/i);
    // The rest of the page (knext-owned series) still renders.
    expect(html).toContain('0.42');
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
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const html = await renderPage();

    // Honest: names the missing var, never falls back to a cluster-wide sum.
    expect(html).toContain(APP_NAME_ENV);
    expect(html).toMatch(/scope|identity/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(html).not.toMatch(/replicas \(latest\)/i);
  });

  it('treats an injection-shaped KN_APP_NAME as unknown scope (no PromQL built from it)', async () => {
    process.env[APP_NAME_ENV] = 'demo"} or on() up{';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const html = await renderPage();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(html).not.toContain('or on()');
  });
});

describe('scaling page — warm-start ratio (plan §5.3 AC)', () => {
  it('renders the warm-start ratio derived from cold starts vs served requests', async () => {
    mockFetch();

    const html = await renderPage();

    expect(html).toMatch(/warm start/i);
    expect(html).toContain('97.5');
  });
});

describe('scaling page — partial Prometheus failure ≠ no data', () => {
  it('marks the failed panel unavailable while healthy panels still render', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      if (String(u).includes('knext_coldstart')) {
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

  it('every knext_* series referenced by a Scaling query exists in metrics.ts', () => {
    const allowed = exportedMetricNames();
    expect(allowed.has('knext_coldstart_total')).toBe(true);
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
      QUERIES.coldStartRate,
      QUERIES.coldStartP50,
      QUERIES.coldStartP99,
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
