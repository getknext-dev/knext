/**
 * Self-contained supervisor — a dependency-free CommonJS preload (baked into
 * the compiled executable, same mechanism as `cache-control-normalize.cjs` and
 * `bun-keepalive-guard.cjs` in `standalone-compile.mjs`), loaded ONLY when
 * `--self-contained 1` is passed to the compile step.
 *
 * WHY THIS EXISTS (N2, #1457): the self-contained runtime image ships ONLY the
 * compiled executable + `public/` + `.next/static` (+ `native/`) — no
 * `.next/standalone/node_modules`, no `/app/node_modules`. The disk-mode image
 * gets graceful SIGTERM drain and a `:9464` metrics endpoint from a SEPARATE
 * supervisor process (`knext-standalone-entry.mjs`, importing
 * `@getknext/core/internal/node-server`) that spawns the compiled/uncompiled
 * server as a CHILD and depends on pino/prom-client/@opentelemetry/api,
 * resolved via a dedicated `npm install` stage and copied into
 * `/app/node_modules` in `Dockerfile.standalone.hbs`. That dependency closure
 * is exactly what self-contained mode must not ship.
 *
 * FOLD, NOT SIDECAR (jev pick: fold 0.87 vs sidecar 0.13, confidence 0.73 —
 * see the N2 PR body). A sidecar process that keeps pino/prom-client/otel
 * still needs `node_modules` on disk, which directly contradicts the "no
 * node_modules" exit criterion; making the sidecar dependency-free instead
 * gains nothing over folding the same dependency-free logic into the ONE
 * process that is already there. So: no second process, no spawn, no
 * `knext-standalone-entry.mjs` in the self-contained image at all — this
 * preload runs INSIDE the same process as the compiled Next server, and the
 * Dockerfile's ENTRYPOINT execs the compiled binary directly.
 *
 * Deliberately NOT feature-equivalent with the disk-mode supervisor: no
 * structured (pino) logging, no OTel, no DB-pool drain (self-contained mode
 * has no `@getknext/lib` on disk to load), no Prometheus client library — only
 * `node:http`/`node:process`. Full metrics/logging parity for self-contained
 * mode is tracked as follow-up tech debt (filed at sprint close per
 * `.claude/rules/workflow.md`), not hidden here.
 */

'use strict';

const INSTALLED = Symbol.for('knext.selfContainedSupervisor.installed');
const SERVER_REF = Symbol.for('knext.selfContainedSupervisor.server');

/** Hard cap for draining in-flight requests on SIGTERM, same default as node-server.ts. */
const DEFAULT_DRAIN_HARDCAP_MS = 10_000;
const DEFAULT_METRICS_PORT = 9464;

/**
 * @param {Record<string, string | undefined> | undefined} env
 * @returns {number}
 */
function drainHardcapMs(env) {
  const raw = env ? env.KNEXT_DRAIN_HARDCAP_MS : undefined;
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DRAIN_HARDCAP_MS;
}

/**
 * @param {Record<string, string | undefined> | undefined} env
 * @returns {number}
 */
function metricsPort(env) {
  const raw = env ? env.METRICS_PORT : undefined;
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_METRICS_PORT;
}

/**
 * The Prometheus text-exposition body this preload serves on `:9464`. Pure
 * (no I/O) so it is unit-testable without a real socket.
 *
 * @param {{ uptimeSeconds: number, draining: boolean }} state
 * @returns {string}
 */
function metricsBody(state) {
  return [
    '# HELP knext_up 1 if the process is serving requests, 0 while draining',
    '# TYPE knext_up gauge',
    `knext_up ${state.draining ? 0 : 1}`,
    '# HELP knext_self_contained_process_uptime_seconds Seconds since this process started',
    '# TYPE knext_self_contained_process_uptime_seconds counter',
    `knext_self_contained_process_uptime_seconds ${state.uptimeSeconds}`,
    '',
  ].join('\n');
}

/**
 * Start the dependency-free metrics HTTP server. Returns the server (for
 * shutdown/tests) or `undefined` when disabled via `KNEXT_SELF_CONTAINED_METRICS=0`.
 *
 * @param {{ env?: Record<string, string | undefined>, isDraining: () => boolean, http?: typeof import('node:http') }} [opts]
 */
function startMetricsServer(opts = {}) {
  const env = opts.env ?? process.env;
  if (env.KNEXT_SELF_CONTAINED_METRICS === '0') return undefined;
  const http = opts.http ?? require('node:http');
  const start = Date.now();
  const server = http.createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    const body = metricsBody({
      uptimeSeconds: (Date.now() - start) / 1000,
      draining: opts.isDraining(),
    });
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' }).end(body);
  });
  server.listen(metricsPort(env), '0.0.0.0');
  return server;
}

/**
 * Install the SIGTERM/SIGINT drain handler on `appServer` (the Next request
 * server this process already created). Stops accepting new connections
 * immediately, lets in-flight ones finish, and force-exits at the hardcap so a
 * stuck connection cannot block pod termination forever.
 *
 * @param {{ close: (cb: () => void) => void, closeAllConnections?: () => void }} appServer
 * @param {{ env?: Record<string, string | undefined>, metricsServer?: { close: () => void }, exit?: (code: number) => void, on?: typeof process.on }} [opts]
 * @returns {{ isDraining: () => boolean }}
 */
function installDrainHandler(appServer, opts = {}) {
  const env = opts.env ?? process.env;
  const exit = opts.exit ?? ((code) => process.exit(code));
  const on = opts.on ?? process.on.bind(process);
  let draining = false;
  let timer;

  function onSignal() {
    if (draining) return; // idempotent — a second signal must not double-fire
    draining = true;
    try {
      opts.metricsServer?.close();
    } catch {
      // metrics shutdown must never block the app drain
    }
    timer = setTimeout(() => {
      try {
        appServer.closeAllConnections?.();
      } catch {
        // best-effort; the exit below is the real backstop
      }
      exit(0);
    }, drainHardcapMs(env));
    // `timer.unref()` — if this is Node's Timer — so an already-idle process
    // is free to exit as soon as `close()`'s callback fires, rather than
    // waiting the full hardcap for a timer nothing else needs.
    timer.unref?.();
    appServer.close(() => {
      clearTimeout(timer);
      exit(0);
    });
  }

  on('SIGTERM', onSignal);
  on('SIGINT', onSignal);
  return { isDraining: () => draining };
}

/**
 * Preload side effect: wraps `http.createServer` so the FIRST server this
 * process creates (the Next request server) is captured, then wires the
 * drain handler + starts the metrics server. Idempotent; a second require of
 * this same module (bundlers can do that) is a no-op.
 *
 * @param {{ http?: typeof import('node:http'), env?: Record<string, string | undefined> }} [opts]
 */
function install(opts = {}) {
  const http = opts.http ?? require('node:http');
  if (http[INSTALLED]) return;
  http[INSTALLED] = true;
  const originalCreateServer = http.createServer;
  http.createServer = function createServer(...args) {
    const server = originalCreateServer.apply(this, args);
    if (!http[SERVER_REF]) {
      http[SERVER_REF] = server;
      let drain;
      const metrics = startMetricsServer({
        env: opts.env,
        isDraining: () => drain?.isDraining() ?? false,
        http,
      });
      drain = installDrainHandler(server, { env: opts.env, metricsServer: metrics });
    }
    return server;
  };
}

// DISCOVERED FACT (measured against a real next@16.3.5 standalone build,
// self-contained image, real docker + a real SIGTERM): Next's OWN
// `start-server.js` installs its own `SIGTERM`/`SIGINT` listeners (unless
// `NEXT_MANUAL_SIG_HANDLE` is set) that drain the server and then
// deliberately call `process.exit(143)` — "Exit with signal-based exit code
// … so that Node.js treats this as a signal termination" (its own comment).
// In DISK mode that is harmless: the supervisor is a separate PARENT process
// that spawns Next as a CHILD and exits 0 on its OWN account regardless of
// the child's exit code. In FOLD mode there is only one process, so Next's
// own `process.exit(143)` and this preload's `process.exit(0)` race — and
// measured, Next's synchronous exit consistently won (`docker wait` reported
// 143 even though this preload's drain handler ran and the in-flight request
// completed). Setting this BEFORE the body (`server.js`) evaluates makes Next
// skip installing its own handlers entirely, leaving this preload's drain
// handler as the sole owner of SIGTERM/SIGINT — restoring the same
// exit-0 contract the disk-mode supervisor provides.
process.env.NEXT_MANUAL_SIG_HANDLE = '1';

// Preload side effect: always installs (this file is only ever baked into a
// self-contained compile, so there is no runtime flag to gate it on the way
// the Bun keep-alive guard gates on Bun version).
install();

module.exports = {
  drainHardcapMs,
  metricsPort,
  metricsBody,
  startMetricsServer,
  installDrainHandler,
  install,
};
