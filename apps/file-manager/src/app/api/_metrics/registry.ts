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
