import { headers } from 'next/headers';
import {
  hasNoSeries,
  instantValue,
  type LabeledValue,
  latestMatrixByLabel,
  latestMatrixValue,
  OVERVIEW_QUERIES,
  PROMETHEUS_URL_ENV,
  type PromResult,
  prometheusBaseUrl,
  queryInstant,
  queryRange,
  SCALING_QUERIES,
} from '../_prom/query';
import { formatMillis, formatNumber, NO_DATA } from '../_ui/format';
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

/** Rows for a by-role series, or a single no-data row when nothing was recorded. */
function roleRows(
  values: LabeledValue[],
  label: string,
  render: (v: number) => string,
): PanelRow[] {
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
    return <AccessDenied />;
  }

  // Degrade closed BEFORE any network call: unconfigured ⇒ no fetch.
  if (!prometheusBaseUrl()) {
    return <Unconfigured />;
  }

  const end = Math.floor(Date.now() / 1000);
  const start = end - RANGE_SECONDS;
  const range = (promql: string) => queryRange(promql, start, end, STEP_SECONDS);

  const [
    replicas,
    coldStartRate,
    coldStartP50,
    coldStartP99,
    dbWakeRate,
    dbWakeP50,
    dbWakeP99,
    currentReplicas,
    inFlight,
  ] = await Promise.all([
    range(SCALING_QUERIES.replicas),
    range(SCALING_QUERIES.coldStartRate),
    range(SCALING_QUERIES.coldStartP50),
    range(SCALING_QUERIES.coldStartP99),
    range(SCALING_QUERIES.dbWakeRateByRole),
    range(SCALING_QUERIES.dbWakeP50ByRole),
    range(SCALING_QUERIES.dbWakeP99ByRole),
    queryInstant(SCALING_QUERIES.currentReplicas),
    queryInstant(OVERVIEW_QUERIES.inFlight),
  ]);

  const results: PromResult<unknown>[] = [
    replicas,
    coldStartRate,
    coldStartP50,
    coldStartP99,
    dbWakeRate,
    dbWakeP50,
    dbWakeP99,
    currentReplicas,
    inFlight,
  ];
  const firstUnreachable = results.find((r) => r.status === 'unreachable');
  if (firstUnreachable && results.every((r) => r.status === 'unreachable')) {
    const summary =
      firstUnreachable.status === 'unreachable'
        ? firstUnreachable.errorSummary
        : 'Prometheus is unreachable';
    return <Unreachable summary={summary} />;
  }

  // A cluster WITHOUT kube-state-metrics returns a successful query with zero
  // series. That is NOT "0 replicas" — say so instead of drawing a false zero.
  const kubeStateAbsent = hasNoSeries(replicas);

  const replicaRows: PanelRow[] = kubeStateAbsent
    ? []
    : [
        { label: 'Replicas (latest)', display: formatNumber(latestMatrixValue(replicas), 0) },
        { label: 'Replicas (now)', display: formatNumber(instantValue(currentReplicas), 0) },
      ];

  const coldStartRows: PanelRow[] = [
    { label: 'Cold starts /s', display: formatNumber(latestMatrixValue(coldStartRate), 2) },
    { label: 'Cold start p50', display: formatMillis(latestMatrixValue(coldStartP50)) },
    { label: 'Cold start p99', display: formatMillis(latestMatrixValue(coldStartP99)) },
  ];

  const dbWakeRows: PanelRow[] = [
    ...roleRows(latestMatrixByLabel(dbWakeRate, 'role'), 'DB wakes /s', (v) => v.toFixed(2)),
    ...roleRows(latestMatrixByLabel(dbWakeP50, 'role'), 'DB wake p50', (v) => formatMillis(v)),
    ...roleRows(latestMatrixByLabel(dbWakeP99, 'role'), 'DB wake p99', (v) => formatMillis(v)),
  ];

  return (
    <main style={shell}>
      <h1>Cold start &amp; scaling</h1>
      <p>
        The scale-to-zero lifecycle of this app over the last hour: how many replicas are running,
        how often and how slowly it cold starts (<code>knext_coldstart_*</code>), and how long the
        database takes to wake per pool role (<code>knext_db_wake_*</code>). Values marked “
        {NO_DATA}” have produced no sample — that is not the same as a measured zero.
      </p>

      <Panel
        title="Currently"
        rows={[
          {
            label: 'Replicas',
            display: kubeStateAbsent
              ? 'requires kube-state-metrics'
              : formatNumber(instantValue(currentReplicas), 0),
          },
          { label: 'In-flight requests', display: formatNumber(instantValue(inFlight), 0) },
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

      <Panel title="Cold starts" rows={coldStartRows} />
      <Panel title="Database wake (by pool role)" rows={dbWakeRows} />

      <GrafanaLinkOut />
    </main>
  );
}
