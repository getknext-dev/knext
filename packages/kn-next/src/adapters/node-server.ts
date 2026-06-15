/**
 * Knative runtime entry for the Next.js standalone server.
 *
 * Responsibilities:
 *  1. Expose Prometheus metrics on :9091 (sidecar pattern — separate port from app).
 *  2. Spawn the Next.js standalone server.js produced by `next build` with
 *     output:'standalone'. The standalone server self-starts on $PORT (default 3000).
 *
 * The standalone server path can be overridden via STANDALONE_SERVER_PATH env var.
 * Default: ".next/standalone/server.js" (single-app repo).
 * Monorepo example: ".next/standalone/apps/file-manager/server.js"
 *
 * NOTE: The previous Nitro runtime entry was removed in the
 * vinext → official Next.js Adapter migration.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { resolve } from 'node:path';
import { collectDefaultMetrics, Registry } from 'prom-client';
import { buildChildEnv } from './env';
import { createLogger } from '../utils/logger';

const log = createLogger({ module: 'server' });
const METRICS_PORT = 9091;

// ── Prometheus metrics server on :9091 ────────────────────────────────────────
// Clean separation: Next.js standalone owns $PORT (3000), metrics owns 9091.
const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

const metricsServer = http.createServer(async (req, res) => {
  if (req.url === '/metrics' && req.method === 'GET') {
    res.setHeader('Content-Type', metricsRegistry.contentType);
    const metrics = await metricsRegistry.metrics();
    res.end(metrics);
    return;
  }
  res.writeHead(404);
  res.end('Not Found');
});

metricsServer.listen(METRICS_PORT, () => {
  log.info({ port: METRICS_PORT }, 'Prometheus metrics server started');
});

// ── Next.js standalone server ─────────────────────────────────────────────────
// `next build` with output:'standalone' emits server.js in .next/standalone/.
// We spawn it as a child process so SIGTERM can drain it cleanly before we exit.
const serverJs = resolve(
  process.cwd(),
  process.env.STANDALONE_SERVER_PATH ?? '.next/standalone/server.js',
);

log.info({ serverJs }, 'Starting Next.js standalone server');

const nextProc = spawn(process.execPath, [serverJs], {
  stdio: 'inherit',
  env: buildChildEnv(),
});

nextProc.on('error', (err) => {
  log.fatal({ err }, 'Failed to start Next.js standalone server');
  process.exit(1);
});

nextProc.on('exit', (code, signal) => {
  log.info({ code, signal }, 'Next.js standalone server exited');
  metricsServer.close();
  process.exit(code ?? 0);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
const shutdown = (signal: string) => {
  log.info({ signal }, 'Shutting down gracefully...');
  metricsServer.close();
  nextProc.kill('SIGTERM');
  // Give the child process time to drain in-flight requests before we exit.
  setTimeout(() => process.exit(0), 5000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
