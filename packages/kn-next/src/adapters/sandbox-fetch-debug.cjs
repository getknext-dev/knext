/**
 * #188 path 2 — edge-sandbox fetch instrumentation. A dependency-free
 * CommonJS preload (`node -r` / `bun -r`) for the Next.js standalone server,
 * STRICTLY OPT-IN: it does nothing at all unless KNEXT_SANDBOX_FETCH_DEBUG is
 * exactly '1' (flipped only by the compat workflow's dispatch-only
 * `sandboxFetchDebug` input — never by a schedule).
 *
 * WHY: the bun compat lane is deterministically red (6/6 CI runs, Bun 1.3.14
 * AND 1.4.0-canary) on `middleware-fetches-with-any-http-method` — the
 * middleware's outbound `fetch()` never resolves — while the node lane is
 * green on identical infra. Both minimal reductions (local docker A/B and the
 * GHA-hosted `bun-sandbox-fetch-ab.yml`, run 28650729775) failed to
 * discriminate; path 1 didn't even reproduce (0/80 hangs). So path 2
 * instruments the red shard IN THE FULL HARNESS.
 *
 * MECHANISM (verified locally under node 24 and bun 1.3.x against the
 * published next@16.2.0 tarball): the edge sandbox's fetch is the undici
 * bundled into next/dist/compiled/@edge-runtime/primitives/fetch.js. That
 * bundle executes HOST-side (the vm context receives host-created functions),
 * uses the host's require("net")/require("tls") (bun's node-compat sockets on
 * the bun lane), and publishes the STANDARD undici diagnostics channels
 * through the host require("diagnostics_channel"). A preload in the server
 * process therefore observes every sandbox fetch phase:
 *
 *   undici:request:create        dispatcher accepted the request
 *   undici:client:beforeConnect  about to open a TCP/TLS connection
 *   undici:client:connected      socket established
 *   undici:client:connectError   socket failed to establish
 *   undici:client:sendHeaders    request headers written
 *   undici:request:bodySent      request body fully written
 *   undici:request:headers       response headers received
 *   undici:request:trailers      response complete
 *   undici:request:error         request failed
 *
 * The last seen phase of a request that never completes NAMES where the hang
 * lives (pool queue vs connect vs awaiting-response vs body streaming) — the
 * discrimination every reduction so far has missed. Lane asymmetry is a
 * feature: bun's NATIVE fetch does not publish undici:* channels, so on the
 * bun lane every event here is bundled-undici (sandbox) traffic; on the node
 * lane node's own global undici also publishes, and lines are origin-labeled.
 *
 * A watchdog (unref'd — never keeps the process alive) reports requests
 * in-flight beyond STALL_MS with their last phase, plus a rate-limited
 * `ss -tnp` socket snapshot on Linux so the socket state behind a stall is
 * captured in the server log (which e2e-cleanup.sh ships at teardown).
 */

'use strict';

const INSTALLED = Symbol.for('knext.sandboxFetchDebug.installed');

const PREFIX = '[sandbox-fetch-debug]';

/** Channels published by the undici bundled into @edge-runtime/primitives
 * (verified against next@16.2.0 dist/compiled/@edge-runtime/primitives/fetch.js). */
const CHANNELS = [
  'undici:request:create',
  'undici:request:bodySent',
  'undici:request:headers',
  'undici:request:trailers',
  'undici:request:error',
  'undici:client:beforeConnect',
  'undici:client:connected',
  'undici:client:connectError',
  'undici:client:sendHeaders',
];

/** Phases that END a request's lifetime (remove it from the in-flight table). */
const TERMINAL = new Set(['undici:request:trailers', 'undici:request:error']);

/** How long a request may stay in-flight before the watchdog reports it. */
const STALL_MS = 20_000;
/** Watchdog cadence. */
const WATCH_INTERVAL_MS = 10_000;
/** Minimum spacing between `ss -tnp` socket snapshots. */
const SNAPSHOT_MIN_INTERVAL_MS = 30_000;

/**
 * Strict opt-in gate.
 * @param {Record<string, string | undefined> | undefined} env
 * @returns {boolean}
 */
function shouldInstall(env) {
  return Boolean(env) && env.KNEXT_SANDBOX_FETCH_DEBUG === '1';
}

/**
 * @param {unknown} request an undici request-like ({ method, origin, path })
 * @returns {string}
 */
function describeRequest(request) {
  if (!request || typeof request !== 'object') return '<no request>';
  const r = /** @type {{ method?: string, origin?: unknown, path?: string }} */ (request);
  const origin = typeof r.origin === 'string' ? r.origin : String(r.origin ?? '');
  return `${r.method ?? '?'} ${origin}${r.path ?? ''}`;
}

/**
 * @param {unknown} message a diagnostics_channel message carrying connectParams
 * @returns {string}
 */
function describeConnect(message) {
  const p =
    message && typeof message === 'object' && 'connectParams' in message
      ? /** @type {{ connectParams?: { host?: string, port?: string | number } }} */ (message)
          .connectParams
      : undefined;
  if (!p) return '<no connectParams>';
  return `${p.host ?? '?'}:${p.port ?? '?'}`;
}

/**
 * Pure event/phase tracker — unit-tested; install() feeds it the real
 * diagnostics_channel events.
 *
 * @param {{ log: (line: string) => void, now?: () => number }} opts
 */
function createInstrumentation({ log, now = Date.now }) {
  /** @type {Map<object, { startedAt: number, phase: string, method: string, origin: string, path: string }>} */
  const requests = new Map();

  /**
   * @param {string} name the channel name
   * @param {unknown} message the published message
   */
  function handleEvent(name, message) {
    const ts = now();
    const msg =
      /** @type {{ request?: object, response?: { statusCode?: number }, error?: unknown }} */ (
        message && typeof message === 'object' ? message : {}
      );
    const request = msg.request;
    let detail = '';
    if (request && typeof request === 'object') {
      detail = describeRequest(request);
      const entry = requests.get(request);
      if (name === 'undici:request:create') {
        const r = /** @type {{ method?: string, origin?: unknown, path?: string }} */ (request);
        requests.set(request, {
          startedAt: ts,
          phase: name,
          method: r.method ?? '?',
          origin: typeof r.origin === 'string' ? r.origin : String(r.origin ?? ''),
          path: r.path ?? '',
        });
      } else if (entry) {
        entry.phase = name;
      }
      if (TERMINAL.has(name)) requests.delete(request);
    } else {
      detail = describeConnect(message);
    }
    if (name === 'undici:request:headers' && msg.response) {
      detail += ` -> ${msg.response.statusCode ?? '?'}`;
    }
    if (name === 'undici:request:error' || name === 'undici:client:connectError') {
      const err = /** @type {{ message?: string } | undefined} */ (msg.error);
      detail += ` error=${(err && err.message) || String(msg.error ?? 'unknown')}`;
    }
    log(`${PREFIX} ${new Date(ts).toISOString()} ${name} ${detail}`);
  }

  /** @returns {Array<{ startedAt: number, phase: string, method: string, origin: string, path: string }>} */
  function inflight() {
    return [...requests.values()];
  }

  /**
   * Requests in-flight longer than stallMs, with their LAST SEEN PHASE — the
   * path-2 deliverable (where does the hang live?).
   * @param {number} [stallMs]
   */
  function stalled(stallMs = STALL_MS) {
    const ts = now();
    return inflight()
      .filter((e) => ts - e.startedAt >= stallMs)
      .map((e) => ({ ...e, ageMs: ts - e.startedAt }));
  }

  return { handleEvent, inflight, stalled };
}

/**
 * Best-effort Linux socket snapshot (`ss -tnp`) for stall triage. Never
 * throws; logs unavailability once.
 * @param {(line: string) => void} log
 */
function snapshotSockets(log) {
  try {
    // eslint-disable-next-line n/no-sync -- diagnostics-only, opt-in lane
    const out = require('node:child_process').execFileSync('ss', ['-tnp'], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    log(`${PREFIX} socket snapshot (ss -tnp):`);
    for (const line of String(out).split('\n')) {
      if (line.trim()) log(`${PREFIX}   ${line}`);
    }
  } catch (err) {
    log(
      `${PREFIX} socket snapshot unavailable (${(err && /** @type {{ message?: string }} */ (err).message) || 'ss failed'})`,
    );
  }
}

/**
 * Subscribe the instrumentation to the real diagnostics channels. Returns a
 * handle ({ uninstall }) or null when disabled / already installed.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   log?: (line: string) => void,
 *   subscribe?: (name: string, cb: (message: unknown, name: string) => void) => void,
 *   watchdog?: boolean,
 * }} [opts]
 */
function install(opts = {}) {
  const env = opts.env ?? process.env;
  if (!shouldInstall(env)) return null;
  const g = /** @type {Record<PropertyKey, unknown>} */ (globalThis);
  if (g[INSTALLED]) return null;
  g[INSTALLED] = true;

  const log =
    opts.log ??
    ((line) => {
      process.stderr.write(`${line}\n`);
    });
  const dc = require('node:diagnostics_channel');
  const instr = createInstrumentation({ log });

  /** @type {Array<[string, (message: unknown, name: string) => void]>} */
  const subscriptions = [];
  for (const name of CHANNELS) {
    const cb = (/** @type {unknown} */ message) => {
      try {
        instr.handleEvent(name, message);
      } catch (err) {
        log(
          `${PREFIX} handler error on ${name}: ${err && /** @type {{ message?: string }} */ (err).message}`,
        );
      }
    };
    (opts.subscribe ?? dc.subscribe)(name, cb);
    subscriptions.push([name, cb]);
  }

  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let lastSnapshotAt = 0;
  if (opts.watchdog !== false) {
    timer = setInterval(() => {
      const stalled = instr.stalled();
      if (stalled.length === 0) return;
      log(`${PREFIX} WATCHDOG: ${stalled.length} request(s) in-flight > ${STALL_MS}ms:`);
      for (const e of stalled) {
        log(
          `${PREFIX}   STALLED ${Math.round(e.ageMs / 1000)}s at phase=${e.phase} ${e.method} ${e.origin}${e.path}`,
        );
      }
      const nowMs = Date.now();
      if (nowMs - lastSnapshotAt >= SNAPSHOT_MIN_INTERVAL_MS) {
        lastSnapshotAt = nowMs;
        snapshotSockets(log);
      }
    }, WATCH_INTERVAL_MS);
    // diagnostics must never keep the server process alive
    if (typeof timer.unref === 'function') timer.unref();
  }

  log(
    `${PREFIX} installed (runtime=${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`}, pid=${process.pid}) — subscribed ${CHANNELS.length} undici channels`,
  );

  function uninstall() {
    for (const [name, cb] of subscriptions) {
      try {
        dc.unsubscribe(name, cb);
      } catch {
        /* best-effort */
      }
    }
    if (timer) clearInterval(timer);
    delete g[INSTALLED];
  }

  return { uninstall, instrumentation: instr };
}

// ── side effect (opt-in; inert unless KNEXT_SANDBOX_FETCH_DEBUG=1) ──────────
install();

// ── entry chain-loading (the bun `-r` diagnostics_channel quirk) ─────────────
// VERIFIED (bun 1.3.x, isolated repro): diagnostics_channel subscriptions made
// from a `bun -r <preload>` module NEVER register for the main program — the
// module object is identical, but the subscriber registry the main program's
// publishes consult stays empty (`hasSubscribers` false; require-chain from the
// main graph works, and node works both ways). So instead of `-r`, the deploy
// script boots THIS file as the MAIN entry with
// KNEXT_SANDBOX_FETCH_DEBUG_SERVER_JS pointing at the real standalone
// server.js; the require below puts the server in the main graph where the
// subscriptions above are visible. Unconditional on the env var (a set target
// must always boot the server — a broken debug lane must never strand a
// deployment), but only when this file IS the entry (never on `-r`/import).
if (
  require.main === module &&
  typeof process.env.KNEXT_SANDBOX_FETCH_DEBUG_SERVER_JS === 'string' &&
  process.env.KNEXT_SANDBOX_FETCH_DEBUG_SERVER_JS.length > 0
) {
  require(process.env.KNEXT_SANDBOX_FETCH_DEBUG_SERVER_JS);
}

module.exports = {
  shouldInstall,
  createInstrumentation,
  install,
  CHANNELS,
  STALL_MS,
};
