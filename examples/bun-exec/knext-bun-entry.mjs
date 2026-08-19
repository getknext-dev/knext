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
import { existsSync } from 'node:fs';
import { useNitroApp } from 'nitro/app';
import { serve } from 'srvx/bun';
import {
  createGracefulShutdown,
  createMetricsState,
  drainPending,
  METRICS_CONTENT_TYPE,
  renderMetrics,
  resolveAssetAnchor,
  resolveBindHost,
} from './runtime-contract.mjs';

// ── #460 bug 3: static assets resolved against the BUILD MACHINE's path ─────
//
// Nitro prepends `globalThis.__nitro_main__ = import.meta.url` to this entry,
// and its public-asset reader does:
//
//     const serverDir = dirname(fileURLToPath(globalThis.__nitro_main__))
//     return fsp.readFile(resolve(serverDir, assets[id].path))   // ../public/…
//
// `bun build --compile` BAKES that `import.meta.url` as the absolute
// `file:///…/examples/bun-exec/.output/server/index.mjs` of the machine that
// built the binary. So the shipped container asked for
// `/Users/<builder>/…/.output/public/_next/static/chunks/index-*.js` and every
// single static asset 500'd with ENOENT — while `/` still returned correct SSR
// HTML, which is exactly why nobody noticed: the page renders, then loads no
// JS and never hydrates.
//
// The routes themselves ARE embedded in the binary (that is what #460 fixed and
// what self-containment means); this is the OTHER half of the ship shape, the
// `.output/public` dir that travels beside the binary.
//
// The decision lives in `resolveAssetAnchor` (runtime-contract.mjs), not here,
// because it cannot be tested from this file — importing this entry pulls in
// nitro + vinext — and because its only failure mode is silence. Exactly what
// it does, in order:
//
//   1. If the BAKED root really has `../public` AND this is not a compiled
//      binary, keep it. A non-compiled `bun run /abs/path/.output/server/
//      index.mjs` from an unrelated cwd has a CORRECT baked value and is left
//      completely alone. The compiled carve-out is what stops a binary run on
//      the machine that BUILT it from silently serving the build tree instead
//      of the assets shipped beside it; when both roots exist the co-located
//      one wins and the runtime warns.
//   2. Otherwise anchor on `dirname(process.execPath)` — the executable's own
//      directory, which is the ship shape README and Dockerfile document
//      (binary beside `.output/public`). Anchoring on the EXECUTABLE rather than
//      cwd is what makes the binary portable: `docker run -w /elsewhere`, a
//      systemd unit with an unrelated WorkingDirectory, or `cd / && /app/server`
//      all still serve. `<dir>/.output/server` need NOT exist — only its dirname
//      is used — which is why the container ships public/ and no server/.
//   3. If neither has the layout, WARN LOUDLY and keep the baked value. Assets
//      are unservable either way; the one thing that must not happen is the
//      silent version of this bug shipping twice.
//
// This assignment has no ordering hazard: nitro's `globalThis.__nitro_main__ =
// import.meta.url` is PREPENDED to this module (so it has already run when this
// statement executes, which is what makes reading the baked value here sound),
// and nitro's asset reader dereferences the global inside `readAsset()`, per
// request — never at module init.
const assetAnchor = resolveAssetAnchor({
  bakedMain: globalThis.__nitro_main__,
  execPath: process.execPath,
  exists: existsSync,
  cwd: process.cwd(),
});
if (assetAnchor.warning) console.warn(assetAnchor.warning);
if (assetAnchor.mainUrl) globalThis.__nitro_main__ = assetAnchor.mainUrl;

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
//
// Prefer the PORT we passed to serve() over srvx's internal `.bun.server.port`
// (#467): the internal shape is a transitive-dep implementation detail. We only
// dip into it for the ephemeral case (PORT=0), where the real bound port is
// assigned by the OS and is not knowable from PORT alone.
const appServer = {
  port: PORT || appSrvx.bun?.server?.port,
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

// ── Eager app-graph warmup ───────────────────────────────────────────────────
// Nitro reaches the application through ONE lazy `import()` (the `_ssr` chunk),
// evaluated on the FIRST matched request. Measured on OKE (2026-08-18): that
// put ~1.2 s of module evaluation AFTER the pod reported Ready — the pod passes
// its readiness probe on a bound port whose app has not been evaluated, and the
// first user pays the difference. Node's standalone boots eagerly BEFORE
// readiness, which is exactly the asymmetry the cold-start A/B surfaced.
//
// Fired CONCURRENTLY, not awaited: the port is already bound (srvx binds
// synchronously above), so this evaluation overlaps the queue-proxy probe
// interval and activator forwarding latency instead of adding to them. If a
// real request lands first, both share the same module-evaluation promise —
// dynamic `import()` of one specifier is evaluated once.
//
// In-process via `nitro.fetch` with a synthetic Request — no self-HTTP, no
// dependence on the listener. The #460-bug-2 caveat (raw `nitro.fetch` misses
// srvx's request-context augmentation) is tolerable HERE and only here: even if
// the warm route touches an srvx-only field and throws, the module graph has
// already evaluated by then, which is the entire point. Hence the try/catch —
// a warmup failure must never take down a healthy listener.
// Comma-separated: each path warms a different subsystem. `/` warms the module
// graph AND the page-render path and pre-fills the page cache; adding e.g.
// `/api/health/deep` also establishes the DB pool, so the first user's query
// skips the connection handshake. Paths warm SEQUENTIALLY — one in-flight warm
// at a time on a contended cold CPU — but the first fires immediately.
const WARM_PATHS = (process.env.KNEXT_WARM_PATH ?? '/api/health')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);
if (process.env.KNEXT_EAGER_WARM !== '0') {
  (async () => {
    for (const path of WARM_PATHS) {
      const warmT0 = Date.now();
      try {
        const res = await nitro.fetch(new Request(`http://127.0.0.1:${appServer.port}${path}`));
        console.log(`WARMED:${path} status=${res.status} ms=${Date.now() - warmT0}`);
      } catch (err) {
        console.log(
          `WARMED:${path} status=error ms=${Date.now() - warmT0} (${err?.message ?? err})`,
        );
      }
    }
  })();
}

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
