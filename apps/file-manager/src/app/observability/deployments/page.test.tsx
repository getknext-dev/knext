import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextAppReadResult, NextAppStatusView } from '../_k8s/nextapp';
import {
  APP_NAME_ENV,
  APP_NAMESPACE_ENV,
  deploymentQueries,
  PROMETHEUS_URL_ENV,
} from '../_prom/query';

/**
 * P1.4 (obs-pages plan) / ADR-0038 — the /observability/deployments page.
 *
 * The page resolves the plan §7 data-path fork as **(c) both, degrading**: the
 * high-fidelity `NextApp` status read is OPT-IN (no RBAC by default), and the
 * always-available Prometheus/kube-state-metrics derivation is the fallback. So
 * the tests must pin, as DISTINCT and discriminating strings:
 *   1. unauthenticated / unconfigured-token ⇒ denied, no data, no I/O,
 *   2. no source configured at all         ⇒ "no deployment history source is configured",
 *   3. Prometheus unreachable              ⇒ "could not reach the observability backend",
 *   4. NextApp source unavailable          ⇒ "NextApp status source unavailable" + a
 *      per-reason line (CRD absent / RBAC denied / not in cluster),
 *   5. NextApp source simply not enabled   ⇒ a DIFFERENT line (it is off, not broken),
 *   6. kube-state-metrics absent           ⇒ "requires kube-state-metrics", never an
 *      empty table implying "no deployments",
 *   7. scope unknown (KN_APP_NAME)         ⇒ no query at all.
 * Plus: the happy paths for both sources, the source attribution, force-dynamic,
 * and no token/URL/kubeconfig leaking into the HTML.
 */

const authHeader = vi.fn<() => string | null>(() => null);

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) => (name === 'authorization' ? authHeader() : null),
  }),
}));

const readNextAppStatus = vi.fn<() => Promise<NextAppReadResult>>(async () => ({
  status: 'disabled',
}));

vi.mock('../_k8s/nextapp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_k8s/nextapp')>();
  return { ...actual, readNextAppStatus: () => readNextAppStatus() };
});

const ORIGINAL_TOKEN = process.env.OBSERVABILITY_TOKEN;
const ORIGINAL_URL = process.env[PROMETHEUS_URL_ENV];
const ORIGINAL_APP = process.env[APP_NAME_ENV];
const ORIGINAL_NS = process.env[APP_NAMESPACE_ENV];
const TOKEN = 's3cret-observability-token';
const APP = 'demo';

const NAMESPACE = 'demo-ns';

/** Deterministic creation timestamps (unix seconds) for the seeded revisions. */
const CREATED_00002 = Date.UTC(2026, 6, 20, 9, 0, 0) / 1000;
const CREATED_00003 = Date.UTC(2026, 6, 24, 15, 30, 0) / 1000;
/** NEWER than this app's newest — a loose selector would call these "current". */
const CREATED_SIBLING = Date.UTC(2026, 6, 25, 8, 0, 0) / 1000;
const CREATED_OTHER_NS = Date.UTC(2026, 6, 26, 8, 0, 0) / 1000;

/**
 * The cluster the fake Prometheus knows about. It contains the two traps the
 * PR-520 review found: a SIBLING app whose name starts with this app's name, and
 * a SAME-NAMED app in another namespace — both with newer revisions, so a loose
 * selector does not merely add a row, it renames "current".
 */
const UNIVERSE = [
  { ns: NAMESPACE, dep: 'demo-00002-deployment', created: CREATED_00002, replicas: 0 },
  { ns: NAMESPACE, dep: 'demo-00003-deployment', created: CREATED_00003, replicas: 2 },
  { ns: NAMESPACE, dep: 'demo-api-00007-deployment', created: CREATED_SIBLING, replicas: 5 },
  { ns: 'other-ns', dep: 'demo-00009-deployment', created: CREATED_OTHER_NS, replicas: 9 },
] as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function vector(...samples: ReadonlyArray<{ metric: Record<string, string>; value: string }>) {
  return {
    status: 'success',
    data: {
      resultType: 'vector',
      result: samples.map((s) => ({ metric: s.metric, value: [0, s.value] })),
    },
  };
}

const EMPTY_VECTOR = { status: 'success', data: { resultType: 'vector', result: [] } };

interface SeedOptions {
  readonly kubeStateAbsent?: boolean;
  /** Restrict the fake cluster to this app's own namespace. */
  readonly singleNamespace?: boolean;
}

/**
 * A fake Prometheus that actually EVALUATES the selector rather than replaying a
 * fixed answer. Without this, a test could not tell an anchored selector from a
 * loose one — the seeded rows would come back either way, which is exactly how
 * the original scoping bug slipped through.
 *
 * Prometheus anchors `=~` matchers on both ends, so the regex is `^…$`.
 */
function evaluate(promql: string, opts: SeedOptions) {
  const deploymentMatch = /deployment=~"([^"]+)"/.exec(promql);
  const namespaceMatch = /namespace="([^"]+)"/.exec(promql);
  const pattern = new RegExp(`^${deploymentMatch?.[1] ?? '.*'}$`);
  const universe = opts.singleNamespace ? UNIVERSE.filter((s) => s.ns === NAMESPACE) : UNIVERSE;

  return universe.filter(
    (s) => pattern.test(s.dep) && (!namespaceMatch || s.ns === namespaceMatch[1]),
  );
}

function seededFetch(url: unknown, opts: SeedOptions = {}): Response {
  const promql = decodeURIComponent(new URL(String(url)).searchParams.get('query') ?? '');

  if (opts.kubeStateAbsent || !promql.includes('kube_deployment_')) {
    return jsonResponse(EMPTY_VECTOR);
  }

  const created = promql.includes('kube_deployment_created');
  return jsonResponse(
    vector(
      ...evaluate(promql, opts).map((s) => ({
        metric: { namespace: s.ns, deployment: s.dep },
        value: created ? String(s.created) : String(s.replicas),
      })),
    ),
  );
}

function mockFetch(opts: SeedOptions = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => seededFetch(u, opts));
}

function sentQueries(spy: ReturnType<typeof mockFetch>): string[] {
  return spy.mock.calls.map((call) => {
    const url = new URL(String(call[0]));
    return url.searchParams.get('query') ?? '';
  });
}

const OK_DATA: NextAppStatusView = {
  observedRevision: 'demo-00003',
  lastSuccessfulDeployTime: '2026-07-24T15:30:00Z',
  scaledToZero: false,
  image: 'registry.example.com/demo@sha256:abc',
  pinnedRevision: 'demo-00002',
  canaryPercent: 10,
  currentTraffic: [
    { revisionName: 'demo-00002', percent: 90, latestRevision: false },
    { revisionName: 'demo-00003', percent: 10, latestRevision: true },
  ],
  conditions: [
    {
      type: 'Ready',
      status: 'True',
      reason: 'ServiceReady',
      message: 'Knative Service is ready',
      lastTransitionTime: '2026-07-24T15:30:05Z',
    },
    {
      type: 'Progressing',
      status: 'False',
      reason: 'RolloutComplete',
      message: 'Rollout complete',
      lastTransitionTime: '2026-07-24T15:30:05Z',
    },
  ],
};

const OK_NEXTAPP: NextAppReadResult = { status: 'ok', data: OK_DATA };

beforeEach(() => {
  authHeader.mockReturnValue(`Bearer ${TOKEN}`);
  readNextAppStatus.mockResolvedValue({ status: 'disabled' });
  process.env.OBSERVABILITY_TOKEN = TOKEN;
  process.env[PROMETHEUS_URL_ENV] = 'http://prometheus.monitoring.svc:9090';
  process.env[APP_NAME_ENV] = APP;
  process.env[APP_NAMESPACE_ENV] = NAMESPACE;
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
  if (ORIGINAL_NS === undefined) delete process.env[APP_NAMESPACE_ENV];
  else process.env[APP_NAMESPACE_ENV] = ORIGINAL_NS;
});

async function renderPage(): Promise<string> {
  const mod = await import('./page');
  const el = await mod.default();
  return renderToStaticMarkup(el);
}

describe('deployments page route config', () => {
  it('is force-dynamic (never cached)', async () => {
    const mod = await import('./page');
    expect(mod.dynamic).toBe('force-dynamic');
  });
});

describe('deployments page auth gate (fail-closed)', () => {
  it('denies an unauthenticated request, leaks no data, and performs NO read at all', async () => {
    authHeader.mockReturnValue(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const html = await renderPage();

    expect(html).toMatch(/unauthorized|forbidden|denied/i);
    expect(html).not.toContain('demo-00003');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readNextAppStatus).not.toHaveBeenCalled();
  });

  it('denies when no token is configured, even with a Bearer header', async () => {
    delete process.env.OBSERVABILITY_TOKEN;
    authHeader.mockReturnValue('Bearer anything');
    const html = await renderPage();
    expect(html).toMatch(/unauthorized|forbidden|denied/i);
  });

  it('never renders the token, the Prometheus URL or a kubeconfig into the HTML', async () => {
    mockFetch();
    readNextAppStatus.mockResolvedValue(OK_NEXTAPP);
    const html = await renderPage();
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain('prometheus.monitoring.svc');
    expect(html).not.toMatch(/kubeconfig|serviceaccount\/token|BEGIN CERTIFICATE/i);
  });
});

describe('deployments page degradation — NOTHING configured', () => {
  it('says no source is configured (naming the env vars) and performs no query', async () => {
    delete process.env[PROMETHEUS_URL_ENV];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const html = await renderPage();

    expect(html).toContain('no deployment history source is configured');
    expect(html).toContain(PROMETHEUS_URL_ENV);
    expect(html).toContain('OBSERVABILITY_NEXTAPP_SOURCE');
    expect(fetchSpy).not.toHaveBeenCalled();
    // Never an empty table implying "this app has never been deployed".
    expect(html).not.toContain('<table');
  });

  it('still renders NextApp history when Prometheus is unset but the CR read works', async () => {
    delete process.env[PROMETHEUS_URL_ENV];
    readNextAppStatus.mockResolvedValue(OK_NEXTAPP);

    const html = await renderPage();

    expect(html).not.toContain('no deployment history source is configured');
    expect(html).toContain('demo-00003');
    // With Prometheus unset the derived section is not rendered at all, so its
    // provenance caveat must be absent too.
    expect(html).not.toContain('rollback state is not available from this source');
  });
});

describe('deployments page degradation — Prometheus unreachable', () => {
  it('renders the unreachable state (distinct from unconfigured) without crashing', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));

    const html = await renderPage();

    expect(html).toContain('could not reach the observability backend');
    expect(html).not.toContain('no deployment history source is configured');
    expect(html).not.toContain('requires kube-state-metrics');
  });
});

describe('deployments page degradation — kube-state-metrics absent', () => {
  it('says the derived history REQUIRES kube-state-metrics instead of an empty table', async () => {
    mockFetch({ kubeStateAbsent: true });

    const html = await renderPage();

    expect(html).toContain('requires kube-state-metrics');
    // Distinct from both other Prometheus-side states.
    expect(html).not.toContain('could not reach the observability backend');
    expect(html).not.toContain('no deployment history source is configured');
    // And NO revision table is drawn — an empty one would read "no deployments".
    expect(html).not.toContain('<table');
  });

  it('does NOT claim kube-state-metrics is missing when the series is present', async () => {
    mockFetch();
    const html = await renderPage();
    expect(html).not.toContain('requires kube-state-metrics');
  });
});

describe('deployments page degradation — NextApp source states are distinct', () => {
  it('reports "not enabled" (off, not broken) when the opt-in read is disabled', async () => {
    mockFetch();
    readNextAppStatus.mockResolvedValue({ status: 'disabled' });

    const html = await renderPage();

    expect(html).toContain('NextApp status reads are not enabled');
    expect(html).not.toContain('NextApp status source unavailable');
  });

  it('reports the CRD-absent reason distinctly (not "denied", not "not enabled")', async () => {
    mockFetch();
    readNextAppStatus.mockResolvedValue({
      status: 'source-unavailable',
      reason: 'crd-absent',
      detail: 'HTTP 404',
    });

    const html = await renderPage();

    expect(html).toContain('NextApp status source unavailable');
    expect(html).toContain('the NextApp CRD is not installed');
    expect(html).not.toContain('read access to NextApp is denied');
    expect(html).not.toContain('NextApp status reads are not enabled');
    // The lower-fidelity source still renders — the page is not dead.
    expect(html).toContain('demo-00003-deployment');
  });

  it('reports the RBAC-denied reason distinctly', async () => {
    mockFetch();
    readNextAppStatus.mockResolvedValue({
      status: 'source-unavailable',
      reason: 'forbidden',
      detail: 'HTTP 403',
    });

    const html = await renderPage();

    expect(html).toContain('read access to NextApp is denied');
    expect(html).not.toContain('the NextApp CRD is not installed');
  });

  it('reports the not-in-cluster reason distinctly', async () => {
    mockFetch();
    readNextAppStatus.mockResolvedValue({
      status: 'source-unavailable',
      reason: 'not-in-cluster',
      detail: 'no ServiceAccount token',
    });

    const html = await renderPage();

    expect(html).toContain('no in-cluster ServiceAccount');
    expect(html).not.toContain('read access to NextApp is denied');
  });

  it('renders an honest state when BOTH sources are gone (never a blank page)', async () => {
    delete process.env[PROMETHEUS_URL_ENV];
    readNextAppStatus.mockResolvedValue({
      status: 'source-unavailable',
      reason: 'forbidden',
      detail: 'HTTP 403',
    });

    const html = await renderPage();

    expect(html).toContain('read access to NextApp is denied');
    expect(html).toContain('no deployment history source is configured');
    expect(html).not.toContain('<table');
  });
});

describe('deployments page — Prometheus-derived history (fallback source)', () => {
  it('renders one row per revision with its deploy time, replicas and current/previous state', async () => {
    const spy = mockFetch();

    const html = await renderPage();

    expect(html).toContain('demo-00003-deployment');
    expect(html).toContain('demo-00002-deployment');
    expect(html).toContain('2026-07-24'); // newest revision's creation date
    expect(html).toContain('2026-07-20'); // previous revision's creation date
    expect(html).toContain('>current<');
    expect(html).toContain('>previous<');
    // Newest first.
    expect(html.indexOf('demo-00003-deployment')).toBeLessThan(
      html.indexOf('demo-00002-deployment'),
    );
    // Attribution: the reader must know WHICH source produced this.
    expect(html).toContain('Prometheus (kube-state-metrics)');
    // Honest about the fidelity this source cannot give.
    expect(html).toContain('rollback state is not available from this source');

    const queries = sentQueries(spy);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.filter((q) => !q.includes(APP))).toEqual([]);
    expect(queries).toContain(deploymentQueries(APP, NAMESPACE).revisionCreated);
  });

  it('EXCLUDES a sibling app whose name starts with this app’s name', async () => {
    // `demo-api-00007-deployment` is newer than every `demo` revision, so a
    // loose `demo.*` selector would not just add a row — it would label another
    // workload's deploy as THIS app's "current" revision.
    mockFetch();
    const html = await renderPage();

    expect(html).not.toContain('demo-api');
    expect(html).toContain('demo-00003-deployment');
    // …and the row still called "current" is this app's own newest revision.
    const currentRow =
      /<tr><td[^>]*>([^<]*)<\/td>(?:<td[^>]*>[^<]*<\/td>){4}<td[^>]*>current</.exec(html);
    expect(currentRow?.[1]).toBe('demo-00003-deployment');
  });

  it('EXCLUDES a same-named app in another namespace when the namespace is known', async () => {
    mockFetch();
    const html = await renderPage();

    expect(html).not.toContain('demo-00009-deployment');
    expect(html).not.toContain('other-ns');
    // Every rendered row belongs to this app's namespace.
    expect(html).toContain(`>${NAMESPACE}<`);
  });
});

describe('deployments page — namespace ambiguity is refused, not guessed', () => {
  it('renders a DISTINCT ambiguous state when two namespaces match and KN_APP_NAMESPACE is unset', async () => {
    delete process.env[APP_NAMESPACE_ENV];
    mockFetch();

    const html = await renderPage();

    expect(html).toContain('namespace scope for this app is ambiguous');
    expect(html).toContain(APP_NAMESPACE_ENV);
    // No table at all: with two candidate namespaces, calling the newest one
    // "current" would be the lying panel this page refuses to be.
    expect(html).not.toContain('<table');
    expect(html).not.toContain('>current<');
    // Distinct from every other honest state.
    expect(html).not.toContain('requires kube-state-metrics');
    expect(html).not.toContain('could not reach the observability backend');
  });

  it('still renders (with an explicit caveat) when only ONE namespace matches', async () => {
    delete process.env[APP_NAMESPACE_ENV];
    mockFetch({ singleNamespace: true });

    const html = await renderPage();

    expect(html).not.toContain('namespace scope for this app is ambiguous');
    expect(html).toContain('demo-00003-deployment');
    expect(html).toContain('not namespace-pinned');
  });

  it('does not warn about pinning when the namespace IS pinned', async () => {
    mockFetch();
    const html = await renderPage();
    expect(html).not.toContain('not namespace-pinned');
  });
});

describe('deployments page — NextApp status history (high-fidelity source)', () => {
  it('renders the live revision, last deploy time, image, conditions and rollback pin', async () => {
    mockFetch();
    readNextAppStatus.mockResolvedValue(OK_NEXTAPP);

    const html = await renderPage();

    expect(html).toContain('NextApp status (Kubernetes API)');
    expect(html).toContain('demo-00003');
    expect(html).toContain('2026-07-24T15:30:00Z');
    expect(html).toContain('sha256:abc');
    expect(html).toContain('Ready');
    expect(html).toContain('RolloutComplete');
    // Rollback fidelity: the pinned revision + canary split.
    expect(html).toContain('pinned to demo-00002');
    expect(html).toContain('>90<');
    // The pin comes from the CR — the derived table cannot know it, which is
    // why the derived section carries its own "not available" caveat (asserted
    // in the derived-source test).
  });

  it('says traffic is NOT pinned when no rollback pin is set', async () => {
    mockFetch();
    readNextAppStatus.mockResolvedValue({
      status: 'ok',
      data: { ...OK_DATA, pinnedRevision: undefined, canaryPercent: undefined },
    });

    const html = await renderPage();

    expect(html).not.toContain('pinned to demo-00002');
    expect(html).toContain('not pinned');
  });

  it('adds no mutating control (read-only page, ADR-0001)', async () => {
    mockFetch();
    readNextAppStatus.mockResolvedValue(OK_NEXTAPP);
    const html = await renderPage();
    expect(html).not.toMatch(/<form|<button/i);
  });
});

describe('deployments page — scope is required before any query (#516 contract)', () => {
  it('renders "scope unknown" and issues NO query when KN_APP_NAME is unset', async () => {
    delete process.env[APP_NAME_ENV];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const html = await renderPage();

    expect(html).toContain(APP_NAME_ENV);
    expect(html).toMatch(/scope|identity/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readNextAppStatus).not.toHaveBeenCalled();
  });

  it('treats an injection-shaped KN_APP_NAME as unknown scope', async () => {
    process.env[APP_NAME_ENV] = 'demo"} or on() up{';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const html = await renderPage();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(html).not.toContain('or on()');
  });
});

describe('deployments page — Grafana link row (consistent with the other pages)', () => {
  it('links out to a shipped dashboard, statically (no iframe)', async () => {
    mockFetch();
    const html = await renderPage();
    expect(html.toLowerCase()).toContain('grafana');
    expect(html).not.toContain('<iframe');
  });
});
