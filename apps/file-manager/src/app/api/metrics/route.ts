import * as fs from 'node:fs';
import * as path from 'node:path';
import { NextResponse } from 'next/server';
import client from 'prom-client';

// Initialize default Node.js metrics (memory, CPU, event loop, etc.)
const register = new client.Registry();
client.collectDefaultMetrics({ register });

// ----- Custom kn-next bytecode cache metrics -----

const appName = process.env.KN_APP_NAME ?? 'unknown';
const cachePath = process.env.NODE_COMPILE_CACHE ?? '';
const buildId = cachePath ? path.basename(cachePath) : 'none';

const startupDuration = new client.Histogram({
  name: 'kn_next_startup_duration_seconds',
  help: 'Time for the Next.js server to become ready',
  labelNames: ['cache_status', 'app'] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

const cacheFilesTotal = new client.Gauge({
  name: 'kn_next_bytecode_cache_files_total',
  help: 'Number of files in the V8 bytecode cache',
  labelNames: ['app', 'build_id'] as const,
  registers: [register],
});

const cacheSizeBytes = new client.Gauge({
  name: 'kn_next_bytecode_cache_size_bytes',
  help: 'Total size of the bytecode cache in bytes',
  labelNames: ['app', 'build_id'] as const,
  registers: [register],
});

const cacheWarmStart = new client.Gauge({
  name: 'kn_next_bytecode_cache_warm_start',
  help: 'Whether the cache was warm (1) or cold (0) at startup',
  labelNames: ['app'] as const,
  registers: [register],
});

const _cacheWriteCount = new client.Counter({
  name: 'kn_next_bytecode_cache_write_count',
  help: 'Number of new bytecode files written to cache',
  labelNames: ['app'] as const,
  registers: [register],
});

// ----- Cache scanner: counts V8 compile cache files -----

function scanCacheDir(): { fileCount: number; totalSize: number } {
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

function recordStartupMetrics() {
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

export async function GET() {
  // Dynamically scan cache on every scrape so Prometheus gets current file count
  const { fileCount, totalSize } = scanCacheDir();
  cacheFilesTotal.labels({ app: appName, build_id: buildId }).set(fileCount);
  cacheSizeBytes.labels({ app: appName, build_id: buildId }).set(totalSize);

  const metrics = await register.metrics();
  return new NextResponse(metrics, {
    headers: { 'Content-Type': register.contentType },
  });
}
