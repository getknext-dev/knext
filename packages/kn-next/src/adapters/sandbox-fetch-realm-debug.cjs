/**
 * #188 path 3 — IN-REALM edge-sandbox fetch instrumentation.
 *
 * Path 2 (PR #206, run 28657820369) ended in a calibrated null: under bun,
 * even a SUCCESSFUL sandbox fetch is invisible to a host-realm main-graph
 * diagnostics_channel subscriber (and to BUN_CONFIG_VERBOSE_FETCH), so
 * instrument-from-outside is structurally blocked on the runtime where the
 * hang lives. Path 3 instruments next's sandbox wiring from INSIDE:
 * scripts/e2e-deploy.sh — ONLY under the dispatch-only debug lane
 * (KNEXT_SANDBOX_FETCH_DEBUG=1) — patches the FIXTURE's staged standalone
 * `next/dist/server/web/sandbox/context.js` (v16.2.0) at two verified-unique
 * anchors so that:
 *
 *   (a) the base primitives fetch (`const __fetch = context.fetch;` — the
 *       fetch injected by @edge-runtime/primitives) is wrapped with per-call
 *       phase logging: call → resolved/rejected (+elapsed) → body.<method>()
 *       start/done — the bundled undici PROVABLY executes host-side
 *       (primitives `load()` runs in the host realm inside
 *       next/dist/compiled/edge-runtime; its objects are injected into the
 *       vm context), so wrapping here sits directly above the layer that
 *       hangs;
 *   (b) next's own `context.fetch` wrapper (built host-side in `extend`) is
 *       wrapped with entry/settled logging — together (a)+(b) discriminate
 *       "stall before dispatch" vs "base fetch's promise never settles" vs
 *       "body stream never ends", the exact phase question every previous
 *       reduction (paths 0/1/2) could not answer;
 *   (c) once per process (first acquire), host `net`/`tls` connects are
 *       instrumented (module-function wrap; sockets report lookup/connect/
 *       secureConnect/first-byte/error/timeout/close with elapsed) — the
 *       socket layer under the bundled undici — and the standard `undici:*`
 *       diagnostics channels are subscribed from THIS graph position as a
 *       further datapoint on path 2's bun invisibility finding.
 *
 * The injected hook is double-gated: the patch itself only happens in the
 * debug lane, and the injected code additionally checks
 * KNEXT_SANDBOX_FETCH_DEBUG === '1' && KNEXT_SANDBOX_FETCH_REALM_DEBUG_MODULE
 * before requiring this module — with both unset (every steady-state lane)
 * the hook is a null-check falling through to the original wiring.
 *
 * Dependency-free CommonJS on purpose: it is loaded inside the fixture's
 * next, where only node built-ins are guaranteed.
 */

'use strict';

const PREFIX = '[sandbox-fetch-realm]';
const MARKER = 'knext-sandbox-fetch-realm-debug';

const SOCKETS_INSTALLED = Symbol.for('knext.sandboxFetchRealmDebug.sockets');
const DC_INSTALLED = Symbol.for('knext.sandboxFetchRealmDebug.dc');

/** How long a call may stay in-flight before the watchdog reports it. */
const STALL_MS = 20_000;
/** Watchdog cadence. */
const WATCH_INTERVAL_MS = 10_000;

/** Undici channels published by the bundled @edge-runtime/primitives fetch. */
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

/** Body-mixin methods instrumented on resolved responses. */
const BODY_METHODS = ['text', 'json', 'arrayBuffer', 'blob', 'formData', 'bytes'];

/**
 * Strict opt-in gate — identical semantics to sandbox-fetch-debug.cjs.
 * @param {Record<string, string | undefined> | undefined} env
 * @returns {boolean}
 */
function shouldInstall(env) {
  return Boolean(env) && env.KNEXT_SANDBOX_FETCH_DEBUG === '1';
}

/**
 * Describe a fetch input (string | URL | Request-shaped) + init.
 * @param {unknown} input
 * @param {{ method?: string } | undefined} init
 * @returns {string}
 */
function describeCall(input, init) {
  let url = '';
  let method = (init && init.method) || undefined;
  if (typeof input === 'string') {
    url = input;
  } else if (input && typeof input === 'object') {
    const r = /** @type {{ url?: unknown, method?: unknown, href?: unknown }} */ (input);
    url = typeof r.url === 'string' ? r.url : typeof r.href === 'string' ? r.href : String(input);
    if (!method && typeof r.method === 'string') method = r.method;
  } else {
    url = String(input);
  }
  return `${method || 'GET'} ${url}`;
}

/**
 * Per-acquire call tracker with phase bookkeeping. Pure and unit-testable;
 * the fetch wrappers feed it.
 *
 * @param {{ log: (line: string) => void, now?: () => number, label?: string }} opts
 */
function createTracker({ log, now = Date.now, label = '' }) {
  let nextId = 0;
  /** @type {Map<number, { id: number, phase: string, startedAt: number, detail: string }>} */
  const calls = new Map();
  const tag = label ? ` [${label}]` : '';

  /** @param {number} ts @param {string} line */
  function emit(ts, line) {
    log(`${PREFIX} ${new Date(ts).toISOString()}${tag} ${line}`);
  }

  /**
   * Wrap a fetch-like function with call/resolved/rejected phase logging.
   * @param {string} kind 'base-fetch' | 'context-fetch'
   * @param {(...args: unknown[]) => Promise<unknown>} fn
   * @param {{ instrumentBody?: boolean }} [wrapOpts]
   */
  function wrapFetch(kind, fn, wrapOpts = {}) {
    return function knextInstrumentedFetch(/** @type {unknown[]} */ ...args) {
      const id = ++nextId;
      const startedAt = now();
      const detail = describeCall(args[0], /** @type {{ method?: string }} */ (args[1]));
      const entry = { id, phase: `${kind}:call`, startedAt, detail };
      calls.set(id, entry);
      emit(startedAt, `${kind}#${id} call ${detail}`);
      /** @type {Promise<unknown>} */
      let result;
      try {
        result = Promise.resolve(fn(...args));
      } catch (err) {
        calls.delete(id);
        emit(
          now(),
          `${kind}#${id} threw-sync ${(err && /** @type {{ message?: string }} */ (err).message) || String(err)} +${now() - startedAt}ms`,
        );
        throw err;
      }
      return result.then(
        (res) => {
          calls.delete(id);
          const status =
            res && typeof res === 'object' && 'status' in res
              ? /** @type {{ status?: unknown }} */ (res).status
              : '?';
          emit(now(), `${kind}#${id} resolved status=${status} +${now() - startedAt}ms`);
          if (wrapOpts.instrumentBody && res && typeof res === 'object') {
            instrumentBody(kind, id, /** @type {Record<string, unknown>} */ (res));
          }
          return res;
        },
        (err) => {
          calls.delete(id);
          emit(
            now(),
            `${kind}#${id} rejected ${(err && /** @type {{ message?: string }} */ (err).message) || String(err)} +${now() - startedAt}ms`,
          );
          throw err;
        },
      );
    };
  }

  /**
   * Instrument body-consumption methods on a resolved response: a body read
   * that never finishes is one of the candidate hang phases.
   * @param {string} kind
   * @param {number} id
   * @param {Record<string, unknown>} res
   */
  function instrumentBody(kind, id, res) {
    try {
      for (const name of BODY_METHODS) {
        const orig = res[name];
        if (typeof orig !== 'function') continue;
        res[name] = function knextInstrumentedBody(/** @type {unknown[]} */ ...args) {
          const startedAt = now();
          const entry = {
            id,
            phase: `${kind}:body.${name}()`,
            startedAt,
            detail: `body.${name}()`,
          };
          calls.set(id, entry);
          emit(startedAt, `${kind}#${id} body.${name}() start`);
          return Promise.resolve(orig.apply(res, args)).then(
            (out) => {
              calls.delete(id);
              emit(now(), `${kind}#${id} body.${name}() done +${now() - startedAt}ms`);
              return out;
            },
            (err) => {
              calls.delete(id);
              emit(
                now(),
                `${kind}#${id} body.${name}() failed ${(err && /** @type {{ message?: string }} */ (err).message) || String(err)} +${now() - startedAt}ms`,
              );
              throw err;
            },
          );
        };
      }
    } catch (err) {
      emit(
        now(),
        `${kind}#${id} body instrumentation unavailable (${(err && /** @type {{ message?: string }} */ (err).message) || String(err)})`,
      );
    }
  }

  /** @returns {Array<{ id: number, phase: string, startedAt: number, detail: string }>} */
  function pending() {
    return [...calls.values()];
  }

  /**
   * Calls in-flight longer than stallMs with their LAST SEEN PHASE — the
   * path-3 deliverable (where does the hang live?).
   * @param {number} [stallMs]
   */
  function stalled(stallMs = STALL_MS) {
    const ts = now();
    return pending()
      .filter((e) => ts - e.startedAt >= stallMs)
      .map((e) => ({ ...e, ageMs: ts - e.startedAt }));
  }

  return { wrapFetch, pending, stalled, emit };
}

/**
 * Once-per-process: wrap `net.connect`/`net.createConnection`/`tls.connect`
 * so outbound sockets (the bundled undici's transport) report their
 * lifecycle. Property lookups happen at call time in undici's connect path,
 * so wrapping the module functions is sufficient. Inbound server sockets
 * never pass through these. Best-effort: a runtime that rejects builtin
 * module mutation gets a single labeled unavailability line, never a throw.
 *
 * @param {(line: string) => void} log
 */
function instrumentSocketConnects(log) {
  const g = /** @type {Record<PropertyKey, unknown>} */ (globalThis);
  if (g[SOCKETS_INSTALLED]) return;
  g[SOCKETS_INSTALLED] = true;

  let nextSocketId = 0;

  /**
   * @param {string} kind 'net' | 'tls'
   * @param {unknown[]} args
   * @returns {string}
   */
  function describeTarget(kind, args) {
    const a = args[0];
    if (a && typeof a === 'object') {
      const o = /** @type {{ host?: unknown, port?: unknown, path?: unknown }} */ (a);
      if (o.path) return `${kind} ${String(o.path)}`;
      return `${kind} ${String(o.host ?? 'localhost')}:${String(o.port ?? '?')}`;
    }
    return `${kind} ${String(args[1] ?? 'localhost')}:${String(a ?? '?')}`;
  }

  /**
   * @param {'net' | 'tls'} kind
   * @param {Record<string, unknown>} mod
   * @param {string} fnName
   */
  function wrapConnect(kind, mod, fnName) {
    const orig = mod[fnName];
    if (typeof orig !== 'function') return;
    mod[fnName] = function knextInstrumentedConnect(/** @type {unknown[]} */ ...args) {
      const socket = /** @type {import('node:net').Socket} */ (orig.apply(mod, args));
      try {
        const id = ++nextSocketId;
        const startedAt = Date.now();
        const target = describeTarget(kind, args);
        const line = (/** @type {string} */ msg) =>
          log(`${PREFIX} ${new Date().toISOString()} socket#${id} ${target} ${msg}`);
        line(`connect() called (+0ms)`);
        const at = () => `+${Date.now() - startedAt}ms`;
        socket.once('lookup', (err, address) =>
          line(`dns lookup ${err ? `FAILED ${err.message}` : `-> ${address}`} ${at()}`),
        );
        socket.once('connect', () => line(`tcp connected ${at()}`));
        // tls sockets only; harmless no-op listener on plain sockets
        socket.once('secureConnect', () => line(`tls secureConnect ${at()}`));
        socket.once('data', (chunk) =>
          line(`first bytes received (${chunk ? chunk.length : 0}B) ${at()}`),
        );
        socket.once('error', (err) => line(`error ${err && err.message} ${at()}`));
        socket.once('timeout', () => line(`timeout ${at()}`));
        socket.once('close', (hadError) => line(`closed hadError=${hadError} ${at()}`));
      } catch {
        /* diagnostics must never break the socket path */
      }
      return socket;
    };
  }

  try {
    const net = require('node:net');
    const tls = require('node:tls');
    wrapConnect('net', net, 'connect');
    wrapConnect('net', net, 'createConnection');
    wrapConnect('tls', tls, 'connect');
    log(
      `${PREFIX} socket instrumentation installed (net.connect/net.createConnection/tls.connect)`,
    );
  } catch (err) {
    log(
      `${PREFIX} socket instrumentation unavailable (${(err && /** @type {{ message?: string }} */ (err).message) || String(err)})`,
    );
  }
}

/**
 * Once-per-process: subscribe the undici diagnostics channels from THIS
 * module's graph position (inside the fixture next's require graph) and log
 * a module-identity datapoint — path 2 proved the main-graph host subscriber
 * sees nothing under bun; whether this graph position does is itself a
 * finding either way.
 *
 * @param {(line: string) => void} log
 */
function subscribeDiagnostics(log) {
  const g = /** @type {Record<PropertyKey, unknown>} */ (globalThis);
  if (g[DC_INSTALLED]) return;
  g[DC_INSTALLED] = true;
  try {
    const dc = require('node:diagnostics_channel');
    const dcBare = require('diagnostics_channel');
    log(
      `${PREFIX} dc identity: require('diagnostics_channel') === require('node:diagnostics_channel') -> ${dc === dcBare}`,
    );
    for (const name of CHANNELS) {
      dc.subscribe(name, (/** @type {unknown} */ message) => {
        try {
          const msg =
            /** @type {{ request?: { method?: string, origin?: unknown, path?: string } }} */ (
              message && typeof message === 'object' ? message : {}
            );
          const r = msg.request;
          const detail = r ? `${r.method ?? '?'} ${String(r.origin ?? '')}${r.path ?? ''}` : '';
          log(`${PREFIX} ${new Date().toISOString()} dc ${name} ${detail}`);
        } catch {
          /* never throw from a dc handler */
        }
      });
    }
    log(`${PREFIX} dc subscribed ${CHANNELS.length} undici channels (in-graph)`);
  } catch (err) {
    log(
      `${PREFIX} dc subscription unavailable (${(err && /** @type {{ message?: string }} */ (err).message) || String(err)})`,
    );
  }
}

/**
 * Entry point called by the PATCHED context.js for each edge module context.
 * Returns null unless the debug lane is on (the hook then falls through to
 * next's original wiring). When on: installs the process-wide socket + dc
 * instrumentation once, and returns per-context fetch wrappers plus a stall
 * watchdog.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   moduleName?: string,
 *   log?: (line: string) => void,
 *   now?: () => number,
 *   instrumentSockets?: boolean,
 *   watchdog?: boolean,
 * }} [opts]
 */
function acquire(opts = {}) {
  const env = opts.env ?? process.env;
  if (!shouldInstall(env)) return null;

  const log =
    opts.log ??
    ((/** @type {string} */ line) => {
      process.stderr.write(`${line}\n`);
    });
  const tracker = createTracker({
    log,
    now: opts.now,
    label: opts.moduleName ? String(opts.moduleName) : '',
  });

  if (opts.instrumentSockets !== false) {
    instrumentSocketConnects(log);
    subscribeDiagnostics(log);
  }

  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  if (opts.watchdog !== false) {
    timer = setInterval(() => {
      const stalledCalls = tracker.stalled();
      if (stalledCalls.length === 0) return;
      log(`${PREFIX} WATCHDOG: ${stalledCalls.length} call(s) in-flight > ${STALL_MS}ms:`);
      for (const e of stalledCalls) {
        log(`${PREFIX}   STALLED ${Math.round(e.ageMs / 1000)}s at phase=${e.phase} ${e.detail}`);
      }
    }, WATCH_INTERVAL_MS);
    // diagnostics must never keep the server process alive
    if (typeof timer.unref === 'function') timer.unref();
  }

  log(
    `${PREFIX} acquired (runtime=${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`}, moduleName=${opts.moduleName ?? '?'}, pid=${process.pid})`,
  );

  return {
    /** Wrap the base primitives fetch (`__fetch`) — phases + body reads. */
    wrapBaseFetch(/** @type {(...args: unknown[]) => Promise<unknown>} */ fn) {
      return tracker.wrapFetch('base-fetch', fn, { instrumentBody: true });
    },
    /** Wrap next's `context.fetch` wrapper — entry/settled only. */
    wrapContextFetch(/** @type {(...args: unknown[]) => Promise<unknown>} */ fn) {
      return tracker.wrapFetch('context-fetch', fn);
    },
    pending: tracker.pending,
    stalled: tracker.stalled,
    uninstall() {
      if (timer) clearInterval(timer);
    },
  };
}

// ── the harness-side patcher (runs under node at deploy time, debug lane only) ──

/** Anchor A: next@16.2.0 captures the primitives fetch before wrapping it. */
const ANCHOR_BASE = 'const __fetch = context.fetch;';
/** Anchor B: the end of next@16.2.0's `extend(context)` callback. */
const ANCHOR_RETURN = 'return context;';

/**
 * Count non-overlapping occurrences of a substring.
 * @param {string} haystack
 * @param {string} needle
 */
function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/**
 * Resolve the staged standalone tree's `next/dist/server/web/sandbox/context.js`.
 *
 * STRICTLY appDir-rooted (#216). Never `require.resolve` here: Node consults
 * the NODE_PATH global folders even with `{ paths: [appDir] }`, and `pnpm exec`
 * injects NODE_PATH=<repo>/node_modules/.pnpm/node_modules — on CI that
 * resolved (and patched!) the harness repo's OWN next install from an empty
 * app dir. Likewise, never walk above the staged tree: the only ascent allowed
 * is from a nested monorepo app dir (`.next/standalone/<app-path>/`) up to its
 * enclosing `.next/standalone` root, where `output:'standalone'` puts the
 * bundled node_modules.
 *
 * @param {string} appDir
 * @returns {string | null}
 */
function resolveSandboxContext(appDir) {
  const { existsSync } = require('node:fs');
  const path = require('node:path');
  const rel = 'next/dist/server/web/sandbox/context.js';
  const start = path.resolve(appDir);

  // The enclosing `.next/standalone` root, if appDir sits inside one.
  let standaloneRoot = null;
  for (let dir = start; ; ) {
    if (path.basename(dir) === 'standalone' && path.basename(path.dirname(dir)) === '.next') {
      standaloneRoot = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (let dir = start; ; ) {
    const candidate = path.join(dir, 'node_modules', ...rel.split('/'));
    if (existsSync(candidate)) return candidate;
    // Bounded walk: appDir itself, or — inside a standalone tree — up to
    // (and including) the standalone root. Nothing outside the staged tree.
    if (standaloneRoot === null || dir === standaloneRoot) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Patch the fixture's installed sandbox context.js with the in-realm debug
 * hook. Idempotent; validates the result with `node --check`; fails loud
 * ({ patched: false, reason }) on anchor drift — never a silent half-patch.
 *
 * @param {{ appDir: string, log?: (line: string) => void }} opts
 * @returns {{ patched: boolean, already?: boolean, contextPath?: string, reason?: string }}
 */
function patchSandboxContext({ appDir, log = () => {} }) {
  const fs = require('node:fs');
  const path = require('node:path');

  const resolved = resolveSandboxContext(appDir);
  if (!resolved) {
    return {
      patched: false,
      reason: `could not resolve next/dist/server/web/sandbox/context.js from ${appDir}`,
    };
  }
  // Never write through a symlink (pnpm-style layouts): patch the real file.
  const contextPath = fs.realpathSync(resolved);
  const source = fs.readFileSync(contextPath, 'utf8');

  if (source.includes(MARKER)) {
    log(`${PREFIX} context.js already patched: ${contextPath}`);
    return { patched: true, already: true, contextPath };
  }

  for (const anchor of [ANCHOR_BASE, ANCHOR_RETURN]) {
    const n = countOccurrences(source, anchor);
    if (n !== 1) {
      return {
        patched: false,
        contextPath,
        reason: `anchor ${JSON.stringify(anchor)} matched ${n} times (need exactly 1) — next version drift? refusing to patch`,
      };
    }
  }

  // Every injected line carries the MARKER so containment tooling (and the
  // idempotence check above) can identify the hook precisely.
  const hookAcquire =
    `const __knextSfrd = (process.env.KNEXT_SANDBOX_FETCH_DEBUG === '1' && process.env.KNEXT_SANDBOX_FETCH_REALM_DEBUG_MODULE) ? ` +
    `(function () { try { return require(process.env.KNEXT_SANDBOX_FETCH_REALM_DEBUG_MODULE).acquire({ env: process.env, moduleName: options.moduleName }); } ` +
    `catch (e) { try { process.stderr.write('${PREFIX} acquire failed: ' + (e && e.message) + '\\n'); } catch (_) {} return null; } })() : null; /* ${MARKER} */`;
  const hookBase = `const __fetch = __knextSfrd ? __knextSfrd.wrapBaseFetch(context.fetch) : context.fetch; /* ${MARKER} */`;
  const hookOuter = `if (__knextSfrd) { context.fetch = __knextSfrd.wrapContextFetch(context.fetch); } /* ${MARKER}:outer */`;

  const baseLine = new RegExp(
    `^([ \\t]*)${ANCHOR_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`,
    'm',
  );
  const returnLine = new RegExp(
    `^([ \\t]*)${ANCHOR_RETURN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`,
    'm',
  );
  if (!baseLine.test(source) || !returnLine.test(source)) {
    return {
      patched: false,
      contextPath,
      reason:
        'anchor lines not found as standalone statements — next version drift? refusing to patch',
    };
  }

  let patched = source.replace(
    baseLine,
    (_m, indent) => `${indent}${hookAcquire}\n${indent}${hookBase}`,
  );
  patched = patched.replace(
    returnLine,
    (_m, indent) => `${indent}${hookOuter}\n${indent}${ANCHOR_RETURN}`,
  );

  // Syntax gate (A3-3 lesson: validate what lands on disk) — write a sibling
  // temp file, `node --check` it, then rename over the original.
  const tmpPath = path.join(
    path.dirname(contextPath),
    `.${path.basename(contextPath)}.knext-sfrd-${process.pid}.tmp.js`,
  );
  try {
    fs.writeFileSync(tmpPath, patched);
    require('node:child_process').execFileSync(process.execPath, ['--check', tmpPath], {
      stdio: 'pipe',
    });
    fs.renameSync(tmpPath, contextPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* best-effort */
    }
    return {
      patched: false,
      contextPath,
      reason: `patched source failed validation: ${(err && /** @type {{ message?: string }} */ (err).message) || String(err)}`,
    };
  }

  log(`${PREFIX} context.js patched: ${contextPath}`);
  return { patched: true, contextPath };
}

module.exports = {
  shouldInstall,
  acquire,
  createTracker,
  patchSandboxContext,
  instrumentSocketConnects,
  subscribeDiagnostics,
  CHANNELS,
  STALL_MS,
  MARKER,
};
