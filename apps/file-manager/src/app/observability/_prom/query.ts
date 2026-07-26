import 'server-only';

/**
 * Server-only Prometheus HTTP-API client for the in-app observability pages
 * (obs-pages plan P1.2, ADR-0038).
 *
 * The Overview (RED) and Scaling pages need range/rate math over the core
 * `knext_http_*` / `knext_coldstart_*` series, which only Prometheus can compute.
 * This module issues those queries **server-side only** (`import 'server-only'`)
 * so the browser never sees the Prometheus URL, a token, or raw metrics — it
 * receives only the rendered aggregates.
 *
 * Degradation contract (ADR-0038 — "degrade closed, not open"):
 *  - `OBSERVABILITY_PROMETHEUS_URL` unset ⇒ a typed `unconfigured` result — NOT a
 *    throw and NOT a network call. The page renders a clear empty state.
 *  - a slow / absent / erroring Prometheus ⇒ a typed `unreachable` result carrying
 *    only a short summary string (never a raw error object, never an internal
 *    host/IP). The page renders an error state and still 200s.
 * Every fetch is uncached (`cache: 'no-store'`) and bounded by a short abort
 * timeout so a hung Prometheus degrades the page instead of hanging the request.
 */

/** Operator-provisioned (K8s Secret/env) Prometheus base URL. */
export const PROMETHEUS_URL_ENV = 'OBSERVABILITY_PROMETHEUS_URL';

/** Short abort budget: a slow Prometheus must degrade the page, never hang it. */
const DEFAULT_TIMEOUT_MS = 4000;

/**
 * The TOTAL budget for every request ONE page render makes (PR-520 sysdesign
 * follow-up).
 *
 * Why a page-level number at all: {@link DEFAULT_TIMEOUT_MS} bounds each call
 * individually, so a page that issues a concurrent wave and THEN a sequential
 * follow-up query (as the Deployments page does on its degraded path) can spend
 * ~4 s + ~4 s. Each call is bounded; the page is not.
 *
 * Why exactly the per-call number, rather than more: "a page must never take
 * longer than the slowest single backend call it makes" is a rule a reader can
 * hold, and 4 s is the budget already in production here. Deliberately NOT done:
 * shrinking {@link DEFAULT_TIMEOUT_MS} — that would make the happy path of every
 * page more fragile (a genuinely slow-but-alive Prometheus starts failing) while
 * still leaving the total unbounded.
 */
export const PAGE_DEADLINE_MS = 4000;

/**
 * A monotonic budget shared by every call of one render. Threaded through
 * {@link QueryOptions.deadline}; each call spends at most what is LEFT, so the
 * total is a bound rather than the sum of the per-call budgets.
 */
export interface PageDeadline {
  /** The total budget this deadline was created with (for honest messaging). */
  readonly totalMs: number;
  /** Milliseconds left, floored at 0 (0 ⇒ do not start another request). */
  remainingMs(): number;
}

/**
 * Start a page-level deadline.
 *
 * The clock is `performance.now()` (monotonic — a wall-clock jump must not
 * lengthen or shorten a request budget) and is injectable so tests can exhaust a
 * budget deterministically without sleeping.
 */
export function startPageDeadline(
  totalMs: number = PAGE_DEADLINE_MS,
  now: () => number = () => performance.now(),
): PageDeadline {
  const startedAt = now();
  return {
    totalMs,
    remainingMs: () => Math.max(0, totalMs - (now() - startedAt)),
  };
}

/** A single Prometheus `matrix` (range) series: labels + [ts, value] samples. */
export interface PromMatrixSeries {
  readonly metric: Record<string, string>;
  readonly values: ReadonlyArray<readonly [number, string]>;
}

/** A single Prometheus `vector` (instant) sample: labels + a [ts, value] point. */
export interface PromVectorSample {
  readonly metric: Record<string, string>;
  readonly value: readonly [number, string];
}

/**
 * Typed query outcome. Callers switch on `status` — no raw error ever surfaces:
 *  - `ok`                — data available,
 *  - `unconfigured`      — the Prometheus URL env is unset (names the var),
 *  - `unreachable`       — network/HTTP/Prometheus-error (summary only),
 *  - `deadline-exceeded` — the shared PAGE budget ran out, so this call was cut
 *    short or never started. Deliberately NOT folded into `unreachable`: the page
 *    established nothing about Prometheus here, so it must not claim the backend
 *    is unreachable (nor, worse, that a series is absent).
 */
export type PromResult<T> =
  | { readonly status: 'ok'; readonly data: T }
  | { readonly status: 'unconfigured'; readonly envVar: string }
  | { readonly status: 'unreachable'; readonly errorSummary: string }
  | { readonly status: 'deadline-exceeded'; readonly budgetMs: number };

/** Options (test seam for the abort budget). */
export interface QueryOptions {
  readonly timeoutMs?: number;
  /**
   * A budget SHARED with every other call of the same render. When present the
   * effective timeout is `min(per-call, remaining)`, and an exhausted budget
   * means no request is issued at all.
   */
  readonly deadline?: PageDeadline;
}

/**
 * The configured Prometheus base URL (trailing slash trimmed), or `undefined`
 * when unset/blank — the single "unconfigured" signal callers degrade on.
 */
export function prometheusBaseUrl(): string | undefined {
  const raw = process.env[PROMETHEUS_URL_ENV];
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, '');
}

const UNCONFIGURED = { status: 'unconfigured', envVar: PROMETHEUS_URL_ENV } as const;

/**
 * Reduce an arbitrary thrown value to a short, non-leaky summary. We deliberately
 * do NOT echo `error.message` (it can contain internal hosts/IPs) — only a stable
 * category the page can display safely.
 */
function isAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))
  );
}

function summarize(err: unknown): string {
  if (isAbort(err)) {
    return 'Prometheus query timed out';
  }
  return 'Prometheus is unreachable';
}

async function runQuery<T>(
  path: string,
  params: URLSearchParams,
  extract: (data: unknown) => T,
  opts: QueryOptions | undefined,
): Promise<PromResult<T>> {
  const base = prometheusBaseUrl();
  if (!base) {
    return UNCONFIGURED;
  }

  const url = `${base}${path}?${params.toString()}`;
  const deadline = opts?.deadline;
  const remainingMs = deadline?.remainingMs();

  // The shared budget is already gone: starting another request would push the
  // page past its total, and the answer would arrive too late to be shown anyway.
  if (deadline && remainingMs !== undefined && remainingMs <= 0) {
    return { status: 'deadline-exceeded', budgetMs: deadline.totalMs };
  }

  // Bound this call by whichever is smaller — its own budget or what is left of
  // the page's. The per-call default is unchanged for callers without a deadline.
  const timeoutMs = Math.min(
    opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    remainingMs ?? Number.POSITIVE_INFINITY,
  );

  try {
    const response = await fetch(url, {
      // Never cache observability data: stale metrics mislead, and the query must
      // reflect the live cluster (mirrors the auth/mutation no-cache rule).
      cache: 'no-store',
      // Bound the wait so a hung Prometheus degrades the page, never hangs it.
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });

    if (!response.ok) {
      return { status: 'unreachable', errorSummary: `Prometheus returned HTTP ${response.status}` };
    }

    const body = (await response.json()) as { status?: string; data?: unknown };
    if (body.status !== 'success') {
      return { status: 'unreachable', errorSummary: 'Prometheus returned an error response' };
    }

    return { status: 'ok', data: extract(body.data) };
  } catch (err) {
    // An abort with nothing left on the shared clock is the PAGE deadline, not a
    // verdict about Prometheus — attribute it as such so the caller does not
    // report a cause it never established.
    if (deadline && isAbort(err) && deadline.remainingMs() <= 0) {
      return { status: 'deadline-exceeded', budgetMs: deadline.totalMs };
    }
    return { status: 'unreachable', errorSummary: summarize(err) };
  }
}

function extractMatrix(data: unknown): PromMatrixSeries[] {
  const result = (data as { result?: unknown } | undefined)?.result;
  return Array.isArray(result) ? (result as PromMatrixSeries[]) : [];
}

function extractVector(data: unknown): PromVectorSample[] {
  const result = (data as { result?: unknown } | undefined)?.result;
  return Array.isArray(result) ? (result as PromVectorSample[]) : [];
}

/**
 * `GET /api/v1/query_range` — a time series over [`startSec`, `endSec`] at
 * `stepSec` resolution. Degrades per the module contract; never throws.
 */
export function queryRange(
  promql: string,
  startSec: number,
  endSec: number,
  stepSec: number,
  opts?: QueryOptions,
): Promise<PromResult<PromMatrixSeries[]>> {
  const params = new URLSearchParams({
    query: promql,
    start: String(startSec),
    end: String(endSec),
    step: String(stepSec),
  });
  return runQuery('/api/v1/query_range', params, extractMatrix, opts);
}

/**
 * `GET /api/v1/query` — an instant vector (current value). Degrades per the
 * module contract; never throws.
 */
export function queryInstant(
  promql: string,
  opts?: QueryOptions,
): Promise<PromResult<PromVectorSample[]>> {
  const params = new URLSearchParams({ query: promql });
  return runQuery('/api/v1/query', params, extractVector, opts);
}

/**
 * The latest numeric sample of the first series in a range result, or `null` when
 * the result is not `ok` / carries no samples. Keeps degradation handling out of
 * the render.
 */
export function latestMatrixValue(result: PromResult<PromMatrixSeries[]>): number | null {
  if (result.status !== 'ok') {
    return null;
  }
  const series = result.data[0];
  const last = series?.values.at(-1);
  if (!last) {
    return null;
  }
  const value = Number(last[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * The sum of the latest sample **across all series** of a range result, or `null`
 * when the result is not `ok` / carries no series.
 *
 * Use this — not {@link latestMatrixValue} — whenever the matching instant query
 * is a `sum(...)`: a `sum by (deployment)` range result has one series per
 * Knative revision, so reading only the first would render a smaller "latest"
 * next to a larger "now" and present two numbers for one fact. `null` (rather
 * than 0) preserves the "no data yet ≠ measured zero" rule.
 */
export function totalLatestMatrixValue(result: PromResult<PromMatrixSeries[]>): number | null {
  if (result.status !== 'ok') {
    return null;
  }
  let total: number | null = null;
  for (const series of result.data) {
    const last = series.values.at(-1);
    if (!last) {
      continue;
    }
    const value = Number(last[1]);
    if (!Number.isFinite(value)) {
      continue;
    }
    total = (total ?? 0) + value;
  }
  return total;
}

/** One `(label value, latest sample)` pair extracted from a range result. */
export interface LabeledValue {
  readonly key: string;
  readonly value: number;
}

/**
 * The latest sample of every series in a range result, keyed by one of its labels
 * (e.g. `role` for the DB-wake panels). Returns `[]` when the result is not `ok`
 * or carries no series — callers then render the no-data marker rather than a
 * misleading zero.
 */
export function latestMatrixByLabel(
  result: PromResult<PromMatrixSeries[]>,
  label: string,
): LabeledValue[] {
  if (result.status !== 'ok') {
    return [];
  }
  const out: LabeledValue[] = [];
  for (const series of result.data) {
    const last = series.values.at(-1);
    if (!last) {
      continue;
    }
    const value = Number(last[1]);
    if (!Number.isFinite(value)) {
      continue;
    }
    out.push({ key: series.metric[label] ?? 'unknown', value });
  }
  return out;
}

/**
 * `true` when the query succeeded but Prometheus knows no series at all for it —
 * the signal used to distinguish "kube-state-metrics is not installed" from
 * "there are currently 0 replicas".
 */
export function hasNoSeries(result: PromResult<PromMatrixSeries[]>): boolean {
  return result.status === 'ok' && result.data.length === 0;
}

/**
 * The numeric value of the first sample in an instant result, or `null` when not
 * `ok` / empty.
 */
export function instantValue(result: PromResult<PromVectorSample[]>): number | null {
  if (result.status !== 'ok') {
    return null;
  }
  const sample = result.data[0];
  if (!sample) {
    return null;
  }
  const value = Number(sample.value[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * The latest sample of every series in an INSTANT result, keyed by one or more
 * of its labels (e.g. `('namespace', 'deployment')` for the per-revision
 * deployment history). Multiple labels are joined with `/` so the key is unique
 * across namespaces — keying on `deployment` alone silently merges two
 * same-named apps in different namespaces into one row (wrong values, duplicate
 * React keys), which is exactly the collision the PR-520 review caught.
 *
 * Returns `[]` when the result is not `ok` or carries no series — callers then
 * render an explicit state rather than an empty table that reads "nothing
 * exists". A series missing the label reads `unknown` (never silently dropped);
 * a non-finite sample is skipped (a `NaN` row would render as a fake value).
 */
export function instantByLabel(
  result: PromResult<PromVectorSample[]>,
  ...labels: string[]
): LabeledValue[] {
  if (result.status !== 'ok') {
    return [];
  }
  const out: LabeledValue[] = [];
  for (const sample of result.data) {
    const value = Number(sample.value[1]);
    if (!Number.isFinite(value)) {
      continue;
    }
    out.push({ key: labels.map((l) => sample.metric[l] ?? 'unknown').join('/'), value });
  }
  return out;
}

/**
 * `true` when an instant query succeeded but Prometheus knows no series at all —
 * the signal that a cluster-provided (kube-state-metrics) series is absent, as
 * opposed to a measured zero.
 */
export function hasNoInstantSeries(result: PromResult<PromVectorSample[]>): boolean {
  return result.status === 'ok' && result.data.length === 0;
}

/** Operator-injected app identity (`nextApp.Name`) — the metric scope. */
export const APP_NAME_ENV = 'KN_APP_NAME';

/**
 * A Kubernetes RFC1123 **label** (what a `NextApp`/Knative Service name is):
 * lowercase alphanumerics and `-`, must start and end alphanumeric, ≤63 chars.
 *
 * This doubles as the PromQL-injection guard: the app name is interpolated into
 * a `{app=~"…"}` selector, so anything containing a quote, brace, backslash,
 * newline or regex metacharacter (`.`, `*`, `|`, …) is REJECTED rather than
 * escaped. Rejection is safe because the caller then degrades to an explicit
 * "scope unknown" state — no query is built at all.
 */
const APP_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The validated app name this deployment's metrics belong to, or `undefined`
 * when `KN_APP_NAME` is unset/blank/not a valid k8s label.
 *
 * `undefined` MUST NOT be treated as "query the whole cluster": an unscoped
 * `kube_deployment_status_replicas` sums every deployment in the cluster and an
 * unscoped `knext_*` query mixes in every other knext app, so the page would
 * confidently render another workload's numbers as its own. Callers render a
 * distinct "scope unknown" state instead.
 */
export function observabilityAppName(): string | undefined {
  const raw = process.env[APP_NAME_ENV];
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  return APP_NAME_PATTERN.test(trimmed) ? trimmed : undefined;
}

/**
 * The app's own Kubernetes namespace — the second half of the metric scope.
 *
 * NOT operator-injected: the operator deliberately refuses downward-API
 * (`fieldRef`) env on the Knative Service (`nextapp_controller.go` — the
 * `kubernetes.podspec-fieldref` feature gate is off on stock Knative), and this
 * page is app-level, so it cannot add one. The deployer sets it through the
 * CR's pass-through `spec.env` (`KN_APP_NAMESPACE: <ns>`).
 *
 * Unset is NOT fatal — the Deployments page falls back to detecting the
 * namespace from the returned series and refuses to render only when they span
 * MORE THAN ONE namespace (where guessing which one is "this app" would be the
 * lying panel).
 */
export const APP_NAMESPACE_ENV = 'KN_APP_NAMESPACE';

/**
 * The validated namespace this app runs in, or `undefined` when unset/invalid.
 * Same RFC1123-label validation as {@link observabilityAppName} — it is likewise
 * interpolated into a PromQL selector, so rejection (not escaping) is the
 * injection guard.
 */
export function observabilityAppNamespace(): string | undefined {
  const raw = process.env[APP_NAMESPACE_ENV];
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  return APP_NAME_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** The RED PromQL for the Overview page, scoped to one app. */
export interface OverviewQueries {
  readonly requestRate: string;
  readonly errorRatePct: string;
  readonly latencyP75: string;
  readonly latencyP99: string;
  readonly inFlight: string;
}

/**
 * Build the RED (Rate / Errors / Duration) + saturation PromQL for `app`.
 *
 * Every `knext_*` series carries an `app` label (`adapters/metrics.ts`, sourced
 * from the same `KN_APP_NAME`), and a cluster runs many knext apps — so an
 * unscoped `sum(rate(knext_http_requests_total[5m]))` reports the CLUSTER's
 * request rate under this app's heading. The `{app=~"…"}` selector matches the
 * shipped `red-overview` dashboard's `$app` template variable.
 *
 * A parity test asserts every `knext_*` series here exists in
 * `adapters/metrics.ts`, so the queries cannot drift from the runtime metric set:
 *  - `knext_http_requests_total{status_class}`    — request + 5xx error rate,
 *  - `knext_http_request_duration_seconds_bucket` — p75 / p99 latency,
 *  - `knext_http_inflight_requests`               — current concurrency.
 *
 * @param app a name already validated by {@link observabilityAppName}.
 */
export function overviewQueries(app: string): OverviewQueries {
  const byApp = `{app=~"${app}"}`;

  return {
    /** Total request rate (req/s), 5-minute rate. */
    requestRate: `sum(rate(knext_http_requests_total${byApp}[5m]))`,
    /** 5xx error rate as a percentage of all requests. */
    errorRatePct: `sum(rate(knext_http_requests_total{app=~"${app}",status_class="5xx"}[5m])) / clamp_min(sum(rate(knext_http_requests_total${byApp}[5m])), 1) * 100`,
    /** p75 request latency (seconds). */
    latencyP75: `histogram_quantile(0.75, sum by (le) (rate(knext_http_request_duration_seconds_bucket${byApp}[5m])))`,
    /** p99 request latency (seconds). */
    latencyP99: `histogram_quantile(0.99, sum by (le) (rate(knext_http_request_duration_seconds_bucket${byApp}[5m])))`,
    /** Current in-flight requests (saturation). */
    inFlight: `sum(knext_http_inflight_requests${byApp})`,
  };
}

/** The PromQL for the Prometheus-DERIVED deployment history (P1.4), per app. */
export interface DeploymentQueries {
  readonly revisionCreated: string;
  readonly revisionReplicas: string;
  readonly revisionAvailable: string;
}

/**
 * Build the deployment-history PromQL for `app` (P1.4).
 *
 * This is the LOW-FIDELITY, zero-new-trust-surface half of the Deployments page's
 * data-path fork (plan §7): Knative creates one Deployment per Revision, so
 * kube-state-metrics' per-Deployment series already encode "which revisions
 * exist, when each appeared, and which one is carrying pods" — with **no RBAC
 * grant on the app's ServiceAccount** and over exactly the same data path as
 * P1.2/P1.3.
 *
 * What it CANNOT tell you (and the page must say so rather than imply): the
 * rollback pin/reason, the image digest, or the operator's Ready/Progressing
 * conditions. Those need the `NextApp` CR (`_k8s/nextapp.ts`, opt-in).
 *
 * Provenance: `kube_deployment_*` is **cluster-provided by kube-state-metrics**,
 * not emitted by knext. Absent kube-state-metrics the queries succeed with ZERO
 * series — which the page renders as "requires kube-state-metrics", NEVER as an
 * empty history table implying the app has never been deployed.
 *
 * SCOPING (PR-520 review — this page ENUMERATES rows, it does not only aggregate,
 * so a stray series becomes a *row* and, if newest, this app's "current"
 * revision):
 *  - the deployment selector is **anchored to Knative's naming**,
 *    `<app>-<digits>-deployment`, NOT the open prefix `"<app>.*"` — otherwise a
 *    sibling workload called `<app>-api` renders as one of this app's deploys;
 *  - a `namespace=` selector is added whenever the namespace is known, because
 *    Deployment names are only unique WITHIN a namespace — two same-named apps
 *    in two namespaces otherwise collide into one row.
 * Both are matched by the by-`(namespace, deployment)` grouping, so the page can
 * still detect (and refuse to guess about) a multi-namespace result when the
 * namespace is unknown.
 *
 * @param app a name already validated by {@link observabilityAppName} (which also
 *   blocks PromQL injection into the selector below).
 * @param namespace an optional namespace already validated by
 *   {@link observabilityAppNamespace}.
 */
export function deploymentQueries(app: string, namespace?: string): DeploymentQueries {
  // Knative names a revision's Deployment `<app>-<5-digit revision>-deployment`.
  // `[0-9]+` is anchored on both sides by Prometheus (regex selectors are fully
  // anchored), so `demo-api-00007-deployment` cannot match `demo`.
  const selector = namespace
    ? `{deployment=~"${app}-[0-9]+-deployment",namespace="${namespace}"}`
    : `{deployment=~"${app}-[0-9]+-deployment"}`;
  const by = 'max by (namespace, deployment)';

  return {
    /** Creation timestamp (unix seconds) per revision Deployment. */
    revisionCreated: `${by} (kube_deployment_created${selector})`,
    /** Desired replicas per revision Deployment (0 under scale-to-zero). */
    revisionReplicas: `${by} (kube_deployment_status_replicas${selector})`,
    /** Available (ready) replicas per revision Deployment. */
    revisionAvailable: `${by} (kube_deployment_status_replicas_available${selector})`,
  };
}

/**
 * The APP-AGNOSTIC kube-state-metrics presence probe (PR-520 review finding 4).
 *
 * Once {@link deploymentQueries} anchors its selector, a zero-series answer has
 * **two** causes that the scoped result alone cannot separate:
 *  1. kube-state-metrics is absent (or not scraped) — nothing at all to derive;
 *  2. it IS present, but no Deployment is named `<app>-<digits>-deployment`.
 * Reporting (1) whenever the scoped query is empty would assert a cause the page
 * has not established — precisely the misleading state the Deployments page
 * exists to avoid. This query carries **no** `deployment`/`namespace` selector, so
 * a non-empty answer proves the exporter is there and the emptiness is (2).
 *
 * `count(...)` keeps it a single scalar-ish series regardless of cluster size, and
 * the page issues it **only** on the already-degraded path — never on the happy
 * path. It is deliberately not part of {@link DeploymentQueries}: every query in
 * there must stay app-scoped.
 */
export const KUBE_STATE_PROBE = 'count(kube_deployment_created)';

/** The PromQL for the Cold-start & Scaling page, scoped to one app. */
export interface ScalingQueries {
  readonly replicas: string;
  readonly currentReplicas: string;
  readonly coldStartRate: string;
  readonly coldStartP50: string;
  readonly coldStartP99: string;
  readonly warmStartRatioPct: string;
  readonly dbWakeRateByRole: string;
  readonly dbWakeP50ByRole: string;
  readonly dbWakeP99ByRole: string;
  readonly inFlight: string;
}

/**
 * Build the scale-to-zero lifecycle PromQL for `app` (P1.3).
 *
 * These are deliberately the **same query shapes as the shipped Grafana
 * `scale-to-zero` dashboard** (`packages/kn-next-operator/config/grafana/dashboards/
 * scale-to-zero.json`) with its `$app` template variable bound to THIS app and a
 * fixed 5m rate window in place of `$__rate_interval` — so the in-app page and
 * the dashboard can never disagree about what a number means. The parity test
 * compares the two **including label selectors** (stripping them, as it did
 * before #516, hid exactly the scoping bug the gate exists to catch).
 *
 * Scoping is not cosmetic: every series here is multi-tenant. `knext_*` carries
 * an `app` label (`adapters/metrics.ts`), and the replica series is per
 * deployment — unscoped, the page reports the cluster, not this app.
 *
 * Provenance note: `kube_deployment_status_replicas` is **cluster-provided by
 * kube-state-metrics**, not emitted by knext. When kube-state-metrics is absent
 * the query succeeds with zero series — which the page must render as "requires
 * kube-state-metrics", NEVER as "0 replicas".
 *
 * KNOWN, DELIBERATE INCONSISTENCY with {@link deploymentQueries} (PR-520): the
 * P1.4 deployment selector is anchored (`<app>-[0-9]+-deployment`) and
 * namespace-pinned, while this one keeps the open `"<app>.*"` prefix and no
 * namespace. That is NOT an oversight — these strings are compared **verbatim**
 * against the shipped `scale-to-zero` Grafana dashboard by the parity test, and
 * the dashboard's own expression is `kube_deployment_status_replicas{deployment=~"$app.*"}`.
 * Anchoring here without changing the dashboard would silently drift the two
 * apart (the exact failure the parity gate exists to catch), and the dashboard
 * lives in the operator's config tree — out of scope for an app-level page.
 * Severity differs too: P1.3 only AGGREGATES (a sibling app inflates a replica
 * SUM), whereas P1.4 ENUMERATES rows and names one "current". Fixing both needs
 * a paired dashboard + page change; tracked as a follow-up.
 *
 * @param app a name already validated by {@link observabilityAppName}.
 */
export function scalingQueries(app: string): ScalingQueries {
  // Matches the dashboard's selectors with `$app` bound: Knative appends a
  // revision suffix to the Deployment name, hence the `.*` on `deployment`.
  const byApp = `{app=~"${app}"}`;
  const byDeployment = `{deployment=~"${app}.*"}`;

  return {
    /** Replica count 0→N over the window (kube-state-metrics; cluster-provided). */
    replicas: `sum by (deployment) (kube_deployment_status_replicas${byDeployment})`,
    /** Current replica count (kube-state-metrics; cluster-provided). */
    currentReplicas: `sum(kube_deployment_status_replicas${byDeployment})`,
    /** Cold starts per second. */
    coldStartRate: `sum(rate(knext_coldstart_total${byApp}[5m]))`,
    /** p50 cold-start duration (seconds). */
    coldStartP50: `histogram_quantile(0.50, sum by (le) (rate(knext_coldstart_duration_seconds_bucket${byApp}[5m])))`,
    /** p99 cold-start duration (seconds). */
    coldStartP99: `histogram_quantile(0.99, sum by (le) (rate(knext_coldstart_duration_seconds_bucket${byApp}[5m])))`,
    /**
     * Share of served requests that did NOT pay a cold start, as a percentage.
     *
     * Derivation (honest about its limits): knext exports a cold-start COUNTER,
     * not a per-request warm/cold flag, so this is `1 − coldstarts/requests`
     * over the same 5m window — i.e. "how rare is a cold start per request",
     * not a per-request attribution. `clamp_min(…, 0)` keeps a burst of cold
     * starts with very few served requests from rendering a negative ratio.
     * It has no dashboard counterpart (page-derived), so it is excluded from
     * the mirrored-query parity list but still parity-checked for real series.
     */
    warmStartRatioPct: `clamp_min((1 - sum(rate(knext_coldstart_total${byApp}[5m])) / sum(rate(knext_http_requests_total${byApp}[5m]))) * 100, 0)`,
    /** DB 0→1 wakes per second, by pool role (writer|reader). */
    dbWakeRateByRole: `sum by (role) (rate(knext_db_wake_total${byApp}[5m]))`,
    /** p50 DB-wake duration (seconds), by pool role. */
    dbWakeP50ByRole: `histogram_quantile(0.50, sum by (le, role) (rate(knext_db_wake_duration_seconds_bucket${byApp}[5m])))`,
    /** p99 DB-wake duration (seconds), by pool role. */
    dbWakeP99ByRole: `histogram_quantile(0.99, sum by (le, role) (rate(knext_db_wake_duration_seconds_bucket${byApp}[5m])))`,
    /** Current in-flight requests for THIS app (saturation). */
    inFlight: `sum(knext_http_inflight_requests${byApp})`,
  };
}
