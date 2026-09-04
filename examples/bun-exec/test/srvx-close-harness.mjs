// Real-srvx variant of drain-harness.mjs (#467). The mock drain-harness serves
// the app via a raw `Bun.serve` (native `.stop()`), so it never exercises the
// entry's ACTUAL coupling: `srvx/bun` `serve` + the `{ stop: (force) =>
// appSrvx.close(force) }` adaptation. A srvx pin bump that changed `close()`
// semantics (no longer draining in-flight on `close()`, or no longer force-closing
// on `close(true)`, or re-enabling its own SIGTERM handler) would pass every mock
// test while silently breaking the SIGTERM drain contract. This harness closes
// that gap: the app listener is the REAL srvx serve exactly as knext-bun-entry.mjs
// wires it, so `runtime-contract.test.ts` can drive drain + hardcap against the
// live srvx `close()`.
import { serve } from 'srvx/bun';
import {
  checkBearer,
  createGracefulShutdown,
  createMetricsState,
  drainPending,
  METRICS_CONTENT_TYPE,
  observeRequest,
  renderMetrics,
} from '../runtime-contract.mjs';

// 0 → the OS assigns a free port (#678). A fixed fallback is how two concurrent
// CI jobs on one runner collide; the LISTENING line below reports what was
// actually bound, so the spec never has to assume.
const PORT = Number(process.env.PORT ?? 0);
const METRICS_PORT = Number(process.env.METRICS_PORT ?? 0);
const GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 25_000);
const HOSTNAME = '127.0.0.1';

const metrics = createMetricsState();

// Stub router — identical shape to drain-harness.mjs. /slow sleeps so a SIGTERM
// can land mid-flight; /hang never resolves so the hardcap path can be exercised.
async function app(req) {
  const url = new URL(req.url);
  if (url.pathname === '/slow') {
    await new Promise((r) => setTimeout(r, 2000));
    return new Response('drained-ok', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  }
  if (url.pathname === '/hang') {
    await new Promise(() => {}); // never resolves → forces the hardcap
    return new Response('unreachable');
  }
  if (url.pathname === '/api/health') {
    return Response.json({ status: 'ok', target: 'bun-exec' });
  }
  if (url.pathname === '/api/cache/invalidate' && req.method === 'POST') {
    const denied = checkBearer(req, process.env.CACHE_INVALIDATE_TOKEN);
    if (denied) return denied;
    return Response.json({ invalidated: true });
  }
  return new Response('<h1>knext bun-exec</h1>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
}

// ── The REAL app listener: srvx/bun serve + in-flight middleware, exactly as
//    knext-bun-entry.mjs wires it (its own graceful shutdown disabled so OURS owns
//    exit). This is what makes this harness exercise srvx `close()` for real.
const appSrvx = serve({
  port: PORT,
  hostname: HOSTNAME,
  fetch: app,
  gracefulShutdown: false,
  silent: true,
  middleware: [
    // Mirrors knext-bun-entry.mjs's middleware, including the status_class +
    // duration recording (#792) — a harness that counts differently from the
    // entry is a harness that proves something the binary does not do.
    async (_req, next) => {
      metrics.inflight++;
      const startedNs = process.hrtime.bigint();
      const elapsed = () => Number(process.hrtime.bigint() - startedNs) / 1e9;
      try {
        const res = await next();
        observeRequest(metrics, res?.status ?? 200, elapsed());
        return res;
      } catch (err) {
        observeRequest(metrics, 500, elapsed());
        throw err;
      } finally {
        metrics.inflight--;
      }
    },
  ],
});
const appServer = {
  port: PORT || appSrvx.bun?.server?.port,
  stop: (force) => appSrvx.close(force),
};

const metricsServer = Bun.serve({
  port: METRICS_PORT,
  hostname: HOSTNAME,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/metrics' && req.method === 'GET') {
      return new Response(renderMetrics(metrics), {
        status: 200,
        headers: { 'content-type': METRICS_CONTENT_TYPE },
      });
    }
    return new Response('Not Found', { status: 404 });
  },
});

console.log(`LISTENING:${appServer.port} METRICS:${metricsServer.port}`);

const shutdown = createGracefulShutdown({
  appServers: [appServer],
  metricsServer,
  drainTasks: drainPending,
  graceMs: GRACE_MS,
  log: (m) => console.log(m),
  exit: (code) => process.exit(code),
});
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
