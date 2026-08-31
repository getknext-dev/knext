import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NextAppReadResult, NextAppStatusView } from '../_k8s/nextapp';
import {
  APP_NAME_ENV,
  APP_NAMESPACE_ENV,
  deploymentQueries,
  KUBE_STATE_PROBE,
  KUBE_STATE_PROBE_RESERVE_MS,
  PAGE_DEADLINE_MS,
  PAGE_TOTAL_BUDGET_MS,
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

const readNextAppStatus = mock<() => Promise<NextAppReadResult>>(async () => ({
  status: 'disabled',
}));

const __knextReal1 = { ...(await import('../_k8s/nextapp')) };
mock.module('../_k8s/nextapp', () => {
  const actual = __knextReal1;
  return { ...actual, readNextAppStatus: () => readNextAppStatus() };
});

/**
 * Virtual clock for the page-level deadline.
 *
 * The deadline logic itself is NOT mocked — only its clock is injected, so the
 * real `startPageDeadline` / remaining-budget / "don't even fetch" code runs. A
 * test advances `clock.now` from inside the fake Prometheus to say "that call
 * consumed N ms of the shared budget", which makes budget exhaustion
 * deterministic without sleeping for seconds.
 */
const clock = { now: 0 };

/**
 * The budget the page's deadline is actually created with. `undefined` = whatever
 * the page asks for (PAGE_DEADLINE_MS). Overriding it is how the "the page reports
 * the budget that APPLIED, not the constant" test distinguishes the two — they are
 * the same number by default, which is exactly why the constant could drift
 * unnoticed (PR-520 review finding 4).
 */
const budget: { totalMs?: number } = {};

const __knextReal2 = { ...(await import('../_prom/query')) };
mock.module('../_prom/query', () => {
  const actual = __knextReal2;
  return {
    ...actual,
    // Only the CLOCK is injected — the requested budget AND the reserved slice
    // are forwarded untouched, so a page that stopped asking for the reserve
    // fails these tests instead of being silently given one by the mock.
    startPageDeadline: (totalMs?: number, _now?: () => number, reserveMs?: number) =>
      actual.startPageDeadline(budget.totalMs ?? totalMs, () => clock.now, reserveMs),
  };
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
  return spyOn(globalThis, 'fetch').mockImplementation(async (u) => seededFetch(u, opts));
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
  clock.now = 0;
  delete budget.totalMs;
  authHeader.mockReturnValue(`Bearer ${TOKEN}`);
  readNextAppStatus.mockResolvedValue({ status: 'disabled' });
  process.env.OBSERVABILITY_TOKEN = TOKEN;
  process.env[PROMETHEUS_URL_ENV] = 'http://prometheus.monitoring.svc:9090';
  process.env[APP_NAME_ENV] = APP;
  process.env[APP_NAMESPACE_ENV] = NAMESPACE;
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
  if (ORIGINAL_NS === undefined) delete process.env[APP_NAMESPACE_ENV];
  else process.env[APP_NAMESPACE_ENV] = ORIGINAL_NS;
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

describe('deployments page route config', () => {
  it('is force-dynamic (never cached)', async () => {
    const mod = await import('./page');
    expect(mod.dynamic).toBe('force-dynamic');
  });
});

describe('deployments page auth gate (fail-closed)', () => {
  it('denies with a real 401, leaks no data, and performs NO read at all', async () => {
    authHeader.mockReturnValue(null);
    const fetchSpy = spyOn(globalThis, 'fetch');

    expect(await denialDigest()).toBe(UNAUTHORIZED_DIGEST);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readNextAppStatus).not.toHaveBeenCalled();
  });

  it('denies with a real 401 when no token is configured, even with a Bearer header', async () => {
    delete process.env.OBSERVABILITY_TOKEN;
    authHeader.mockReturnValue('Bearer anything');
    expect(await denialDigest()).toBe(UNAUTHORIZED_DIGEST);
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
    const fetchSpy = spyOn(globalThis, 'fetch');

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
    spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));

    const html = await renderPage();

    expect(html).toContain('could not reach the observability backend');
    expect(html).not.toContain('no deployment history source is configured');
    expect(html).not.toContain('requires kube-state-metrics');
  });
});

describe('deployments page degradation — ASYMMETRIC partial Prometheus failure', () => {
  /**
   * The timeline is a JOIN of three independent queries, so they can fail
   * independently: `kube_deployment_created` answers while the two replica
   * queries do not. Rendering the rows anyway would produce a table that looks
   * complete (every revision, "current" and all) with silently null replica
   * columns — a half-truth is the one thing this page must never draw. So a
   * partial failure suppresses the WHOLE timeline and says "could not reach".
   */
  it('suppresses the whole timeline when only the replica queries fail', async () => {
    const spy = spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      const promql = decodeURIComponent(new URL(String(u)).searchParams.get('query') ?? '');
      if (promql.includes('kube_deployment_status_replicas')) {
        throw new Error('connect ECONNREFUSED');
      }
      return seededFetch(u);
    });

    const html = await renderPage();

    // The created-timestamps query DID succeed — proving the failure is partial,
    // not total, so this is not just the all-queries-failed path again.
    expect(sentQueries(spy)).toContain(deploymentQueries(APP, NAMESPACE).revisionCreated);

    expect(html).toContain('could not reach the observability backend');
    // NOT a half-populated history: no rows, no table, nothing called "current".
    expect(html).not.toContain('demo-00003-deployment');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('>current<');
    // …and no other cause is claimed.
    expect(html).not.toContain('requires kube-state-metrics');
    expect(html).not.toContain('no Deployment for this app is known');
    expect(html).not.toContain('ran out of its time budget');
  });
});

describe('deployments page — the page-level deadline is honest when exhausted', () => {
  /**
   * The page makes one CONCURRENT wave of queries and then, only on the degraded
   * path, a sequential probe — each with its own ~4 s abort budget, so the total
   * used to be able to reach ~8 s. One shared deadline bounds the total instead;
   * exhausting it must render its OWN state, never a cause the page never
   * established ("kube-state-metrics is absent") and never a zero.
   */
  it('renders a distinct deadline state and issues NO probe once the budget is gone', async () => {
    const spy = spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      // The wave consumes the whole page CEILING between them — 1500 ms each,
      // i.e. the 4000 ms ordinary share AND the 500 ms probe reserve (#534)…
      clock.now += PAGE_DEADLINE_MS / 2 - 500;
      // …and answers with an empty scoped result, which is exactly the path that
      // would otherwise spend a SECOND full timeout on the presence probe.
      return seededFetch(u, { kubeStateAbsent: true });
    });

    const html = await renderPage();

    expect(html).toContain('ran out of its time budget');
    // The probe never ran, so its cause claims must not appear…
    expect(html).not.toContain('requires kube-state-metrics');
    expect(html).not.toContain('no Deployment for this app is known');
    // …nor may a timeout be reported as an unreachable backend.
    expect(html).not.toContain('could not reach the observability backend');
    // …nor a zero-row table implying "never deployed".
    expect(html).not.toContain('<table');

    // The bound is the point: the probe was not even attempted.
    expect(sentQueries(spy)).not.toContain(KUBE_STATE_PROBE);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('reports a probe that itself ran out of budget as the deadline, not as unreachable', async () => {
    spyOn(globalThis, 'fetch').mockImplementation((u, init) => {
      const promql = decodeURIComponent(new URL(String(u)).searchParams.get('query') ?? '');
      if (promql === KUBE_STATE_PROBE) {
        // The probe was issued with the ~100 ms the wave left, and then HANGS: the
        // only thing that can end it is the shared budget's own abort signal.
        // Aborting through the signal (rather than throwing an `AbortError`
        // outright) is what a hung backend actually does, and it is what makes the
        // attribution provable: the verdict comes from the page's own timeout
        // having fired, not from re-reading a clock (PR-520 review finding 1).
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError')),
          );
        });
      }
      // The concurrent wave spends all but ~100 ms of the shared budget.
      clock.now += PAGE_DEADLINE_MS / 3 - 33;
      return Promise.resolve(seededFetch(u, { kubeStateAbsent: true }));
    });

    const html = await renderPage();

    expect(html).toContain('ran out of its time budget');
    expect(html).not.toContain('requires kube-state-metrics');
    expect(html).not.toContain('could not reach the observability backend');
  });

  it('says nothing about a deadline on the happy path', async () => {
    mockFetch();
    const html = await renderPage();
    expect(html).not.toContain('ran out of its time budget');
    expect(html).toContain('demo-00003-deployment');
  });

  /**
   * The number in that message must be the budget that ACTUALLY applied — the one
   * the query result carries — not the {@link PAGE_DEADLINE_MS} constant re-read at
   * render time (PR-520 review finding 4). Here the render runs under a 1500 ms
   * budget, so printing the 4000 ms constant would state a bound that was never
   * enforced.
   */
  it('reports the budget that actually applied, not the module constant', async () => {
    budget.totalMs = 1500;
    spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      // 3 × 700 ms = 2100 ms — past the 1500 + reserve ceiling, so even the
      // reserved probe is refused and the budget state is the honest answer.
      clock.now += 700;
      return seededFetch(u, { kubeStateAbsent: true });
    });

    const html = await renderPage();

    expect(html).toContain('ran out of its time budget');
    // The CEILING that applied to this render (share + reserve), derived here
    // rather than read from the module — the constants are what could drift.
    expect(html).toContain(`${1500 + KUBE_STATE_PROBE_RESERVE_MS}`);
    expect(html).not.toContain(`${PAGE_DEADLINE_MS}`);
    expect(html).not.toContain(`${PAGE_TOTAL_BUDGET_MS}`);
  });

  /**
   * The number rendered must be the bound that was ENFORCED on the read that ran
   * out, not the page ceiling (the #520 round-4 rule, re-checked for the reserve).
   * A wave query is cut at the SHARE and could never have spent the reserve, so
   * printing the ceiling would state a bound 500 ms larger than the one applied —
   * the existing "budget that actually applied" test does not cover this path,
   * because there all three queries answer `ok` and the number comes from the
   * probe, whose bound genuinely IS the ceiling.
   */
  it('prints the SHARE, not the ceiling, when an ordinary wave read is the one cut short', async () => {
    budget.totalMs = 37; // distinctive: 37 is the share, 537 would be the ceiling
    spyOn(globalThis, 'fetch').mockImplementation(
      (_u, init) =>
        // Hangs until the wave's own budget aborts it ⇒ deadline-exceeded.
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError')),
          );
        }),
    );

    const html = await renderPage();

    expect(html).toContain('ran out of its time budget');
    expect(html).toContain('37');
    // The ceiling was NOT the bound on these reads, so it must not be printed as
    // though it were.
    expect(html).not.toContain('537');
  });

  /**
   * A MIXED wave: one query establishes `unreachable`, the others never ran
   * (`deadline-exceeded`). The established fact is deliberately NOT surfaced —
   * a timeout suppresses cause claims, because the page cannot tell whether the
   * rest of the history would have contradicted the one failure it saw. That
   * suppression is intended, and nothing pinned it until now (#534), so it could
   * have silently inverted into reporting a cause the page did not establish for
   * the render as a whole.
   */
  it('suppresses an established "unreachable" when the same wave also ran out of budget', async () => {
    budget.totalMs = 30;
    const spy = spyOn(globalThis, 'fetch').mockImplementation((u, init) => {
      const promql = decodeURIComponent(new URL(String(u)).searchParams.get('query') ?? '');
      if (promql.includes('kube_deployment_created')) {
        // Hangs until the SHARED budget's own signal aborts it ⇒ deadline-exceeded.
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError')),
          );
        });
      }
      // The other two ESTABLISH that Prometheus is unreachable ⇒ unreachable.
      return Promise.reject(new Error('connect ECONNREFUSED'));
    });

    const html = await renderPage();

    // All three ran — this is a genuinely MIXED wave, not all-unreachable.
    expect(spy).toHaveBeenCalledTimes(3);
    expect(html).toContain('ran out of its time budget');
    expect(html).not.toContain('could not reach the observability backend');
    expect(html).not.toContain('requires kube-state-metrics');
    expect(html).not.toContain('no Deployment for this app is known');
    expect(html).not.toContain('<table');
  });

  /**
   * Suppressing the cause CLAIM is right; asserting its opposite is not (PR-636
   * review finding 3). In the mixed wave above two of three reads came back
   * `ECONNREFUSED`, so a banner reading "the observability backend is slow rather
   * than absent" would guarantee that a real outage is described as slowness — the
   * page inventing a cause in the other direction. The page still refuses to name
   * the cause; it just stops ruling one out that it has evidence for.
   */
  it('does not claim "slow rather than absent" when a read in the same wave DID fail outright', async () => {
    budget.totalMs = 30;
    spyOn(globalThis, 'fetch').mockImplementation((u, init) => {
      const promql = decodeURIComponent(new URL(String(u)).searchParams.get('query') ?? '');
      if (promql.includes('kube_deployment_created')) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError')),
          );
        });
      }
      return Promise.reject(new Error('connect ECONNREFUSED'));
    });

    const html = await renderPage();

    expect(html).toContain('ran out of its time budget');
    // The opposite-of-the-evidence sentence is gone…
    expect(html).not.toContain('slow rather than absent');
    // …replaced by one that reports the observation without promoting it to the
    // render's cause.
    expect(html).toContain('failed outright');
    // …and it is still NOT the unreachable state: no cause claim is made.
    expect(html).not.toContain('could not reach the observability backend');
  });

  /**
   * The CR read is the gap the first cut of this flag left (PR-636 round-2 review)
   * — and it is the read this whole issue names as the realistic trigger. With the
   * opt-in Kubernetes read erroring outright, the page rendered
   * "the Kubernetes API could not be reached" in one paragraph and
   * "none of them errored … slow rather than absent" in the next: two adjacent
   * assertions of opposite things in a single render.
   */
  it('counts the OPT-IN CR read as a read that failed outright', async () => {
    budget.totalMs = 30;
    readNextAppStatus.mockResolvedValue({
      status: 'source-unavailable',
      reason: 'unreachable',
      detail: 'connect ECONNREFUSED',
    });
    spyOn(globalThis, 'fetch').mockImplementation(
      (_u, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError')),
          );
        }),
    );

    const html = await renderPage();

    // The render DID time out, and it DOES say the API server could not be reached…
    expect(html).toContain('ran out of its time budget');
    expect(html).toContain('the Kubernetes API could not be reached');
    // …so the very next paragraph must not claim the opposite.
    expect(html).not.toContain('none of them errored');
    expect(html).not.toContain('slow rather than absent');
    expect(html).toContain('failed outright');
  });

  /**
   * The exclusions are the point, so they are pinned too: these CR-read reasons
   * are ANSWERS or non-reads, not errors, and must not be laundered into "a read
   * failed outright" — that would be the same invented-cause mistake in yet
   * another direction. `crd-absent`/`forbidden` are authoritative answers;
   * `not-in-cluster`/`invalid-name` mean no request was made; `deadline-exceeded`
   * is the cut-short case the banner is already about.
   */
  it.each([
    'crd-absent',
    'forbidden',
    'not-in-cluster',
    'invalid-name',
    'deadline-exceeded',
  ])('does NOT count a CR read that answered or never ran (%s) as an outright failure', async (reason) => {
    readNextAppStatus.mockResolvedValue({
      status: 'source-unavailable',
      reason: reason as 'crd-absent',
      detail: 'detail',
    });
    spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      clock.now += PAGE_TOTAL_BUDGET_MS / 3;
      return seededFetch(u, { kubeStateAbsent: true });
    });

    const html = await renderPage();

    expect(html).toContain('ran out of its time budget');
    expect(html).not.toContain('failed outright');
    expect(html).toContain('slow rather than absent');
  });

  it('keeps the "slow rather than absent" reading when NO read failed outright', async () => {
    spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      clock.now += PAGE_TOTAL_BUDGET_MS / 3;
      return seededFetch(u, { kubeStateAbsent: true });
    });

    const html = await renderPage();

    expect(html).toContain('ran out of its time budget');
    expect(html).toContain('slow rather than absent');
    expect(html).not.toContain('failed outright');
  });
});

/**
 * #534 — the reserved slice for the kube-state probe.
 *
 * The probe is the read that turns "zero series" into a diagnosis, and it is last
 * in line for the shared budget. The realistic trigger is NOT a slow Prometheus
 * (an empty scoped query answers fast) — it is the OPT-IN Kubernetes read
 * consuming the budget inside the same wave. A slow, opt-in backend must not cost
 * the reader the diagnosis of a different, default one that answered promptly.
 */
describe('deployments page — the kube-state probe has a reserved slice (#534)', () => {
  /**
   * Prometheus answers all three scoped queries at t=0 (promptly, zero series);
   * only THEN does the hung `NextApp` read give up, having spent the whole
   * ordinary share. Gating the CR read on the last scoped answer is what makes
   * the ordering deterministic rather than a microtask-scheduling accident.
   */
  function hungNextAppReadAfterPromptProm(opts: SeedOptions = {}) {
    let released: () => void = () => {};
    const crRead = new Promise<void>((resolve) => {
      released = resolve;
    });
    let answered = 0;

    const spy = spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      const promql = decodeURIComponent(new URL(String(u)).searchParams.get('query') ?? '');
      const response = seededFetch(u, opts);
      if (promql !== KUBE_STATE_PROBE && ++answered === 3) {
        // The scoped wave is done and cost ~nothing; the hung CR read then burns
        // the ENTIRE ordinary share before failing.
        clock.now += PAGE_DEADLINE_MS;
        released();
      }
      return response;
    });

    readNextAppStatus.mockImplementation(async () => {
      await crRead;
      return {
        status: 'source-unavailable',
        reason: 'deadline-exceeded',
        detail: 'the page ran out of its shared time budget before this read could start',
      };
    });

    return spy;
  }

  it('still reaches the kube-state-absent diagnosis when a hung CR read spent the whole share', async () => {
    const spy = hungNextAppReadAfterPromptProm({ kubeStateAbsent: true });

    const html = await renderPage();

    // The probe RAN — on the reserve, with the ordinary share already at zero.
    expect(sentQueries(spy).filter((q) => q === KUBE_STATE_PROBE)).toHaveLength(1);
    // …so the reader gets the answer the page went and asked for…
    expect(html).toContain('requires kube-state-metrics');
    // …instead of a budget banner that knows nothing.
    expect(html).not.toContain('ran out of its time budget');
    expect(html).not.toContain('could not reach the observability backend');
  });

  it('still reaches the no-Deployment-matches diagnosis in the same conditions', async () => {
    process.env[APP_NAME_ENV] = 'ghost';
    const spy = hungNextAppReadAfterPromptProm();

    const html = await renderPage();

    expect(sentQueries(spy).filter((q) => q === KUBE_STATE_PROBE)).toHaveLength(1);
    expect(html).toContain('no Deployment for this app is known');
    expect(html).not.toContain('ran out of its time budget');
    expect(html).not.toContain('requires kube-state-metrics');
  });

  /**
   * The reserve is a slice of a documented CEILING, not an extra budget bolted on:
   * a wave that runs past the ordinary share into the reserve leaves the probe
   * nothing, and the page falls back to the honest budget state.
   */
  it('does not hand out a reserve the ceiling has already spent', async () => {
    const spy = spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      clock.now += PAGE_TOTAL_BUDGET_MS / 3;
      return seededFetch(u, { kubeStateAbsent: true });
    });

    const html = await renderPage();

    expect(sentQueries(spy)).not.toContain(KUBE_STATE_PROBE);
    expect(html).toContain('ran out of its time budget');
    expect(html).not.toContain('requires kube-state-metrics');
  });

  /**
   * SCANNED, not enumerated (#534, hardened by the PR-636 review).
   *
   * Two halves, and the second is the one that matters. The POSITIVE half — every
   * query carries the shared budget — keeps the total bounded. The NEGATIVE half —
   * NOTHING but the probe may take the reserved view — is what makes the reserve
   * mean anything: the first cut asserted only the positive half, and two
   * mutations stayed green under it, one of them (`readNextAppStatus(app, {
   * timeoutMs: deadline.reserved().remainingMs() })`) silently reinstating #534 in
   * its original form, since a hung CR read would then spend the whole ceiling and
   * leave the probe nothing.
   *
   * So the negative half scans the WHOLE (comment-stripped) source, not the query
   * call sites: the CR read is not a `queryInstant` at all, which is exactly why it
   * slipped through a query-shaped scan.
   */
  const PAGE_SOURCE = resolve(import.meta.dirname, 'page.tsx');

  /** Source with comments removed — a doc comment must not satisfy a guard. */
  function pageSource(): string {
    return readFileSync(PAGE_SOURCE, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
  }

  /**
   * Every `queryInstant(`/`queryRange(` call site as `[start, end)` offsets plus
   * its argument text, found by balancing parentheses — so a call reflowed across
   * lines (by biome or by hand) is still ONE site rather than a spurious failure.
   */
  function queryCallSites(source: string): { args: string; start: number; end: number }[] {
    const sites: { args: string; start: number; end: number }[] = [];
    for (const m of source.matchAll(/\bquery(?:Instant|Range)\(/g)) {
      const open = m.index + m[0].length - 1;
      let depth = 0;
      for (let i = open; i < source.length; i++) {
        if (source[i] === '(') depth++;
        else if (source[i] === ')') {
          depth--;
          if (depth === 0) {
            sites.push({ args: source.slice(open + 1, i), start: m.index, end: i + 1 });
            break;
          }
        }
      }
    }
    return sites;
  }

  it('gives every query on this page the SHARED deadline (positive half)', () => {
    const sites = queryCallSites(pageSource());

    // Green-by-skip guard (#408): a scan that found nothing would pass vacuously.
    expect(sites.length).toBeGreaterThanOrEqual(4);

    // The budget must be THE shared one, spelled either `{ deadline }` or
    // `{ deadline: deadline.reserved() }` — a freshly minted
    // `{ deadline: startPageDeadline(9999) }` is not a share of this page's
    // ceiling and must not pass.
    const offenders = sites
      .map((s) => s.args)
      .filter((args) => !/\{\s*deadline\s*\}/.test(args) && !/deadline:\s*deadline\./.test(args));
    expect(offenders).toEqual([]);
  });

  it('lets NOTHING but the probe take the reserved view (negative half)', () => {
    const source = pageSource();
    const sites = queryCallSites(source);

    const probe = sites.filter((s) => s.args.includes('KUBE_STATE_PROBE'));
    expect(probe).toHaveLength(1);
    expect(probe[0]?.args).toMatch(/deadline\.reserved\(\)/);

    // EVERY `reserved()` anywhere in the file — not just inside a query call —
    // must sit within the probe's call site. This is what catches a read that is
    // not a query at all (the opt-in `readNextAppStatus`) helping itself to the
    // slice the probe is supposed to be guaranteed.
    const uses = [...source.matchAll(/\breserved\(\)/g)].map((m) => m.index);
    expect(uses.length).toBeGreaterThanOrEqual(1);
    const outside = uses.filter((i) => !probe.some((p) => i >= p.start && i < p.end));
    expect(outside.map((i) => source.slice(Math.max(0, i - 70), i + 12).trim())).toEqual([]);
  });
});

describe('deployments page — a NextApp read that never started is not a cluster verdict', () => {
  it('reports a budget-exhausted NextApp read as its own reason, not as unreachable', async () => {
    readNextAppStatus.mockResolvedValue({
      status: 'source-unavailable',
      reason: 'deadline-exceeded',
      detail: 'the page ran out of its shared time budget before this read could start',
    });
    mockFetch();

    const html = await renderPage();

    expect(html).toContain('shared time budget was already spent');
    // A read that never happened says NOTHING about the API server.
    expect(html).not.toContain('the Kubernetes API could not be reached');
    expect(html).not.toContain('CRD is not installed');
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

  it('proves the "absent" claim with an app-agnostic probe rather than asserting it', async () => {
    const spy = mockFetch({ kubeStateAbsent: true });

    await renderPage();

    // Exactly one probe, carrying no app selector: without it, "the exporter is
    // missing" and "the exporter is there but this app has no Deployment" are
    // indistinguishable, and only the first would be reported.
    const probes = sentQueries(spy).filter((q) => q === KUBE_STATE_PROBE);
    expect(probes).toHaveLength(1);
  });

  it('issues NO probe on the happy path (it is a degradation-only query)', async () => {
    const spy = mockFetch();
    await renderPage();
    expect(sentQueries(spy)).not.toContain(KUBE_STATE_PROBE);
  });
});

describe('deployments page degradation — kube-state-metrics PRESENT but nothing matches', () => {
  /**
   * The second cause of a zero-series result, which the anchored selector made
   * possible and which the page must NOT report as "kube-state-metrics is
   * missing": the exporter is scraped (the probe answers) but no Deployment is
   * named `<app>-<digits>-deployment`. `ghost` is a valid app name that the
   * seeded universe contains no revision for.
   */
  it('says no Deployment matches this app, NOT that kube-state-metrics is absent', async () => {
    process.env[APP_NAME_ENV] = 'ghost';
    mockFetch();

    const html = await renderPage();

    expect(html).toContain('no Deployment for this app is known');
    // The wrong cause must not be asserted…
    expect(html).not.toContain('requires kube-state-metrics');
    // …nor any of the other honest states.
    expect(html).not.toContain('could not reach the observability backend');
    expect(html).not.toContain('no deployment history source is configured');
    // And still no table implying a deploy history.
    expect(html).not.toContain('<table');
  });

  it('reaches that state via the app-agnostic probe answering non-empty', async () => {
    process.env[APP_NAME_ENV] = 'ghost';
    const spy = mockFetch();

    await renderPage();

    expect(sentQueries(spy).filter((q) => q === KUBE_STATE_PROBE)).toHaveLength(1);
  });

  it('falls back to "could not reach" (never a cause claim) when the probe itself fails', async () => {
    process.env[APP_NAME_ENV] = 'ghost';
    spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      const promql = decodeURIComponent(new URL(String(u)).searchParams.get('query') ?? '');
      if (promql === KUBE_STATE_PROBE) {
        throw new Error('connect ECONNREFUSED');
      }
      return seededFetch(u);
    });

    const html = await renderPage();

    expect(html).toContain('could not reach the observability backend');
    expect(html).not.toContain('requires kube-state-metrics');
    expect(html).not.toContain('no Deployment for this app is known');
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
    const fetchSpy = spyOn(globalThis, 'fetch');

    const html = await renderPage();

    expect(html).toContain(APP_NAME_ENV);
    expect(html).toMatch(/scope|identity/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readNextAppStatus).not.toHaveBeenCalled();
  });

  it('treats an injection-shaped KN_APP_NAME as unknown scope', async () => {
    process.env[APP_NAME_ENV] = 'demo"} or on() up{';
    const fetchSpy = spyOn(globalThis, 'fetch');

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
