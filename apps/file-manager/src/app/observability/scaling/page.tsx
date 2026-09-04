import { headers } from 'next/headers';
import {
  APP_NAME_ENV,
  hasNoSeries,
  instantValue,
  type LabeledValue,
  latestMatrixByLabel,
  latestMatrixValue,
  observabilityAppName,
  PROMETHEUS_URL_ENV,
  type PromMatrixSeries,
  type PromResult,
  type PromVectorSample,
  prometheusBaseUrl,
  queryInstant,
  queryRange,
  scalingQueries,
  totalLatestMatrixValue,
} from '../_prom/query';
import { denyObservabilityAccess } from '../_ui/access-denied';
import { formatMillis, formatNumber, NO_DATA, UNAVAILABLE } from '../_ui/format';
import { isObservabilityAuthorized, observabilityToken } from '../auth';

/**
 * /observability/scaling — the Cold-start & Scaling page (obs-pages plan P1.3,
 * ADR-0038).
 *
 * knext's signature observability surface: the scale-to-zero lifecycle Vercel has
 * no equivalent for — replicas going 0→N, how often and how slowly the app cold
 * starts, and how long the database takes to wake per pool role. Every series is
 * computed server-side by Prometheus via `_prom/query.ts`, reusing the exact
 * PromQL shapes of the shipped `scale-to-zero` Grafana dashboard.
 *
 * Security + degradation (`.claude/rules/security.md` + ADR-0038) — identical to
 * the Overview page:
 *  - Auth-gated, FAIL-CLOSED: unset `OBSERVABILITY_TOKEN` ⇒ deny-all; the check
 *    runs before any query, so an unauth'd browser triggers no Prometheus fetch.
 *  - Never cached (`force-dynamic`).
 *  - Degrade closed: Prometheus unset ⇒ a "not configured" empty state naming the
 *    env var (no fetch); unreachable ⇒ an error state — the page still 200s and
 *    never crashes/hangs. The browser receives rendered aggregates only.
 *  - THIRD, distinct state: the replica series is cluster-provided by
 *    kube-state-metrics. If it is absent the replica panel says so explicitly —
 *    conflating "kube-state-metrics not installed" with "0 replicas" would be a
 *    dishonest zero.
 *  - FOURTH, distinct state: every series here is multi-tenant, so each query is
 *    scoped to THIS app via the operator-injected `KN_APP_NAME`. If that scope
 *    is missing/invalid we render "scope unknown" and query nothing — an
 *    unscoped fallback would report the whole cluster as if it were this app.
 *  - FIFTH, distinct state: a PARTIALLY unavailable Prometheus marks only the
 *    failed panels `metric unavailable` — never `no data yet`, which would claim
 *    "nothing was recorded" when the truth is "we could not find out".
 */
export const dynamic = 'force-dynamic';

const RANGE_SECONDS = 60 * 60; // last 1h
const STEP_SECONDS = 60;
const GRAFANA_SCALE_TO_ZERO =
  'https://github.com/getknext-dev/knext/blob/main/packages/kn-next-operator/config/grafana/dashboards/scale-to-zero.json';

const shell = { padding: '2rem', fontFamily: 'system-ui, sans-serif' } as const;
const cell = { padding: '0.5rem 1rem' } as const;
const labelCell = { ...cell, fontWeight: 600 } as const;
const valueCell = { ...cell, textAlign: 'right' } as const;

function GrafanaLinkOut() {
  return (
    <p style={{ marginTop: '1.5rem', fontSize: '0.9rem' }}>
      For the full lifecycle view (per-deployment replicas, longer ranges, alerting) open the
      shipped <a href={GRAFANA_SCALE_TO_ZERO}>Grafana “Scale-to-zero lifecycle” dashboard</a> — this
      page renders the same queries.
    </p>
  );
}

function Unconfigured() {
  return (
    <main style={shell}>
      <h1>Cold start &amp; scaling</h1>
      <p>
        The observability backend is <strong>not configured</strong>. Set{' '}
        <code>{PROMETHEUS_URL_ENV}</code> (provisioned via a Kubernetes Secret) to the in-cluster
        Prometheus URL to surface replica counts, cold-start latency and database wake times here.
      </p>
      <GrafanaLinkOut />
    </main>
  );
}

function Unreachable({ summary }: { summary: string }) {
  return (
    <main style={shell}>
      <h1>Cold start &amp; scaling</h1>
      <p>
        The observability backend is currently <strong>unavailable</strong>: {summary}.
        Scale-to-zero metrics could not be loaded; this page will recover once Prometheus is
        reachable again.
      </p>
      <GrafanaLinkOut />
    </main>
  );
}

function ScopeUnknown() {
  return (
    <main style={shell}>
      <h1>Cold start &amp; scaling</h1>
      <p>
        The <strong>metric scope for this app is unknown</strong>: <code>{APP_NAME_ENV}</code> is
        unset or is not a valid Kubernetes name, so no query was run. Every series on this page
        (replicas, cold starts, DB wakes) is cluster-wide unless it is scoped to one app, and
        showing the cluster&rsquo;s totals as if they were this app&rsquo;s would be a lying panel.
        The operator sets <code>{APP_NAME_ENV}</code> when <code>spec.observability.enabled</code>{' '}
        is true; set it to this app&rsquo;s <code>NextApp</code> name to enable this page.
      </p>
      <GrafanaLinkOut />
    </main>
  );
}

interface PanelRow {
  readonly label: string;
  readonly display: string;
}

function Panel({ title, rows, note }: { title: string; rows: PanelRow[]; note?: string }) {
  return (
    <section style={{ marginTop: '1.5rem' }}>
      <h2 style={{ fontSize: '1.1rem' }}>{title}</h2>
      {note ? <p style={{ fontSize: '0.85rem', margin: '0.25rem 0' }}>{note}</p> : null}
      <table style={{ borderCollapse: 'collapse' }}>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td style={labelCell}>{row.label}</td>
              <td style={valueCell}>{row.display}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * The latest value of a range query, or the marker that tells the truth about
 * why there is no number: `metric unavailable` (the query FAILED) is deliberately
 * distinct from `no data yet` (the query succeeded, nothing was recorded).
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

/** Rows for a by-role series, or a single no-data/unavailable row. */
function roleRows(
  result: PromResult<PromMatrixSeries[]>,
  label: string,
  render: (v: number) => string,
): PanelRow[] {
  if (result.status === 'unreachable') {
    return [{ label, display: UNAVAILABLE }];
  }
  const values: LabeledValue[] = latestMatrixByLabel(result, 'role');
  if (values.length === 0) {
    return [{ label, display: NO_DATA }];
  }
  return values.map((v) => ({ label: `${label} — ${v.key}`, display: render(v.value) }));
}

export default async function ScalingPage() {
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
  const queries = scalingQueries(app);

  const end = Math.floor(Date.now() / 1000);
  const start = end - RANGE_SECONDS;
  const range = (promql: string) => queryRange(promql, start, end, STEP_SECONDS);

  const [
    replicas,
    startsObserved,
    startupP50,
    startupMax,
    dbWakeRate,
    dbWakeP50,
    dbWakeP99,
    currentReplicas,
    inFlight,
  ] = await Promise.all([
    range(queries.replicas),
    range(queries.startsObserved),
    range(queries.startupP50),
    range(queries.startupMax),
    range(queries.dbWakeRateByRole),
    range(queries.dbWakeP50ByRole),
    range(queries.dbWakeP99ByRole),
    queryInstant(queries.currentReplicas),
    queryInstant(queries.inFlight),
  ]);

  const results: PromResult<unknown>[] = [
    replicas,
    startsObserved,
    startupP50,
    startupMax,
    dbWakeRate,
    dbWakeP50,
    dbWakeP99,
    currentReplicas,
    inFlight,
  ];
  const unreachable = results.filter((r) => r.status === 'unreachable');
  if (unreachable.length === results.length && unreachable[0]?.status === 'unreachable') {
    return <Unreachable summary={unreachable[0].errorSummary} />;
  }
  // Some queries failed but not all: the affected panels must say so rather than
  // fall through to the "no data yet" marker (which means "nothing recorded").
  const partiallyUnavailable = unreachable.length > 0;

  // A cluster WITHOUT kube-state-metrics returns a successful query with zero
  // series. That is NOT "0 replicas" — say so instead of drawing a false zero.
  const kubeStateAbsent = hasNoSeries(replicas);

  // "Latest" sums ACROSS the per-revision series so it cannot contradict "now"
  // (an instant `sum(...)`); reading only the first series would show one
  // revision's replicas next to the app's total.
  const replicaRows: PanelRow[] = kubeStateAbsent
    ? []
    : [
        {
          label: 'Replicas (latest)',
          display:
            replicas.status === 'unreachable'
              ? UNAVAILABLE
              : formatNumber(totalLatestMatrixValue(replicas), 0),
        },
        {
          label: 'Replicas (now)',
          display: instantDisplay(currentReplicas, (v) => formatNumber(v, 0)),
        },
        // Per-Deployment breakdown (a Knative app has one Deployment per
        // revision) — the detail the aggregate above hides.
        ...latestMatrixByLabel(replicas, 'deployment').map((v) => ({
          label: `Replicas — ${v.key}`,
          display: formatNumber(v.value, 0),
        })),
      ];

  const coldStartRows: PanelRow[] = [
    // Gauge-derived, matching the shipped dashboard: the entry reports each
    // pod's startup duration once; there is no per-request cold/warm counter,
    // so a rate or a warm-ratio is not computable from the emitted set.
    { label: 'Starts observed', display: matrixDisplay(startsObserved, (v) => formatNumber(v, 0)) },
    { label: 'Startup p50', display: matrixDisplay(startupP50, formatMillis) },
    { label: 'Startup max', display: matrixDisplay(startupMax, formatMillis) },
  ];

  const dbWakeRows: PanelRow[] = [
    ...roleRows(dbWakeRate, 'DB wakes /s', (v) => v.toFixed(2)),
    ...roleRows(dbWakeP50, 'DB wake p50', (v) => formatMillis(v)),
    ...roleRows(dbWakeP99, 'DB wake p99', (v) => formatMillis(v)),
  ];

  return (
    <main style={shell}>
      <h1>Cold start &amp; scaling</h1>
      <p>
        The scale-to-zero lifecycle of this app over the last hour: how many replicas are running,
        how slowly it starts (<code>knext_bunexec_startup_duration_seconds</code>), and how long the
        database takes to wake per pool role (<code>knext_db_wake_*</code>). Values marked “
        {NO_DATA}” have produced no sample — that is not the same as a measured zero. Every query is
        scoped to this app (<code>{app}</code>).
      </p>

      {partiallyUnavailable ? (
        <p style={{ fontSize: '0.9rem' }}>
          <strong>Partial outage:</strong> some metrics could not be loaded — those values read “
          {UNAVAILABLE}”. That is <em>not</em> the same as “{NO_DATA}”: the query failed, so nothing
          is known about those series right now.
        </p>
      ) : null}

      <Panel
        title="Currently"
        rows={[
          {
            label: 'Replicas',
            display: kubeStateAbsent
              ? 'requires kube-state-metrics'
              : instantDisplay(currentReplicas, (v) => formatNumber(v, 0)),
          },
          {
            label: 'In-flight requests',
            display: instantDisplay(inFlight, (v) => formatNumber(v, 0)),
          },
        ]}
      />

      {kubeStateAbsent ? (
        <section style={{ marginTop: '1.5rem' }}>
          <h2 style={{ fontSize: '1.1rem' }}>Replica count 0→N</h2>
          <p style={{ fontSize: '0.9rem' }}>
            This panel <strong>requires kube-state-metrics</strong>. The replica series (
            <code>kube_deployment_status_replicas</code>) is provided by the cluster, not by knext,
            and Prometheus currently knows no such series — so replica counts cannot be shown. This
            is <em>not</em> a report of zero replicas. Install kube-state-metrics and scrape it to
            enable this panel.
          </p>
        </section>
      ) : (
        <Panel
          title="Replica count 0→N"
          note="Cluster-provided by kube-state-metrics (kube_deployment_status_replicas) — not a knext metric."
          rows={replicaRows}
        />
      )}

      <Panel
        title="Cold starts"
        note="Gauge-derived from each pod's reported startup duration — there is no per-request cold/warm counter, so no rate or warm-ratio is shown."
        rows={coldStartRows}
      />
      <Panel title="Database wake (by pool role)" rows={dbWakeRows} />

      <GrafanaLinkOut />
    </main>
  );
}
