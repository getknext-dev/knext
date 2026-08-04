import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_NAME_ENV,
  APP_NAMESPACE_ENV,
  deploymentQueries,
  hasNoInstantSeries,
  hasNoSeries,
  instantByLabel,
  instantValue,
  KUBE_STATE_PROBE,
  latestMatrixByLabel,
  latestMatrixValue,
  observabilityAppName,
  observabilityAppNamespace,
  overviewQueries,
  PAGE_DEADLINE_MS,
  PROMETHEUS_URL_ENV,
  type PromMatrixSeries,
  type PromResult,
  type PromVectorSample,
  prometheusBaseUrl,
  queryInstant,
  queryRange,
  scalingQueries,
  startPageDeadline,
  totalLatestMatrixValue,
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

describe('result helpers — no silent zeros', () => {
  function matrixResult(...series: PromMatrixSeries[]): PromResult<PromMatrixSeries[]> {
    return { status: 'ok', data: series };
  }

  describe('latestMatrixByLabel', () => {
    it('returns the LATEST sample of every series, keyed by the label', () => {
      const result = matrixResult(
        {
          metric: { role: 'writer' },
          values: [
            [0, '0.1'],
            [60, '0.5'],
          ],
        },
        {
          metric: { role: 'reader' },
          values: [
            [0, '0.2'],
            [60, '0.25'],
          ],
        },
      );
      expect(latestMatrixByLabel(result, 'role')).toEqual([
        { key: 'writer', value: 0.5 },
        { key: 'reader', value: 0.25 },
      ]);
    });

    it('handles a single series', () => {
      const result = matrixResult({ metric: { role: 'writer' }, values: [[0, '3']] });
      expect(latestMatrixByLabel(result, 'role')).toEqual([{ key: 'writer', value: 3 }]);
    });

    it('returns [] for an empty result and for a non-ok result', () => {
      expect(latestMatrixByLabel(matrixResult(), 'role')).toEqual([]);
      expect(latestMatrixByLabel({ status: 'unreachable', errorSummary: 'down' }, 'role')).toEqual(
        [],
      );
    });

    it('falls back to "unknown" for a series missing the label, and skips unparseable/empty series', () => {
      const result = matrixResult(
        { metric: {}, values: [[0, '7']] },
        { metric: { role: 'reader' }, values: [] },
        { metric: { role: 'writer' }, values: [[0, 'NaN']] },
      );
      expect(latestMatrixByLabel(result, 'role')).toEqual([{ key: 'unknown', value: 7 }]);
    });
  });

  describe('totalLatestMatrixValue', () => {
    it('sums the latest sample ACROSS series so it agrees with an instant sum()', () => {
      const result = matrixResult(
        { metric: { deployment: 'demo-00001' }, values: [[0, '2']] },
        { metric: { deployment: 'demo-00002' }, values: [[0, '1']] },
      );
      // Taking only data[0] here would render "2" next to an instant "3".
      expect(totalLatestMatrixValue(result)).toBe(3);
    });

    it('is null (never 0) for an empty or non-ok result', () => {
      expect(totalLatestMatrixValue(matrixResult())).toBeNull();
      expect(totalLatestMatrixValue({ status: 'unreachable', errorSummary: 'down' })).toBeNull();
    });

    it('returns a genuine 0 when a series really reports 0', () => {
      const result = matrixResult({ metric: { deployment: 'demo' }, values: [[0, '0']] });
      expect(totalLatestMatrixValue(result)).toBe(0);
    });
  });

  describe('hasNoSeries', () => {
    it('is true ONLY when the query succeeded with zero series', () => {
      expect(hasNoSeries(matrixResult())).toBe(true);
      expect(hasNoSeries(matrixResult({ metric: {}, values: [[0, '1']] }))).toBe(false);
      // A failed query knows nothing — it must not claim "the series is absent".
      expect(hasNoSeries({ status: 'unreachable', errorSummary: 'down' })).toBe(false);
      expect(hasNoSeries({ status: 'unconfigured', envVar: PROMETHEUS_URL_ENV })).toBe(false);
    });
  });
});

describe('overviewQueries — every RED series is scoped to THIS app', () => {
  const q = overviewQueries('demo');

  it('scopes every knext_* series by the app label (dashboard shape)', () => {
    const unscoped = Object.entries(q).filter(([, promql]) => !promql.includes('{app=~"demo"'));
    expect(unscoped).toEqual([]);
  });

  it('keeps the 5xx selector alongside the app scope', () => {
    expect(q.errorRatePct).toContain('{app=~"demo",status_class="5xx"}');
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

/**
 * P1.4 helpers (PR-520 review): the Deployments page ENUMERATES one row per
 * matched series and calls the newest one "current", so a selector that is one
 * character too loose is not a rounding error — it is another workload's deploy
 * presented as this app's. These pin the selector shape itself.
 */
describe('deploymentQueries — the selector cannot match a sibling workload', () => {
  const q = deploymentQueries('demo', 'demo-ns');

  it('anchors on Knative revision-Deployment naming, not an open prefix', () => {
    for (const promql of Object.values(q)) {
      expect(promql).toContain('deployment=~"demo-[0-9]+-deployment"');
      // The open prefix is the bug: it matches `demo-api-00007-deployment`.
      expect(promql).not.toContain('deployment=~"demo.*"');
    }
  });

  it('excludes a sibling app name under the anchored pattern (regex proof)', () => {
    // Derived FROM the production query, never retyped: a regex literal copied
    // into the test would keep passing after the selector regressed to `demo.*`.
    // Prometheus fully anchors regex label matchers, so mirror that with `^…$`.
    const matcher = /deployment=~"([^"]+)"/.exec(q.revisionCreated)?.[1];
    expect(matcher).toBeTruthy();
    const pattern = new RegExp(`^${matcher}$`);

    expect(pattern.test('demo-00007-deployment')).toBe(true);
    expect(pattern.test('demo-api-00007-deployment')).toBe(false);
    expect(pattern.test('demo-api')).toBe(false);
    expect(pattern.test('demo-00007-deployment-extra')).toBe(false);
  });

  it('exposes an app-agnostic kube-state-metrics probe, so a zero result has one cause', () => {
    // The probe is what lets the page tell "kube-state-metrics is absent" apart
    // from "present, but no Deployment matches this app" — it must therefore
    // carry NO app/namespace selector at all, or it would answer the same
    // question as the scoped query and prove nothing.
    expect(KUBE_STATE_PROBE).toContain('kube_deployment_created');
    expect(KUBE_STATE_PROBE).not.toContain('deployment=~');
    expect(KUBE_STATE_PROBE).not.toContain('namespace=');
    expect(KUBE_STATE_PROBE).not.toContain('demo');
    // …and it is deliberately NOT one of the per-app queries: every value in
    // `DeploymentQueries` must stay app-scoped (asserted above).
    expect(Object.values(q)).not.toContain(KUBE_STATE_PROBE);
  });

  it('adds the namespace selector when the namespace is known', () => {
    for (const promql of Object.values(q)) {
      expect(promql).toContain('namespace="demo-ns"');
    }
  });

  it('omits the namespace selector (rather than inventing one) when unknown', () => {
    const unscoped = deploymentQueries('demo');
    for (const promql of Object.values(unscoped)) {
      expect(promql).not.toContain('namespace=');
      expect(promql).toContain('deployment=~"demo-[0-9]+-deployment"');
    }
  });

  it('groups by (namespace, deployment) so same-named apps cannot merge', () => {
    for (const promql of Object.values(q)) {
      expect(promql).toContain('max by (namespace, deployment)');
    }
  });

  it('uses only cluster-provided kube_deployment_* series', () => {
    expect(q.revisionCreated).toContain('kube_deployment_created');
    expect(q.revisionReplicas).toContain('kube_deployment_status_replicas{');
    expect(q.revisionAvailable).toContain('kube_deployment_status_replicas_available');
  });
});

describe('observabilityAppNamespace — validated namespace scope', () => {
  const ORIGINAL_NS = process.env[APP_NAMESPACE_ENV];

  afterEach(() => {
    if (ORIGINAL_NS === undefined) delete process.env[APP_NAMESPACE_ENV];
    else process.env[APP_NAMESPACE_ENV] = ORIGINAL_NS;
  });

  it('returns the trimmed namespace when it is a valid k8s label', () => {
    process.env[APP_NAMESPACE_ENV] = '  demo-ns  ';
    expect(observabilityAppNamespace()).toBe('demo-ns');
  });

  it('returns undefined when unset or empty (never a guessed default)', () => {
    delete process.env[APP_NAMESPACE_ENV];
    expect(observabilityAppNamespace()).toBeUndefined();
    process.env[APP_NAMESPACE_ENV] = '  ';
    expect(observabilityAppNamespace()).toBeUndefined();
  });

  it('rejects an injection-shaped value rather than escaping it', () => {
    process.env[APP_NAMESPACE_ENV] = 'ns"} or on() up{';
    expect(observabilityAppNamespace()).toBeUndefined();
  });
});

describe('instantByLabel / hasNoInstantSeries — instant-vector helpers', () => {
  const ok = (
    samples: ReadonlyArray<{ metric: Record<string, string>; value: string }>,
  ): PromResult<PromVectorSample[]> => ({
    status: 'ok',
    data: samples.map((s) => ({ metric: s.metric, value: [0, s.value] as const })),
  });

  it('keys by a single label', () => {
    const result = ok([{ metric: { deployment: 'demo-00001-deployment' }, value: '2' }]);
    expect(instantByLabel(result, 'deployment')).toEqual([
      { key: 'demo-00001-deployment', value: 2 },
    ]);
  });

  it('joins MULTIPLE labels so two namespaces cannot collapse into one key', () => {
    const result = ok([
      { metric: { namespace: 'a', deployment: 'demo-00001-deployment' }, value: '2' },
      { metric: { namespace: 'b', deployment: 'demo-00001-deployment' }, value: '5' },
    ]);
    const rows = instantByLabel(result, 'namespace', 'deployment');
    expect(rows).toEqual([
      { key: 'a/demo-00001-deployment', value: 2 },
      { key: 'b/demo-00001-deployment', value: 5 },
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });

  it('renders a missing label as "unknown" instead of dropping the series', () => {
    const result = ok([{ metric: {}, value: '3' }]);
    expect(instantByLabel(result, 'deployment')).toEqual([{ key: 'unknown', value: 3 }]);
  });

  it('skips non-finite samples (a NaN row would render as a fake value)', () => {
    const result = ok([
      { metric: { deployment: 'a' }, value: 'NaN' },
      { metric: { deployment: 'b' }, value: '7' },
    ]);
    expect(instantByLabel(result, 'deployment')).toEqual([{ key: 'b', value: 7 }]);
  });

  it('returns [] for non-ok results (caller renders an explicit state)', () => {
    expect(instantByLabel({ status: 'unreachable', errorSummary: 'x' }, 'deployment')).toEqual([]);
    expect(instantByLabel({ status: 'unconfigured', envVar: 'X' }, 'deployment')).toEqual([]);
  });

  it('hasNoInstantSeries is true ONLY for a successful, empty result', () => {
    expect(hasNoInstantSeries({ status: 'ok', data: [] })).toBe(true);
    expect(hasNoInstantSeries(ok([{ metric: {}, value: '0' }]))).toBe(false);
    // A FAILED query is not "the series does not exist" — the page must render
    // "unreachable", not "requires kube-state-metrics".
    expect(hasNoInstantSeries({ status: 'unreachable', errorSummary: 'x' })).toBe(false);
    expect(hasNoInstantSeries({ status: 'unconfigured', envVar: 'X' })).toBe(false);
  });
});

/**
 * The shared PAGE-LEVEL deadline (PR-520 sysdesign follow-up).
 *
 * Every call already had its own ~4 s abort budget, but a page that makes a
 * concurrent wave and then a sequential probe SUMS those budgets — ~8 s of wall
 * clock with no cap. One deadline threaded through every call of one render turns
 * the total into a bound instead of a sum.
 */
describe('startPageDeadline — one shared budget, not a per-call sum', () => {
  it('reports the remaining budget from an injected monotonic clock, floored at 0', () => {
    let now = 1000;
    const deadline = startPageDeadline(4000, () => now);

    expect(deadline.totalMs).toBe(4000);
    expect(deadline.remainingMs()).toBe(4000);
    now = 2500;
    expect(deadline.remainingMs()).toBe(2500);
    now = 99_999;
    expect(deadline.remainingMs()).toBe(0);
  });

  it('defaults to the page budget constant', () => {
    expect(startPageDeadline().totalMs).toBe(PAGE_DEADLINE_MS);
  });

  it('does NOT fetch at all once the budget is gone, returning a typed deadline result', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    let now = 0;
    const deadline = startPageDeadline(4000, () => now);
    now = 4000;

    const r = await queryInstant('up', { deadline });

    expect(r.status).toBe('deadline-exceeded');
    if (r.status === 'deadline-exceeded') {
      expect(r.budgetMs).toBe(4000);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    // Distinct from every other degradation: not a zero, not "no series".
    expect(instantValue(r)).toBeNull();
    expect(hasNoInstantSeries(r)).toBe(false);
  });

  it('caps a per-call timeout at the REMAINING budget and attributes that abort to the deadline', async () => {
    // A hung Prometheus: the request ends only when its signal aborts. Under the
    // per-call 4 s budget that takes ~4 s and reports "unreachable"; with a 30 ms
    // shared budget left it must end in ~30 ms and say "deadline".
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError')),
          );
        }),
    );

    const startedAt = performance.now();
    const r = await queryInstant('up', { deadline: startPageDeadline(30) });
    const elapsed = performance.now() - startedAt;

    expect(r.status).toBe('deadline-exceeded');
    // Far below the per-call default (4000 ms): the SHARED budget bounded it.
    expect(elapsed).toBeLessThan(1500);
  });

  /**
   * The attribution must be a FACT captured at request time, not a clock reading
   * in the `catch` (PR-520 review finding 1).
   *
   * This is the deterministic reproduction of the load-sensitive flake: the clock
   * is FROZEN, so at the moment the abort arrives `remainingMs()` still reports the
   * full budget — exactly what a busy event loop does to a real timer, whose
   * schedule is based on libuv's cached (stale) loop time. An implementation that
   * asks "is the budget gone NOW?" answers "no" and reports `unreachable`, i.e. it
   * asserts that Prometheus is down when only the page's own budget expired.
   */
  it('attributes a deadline-bounded abort to the deadline even when the clock still shows budget left', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError')),
          );
        }),
    );

    // A clock that never advances: `remainingMs()` is 20 for the whole call, so
    // nothing about the outcome may be derived from it.
    const deadline = startPageDeadline(20, () => 0);
    expect(deadline.remainingMs()).toBe(20);

    const r = await queryInstant('up', { deadline });

    expect(r.status).toBe('deadline-exceeded');
    if (r.status === 'deadline-exceeded') {
      expect(r.budgetMs).toBe(20);
    }
    // Still true after the fact — proving the verdict did NOT come from the clock.
    expect(deadline.remainingMs()).toBe(20);
  });

  it('leaves attribution to the per-call budget when the deadline is NOT the binding bound', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError')),
          );
        }),
    );

    // 20 ms per-call budget under a 4 s page budget: the CALL is what ran out, so
    // the honest answer is about Prometheus, not about the page's deadline.
    const r = await queryInstant('up', {
      timeoutMs: 20,
      deadline: startPageDeadline(4000, () => 0),
    });

    expect(r.status).toBe('unreachable');
  });

  it('still reports an abort that is not the deadline as unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new DOMException('The operation was aborted', 'AbortError'),
    );
    let now = 0;
    const deadline = startPageDeadline(4000, () => now);
    now = 100; // plenty of budget left — this abort came from somewhere else.

    const r = await queryInstant('up', { deadline });

    expect(r.status).toBe('unreachable');
  });

  it('changes nothing for callers that pass no deadline (the other pages)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ status: 'success', data: { resultType: 'vector', result: [] } }),
    );
    const r = await queryInstant('up');
    expect(r.status).toBe('ok');
  });
});

/**
 * The RESERVED slice (#534).
 *
 * One shared budget makes the page's total a bound, but it also makes the LAST
 * read the one that pays for everything before it — on the Deployments page that
 * is the app-agnostic kube-state probe, i.e. precisely the read that turns
 * "empty" into a diagnosis. A reserve carves a slice out of the ceiling that only
 * a reserved view may spend, so an unrelated slow backend cannot eat it.
 *
 * The reserve must be part of a documented ceiling, never an extra budget bolted
 * on after the fact: `totalMs` is the CEILING (ordinary share + reserve), and the
 * reserved view runs out at that ceiling too.
 */
describe('startPageDeadline — a reserved slice the ordinary reads cannot spend', () => {
  it('reports the ceiling (share + reserve) as the total, and no reserve by default', () => {
    expect(startPageDeadline(4000, () => 0, 500).totalMs).toBe(4500);
    // Unchanged for every caller that asks for no reserve — the other two pages.
    expect(startPageDeadline(4000, () => 0).totalMs).toBe(4000);
    expect(startPageDeadline().totalMs).toBe(PAGE_DEADLINE_MS);
  });

  it('never lets an ordinary read see the reserve, however early it runs', () => {
    let now = 0;
    const deadline = startPageDeadline(4000, () => now, 500);

    expect(deadline.remainingMs()).toBe(4000);
    now = 3900;
    expect(deadline.remainingMs()).toBe(100);
    now = 4000;
    expect(deadline.remainingMs()).toBe(0);
  });

  it('keeps the reserved slice available after the ordinary share is gone', () => {
    let now = 0;
    const deadline = startPageDeadline(4000, () => now, 500);
    const reserved = deadline.reserved();

    now = 4000;
    expect(deadline.remainingMs()).toBe(0);
    expect(reserved.remainingMs()).toBe(500);
    // Same clock, not a second budget: it drains with the page, not from zero.
    now = 4200;
    expect(reserved.remainingMs()).toBe(300);
  });

  it('bounds the reserved view at the ceiling — a reserve is not an extra budget', () => {
    let now = 0;
    const deadline = startPageDeadline(4000, () => now, 500);
    const reserved = deadline.reserved();

    // Read EARLY it is still only the ceiling, never share + reserve on top of
    // whatever is left, and never more than the total.
    expect(reserved.remainingMs()).toBe(4500);
    expect(reserved.remainingMs()).toBeLessThanOrEqual(reserved.totalMs);
    now = 4500;
    expect(reserved.remainingMs()).toBe(0);
    now = 9999;
    expect(reserved.remainingMs()).toBe(0);
    // The reserved view is itself reserved — `reserved().reserved()` cannot
    // compound into a third slice.
    expect(reserved.reserved().remainingMs()).toBe(0);
  });

  it('lets a reserved query run when the ordinary share is spent, and reports the ceiling when even the reserve is gone', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonResponse({ status: 'success', data: { resultType: 'vector', result: [] } }),
      );
    let now = 0;
    const deadline = startPageDeadline(4000, () => now, 500);
    now = 4000; // the ordinary wave spent its whole share

    // An ordinary read is refused…
    expect((await queryInstant('up', { deadline })).status).toBe('deadline-exceeded');
    expect(fetchSpy).not.toHaveBeenCalled();

    // …while the reserved read still happens: this is the diagnosis the reserve exists for.
    expect((await queryInstant('up', { deadline: deadline.reserved() })).status).toBe('ok');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // And once the CEILING is reached the reserved read stops too, reporting the
    // ceiling as the budget that applied (never the ordinary share alone).
    now = 4500;
    const r = await queryInstant('up', { deadline: deadline.reserved() });
    expect(r.status).toBe('deadline-exceeded');
    if (r.status === 'deadline-exceeded') {
      expect(r.budgetMs).toBe(4500);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
