// knext bun entry — the bespoke Nitro server entry for the opt-in `bun-exec`
// build target (ADR-0036). `vite.config.ts` points nitro's `bun` preset at this
// file (`nitro({ preset: "bun", entry: "./knext-bun-entry.mjs" })`), so the
// build inlines this wrapper AROUND vinext's real request handler and
// `bun build --compile --bytecode` bakes the result into one executable.
//
// Why a bespoke entry: vinext is Vite/rolldown and ignores knext's webpack
// adapter hooks, so it cannot re-provide the RuntimeContract the node supervisor
// gives (metrics, drain, auth). A Nitro server entry is a replaceable template,
// so this file wraps Nitro's REAL request pipeline with the contract instead of
// hooking it.
//
// IMPORTANT (#460 bug 2): do NOT call `useNitroApp().fetch(req)` from a raw
// `Bun.serve`. Nitro's default bun preset entry serves through srvx's `serve`
// (`srvx/bun`), which (a) augments the incoming Request with the `runtime`
// context + `waitUntil` Nitro/vinext route matching depends on, (b) runs
// registered middleware, and (c) normalises the handler's result via
// `toNativeResponse`. Skipping that (raw `Bun.serve` → `nitroApp.fetch`) makes
// Nitro answer a framework 404 (`{"error":true}`) for EVERY app route — the
// metrics listener still works, which is why the bug looked entry-shaped. So we
// delegate app serving to the SAME `srvx/bun` `serve` the default entry uses,
// and thread the RuntimeContract's in-flight counting through srvx MIDDLEWARE
// (its own SIGTERM/SIGINT graceful-shutdown is disabled so OUR drain owns exit).
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

// MUST be first (#460 bug 1). Nitro's DEFAULT bun entry opens with this import;
// it pulls in `#nitro-vite-setup`, which registers `globalThis.__nitro_vite_envs__`
// (vinext's ssr/rsc render services) and thereby keeps the ssr/rsc route chunks in
// the build graph. Without it, overriding nitro's `entry` with this file drops the
// vinext route wiring entirely → the compiled binary answers a framework 404 for
// every app route (no `_ssr` chunks are even emitted). With it, routes are bundled
// and the binary is self-contained.
import '#nitro/virtual/polyfills';
import { useNitroApp } from 'nitro/app';
import { serve } from 'srvx/bun';
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

// ── App listener — Nitro's REAL request pipeline via srvx/bun (#460 bug 2) ───
// `serve` is the exact code path the default bun preset entry uses; it wraps
// `nitro.fetch` with the srvx request-context augmentation + `toNativeResponse`
// that route matching needs. We add ONE srvx middleware for in-flight counting
// (RuntimeContract §2) and disable srvx's own graceful shutdown so OUR SIGTERM
// drain below owns the exit. `silent` suppresses srvx's listen banner (we print
// our own startup-order signal). srvx starts the Bun listener synchronously in
// the constructor, so it is bound before the log line below.
const appSrvx = serve({
  port: PORT,
  hostname: HOSTNAME,
  fetch: nitro.fetch,
  gracefulShutdown: false,
  silent: true,
  middleware: [
    async (_req, next) => {
      metrics.requestsTotal++;
      metrics.inflight++;
      try {
        return await next();
      } finally {
        metrics.inflight--;
      }
    },
  ],
});
// Adapt srvx's BunServer to the { port, stop(force) } shape the metrics log and
// the shared drain orchestrator (runtime-contract.mjs) expect. srvx `close()`
// also awaits its own waitUntil() tasks, so vinext `after()`/waitUntil drains.
const appServer = {
  port: appSrvx.bun.server.port,
  stop: (force) => appSrvx.close(force),
};

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
