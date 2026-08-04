import { headers } from 'next/headers';
import {
  APP_NAME_ENV,
  instantValue,
  latestMatrixValue,
  observabilityAppName,
  overviewQueries,
  PROMETHEUS_URL_ENV,
  type PromMatrixSeries,
  type PromResult,
  type PromVectorSample,
  prometheusBaseUrl,
  queryInstant,
  queryRange,
} from './_prom/query';
import { denyObservabilityAccess } from './_ui/access-denied';
import { formatMillis, formatNumber, NO_DATA, UNAVAILABLE } from './_ui/format';
import { isObservabilityAuthorized, observabilityToken } from './auth';

/**
 * /observability — the Overview (RED) page (obs-pages plan P1.2, ADR-0038).
 *
 * A Vercel-"Observability-overview"-analogue: request rate, 5xx error-rate, p75 +
 * p99 latency and current in-flight concurrency, computed server-side from the
 * core `knext_http_*` series via Prometheus (`_prom/query.ts`).
 *
 * Security + degradation (`.claude/rules/security.md` + ADR-0038):
 *  - Auth-gated, FAIL-CLOSED: unset `OBSERVABILITY_TOKEN` ⇒ deny-all; the check
 *    runs server-side every request before any query, so an unauth'd browser
 *    triggers no Prometheus fetch and sees no metric data.
 *  - Never cached (`force-dynamic`).
 *  - Degrade closed, not open: Prometheus unset ⇒ a clear "not configured" empty
 *    state (naming the env var, no fetch); unreachable ⇒ an error state — the page
 *    still 200s and never crashes/hangs. All queries are server-side only; the
 *    browser receives rendered aggregates, never the Prometheus URL or a token.
 *  - Scoped to THIS app via the operator-injected `KN_APP_NAME` (the same source
 *    `adapters/metrics.ts` labels the series with). The `knext_http_*` series are
 *    per-app and a cluster runs many apps, so an unscoped query would report the
 *    cluster under this app's heading; a missing/invalid scope renders a distinct
 *    "scope unknown" state and queries nothing.
 *  - A PARTIALLY unavailable Prometheus marks only the failed rows
 *    `metric unavailable` — never `no data yet`, which claims "nothing was
 *    recorded" when the truth is "we could not find out".
 */
export const dynamic = 'force-dynamic';

const RANGE_SECONDS = 60 * 60; // last 1h
const STEP_SECONDS = 60;
const GRAFANA_DOCS =
  'https://github.com/getknext-dev/knext/tree/main/packages/kn-next-operator/config/grafana';

const shell = { padding: '2rem', fontFamily: 'system-ui, sans-serif' } as const;

function GrafanaLinkOut() {
  return (
    <p style={{ marginTop: '1.5rem', fontSize: '0.9rem' }}>
      For deep, cluster-wide analysis, open the turnkey{' '}
      <a href={GRAFANA_DOCS}>Grafana dashboards</a> (RED overview, scale-to-zero, RUM, bytecode,
      load-testing).
    </p>
  );
}

function Unconfigured() {
  return (
    <main style={shell}>
      <h1>Overview</h1>
      <p>
        The observability backend is <strong>not configured</strong>. Set{' '}
        <code>{PROMETHEUS_URL_ENV}</code> (provisioned via a Kubernetes Secret) to the in-cluster
        Prometheus URL to surface request rate, error rate, latency and in-flight metrics here.
      </p>
      <GrafanaLinkOut />
    </main>
  );
}

function Unreachable({ summary }: { summary: string }) {
  return (
    <main style={shell}>
      <h1>Overview</h1>
      <p>
        The observability backend is currently <strong>unavailable</strong>: {summary}. Metrics
        could not be loaded; this page will recover once Prometheus is reachable again.
      </p>
      <GrafanaLinkOut />
    </main>
  );
}

function ScopeUnknown() {
  return (
    <main style={shell}>
      <h1>Overview</h1>
      <p>
        The <strong>metric scope for this app is unknown</strong>: <code>{APP_NAME_ENV}</code> is
        unset or is not a valid Kubernetes name, so no query was run. The <code>knext_http_*</code>{' '}
        series are labelled per app and a cluster runs many of them, so an unscoped query would
        report the whole cluster&rsquo;s RED signals under this app&rsquo;s heading. The operator
        sets <code>{APP_NAME_ENV}</code> when <code>spec.observability.enabled</code> is true; set
        it to this app&rsquo;s <code>NextApp</code> name to enable this page.
      </p>
      <GrafanaLinkOut />
    </main>
  );
}

interface PanelRow {
  readonly label: string;
  readonly display: string;
}

/**
 * A failed query reads `metric unavailable`, NOT `no data yet`: "we could not
 * find out" and "nothing was recorded" are different facts (and neither is a
 * measured zero). Shared shape with the Scaling page.
 */
function matrixDisplay(
  result: PromResult<PromMatrixSeries[]>,
  render: (v: number | null) => string,
): string {
  return result.status === 'unreachable' ? UNAVAILABLE : render(latestMatrixValue(result));
}

/** As {@link matrixDisplay}, for an instant query. */
function instantDisplay(
  result: PromResult<PromVectorSample[]>,
  render: (v: number | null) => string,
): string {
  return result.status === 'unreachable' ? UNAVAILABLE : render(instantValue(result));
}

export default async function OverviewPage() {
  const requestHeaders = await headers();
  const authorized = isObservabilityAuthorized(
    requestHeaders.get('authorization'),
    observabilityToken(),
  );
  if (!authorized) {
    denyObservabilityAccess(); // real HTTP 401, never returns (#525)
  }

  // Degrade closed BEFORE any network call: unconfigured ⇒ no fetch.
  if (!prometheusBaseUrl()) {
    return <Unconfigured />;
  }

  // Also BEFORE any network call: without a validated app scope we would have to
  // query the whole cluster. Say "unknown" instead of lying (#516).
  const app = observabilityAppName();
  if (!app) {
    return <ScopeUnknown />;
  }
  const queries = overviewQueries(app);

  const end = Math.floor(Date.now() / 1000);
  const start = end - RANGE_SECONDS;
  const range = (promql: string) => queryRange(promql, start, end, STEP_SECONDS);

  const [rate, errorRate, p75, p99, inFlight] = await Promise.all([
    range(queries.requestRate),
    range(queries.errorRatePct),
    range(queries.latencyP75),
    range(queries.latencyP99),
    queryInstant(queries.inFlight),
  ]);

  const results: PromResult<unknown>[] = [rate, errorRate, p75, p99, inFlight];
  const unreachable = results.filter((r) => r.status === 'unreachable');
  if (unreachable.length === results.length && unreachable[0]?.status === 'unreachable') {
    return <Unreachable summary={unreachable[0].errorSummary} />;
  }
  // Some queries failed but not all: the affected rows must say so rather than
  // fall through to the "no data yet" marker (which means "nothing recorded").
  const partiallyUnavailable = unreachable.length > 0;

  const rows: PanelRow[] = [
    {
      label: 'Request rate (req/s)',
      display: matrixDisplay(rate, (v) => formatNumber(v, 2, '')),
    },
    {
      label: '5xx error rate',
      display: matrixDisplay(errorRate, (v) => formatNumber(v, 1, ' %')),
    },
    { label: 'Latency p75', display: matrixDisplay(p75, formatMillis) },
    { label: 'Latency p99', display: matrixDisplay(p99, formatMillis) },
    {
      label: 'In-flight requests',
      display: instantDisplay(inFlight, (v) => formatNumber(v, 0, '')),
    },
  ];

  return (
    <main style={shell}>
      <h1>Overview</h1>
      <p>
        RED signals for this app over the last hour — request rate, 5xx error rate, latency
        percentiles and current concurrency, from the core <code>knext_http_*</code> metrics. Values
        marked “{NO_DATA}” have produced no sample — that is not the same as a measured zero. Every
        query is scoped to this app (<code>{app}</code>).
      </p>
      {partiallyUnavailable ? (
        <p style={{ fontSize: '0.9rem' }}>
          <strong>Partial outage:</strong> some metrics could not be loaded — those values read “
          {UNAVAILABLE}”. That is <em>not</em> the same as “{NO_DATA}”: the query failed, so nothing
          is known about those series right now.
        </p>
      ) : null}
      <table style={{ borderCollapse: 'collapse', marginTop: '1rem' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '0.5rem 1rem' }}>Signal</th>
            <th style={{ textAlign: 'right', padding: '0.5rem 1rem' }}>Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td style={{ padding: '0.5rem 1rem', fontWeight: 600 }}>{row.label}</td>
              <td style={{ padding: '0.5rem 1rem', textAlign: 'right' }}>{row.display}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <GrafanaLinkOut />
    </main>
  );
}
