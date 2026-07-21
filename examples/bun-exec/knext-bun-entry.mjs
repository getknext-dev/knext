// knext bun entry — the bespoke Nitro server entry for the opt-in `bun-exec`
// build target (ADR-0036). `vite.config.ts` points nitro's `bun` preset at this
// file (`nitro({ preset: "bun", entry: "./knext-bun-entry.mjs" })`), so the
// build inlines this wrapper AROUND vinext's real request handler and
// `bun build --compile --bytecode` bakes the result into one executable.
//
// Why a bespoke entry: vinext is Vite/rolldown and ignores knext's webpack
// adapter hooks, so it cannot re-provide the RuntimeContract the node supervisor
// gives (metrics, drain, auth). Nitro exposes the WinterCG handler via
// `useNitroApp().fetch`, and a Nitro server entry is a replaceable template — so
// this ~40-line file wraps that handler with the contract instead of hooking it.
//
// Env-injection contract (RuntimeContract item 6 — operator-supplied):
//   PORT               app listen port           (default 3000)
//   HOSTNAME           app + metrics bind host    (default 0.0.0.0). Honoured
//                      ONLY when it is an explicit bind/loopback address
//                      (0.0.0.0, ::, 127.0.0.1, ::1, localhost). A k8s-injected
//                      pod-name HOSTNAME is NOT a bind address — it falls
//                      through to 0.0.0.0 (see resolveBindHost), matching the
//                      node path so the listener stays reachable in-cluster.
//   METRICS_PORT       Prometheus port            (default 9091)
//   SHUTDOWN_GRACE_MS  drain hardcap in ms        (default 25000)
//   CACHE_INVALIDATE_TOKEN  read by the app route, not here (see app/api/cache).

import { useNitroApp } from 'nitro/app';
import {
  createGracefulShutdown,
  createMetricsState,
  drainPending,
  METRICS_CONTENT_TYPE,
  renderMetrics,
  resolveBindHost,
} from './runtime-contract.mjs';

const PORT = Number(process.env.PORT ?? 3000);
// Bind to 0.0.0.0 unless HOSTNAME is an EXPLICIT bind/loopback address. k8s sets
// HOSTNAME=<pod-name> in every pod; binding to a pod name makes the server
// unreachable on 127.0.0.1 / the pod IP (mirrors the node path — see env.ts).
const HOSTNAME = resolveBindHost(process.env);
const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9091);
const GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 25_000);

// biome-ignore lint/correctness/useHookAtTopLevel: useNitroApp() is Nitro's server-app accessor, not a React hook — the "use" prefix is coincidental.
const nitro = useNitroApp();
const metrics = createMetricsState();

// ── App listener — wraps vinext's real handler, counts in-flight requests ────
const appServer = Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  async fetch(req) {
    metrics.requestsTotal++;
    metrics.inflight++;
    try {
      return await nitro.fetch(req);
    } finally {
      metrics.inflight--;
    }
  },
});

// ── (2) In-process Prometheus :9091 — a SECOND Bun.serve, bound at listen-time
// so a scrape while the runtime is up is always answered (RuntimeContract §2).
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

// Startup-order signal (RuntimeContract startup-order test): both listeners are
// bound synchronously above BEFORE this line prints — nothing accepts a first
// request before the app + :9091 listeners are up.
console.log(`LISTENING:${appServer.port} METRICS:${metricsServer.port}`);

// ── (3) SIGTERM / SIGINT graceful drain ─────────────────────────────────────
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
