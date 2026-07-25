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
 *  - `ok`           — data available,
 *  - `unconfigured` — the Prometheus URL env is unset (names the var),
 *  - `unreachable`  — network/timeout/HTTP/Prometheus-error (summary only).
 */
export type PromResult<T> =
  | { readonly status: 'ok'; readonly data: T }
  | { readonly status: 'unconfigured'; readonly envVar: string }
  | { readonly status: 'unreachable'; readonly errorSummary: string };

/** Options (test seam for the abort budget). */
export interface QueryOptions {
  readonly timeoutMs?: number;
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
function summarize(err: unknown): string {
  if (err instanceof DOMException && err.name === 'AbortError') {
    return 'Prometheus query timed out';
  }
  if (err instanceof Error && err.name === 'TimeoutError') {
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
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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
 * The RED (Rate / Errors / Duration) + saturation PromQL for the Overview page.
 * Every `knext_*` series here is asserted against `adapters/metrics.ts` by the
 * page's parity test, so the queries can never drift from the runtime metric set:
 *  - `knext_http_requests_total{status_class}`   — request + 5xx error rate,
 *  - `knext_http_request_duration_seconds_bucket` — p75 / p99 latency,
 *  - `knext_http_inflight_requests`               — current concurrency.
 */
export const OVERVIEW_QUERIES = {
  /** Total request rate (req/s), 5-minute rate. */
  requestRate: 'sum(rate(knext_http_requests_total[5m]))',
  /** 5xx error rate as a percentage of all requests. */
  errorRatePct:
    'sum(rate(knext_http_requests_total{status_class="5xx"}[5m])) / clamp_min(sum(rate(knext_http_requests_total[5m])), 1) * 100',
  /** p75 request latency (seconds). */
  latencyP75:
    'histogram_quantile(0.75, sum by (le) (rate(knext_http_request_duration_seconds_bucket[5m])))',
  /** p99 request latency (seconds). */
  latencyP99:
    'histogram_quantile(0.99, sum by (le) (rate(knext_http_request_duration_seconds_bucket[5m])))',
  /** Current in-flight requests (saturation). */
  inFlight: 'sum(knext_http_inflight_requests)',
} as const;

/**
 * The scale-to-zero lifecycle PromQL for the Cold-start & Scaling page (P1.3).
 *
 * These are deliberately the **same query shapes as the shipped Grafana
 * `scale-to-zero` dashboard** (`packages/kn-next-operator/config/grafana/dashboards/
 * scale-to-zero.json`), minus its `$app` template selector and with a fixed 5m
 * rate window in place of `$__rate_interval` — so the in-app page and the
 * dashboard can never disagree about what a number means. A parity test asserts
 * both that every `knext_*` series exists in `adapters/metrics.ts` and that each
 * mirrored query matches a dashboard expression.
 *
 * Provenance note: `kube_deployment_status_replicas` is **cluster-provided by
 * kube-state-metrics**, not emitted by knext. When kube-state-metrics is absent
 * the query succeeds with zero series — which the page must render as "requires
 * kube-state-metrics", NEVER as "0 replicas".
 */
export const SCALING_QUERIES = {
  /** Replica count 0→N over the window (kube-state-metrics; cluster-provided). */
  replicas: 'sum by (deployment) (kube_deployment_status_replicas)',
  /** Current replica count (kube-state-metrics; cluster-provided). */
  currentReplicas: 'sum(kube_deployment_status_replicas)',
  /** Cold starts per second. */
  coldStartRate: 'sum(rate(knext_coldstart_total[5m]))',
  /** p50 cold-start duration (seconds). */
  coldStartP50:
    'histogram_quantile(0.50, sum by (le) (rate(knext_coldstart_duration_seconds_bucket[5m])))',
  /** p99 cold-start duration (seconds). */
  coldStartP99:
    'histogram_quantile(0.99, sum by (le) (rate(knext_coldstart_duration_seconds_bucket[5m])))',
  /** DB 0→1 wakes per second, by pool role (writer|reader). */
  dbWakeRateByRole: 'sum by (role) (rate(knext_db_wake_total[5m]))',
  /** p50 DB-wake duration (seconds), by pool role. */
  dbWakeP50ByRole:
    'histogram_quantile(0.50, sum by (le, role) (rate(knext_db_wake_duration_seconds_bucket[5m])))',
  /** p99 DB-wake duration (seconds), by pool role. */
  dbWakeP99ByRole:
    'histogram_quantile(0.99, sum by (le, role) (rate(knext_db_wake_duration_seconds_bucket[5m])))',
} as const;
