import { headers } from 'next/headers';
import {
  instantValue,
  latestMatrixValue,
  OVERVIEW_QUERIES,
  PROMETHEUS_URL_ENV,
  type PromResult,
  prometheusBaseUrl,
  queryInstant,
  queryRange,
} from './_prom/query';
import { formatMillis, formatNumber, NO_DATA } from './_ui/format';
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
 */
export const dynamic = 'force-dynamic';

const RANGE_SECONDS = 60 * 60; // last 1h
const STEP_SECONDS = 60;
const GRAFANA_DOCS =
  'https://github.com/getknext-dev/knext/tree/main/packages/kn-next-operator/config/grafana';

const shell = { padding: '2rem', fontFamily: 'system-ui, sans-serif' } as const;

function AccessDenied() {
  return (
    <main style={shell}>
      <h1>401 — Unauthorized</h1>
      <p>The observability pages require a valid bearer token.</p>
    </main>
  );
}

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

interface PanelRow {
  readonly label: string;
  readonly display: string;
}

export default async function OverviewPage() {
  const requestHeaders = await headers();
  const authorized = isObservabilityAuthorized(
    requestHeaders.get('authorization'),
    observabilityToken(),
  );
  if (!authorized) {
    return <AccessDenied />;
  }

  // Degrade closed BEFORE any network call: unconfigured ⇒ no fetch.
  if (!prometheusBaseUrl()) {
    return <Unconfigured />;
  }

  const end = Math.floor(Date.now() / 1000);
  const start = end - RANGE_SECONDS;
  const range = (promql: string) => queryRange(promql, start, end, STEP_SECONDS);

  const [rate, errorRate, p75, p99, inFlight] = await Promise.all([
    range(OVERVIEW_QUERIES.requestRate),
    range(OVERVIEW_QUERIES.errorRatePct),
    range(OVERVIEW_QUERIES.latencyP75),
    range(OVERVIEW_QUERIES.latencyP99),
    queryInstant(OVERVIEW_QUERIES.inFlight),
  ]);

  const results: PromResult<unknown>[] = [rate, errorRate, p75, p99, inFlight];
  const firstUnreachable = results.find((r) => r.status === 'unreachable');
  if (firstUnreachable && results.every((r) => r.status === 'unreachable')) {
    const summary =
      firstUnreachable.status === 'unreachable'
        ? firstUnreachable.errorSummary
        : 'Prometheus is unreachable';
    return <Unreachable summary={summary} />;
  }

  const rows: PanelRow[] = [
    { label: 'Request rate (req/s)', display: formatNumber(latestMatrixValue(rate), 2, '') },
    { label: '5xx error rate', display: formatNumber(latestMatrixValue(errorRate), 1, ' %') },
    { label: 'Latency p75', display: formatMillis(latestMatrixValue(p75)) },
    { label: 'Latency p99', display: formatMillis(latestMatrixValue(p99)) },
    { label: 'In-flight requests', display: formatNumber(instantValue(inFlight), 0, '') },
  ];

  return (
    <main style={shell}>
      <h1>Overview</h1>
      <p>
        RED signals for this app over the last hour — request rate, 5xx error rate, latency
        percentiles and current concurrency, from the core <code>knext_http_*</code> metrics. Values
        marked “{NO_DATA}” have produced no sample — that is not the same as a measured zero.
      </p>
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
