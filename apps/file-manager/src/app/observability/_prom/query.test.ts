import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_NAME_ENV,
  instantValue,
  latestMatrixValue,
  observabilityAppName,
  PROMETHEUS_URL_ENV,
  prometheusBaseUrl,
  queryInstant,
  queryRange,
  scalingQueries,
} from './query';

/**
 * P1.2 (obs-pages plan) / ADR-0038 — the server-only Prometheus query util:
 *  - reports a TYPED "unconfigured" result (never throws) when the env is unset,
 *    and does NOT hit the network in that case,
 *  - fetches uncached (`cache: 'no-store'`) with a short abort timeout so a slow
 *    or absent Prometheus degrades the page rather than hanging it,
 *  - degrades to a typed "unreachable" result (summary only, no raw error object)
 *    on network failure / non-2xx / Prometheus error envelope.
 */

const ORIGINAL = process.env[PROMETHEUS_URL_ENV];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  process.env[PROMETHEUS_URL_ENV] = 'http://prometheus.monitoring.svc:9090';
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL === undefined) delete process.env[PROMETHEUS_URL_ENV];
  else process.env[PROMETHEUS_URL_ENV] = ORIGINAL;
});

describe('prometheusBaseUrl', () => {
  it('returns the trimmed env value when set, undefined (with no trailing slash) otherwise', () => {
    process.env[PROMETHEUS_URL_ENV] = 'http://prom:9090/';
    expect(prometheusBaseUrl()).toBe('http://prom:9090');
    delete process.env[PROMETHEUS_URL_ENV];
    expect(prometheusBaseUrl()).toBeUndefined();
    process.env[PROMETHEUS_URL_ENV] = '   ';
    expect(prometheusBaseUrl()).toBeUndefined();
  });
});

describe('query util — unconfigured (env unset)', () => {
  it('returns a typed unconfigured result and does NOT fetch', async () => {
    delete process.env[PROMETHEUS_URL_ENV];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const range = await queryRange('up', 0, 60, 15);
    const instant = await queryInstant('up');

    expect(range.status).toBe('unconfigured');
    expect(instant.status).toBe('unconfigured');
    if (range.status === 'unconfigured') {
      expect(range.envVar).toBe(PROMETHEUS_URL_ENV);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('query util — ok path', () => {
  it('queryRange returns ok with the matrix result', async () => {
    const payload = {
      status: 'success',
      data: {
        resultType: 'matrix',
        result: [
          {
            metric: {},
            values: [
              [0, '1'],
              [60, '2.5'],
            ],
          },
        ],
      },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(payload));

    const r = await queryRange('sum(rate(x[5m]))', 0, 60, 15);
    expect(r.status).toBe('ok');
    expect(latestMatrixValue(r)).toBeCloseTo(2.5);
  });

  it('queryInstant returns ok with the vector result', async () => {
    const payload = {
      status: 'success',
      data: {
        resultType: 'vector',
        result: [{ metric: {}, value: [123, '7'] }],
      },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(payload));

    const r = await queryInstant('sum(x)');
    expect(r.status).toBe('ok');
    expect(instantValue(r)).toBe(7);
  });

  it('fetches uncached (no-store) with an abort signal, hitting the query_range API', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonResponse({ status: 'success', data: { resultType: 'matrix', result: [] } }),
      );

    await queryRange('up', 10, 70, 15);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain('/api/v1/query_range');
    expect(String(url)).toContain('query=up');
    expect(init?.cache).toBe('no-store');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('query util — degradation (unreachable)', () => {
  it('degrades to unreachable when fetch rejects, leaking no raw error object', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('connect ECONNREFUSED 10.4.2.7:9090'),
    );

    const r = await queryRange('up', 0, 60, 15);
    expect(r.status).toBe('unreachable');
    if (r.status === 'unreachable') {
      expect(typeof r.errorSummary).toBe('string');
      expect(r.errorSummary.length).toBeGreaterThan(0);
      // No raw internal host/IP leaked into the summary.
      expect(r.errorSummary).not.toContain('10.4.2.7');
    }
    expect(latestMatrixValue(r)).toBeNull();
  });

  it('degrades to unreachable on a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 503 }));
    const r = await queryInstant('up');
    expect(r.status).toBe('unreachable');
    expect(instantValue(r)).toBeNull();
  });

  it('degrades to unreachable on a Prometheus error envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ status: 'error', errorType: 'bad_data', error: 'parse error' }),
    );
    const r = await queryRange('up{', 0, 60, 15);
    expect(r.status).toBe('unreachable');
  });

  it('never throws — a rejecting fetch resolves to a typed result', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
    await expect(queryInstant('up')).resolves.toMatchObject({ status: 'unreachable' });
  });
});

/**
 * App scoping (#516 review): an UNSCOPED replica/knext query sums every workload
 * in the cluster, so the page would render an arbitrary other deployment's number
 * as "this app". The scope comes from `KN_APP_NAME` (set by the operator), which
 * is untrusted input as far as PromQL is concerned — it must be validated, never
 * interpolated blindly.
 */
describe('observabilityAppName — validated app scope (no PromQL injection)', () => {
  const ORIGINAL_APP = process.env[APP_NAME_ENV];

  afterEach(() => {
    if (ORIGINAL_APP === undefined) delete process.env[APP_NAME_ENV];
    else process.env[APP_NAME_ENV] = ORIGINAL_APP;
  });

  it('returns a valid RFC1123-label app name (what the operator sets)', () => {
    process.env[APP_NAME_ENV] = 'file-manager';
    expect(observabilityAppName()).toBe('file-manager');
  });

  it('trims surrounding whitespace', () => {
    process.env[APP_NAME_ENV] = '  demo  ';
    expect(observabilityAppName()).toBe('demo');
  });

  it('returns undefined when unset or blank — never a silent cluster-wide scope', () => {
    delete process.env[APP_NAME_ENV];
    expect(observabilityAppName()).toBeUndefined();
    process.env[APP_NAME_ENV] = '   ';
    expect(observabilityAppName()).toBeUndefined();
  });

  it.each([
    ['quote break-out', 'demo"} or on() up{'],
    ['brace', 'demo}'],
    ['backslash escape', 'demo\\"'],
    ['regex metacharacters', '.*'],
    ['pipe alternation', 'demo|other'],
    ['newline', 'demo\nup'],
    ['dot (regex any-char)', 'demo.prod'],
    ['uppercase / underscore (not a k8s label)', 'Demo_App'],
    ['leading hyphen', '-demo'],
    ['over 63 chars', 'a'.repeat(64)],
  ])('rejects %s rather than interpolating it into PromQL', (_name, value) => {
    process.env[APP_NAME_ENV] = value;
    expect(observabilityAppName()).toBeUndefined();
  });
});

describe('scalingQueries — every series is scoped to THIS app', () => {
  const q = scalingQueries('demo');

  it('scopes the cluster-provided replica series exactly like the dashboard', () => {
    expect(q.replicas).toBe(
      'sum by (deployment) (kube_deployment_status_replicas{deployment=~"demo.*"})',
    );
    expect(q.currentReplicas).toBe('sum(kube_deployment_status_replicas{deployment=~"demo.*"})');
  });

  it('scopes every knext_* series by the app label', () => {
    const unscoped = Object.entries(q).filter(([, promql]) => !promql.includes('demo'));
    expect(unscoped).toEqual([]);
  });

  it('exposes a warm-start ratio derived from cold starts vs requests', () => {
    expect(q.warmStartRatioPct).toContain('knext_coldstart_total');
    expect(q.warmStartRatioPct).toContain('knext_http_requests_total');
    // Clamped so a cold-start burst with no served requests cannot render a
    // negative / infinite "ratio".
    expect(q.warmStartRatioPct).toContain('clamp');
  });
});
