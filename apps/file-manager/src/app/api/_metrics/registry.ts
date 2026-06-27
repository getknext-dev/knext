import * as fs from 'node:fs';
import * as path from 'node:path';
import client from 'prom-client';
import type { Metric, Rating } from '../rum/validate';

/**
 * Shared prom-client registry (#94).
 *
 * Previously the registry + metrics lived inline in the /api/metrics route.
 * They are extracted here so the RUM ingest route (/api/rum) can record Web
 * Vitals into the SAME registry — the series then merge automatically into
 * register.metrics() served on the existing /api/metrics scrape.
 *
 * Behavior of the existing bytecode/cache series is unchanged.
 */

export const register = new client.Registry();
client.collectDefaultMetrics({ register });

// ----- Custom kn-next bytecode cache metrics -----

export const appName = process.env.KN_APP_NAME ?? 'unknown';
const cachePath = process.env.NODE_COMPILE_CACHE ?? '';
export const buildId = cachePath ? path.basename(cachePath) : 'none';

export const startupDuration = new client.Histogram({
  name: 'kn_next_startup_duration_seconds',
  help: 'Time for the Next.js server to become ready',
  labelNames: ['cache_status', 'app'] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export const cacheFilesTotal = new client.Gauge({
  name: 'kn_next_bytecode_cache_files_total',
  help: 'Number of files in the V8 bytecode cache',
  labelNames: ['app', 'build_id'] as const,
  registers: [register],
});

export const cacheSizeBytes = new client.Gauge({
  name: 'kn_next_bytecode_cache_size_bytes',
  help: 'Total size of the bytecode cache in bytes',
  labelNames: ['app', 'build_id'] as const,
  registers: [register],
});

export const cacheWarmStart = new client.Gauge({
  name: 'kn_next_bytecode_cache_warm_start',
  help: 'Whether the cache was warm (1) or cold (0) at startup',
  labelNames: ['app'] as const,
  registers: [register],
});

export const cacheWriteCount = new client.Counter({
  name: 'kn_next_bytecode_cache_write_count',
  help: 'Number of new bytecode files written to cache',
  labelNames: ['app'] as const,
  registers: [register],
});

// ----- Server-side RED metrics (request Rate / Error / Duration) -----
//
// These are the server-observed counterpart to the client RUM histograms.
// Without them the availability + latency SLIs in docs/observability/slos.md
// cannot be computed from the scrape (RUM is client-sampled and absent at
// scale-to-zero / cold start). Cardinality is bounded on purpose:
//   - `app` is the server env (KN_APP_NAME), so a Prometheus scraping >1 knext
//     app can aggregate per-app — the SLO alerts group `... by (app)`.
//   - `route` is a server-mapped template (e.g. "/dashboard"), never a raw URL
//   - `status_class` is the HTTP status class ("2xx".."5xx"), never the raw code
//   - `method` is the HTTP verb
// No user/session/query labels.

const RED_LABELS = ['app', 'method', 'route', 'status_class'] as const;

export const httpRequestsTotal = new client.Counter({
  name: 'kn_next_http_requests_total',
  help: 'Total HTTP requests handled by the app, by method/route/status class.',
  labelNames: RED_LABELS,
  registers: [register],
});

export const httpRequestDuration = new client.Histogram({
  name: 'kn_next_http_request_duration_seconds',
  help: 'HTTP request handling duration in seconds, by method/route/status class.',
  labelNames: RED_LABELS,
  // Web-request latency scale: sub-ms-ish floor up to slow/cold paths.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export interface HttpRequestObservation {
  method: string;
  route: string;
  status: number;
  durationSeconds: number;
}

/**
 * Buckets an HTTP status code into its class ("1xx".."5xx"). Anything outside
 * 100-599 is reported as "other" so a bad value can never create unbounded
 * series. This is the ONLY status label we emit.
 */
export function statusClass(status: number): string {
  if (status >= 100 && status < 600) {
    return `${Math.floor(status / 100)}xx`;
  }
  return 'other';
}

/**
 * Records one server-side request: increments the request counter and observes
 * the duration histogram against the same bounded label set. This is a
 * FIXED-SCHEMA aggregator — it can only `inc()`/`observe()` pre-declared
 * series, never create new ones, and has no side effects on cache/storage.
 */
export function observeHttpRequest(obs: HttpRequestObservation): void {
  const labels = {
    app: appName,
    method: obs.method,
    route: obs.route,
    status_class: statusClass(obs.status),
  };
  httpRequestsTotal.labels(labels).inc();
  httpRequestDuration.labels(labels).observe(obs.durationSeconds);
}

/**
 * Wraps a Next.js Route Handler so that every invocation records a server-side
 * RED sample (count + duration + status class) for the given `route` template.
 * Behavior is fully preserved: the wrapper returns the handler's own Response
 * (or rethrows), only adding instrumentation. Errors are recorded as 5xx and
 * re-thrown so the framework's error handling is unchanged.
 */
export function withRedMetrics<A extends unknown[]>(
  route: string,
  handler: (...args: A) => Response | Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A): Promise<Response> => {
    const start = process.hrtime.bigint();
    const method =
      args[0] && typeof args[0] === 'object' && 'method' in (args[0] as object)
        ? String((args[0] as { method?: string }).method ?? 'GET')
        : 'GET';
    try {
      const res = await handler(...args);
      observeHttpRequest({
        method,
        route,
        status: res.status,
        durationSeconds: Number(process.hrtime.bigint() - start) / 1e9,
      });
      return res;
    } catch (err) {
      observeHttpRequest({
        method,
        route,
        status: 500,
        durationSeconds: Number(process.hrtime.bigint() - start) / 1e9,
      });
      throw err;
    }
  };
}

// ----- Web Vitals (RUM) histograms (#94) -----
//
// One histogram per Core Web Vital — buckets differ by unit:
//   CLS                 → unitless (~0-1)
//   LCP / FCP / TTFB    → milliseconds (page-load scale)
//   INP                 → milliseconds (interaction scale)
// Labels are STRICTLY bounded: {app, route, rating}. `app` comes from the
// server env (KN_APP_NAME), never the client; route is a server-mapped
// template; rating is from a closed allow-list. No user/session/URL labels.

const RUM_LABELS = ['app', 'route', 'rating'] as const;

const MS_BUCKETS = [50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000];
const INP_BUCKETS = [50, 100, 200, 300, 500, 1000, 2000, 4000];
const CLS_BUCKETS = [0.01, 0.05, 0.1, 0.15, 0.25, 0.5, 1];

const webVitalsByMetric: Record<Metric, client.Histogram<string>> = {
  LCP: new client.Histogram({
    name: 'kn_next_web_vitals_lcp',
    help: 'Largest Contentful Paint (ms)',
    labelNames: RUM_LABELS,
    buckets: MS_BUCKETS,
    registers: [register],
  }),
  FCP: new client.Histogram({
    name: 'kn_next_web_vitals_fcp',
    help: 'First Contentful Paint (ms)',
    labelNames: RUM_LABELS,
    buckets: MS_BUCKETS,
    registers: [register],
  }),
  TTFB: new client.Histogram({
    name: 'kn_next_web_vitals_ttfb',
    help: 'Time To First Byte (ms)',
    labelNames: RUM_LABELS,
    buckets: MS_BUCKETS,
    registers: [register],
  }),
  INP: new client.Histogram({
    name: 'kn_next_web_vitals_inp',
    help: 'Interaction to Next Paint (ms)',
    labelNames: RUM_LABELS,
    buckets: INP_BUCKETS,
    registers: [register],
  }),
  CLS: new client.Histogram({
    name: 'kn_next_web_vitals_cls',
    help: 'Cumulative Layout Shift (unitless)',
    labelNames: RUM_LABELS,
    buckets: CLS_BUCKETS,
    registers: [register],
  }),
};

export interface WebVitalObservation {
  metric: Metric;
  route: string;
  rating: Rating;
  value: number;
}

/**
 * Records a single Web Vital sample. This is a FIXED-SCHEMA, lossy aggregator:
 * the only effect it can have is `observe()` on one of a closed set of
 * pre-declared histograms — it cannot create new series, write storage, or
 * touch cache. The label values must already be validated/normalized by the
 * caller (see ../rum/validate.ts).
 */
export function observeWebVital(obs: WebVitalObservation): void {
  const histogram = webVitalsByMetric[obs.metric];
  if (!histogram) return; // defense-in-depth: unknown metric is dropped
  histogram.labels({ app: appName, route: obs.route, rating: obs.rating }).observe(obs.value);
}

// ----- Cache scanner: counts V8 compile cache files -----

export function scanCacheDir(): { fileCount: number; totalSize: number } {
  if (!cachePath || !fs.existsSync(cachePath)) {
    return { fileCount: 0, totalSize: 0 };
  }

  let fileCount = 0;
  let totalSize = 0;

  // Recursively walk the cache directory
  // V8 compile cache uses hex-named files without extensions (e.g. '712488c2')
  // inside a version-specific subdirectory like v24.13.0-x64-cf738c9d-0
  function walk(dir: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile()) {
          fileCount++;
          try {
            const stat = fs.statSync(fullPath);
            totalSize += stat.size;
          } catch {
            /* skip */
          }
        } else if (entry.isDirectory() && entry.name !== 'lost+found') {
          walk(fullPath);
        }
      }
    } catch {
      /* skip unreadable dirs */
    }
  }

  walk(cachePath);
  return { fileCount, totalSize };
}

// ----- Record startup metrics once -----

let startupRecorded = false;

export function recordStartupMetrics() {
  if (startupRecorded) return;
  startupRecorded = true;

  const { fileCount } = scanCacheDir();
  const isWarm = fileCount > 0;

  cacheWarmStart.labels({ app: appName }).set(isWarm ? 1 : 0);

  const uptimeSeconds = process.uptime();
  startupDuration
    .labels({
      cache_status: isWarm ? 'warm' : 'cold',
      app: appName,
    })
    .observe(uptimeSeconds);
}

// Record startup on first import
recordStartupMetrics();
