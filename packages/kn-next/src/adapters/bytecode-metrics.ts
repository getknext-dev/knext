import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Bytecode cache metrics for Prometheus.
 *
 * Collects metrics about Node.js V8 compile cache (NODE_COMPILE_CACHE) performance,
 * including startup duration, cache warmth, file counts, and cache writes.
 */

const APP_NAME = process.env.KN_APP_NAME || process.env.npm_package_name || 'unknown';
const BUILD_ID = process.env.NODE_COMPILE_CACHE?.split('/').pop() || 'unknown';

// Create a dedicated registry
export const metricsRegistry = new Registry();

// Collect default Node.js process metrics (CPU, memory, event loop, GC)
collectDefaultMetrics({ register: metricsRegistry });

// --- Custom Bytecode Cache Metrics ---

/** Startup duration from process start to server ready */
export const startupDuration = new Histogram({
  name: 'kn_next_startup_duration_seconds',
  help: 'Time from process start to server ready (seconds)',
  labelNames: ['app', 'build_id', 'cache_status'] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [metricsRegistry],
});

/** Number of cached bytecode files found at startup */
export const cacheFilesTotal = new Gauge({
  name: 'kn_next_bytecode_cache_files_total',
  help: 'Number of cached bytecode files at startup',
  labelNames: ['app', 'build_id'] as const,
  registers: [metricsRegistry],
});

/** Total size of bytecode cache on disk */
export const cacheSizeBytes = new Gauge({
  name: 'kn_next_bytecode_cache_size_bytes',
  help: 'Total size of bytecode cache on disk (bytes)',
  labelNames: ['app', 'build_id'] as const,
  registers: [metricsRegistry],
});

/** Whether pod started with pre-existing cache */
export const cacheWarmStart = new Gauge({
  name: 'kn_next_bytecode_cache_warm_start',
  help: '1 if pod started with pre-existing bytecode cache, 0 if cold',
  labelNames: ['app', 'build_id'] as const,
  registers: [metricsRegistry],
});

/** Files written to cache during pod lifetime */
export const cacheWriteCount = new Counter({
  name: 'kn_next_bytecode_cache_write_count',
  help: 'Files written to bytecode cache during pod lifetime',
  labelNames: ['app', 'build_id'] as const,
  registers: [metricsRegistry],
});

/**
 * Scan the bytecode cache directory and set initial metrics.
 * Returns { fileCount, totalBytes, isWarm }.
 */
function scanCacheDirectory(cacheDir: string): {
  fileCount: number;
  totalBytes: number;
  isWarm: boolean;
} {
  try {
    const files = readdirSync(cacheDir, { recursive: true }) as string[];
    let totalBytes = 0;
    let fileCount = 0;

    for (const file of files) {
      try {
        const filePath = join(cacheDir, file);
        const stat = statSync(filePath);
        if (stat.isFile()) {
          totalBytes += stat.size;
          fileCount++;
        }
      } catch {
        // Skip files we can't stat
      }
    }

    return { fileCount, totalBytes, isWarm: fileCount > 0 };
  } catch {
    // Cache directory doesn't exist or is empty
    return { fileCount: 0, totalBytes: 0, isWarm: false };
  }
}

/**
 * Watch the cache directory for new file writes.
 * Uses periodic polling since fs.watch doesn't work on all volume types.
 */
function watchCacheWrites(cacheDir: string): void {
  let lastCount = 0;

  const checkInterval = setInterval(() => {
    try {
      const { fileCount } = scanCacheDirectory(cacheDir);
      const newFiles = fileCount - lastCount;

      if (newFiles > 0) {
        cacheWriteCount.inc({ app: APP_NAME, build_id: BUILD_ID }, newFiles);
        lastCount = fileCount;

        // Update the current totals too
        cacheFilesTotal.set({ app: APP_NAME, build_id: BUILD_ID }, fileCount);
      }
    } catch {
      // Silently ignore errors in background polling
    }
  }, 10_000); // Poll every 10 seconds

  // Don't let this interval prevent process exit
  checkInterval.unref();
}

/**
 * Initialize bytecode cache metrics.
 * Call this at server startup BEFORE the server starts listening.
 */
export function initBytecodeCacheMetrics(): void {
  const cacheDir = process.env.NODE_COMPILE_CACHE;

  if (!cacheDir) {
    console.info('[kn-next] Bytecode cache metrics: NODE_COMPILE_CACHE not set, skipping');
    cacheWarmStart.set({ app: APP_NAME, build_id: BUILD_ID }, 0);
    return;
  }

  console.info(`[kn-next] Bytecode cache metrics: scanning ${cacheDir}`);

  const { fileCount, totalBytes, isWarm } = scanCacheDirectory(cacheDir);

  // Set initial metrics
  cacheFilesTotal.set({ app: APP_NAME, build_id: BUILD_ID }, fileCount);
  cacheSizeBytes.set({ app: APP_NAME, build_id: BUILD_ID }, totalBytes);
  cacheWarmStart.set({ app: APP_NAME, build_id: BUILD_ID }, isWarm ? 1 : 0);

  console.info(
    `[kn-next] Bytecode cache: ${isWarm ? '🔥 WARM' : '❄️ COLD'} start ` +
      `(${fileCount} files, ${(totalBytes / 1024).toFixed(1)} KB)`,
  );

  // Start watching for new cache writes
  watchCacheWrites(cacheDir);
}

/**
 * Record that the server is ready (for startup duration metric).
 * Call this when the HTTP server starts listening.
 */
export function recordServerReady(): void {
  const cacheDir = process.env.NODE_COMPILE_CACHE;
  const cacheStatus = cacheDir ? 'warm' : 'cold';

  // process.uptime() gives seconds since process start
  const uptimeSeconds = process.uptime();

  startupDuration.observe(
    { app: APP_NAME, build_id: BUILD_ID, cache_status: cacheStatus },
    uptimeSeconds,
  );

  console.info(
    `[kn-next] Server ready in ${(uptimeSeconds * 1000).toFixed(0)}ms (${cacheStatus} cache)`,
  );
}
