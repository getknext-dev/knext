import { NextResponse } from 'next/server';
import client from 'prom-client';

// Initialize default Node.js metrics (memory, CPU, event loop, etc.)
const register = new client.Registry();
client.collectDefaultMetrics({ register });

// ----- Custom kn-next bytecode cache metrics -----

const appName = process.env.KN_APP_NAME ?? 'unknown';

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

const cacheWriteCount = new client.Counter({
    name: 'kn_next_bytecode_cache_write_count',
    help: 'Number of new bytecode files written to cache',
    labelNames: ['app'] as const,
    registers: [register],
});

// ----- Initialize metrics on first import -----

let initialized = false;

function initMetrics() {
    if (initialized) return;
    initialized = true;

    const cachePath = process.env.NODE_COMPILE_CACHE;
    if (!cachePath) {
        cacheWarmStart.labels({ app: appName }).set(0);
        return;
    }

    try {
        const fs = require('node:fs');
        const path = require('node:path');

        if (!fs.existsSync(cachePath)) {
            cacheWarmStart.labels({ app: appName }).set(0);
            return;
        }

        const files = fs.readdirSync(cachePath, { recursive: true }) as string[];
        const cacheFiles = files.filter((f: string) => f.endsWith('.cache') || f.endsWith('.blob'));
        const buildId = path.basename(cachePath);

        let totalSize = 0;
        for (const file of cacheFiles) {
            try {
                const stat = fs.statSync(path.join(cachePath, file));
                totalSize += stat.size;
            } catch { /* skip */ }
        }

        const isWarm = cacheFiles.length > 0;
        cacheFilesTotal.labels({ app: appName, build_id: buildId }).set(cacheFiles.length);
        cacheSizeBytes.labels({ app: appName, build_id: buildId }).set(totalSize);
        cacheWarmStart.labels({ app: appName }).set(isWarm ? 1 : 0);

        // Record startup duration based on process uptime
        const uptimeSeconds = process.uptime();
        startupDuration.labels({
            cache_status: isWarm ? 'warm' : 'cold',
            app: appName,
        }).observe(uptimeSeconds);

        console.log(
            `[kn-next] Metrics initialized: ${isWarm ? '🔥 WARM' : '❄️ COLD'} ` +
            `(${cacheFiles.length} files, ${(totalSize / 1024).toFixed(1)} KB, ${uptimeSeconds.toFixed(2)}s startup)`
        );
    } catch (err) {
        console.error('[kn-next] Error initializing bytecode metrics:', err);
    }
}

// Initialize on first load
initMetrics();

export async function GET() {
    const metrics = await register.metrics();
    return new NextResponse(metrics, {
        headers: { 'Content-Type': register.contentType },
    });
}
