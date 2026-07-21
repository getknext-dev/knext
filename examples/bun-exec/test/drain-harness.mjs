// Self-contained Bun harness that exercises the net-new knext RuntimeContract
// wiring WITHOUT a vinext build. It mirrors `knext-bun-entry.mjs` exactly —
// same two `Bun.serve` listeners, same shared `runtime-contract.mjs`, same
// drain hook — but swaps `useNitroApp()` for a tiny stub router (page, /slow,
// /api/health, /api/cache/invalidate). This is the SAME split the P2 spike
// proved: the pure-mechanism binary and the real-vinext binary passed the drain
// + metrics assertions identically, because the contract is handler-agnostic.
//
// So this harness proves items (2) metrics, (3) SIGTERM drain + hardcap, and
// (5) fail-closed auth end-to-end over real sockets under bun. The vinext
// handler COMPOSITION (that `useNitroApp().fetch` slots into the app listener)
// is proven separately by the P1a/P2 spikes and re-proven on OKE — see README.
import {
  checkBearer,
  createGracefulShutdown,
  createMetricsState,
  drainPending,
  METRICS_CONTENT_TYPE,
  renderMetrics,
} from '../runtime-contract.mjs';

const PORT = Number(process.env.PORT ?? 3000);
const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9091);
const GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 25_000);

const metrics = createMetricsState();

// Stub app router — stands in for vinext's `useNitroApp().fetch`.
async function app(req) {
  const url = new URL(req.url);
  if (url.pathname === '/slow') {
    await new Promise((r) => setTimeout(r, 2000));
    return new Response('drained-ok', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
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

const appServer = Bun.serve({
  port: PORT,
  async fetch(req) {
    metrics.requestsTotal++;
    metrics.inflight++;
    try {
      return await app(req);
    } finally {
      metrics.inflight--;
    }
  },
});

const metricsServer = Bun.serve({
  port: METRICS_PORT,
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
