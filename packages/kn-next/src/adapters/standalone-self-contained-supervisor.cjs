/**
 * Self-contained supervisor — a dependency-free CommonJS preload (baked into
 * the compiled executable, same mechanism as `cache-control-normalize.cjs` and
 * `bun-keepalive-guard.cjs` in `standalone-compile.mjs`), loaded ONLY when
 * `--self-contained 1` is passed to the compile step.
 *
 * WHY THIS EXISTS (N2, #1457): the self-contained runtime image ships ONLY the
 * compiled executable + `public/` + `.next/static` — no `native/` directory yet
 * (native addons like sharp currently FAIL the self-contained build outright
 * rather than being staged — see `Dockerfile.standalone.hbs`'s own note on the
 * self-contained stage; m4 round-2 fix: this comment used to say "(+ `native/`)",
 * which contradicted that), no `.next/standalone/node_modules`, no
 * `/app/node_modules`. The disk-mode image
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
 * mode is tracked as follow-up tech debt — filed as a GitHub issue in the
 * milestone (see the N2 PR body's Round 2 section for the number), not hidden
 * here.
 */

'use strict';

const INSTALLED = Symbol.for('knext.selfContainedSupervisor.installed');
const SERVER_REF = Symbol.for('knext.selfContainedSupervisor.server');
const EXIT_STATE = Symbol.for('knext.selfContainedSupervisor.exitState');

/**
 * Hard cap for draining in-flight requests on SIGTERM. Same default AND same
 * env var name as `node-server.ts`'s `SHUTDOWN_GRACE_MS` (round-2 fix, M1 —
 * the previous 10_000 default/`KNEXT_DRAIN_HARDCAP_MS` name silently shrank
 * the drain window by 60% relative to disk mode and `security.mdx:195`).
 * `KNEXT_DRAIN_HARDCAP_MS` is still honored as a fallback so an operator that
 * already set it keeps working, but `SHUTDOWN_GRACE_MS` takes precedence —
 * the same knob users are told about.
 */
const DEFAULT_DRAIN_HARDCAP_MS = 25_000;
const DEFAULT_METRICS_PORT = 9464;

/**
 * @param {Record<string, string | undefined> | undefined} env
 * @returns {number}
 */
function drainHardcapMs(env) {
  const e = env ?? {};
  const raw = e.SHUTDOWN_GRACE_MS ?? e.KNEXT_DRAIN_HARDCAP_MS;
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
  // m1 (round-2): an EADDRINUSE (or any other bind failure) on :9464 must not
  // crash the app — mirrors node-server.ts:317-320, which logs a warning and
  // continues rather than letting an uncaught 'error' event take the process
  // down. The metrics server is a diagnostic; the app itself is not.
  server.on('error', (err) => {
    // biome-ignore lint/suspicious/noConsole: dependency-free preload, no pino/logger available
    console.warn(
      `[knext] self-contained metrics endpoint failed to bind :${metricsPort(env)}: ${err && err.message ? err.message : err}`,
    );
  });
  server.listen(metricsPort(env), '0.0.0.0');
  return server;
}

/**
 * Wraps `process.exit` (once, idempotently — anchored on `globalThis` via
 * `process[EXIT_STATE]` the same way the http monkeypatch below anchors on
 * `http[INSTALLED]`/`http[SERVER_REF]`, per `.claude/rules/architecture.md`
 * §4's "no bare module-level `let` for a cross-require seam" rule) so that,
 * once shutdown has begun, Next's own SIGNAL-exit codes (143 for SIGTERM, 130
 * for SIGINT — `next/dist/server/lib/start-server.js`'s `cleanup()`) are
 * rewritten to 0. Every other exit code (including 128 for an unhandled
 * signal) passes through untouched, so a real crash still surfaces as a
 * non-zero exit.
 *
 * B1 round-2 fix: this preload used to set `NEXT_MANUAL_SIG_HANDLE=1` so
 * Next's own SIGTERM handler never ran, and drove the drain itself. That
 * dropped pending `after()`/`waitUntil` work — Next's own handler is what
 * awaits `nextServer.close()`, which runs `cleanupListeners.runAll()`. The
 * fix is to let Next's handler own the drain (so `after()` runs) and instead
 * normalize the exit code it produces, keeping the hardcap below as a
 * backstop in case that handler hangs.
 *
 * @param {{ process?: NodeJS.Process }} [opts]
 * @returns {{ normalize: boolean }} the shared, mutable state object — flip
 *   `.normalize = true` once a drain has started.
 */
function installExitNormalizer(opts = {}) {
  const proc = opts.process ?? process;
  if (!proc[EXIT_STATE]) {
    const state = { normalize: false };
    proc[EXIT_STATE] = state;
    const realExit = proc.exit.bind(proc);
    proc.exit = (code) => {
      if (state.normalize && (code === 143 || code === 130)) {
        return realExit(0);
      }
      return realExit(code);
    };
  }
  return proc[EXIT_STATE];
}

/**
 * Install the SIGTERM/SIGINT drain handler. Deliberately does NOT call
 * `appServer.close()` itself (round-2 fix, B1): Next's own SIGTERM handler —
 * which now runs, because this preload no longer sets
 * `NEXT_MANUAL_SIG_HANDLE` — already closes this same server and awaits
 * `nextServer.close()` (which drains pending `after()`/`waitUntil` work)
 * before it exits. Calling `appServer.close()` here too and exiting from OUR
 * callback would race that drain and could exit before `after()` settles —
 * the exact defect this fix corrects. So this handler exists only to:
 *   1. mark `draining` (for the `/metrics` gauge),
 *   2. close the metrics server,
 *   3. arm the exit-code normalizer (143/130 → 0) via `opts.armExitNormalizer`,
 *   4. provide the hardcap BACKSTOP — if nothing has exited the process by
 *      `drainHardcapMs`, force-close remaining connections and exit(0)
 *      itself, so a stuck `after()` or a hung request can't block pod
 *      termination past `terminationGracePeriodSeconds`.
 *
 * @param {{ close: (cb: () => void) => void, closeAllConnections?: () => void }} appServer
 * @param {{ env?: Record<string, string | undefined>, metricsServer?: { close: () => void }, exit?: (code: number) => void, on?: typeof process.on, armExitNormalizer?: () => void }} [opts]
 * @returns {{ isDraining: () => boolean }}
 */
function installDrainHandler(appServer, opts = {}) {
  const env = opts.env ?? process.env;
  const exit = opts.exit ?? ((code) => process.exit(code));
  const on = opts.on ?? process.on.bind(process);
  const armExitNormalizer = opts.armExitNormalizer ?? (() => {});
  let draining = false;
  let timer;

  function onSignal() {
    if (draining) return; // idempotent — a second signal must not double-fire
    draining = true;
    armExitNormalizer();
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
    // is free to exit as soon as Next's own handler finishes, rather than
    // waiting the full hardcap for a timer nothing else needs.
    timer.unref?.();
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
 * @param {{ http?: typeof import('node:http'), env?: Record<string, string | undefined>, process?: NodeJS.Process }} [opts]
 */
function install(opts = {}) {
  const http = opts.http ?? require('node:http');
  const exitState = installExitNormalizer({ process: opts.process });
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
      drain = installDrainHandler(server, {
        env: opts.env,
        metricsServer: metrics,
        armExitNormalizer: () => {
          exitState.normalize = true;
        },
      });
    }
    return server;
  };
}

// DISCOVERED FACT (measured against a real next@16.3.5 standalone build,
// self-contained image, real docker + a real SIGTERM): Next's OWN
// `start-server.js` installs its own `SIGTERM`/`SIGINT` listeners (unless
// `NEXT_MANUAL_SIG_HANDLE` is set) that drain the server, await
// `nextServer.close()` (which runs pending `after()`/`waitUntil` work via
// `cleanupListeners.runAll()`), and only THEN call
// `process.exit(143 | 130 | 128)` — "Exit with signal-based exit code … so
// that Node.js treats this as a signal termination" (its own comment).
//
// round-1 set `NEXT_MANUAL_SIG_HANDLE=1` here to stop that handler from
// racing this preload's OWN close+exit path — but that raced away `after()`
// itself, which the docker e2e didn't assert on and which round-2 fixes: see
// `installExitNormalizer`/`installDrainHandler` above. `NEXT_MANUAL_SIG_HANDLE`
// is deliberately NOT set anymore — Next's own handler is now the ONLY thing
// that closes the server and calls `process.exit()`; this preload only
// normalizes that exit's code and backstops it with a hardcap.

// Preload side effect: always installs (this file is only ever baked into a
// self-contained compile, so there is no runtime flag to gate it on the way
// the Bun keep-alive guard gates on Bun version).
install();

module.exports = {
  drainHardcapMs,
  metricsPort,
  metricsBody,
  startMetricsServer,
  installExitNormalizer,
  installDrainHandler,
  install,
};
