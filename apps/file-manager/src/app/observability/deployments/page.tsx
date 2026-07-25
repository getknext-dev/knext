import { headers } from 'next/headers';
import {
  NEXTAPP_SOURCE_ENV,
  NEXTAPP_SOURCE_KUBERNETES,
  type NextAppReadResult,
  readNextAppStatus,
} from '../_k8s/nextapp';
import {
  APP_NAME_ENV,
  deploymentQueries,
  hasNoInstantSeries,
  instantByLabel,
  observabilityAppName,
  PROMETHEUS_URL_ENV,
  type PromResult,
  type PromVectorSample,
  prometheusBaseUrl,
  queryInstant,
} from '../_prom/query';
import { NO_DATA } from '../_ui/format';
import { isObservabilityAuthorized, observabilityToken } from '../auth';

/**
 * /observability/deployments — the Deployments page (obs-pages plan P1.4,
 * ADR-0038). Final page of Phase 1.
 *
 * ## The §7 data-path fork, resolved: (c) both, degrading — (a) strictly opt-in
 *
 * Deploy/rollback history could come from (a) the Kubernetes API (`NextApp`
 * status: highest fidelity, but an RBAC surface on the APP's ServiceAccount and
 * a hard coupling to the operator's CRD — which is NOT installed on the OKE
 * cluster, so (a) alone renders permanently "unavailable" there), or (b) the
 * Prometheus/kube-state-metrics series already used by P1.2/P1.3 (no new trust
 * surface, but no rollback pin, image or condition history).
 *
 * We take **both, degrading, with (a) OFF unless explicitly enabled**:
 *  - the DEFAULT trust surface is exactly (b)'s — with `{@link NEXTAPP_SOURCE_ENV}`
 *    unset the reader performs no file read and no API call, and needs no RBAC;
 *  - an operator who wants rollback fidelity opts in deliberately: set
 *    `OBSERVABILITY_NEXTAPP_SOURCE=kubernetes` AND apply the least-privilege,
 *    read-only Role in `apps/file-manager/deploy/observability-nextapp-read-rbac.yaml`
 *    (get/list/watch `nextapps` in this namespace only; never part of the
 *    operator's default bundle);
 *  - the page ALWAYS states which source produced what it shows.
 * Choosing (a)-only would have added RBAC for everyone and shown nothing on OKE;
 * (b)-only could never show a rollback. This keeps the smallest default surface
 * while letting fidelity be bought explicitly.
 *
 * ## Security + degradation (`.claude/rules/security.md`, ADR-0038)
 *  - Auth-gated, FAIL-CLOSED (unset `OBSERVABILITY_TOKEN` ⇒ deny-all); the gate
 *    runs before ANY read, so an unauth'd request touches neither backend.
 *  - Read-only: no mutating control anywhere on the page (ADR-0001 — the
 *    operator owns cluster state).
 *  - Never cached (`force-dynamic`); no token, Prometheus URL, kubeconfig or
 *    ServiceAccount token ever reaches the browser.
 *  - Distinct honest states, never a fake-empty table implying "no deployments":
 *    unconfigured · unreachable · source-unavailable (CRD absent / RBAC denied /
 *    not in cluster) · source not enabled · kube-state-metrics absent · scope
 *    unknown.
 */
export const dynamic = 'force-dynamic';

const GRAFANA_SCALE_TO_ZERO =
  'https://github.com/getknext-dev/knext/blob/main/packages/kn-next-operator/config/grafana/dashboards/scale-to-zero.json';

/** The state strings the tests pin — each one belongs to exactly one branch. */
const NO_SOURCE = 'no deployment history source is configured';
const BACKEND_UNREACHABLE = 'could not reach the observability backend';
const KUBE_STATE_ABSENT = 'requires kube-state-metrics';
const NEXTAPP_UNAVAILABLE = 'NextApp status source unavailable';
const NEXTAPP_NOT_ENABLED = 'NextApp status reads are not enabled';
const PROM_SOURCE_LABEL = 'Prometheus (kube-state-metrics)';
const K8S_SOURCE_LABEL = 'NextApp status (Kubernetes API)';
const NO_ROLLBACK_FIDELITY = 'rollback state is not available from this source';

const shell = { padding: '2rem', fontFamily: 'system-ui, sans-serif' } as const;
const cell = { padding: '0.5rem 1rem' } as const;
const labelCell = { ...cell, fontWeight: 600 } as const;
const headCell = { ...cell, textAlign: 'left', borderBottom: '1px solid #ccc' } as const;

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
      For revision-level replica timelines and longer history open the shipped{' '}
      <a href={GRAFANA_SCALE_TO_ZERO}>Grafana “Scale-to-zero lifecycle” dashboard</a> — it reads the
      same cluster series this page derives its revision history from.
    </p>
  );
}

function ScopeUnknown() {
  return (
    <main style={shell}>
      <h1>Deployments</h1>
      <p>
        The <strong>metric scope for this app is unknown</strong>: <code>{APP_NAME_ENV}</code> is
        unset or is not a valid Kubernetes name, so no query and no Kubernetes read was made. Both
        sources are per-app (the revision series is cluster-wide, and the <code>NextApp</code> read
        needs a name), and showing another workload&rsquo;s deploys as this app&rsquo;s would be a
        lying panel. The operator sets <code>{APP_NAME_ENV}</code> when{' '}
        <code>spec.observability.enabled</code> is true.
      </p>
      <GrafanaLinkOut />
    </main>
  );
}

/** The `NextApp`-source banner: OFF and BROKEN are deliberately different texts. */
function NextAppSourceNotice({ result }: { result: NextAppReadResult }) {
  if (result.status === 'ok') {
    return null;
  }
  if (result.status === 'disabled') {
    return (
      <p style={{ fontSize: '0.9rem' }}>
        <strong>{NEXTAPP_NOT_ENABLED}.</strong> The high-fidelity source (rollback pin, image
        digest, operator conditions) is opt-in: it needs{' '}
        <code>
          {NEXTAPP_SOURCE_ENV}={NEXTAPP_SOURCE_KUBERNETES}
        </code>{' '}
        plus the read-only <code>NextApp</code> Role from the app&rsquo;s deploy assets. Until then
        this page shows only what can be derived without any cluster credential.
      </p>
    );
  }

  const reason =
    result.reason === 'crd-absent'
      ? 'the NextApp CRD is not installed in this cluster (or this NextApp no longer exists)'
      : result.reason === 'forbidden'
        ? 'read access to NextApp is denied — the opt-in, read-only Role is not bound to this app’s ServiceAccount'
        : result.reason === 'not-in-cluster'
          ? 'there is no in-cluster ServiceAccount mounted in this pod, so the Kubernetes API cannot be called'
          : 'the Kubernetes API could not be reached';

  return (
    <p style={{ fontSize: '0.9rem' }}>
      <strong>{NEXTAPP_UNAVAILABLE}:</strong> {reason}. Nothing about rollbacks is being hidden — it
      simply could not be read, and this page does not guess.
    </p>
  );
}

/** One revision as derived from the cluster-provided kube-state-metrics series. */
interface RevisionRow {
  readonly deployment: string;
  readonly createdSec: number;
  readonly replicas: number | null;
  readonly available: number | null;
}

function buildRevisionRows(
  created: PromResult<PromVectorSample[]>,
  replicas: PromResult<PromVectorSample[]>,
  available: PromResult<PromVectorSample[]>,
): RevisionRow[] {
  const byDeployment = (r: PromResult<PromVectorSample[]>) =>
    new Map(instantByLabel(r, 'deployment').map((v) => [v.key, v.value]));
  const replicaMap = byDeployment(replicas);
  const availableMap = byDeployment(available);

  return instantByLabel(created, 'deployment')
    .map((v) => ({
      deployment: v.key,
      createdSec: v.value,
      replicas: replicaMap.get(v.key) ?? null,
      available: availableMap.get(v.key) ?? null,
    }))
    .sort((a, b) => b.createdSec - a.createdSec);
}

function formatCount(value: number | null): string {
  return value === null ? NO_DATA : String(value);
}

function DerivedHistory({ rows }: { rows: RevisionRow[] }) {
  return (
    <section style={{ marginTop: '1.5rem' }}>
      <h2 style={{ fontSize: '1.1rem' }}>Revision history</h2>
      <p style={{ fontSize: '0.85rem', margin: '0.25rem 0' }}>
        Source: <strong>{PROM_SOURCE_LABEL}</strong> — derived from the per-revision Deployment
        series (<code>kube_deployment_created</code> / <code>kube_deployment_status_replicas</code>
        ), which the cluster provides. Knative creates one Deployment per Revision, so each row is
        one deploy. Replica counts of 0 are normal under scale-to-zero. This source records what
        changed and when, but {NO_ROLLBACK_FIDELITY}.
      </p>
      <table style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={headCell}>Revision (Deployment)</th>
            <th style={headCell}>First seen (UTC)</th>
            <th style={headCell}>Replicas</th>
            <th style={headCell}>Ready</th>
            <th style={headCell}>State</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.deployment}>
              <td style={labelCell}>{row.deployment}</td>
              <td style={cell}>{new Date(row.createdSec * 1000).toISOString()}</td>
              <td style={cell}>{formatCount(row.replicas)}</td>
              <td style={cell}>{formatCount(row.available)}</td>
              <td style={cell}>{index === 0 ? 'current' : 'previous'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function NextAppHistory({ data }: { data: Extract<NextAppReadResult, { status: 'ok' }>['data'] }) {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['Live revision', data.observedRevision ?? NO_DATA],
    ['Last successful deploy', data.lastSuccessfulDeployTime ?? NO_DATA],
    ['Desired image', data.image ?? NO_DATA],
    [
      'Scaled to zero',
      data.scaledToZero === undefined ? NO_DATA : data.scaledToZero ? 'yes' : 'no',
    ],
    [
      'Rollback',
      data.pinnedRevision
        ? `pinned to ${data.pinnedRevision}${
            data.canaryPercent ? ` (${data.canaryPercent}% canary to latest)` : ''
          }`
        : 'not pinned (latest ready revision serves)',
    ],
  ];

  return (
    <section style={{ marginTop: '1.5rem' }}>
      <h2 style={{ fontSize: '1.1rem' }}>Current deploy</h2>
      <p style={{ fontSize: '0.85rem', margin: '0.25rem 0' }}>
        Source: <strong>{K8S_SOURCE_LABEL}</strong> — the operator&rsquo;s own record of this app,
        read read-only via the opt-in Role.
      </p>
      <table style={{ borderCollapse: 'collapse' }}>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <td style={labelCell}>{label}</td>
              <td style={cell}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {data.currentTraffic.length > 0 ? (
        <table style={{ borderCollapse: 'collapse', marginTop: '1rem' }}>
          <thead>
            <tr>
              <th style={headCell}>Serving revision</th>
              <th style={headCell}>Traffic %</th>
              <th style={headCell}>Latest</th>
            </tr>
          </thead>
          <tbody>
            {data.currentTraffic.map((t) => (
              <tr key={t.revisionName ?? 'unknown'}>
                <td style={labelCell}>{t.revisionName ?? NO_DATA}</td>
                <td style={cell}>{t.percent === undefined ? NO_DATA : String(t.percent)}</td>
                <td style={cell}>{t.latestRevision ? 'yes' : 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {data.conditions.length > 0 ? (
        <table style={{ borderCollapse: 'collapse', marginTop: '1rem' }}>
          <thead>
            <tr>
              <th style={headCell}>Condition</th>
              <th style={headCell}>Status</th>
              <th style={headCell}>Reason</th>
              <th style={headCell}>Since</th>
            </tr>
          </thead>
          <tbody>
            {data.conditions.map((c) => (
              <tr key={c.type}>
                <td style={labelCell}>{c.type}</td>
                <td style={cell}>{c.status}</td>
                <td style={cell}>{c.reason ?? NO_DATA}</td>
                <td style={cell}>{c.lastTransitionTime ?? NO_DATA}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

export default async function DeploymentsPage() {
  const requestHeaders = await headers();
  const authorized = isObservabilityAuthorized(
    requestHeaders.get('authorization'),
    observabilityToken(),
  );
  if (!authorized) {
    return <AccessDenied />;
  }

  // Before ANY read: both sources are per-app, so an unknown scope means we say
  // "unknown" rather than reading someone else's history.
  const app = observabilityAppName();
  if (!app) {
    return <ScopeUnknown />;
  }

  const nextApp = await readNextAppStatus(app);

  // Degrade closed before any network call: Prometheus unset ⇒ no fetch.
  const promConfigured = Boolean(prometheusBaseUrl());
  let created: PromResult<PromVectorSample[]> | undefined;
  let replicas: PromResult<PromVectorSample[]> | undefined;
  let available: PromResult<PromVectorSample[]> | undefined;
  if (promConfigured) {
    const queries = deploymentQueries(app);
    [created, replicas, available] = await Promise.all([
      queryInstant(queries.revisionCreated),
      queryInstant(queries.revisionReplicas),
      queryInstant(queries.revisionAvailable),
    ]);
  }

  // ANY failed query means the timeline cannot be trusted, so the page says
  // "could not reach" rather than drawing a partial history that silently omits
  // revisions.
  const promUnreachable = [created, replicas, available].some((r) => r?.status === 'unreachable');
  const kubeStateAbsent = created !== undefined && !promUnreachable && hasNoInstantSeries(created);
  const rows =
    created && replicas && available && !promUnreachable && !kubeStateAbsent
      ? buildRevisionRows(created, replicas, available)
      : [];

  const nextAppUsable = nextApp.status === 'ok';
  // Neither source can say anything AND neither is even configured: that is a
  // configuration state, not an empty history.
  const nothingConfigured = !promConfigured && !nextAppUsable;

  return (
    <main style={shell}>
      <h1>Deployments</h1>
      <p>
        What has been deployed for <code>{app}</code>, when, and what is serving now. This page is
        strictly read-only — deploys and rollbacks are driven by the operator through the{' '}
        <code>NextApp</code> resource, never from here.
      </p>

      <NextAppSourceNotice result={nextApp} />

      {nextApp.status === 'ok' ? <NextAppHistory data={nextApp.data} /> : null}

      {nothingConfigured ? (
        <p>
          There is <strong>{NO_SOURCE}</strong>. Set <code>{PROMETHEUS_URL_ENV}</code> (provisioned
          via a Kubernetes Secret) for the derived revision history, and/or opt into the
          high-fidelity source with <code>{NEXTAPP_SOURCE_ENV}</code> plus the read-only{' '}
          <code>NextApp</code> Role. Nothing is being shown because nothing can be read — this app
          may well have deployments.
        </p>
      ) : null}

      {promUnreachable ? (
        <p>
          The revision history <strong>{BACKEND_UNREACHABLE}</strong>: the Prometheus queries
          failed, so the deploy timeline is unknown right now. This is not a report that there are
          no deployments; the page recovers as soon as Prometheus answers again.
        </p>
      ) : null}

      {kubeStateAbsent ? (
        <p>
          The derived revision history <strong>{KUBE_STATE_ABSENT}</strong>. The per-revision
          Deployment series (<code>kube_deployment_created</code>) is provided by the cluster, not
          by knext, and Prometheus knows no such series — so no deploy timeline can be built. This
          is <em>not</em> a report of zero deployments. Install kube-state-metrics and scrape it, or
          opt into the <code>NextApp</code> source above.
        </p>
      ) : null}

      {rows.length > 0 ? <DerivedHistory rows={rows} /> : null}

      {promConfigured && !promUnreachable && !kubeStateAbsent && rows.length === 0 ? (
        <p>
          The revision query succeeded but returned {NO_DATA} for this app&rsquo;s Deployments — no
          revision has been observed yet.
        </p>
      ) : null}

      <GrafanaLinkOut />
    </main>
  );
}
