// RuntimeContract helpers for the opt-in `bun-exec` build target (ADR-0036).
//
// Pure and dependency-free ON PURPOSE: this module is imported by BOTH the real
// bun entry (`knext-bun-entry.mjs`, compiled into the single executable) and the
// test harness (`test/drain-harness.mjs`, run under bun without a vinext build).
// Because it imports nothing bun- or nitro-specific, the same code runs under
// node (vitest unit tests), under bun, and inside the `bun --compile --bytecode`
// binary — so the behaviour the tests assert is the behaviour the binary ships.
//
// It provides three of the seven RuntimeContract items ADR-0036 enumerates:
//   (2) in-process Prometheus `:9091` exposition,
//   (3) SIGTERM graceful drain (+ `after()`/waitUntil draining, + hardcap),
//   (5) Bearer-authenticated, fail-closed mutating-route guard.
// Items 1 (health), 4 (Redis cache-handler — likely fallback-to-node), 6
// (operator env-injection) and 7 (module-state seam) are covered by the sample
// app routes / the env contract / the globalThis anchor below, or explicitly
// deferred — see README.md.

// The only imports are node: builtins, which resolve identically under node,
// under bun, and inside the compiled binary — the "dependency-free" property
// above is about bun/nitro/vinext coupling, not about the standard library.
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── (6) Bind-host resolution — never bind to a k8s pod name ─────────────────
// Kubernetes injects HOSTNAME=<pod-name> (e.g. `recipe-validate-fn252`) into
// EVERY pod. A pod name is an identity, not a bind address: binding
// `Bun.serve({ hostname: '<pod-name>' })` makes the listener unreachable on
// 127.0.0.1 / the pod IP, so every request (app :PORT AND metrics :9091) is
// connection-refused and boot times out (confirmed on OKE).
//
// Mirror the node supervisor's intent (packages/kn-next/src/adapters/env.ts
// `isBindOrLoopback`): only an EXPLICIT bind/loopback address is a real bind
// target — anything else (a pod name, any non-address hostname) falls through
// to 0.0.0.0. This keeps an explicit `HOSTNAME=127.0.0.1` / `::1` / `localhost`
// bind honoured for local dev while never trusting a k8s-injected pod name.
// `127.` is prefix-matched (the whole 127.0.0.0/8 loopback block); no valid pod
// name contains a dot, so the prefix can't collide with one.
const BIND_OR_LOOPBACK_HOSTNAMES = new Set(['0.0.0.0', '::', '::1', 'localhost']);

function isBindOrLoopback(value) {
  const v = value.toLowerCase();
  return BIND_OR_LOOPBACK_HOSTNAMES.has(v) || v.startsWith('127.');
}

/**
 * Resolve the host both `Bun.serve` listeners bind to. Returns `HOSTNAME` only
 * when it is an explicit bind/loopback address; otherwise `0.0.0.0`. A k8s
 * pod-name HOSTNAME (or any non-address value, or unset) ⇒ `0.0.0.0`.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolveBindHost(env = process.env) {
  const h = env.HOSTNAME;
  return h && isBindOrLoopback(h) ? h : '0.0.0.0';
}

// ── (#460 bug 3) Where the runtime reads `.output/public` from ──────────────
//
// Nitro prepends `globalThis.__nitro_main__ = import.meta.url` to the server
// entry and its public-asset reader does
// `readFile(resolve(dirname(fileURLToPath(__nitro_main__)), '../public/…'))`.
// `bun build --compile` BAKES that URL as the absolute path on the machine that
// built the binary, so a shipped container asks for
// `/Users/<builder>/…/.output/public/_next/static/…` and 500s (ENOENT) on every
// asset — while `/` still returns correct SSR HTML. That is why it survived five
// verifications: the page renders and never hydrates.
//
// The decision is factored out here, away from the entry, for two reasons: the
// entry cannot be imported by a test (it pulls in nitro + vinext), and the only
// failure mode of getting this wrong is SILENCE. Both are addressed by making it
// a pure function with an injected `exists`.
//
// Candidate order, and why:
//   1. the BAKED root, if its `../public` is actually there. A non-compiled
//      `bun run /abs/path/.output/server/index.mjs` has a CORRECT baked value,
//      and it must win over anything discovered from the environment.
//   2. `dirname(process.execPath)` — the compiled case. The ship shape is the
//      executable next to `.output/public` (README + Dockerfile), so anchoring
//      on the EXECUTABLE makes the binary portable. cwd deliberately is NOT a
//      candidate: it would both miss (`docker run -w /elsewhere`) and misfire
//      (an unrelated `.output/public` under cwd hijacking a correct baked root).
//   3. nothing → keep the baked value and WARN LOUDLY. Serving is already broken
//      at this point; the only thing left to get right is not being silent.
const PUBLIC_REL = '.output/public';
const SERVER_ENTRY_REL = '.output/server/index.mjs';

/**
 * @param {object} opts
 * @param {string | undefined} opts.bakedMain `globalThis.__nitro_main__` as baked at build time.
 * @param {string} opts.execPath              `process.execPath`.
 * @param {(path: string) => boolean} opts.exists
 * @param {string} [opts.cwd]                 Reported in the warning only — never a candidate.
 * @returns {{ mainUrl: string | null, source: 'baked' | 'execdir' | 'unresolved', warning: string | null }}
 *   `mainUrl` is null when `__nitro_main__` must be left alone (candidate 1 or 3).
 */
export function resolveAssetAnchor({ bakedMain, execPath, exists, cwd }) {
  // A malformed/absent baked value must degrade, never throw — this runs at
  // module init of the entry, so throwing here kills the process before it listens.
  let bakedDir = null;
  try {
    if (bakedMain) bakedDir = dirname(fileURLToPath(bakedMain));
  } catch {
    bakedDir = null;
  }
  const bakedPublic = bakedDir ? resolve(bakedDir, '../public') : null;
  if (bakedPublic && exists(bakedPublic)) {
    return { mainUrl: null, source: 'baked', warning: null };
  }

  const execDir = dirname(execPath);
  if (exists(resolve(execDir, PUBLIC_REL))) {
    return {
      mainUrl: pathToFileURL(resolve(execDir, SERVER_ENTRY_REL)).href,
      source: 'execdir',
      warning: null,
    };
  }

  return {
    mainUrl: null,
    source: 'unresolved',
    warning:
      'knext bun-exec: no static-asset root found — every /_next/static request will 500 ' +
      '(the page will render but never hydrate). Ship the executable NEXT TO its `.output/public` ' +
      `directory. Looked for: ${resolve(execDir, PUBLIC_REL)}` +
      (bakedPublic ? ` and ${bakedPublic}` : ' (no baked __nitro_main__ to fall back on)') +
      (cwd ? ` [cwd: ${cwd}]` : ''),
  };
}

// ── (2) Prometheus metrics ─────────────────────────────────────────────────
// Hand-rolled exposition (no prom-client dependency) so the module stays
// self-contained and compile-safe. Mirrors the process-metric shape the node
// supervisor exposes (packages/kn-next/src/adapters/node-server.ts) but scoped
// to what a single in-process runtime can measure without a child scrape.
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export function createMetricsState() {
  return {
    requestsTotal: 0,
    inflight: 0,
    startNs: process.hrtime.bigint(),
  };
}

export function renderMetrics(state) {
  const mem = process.memoryUsage();
  const uptimeSec = Number(process.hrtime.bigint() - state.startNs) / 1e9;
  return (
    [
      '# HELP knext_bunexec_process_resident_memory_bytes Resident set size of the runtime in bytes.',
      '# TYPE knext_bunexec_process_resident_memory_bytes gauge',
      `knext_bunexec_process_resident_memory_bytes ${mem.rss}`,
      '# HELP knext_bunexec_process_uptime_seconds Seconds since the runtime process started.',
      '# TYPE knext_bunexec_process_uptime_seconds gauge',
      `knext_bunexec_process_uptime_seconds ${uptimeSec.toFixed(3)}`,
      '# HELP knext_bunexec_http_requests_total Total app HTTP requests handled.',
      '# TYPE knext_bunexec_http_requests_total counter',
      `knext_bunexec_http_requests_total ${state.requestsTotal}`,
      '# HELP knext_bunexec_http_inflight_requests App HTTP requests currently in flight.',
      '# TYPE knext_bunexec_http_inflight_requests gauge',
      `knext_bunexec_http_inflight_requests ${state.inflight}`,
    ].join('\n') + '\n'
  );
}

// ── (5) Bearer-authenticated, fail-closed mutating-route guard ──────────────
// security.md hard rule: no unauthenticated mutating endpoints. Returns `null`
// when the request is authorised, or a 401 `Response` when it is NOT. Fails
// CLOSED on every ambiguity: unset server token, missing header, and mismatch
// all deny. Constant-time comparison avoids leaking the token via timing.
export function checkBearer(req, token) {
  if (!token) {
    // Misconfigured server (token env unset) → deny, never allow-through.
    return jsonResponse(401, {
      error: 'unauthorized',
      reason: 'server misconfigured: CACHE_INVALIDATE_TOKEN is not set',
    });
  }
  const header = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${token}`;
  if (!constantTimeEqual(header, expected)) {
    return jsonResponse(401, { error: 'unauthorized' });
  }
  return null;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Length-independent constant-time-ish compare: iterate to the longer length so
// the loop count does not branch on a match, and fold the length difference in.
function constantTimeEqual(a, b) {
  let mismatch = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

// ── (7 / after()) Background-task registry, anchored on globalThis ──────────
// ADR-0027: a runtime seam's mutable state MUST live on globalThis via a
// namespaced Symbol.for key, never a bare module-level `let` — a bundler may
// duplicate this module across layers, giving each copy independent state. The
// binary bundles this file once, but we honour the invariant so route handlers
// in a different bundle layer share ONE pending set. Next.js `after()` /
// WinterCG `waitUntil` callbacks register here and are awaited during drain.
const PENDING_KEY = Symbol.for('knext.bunexec.pendingTasks');

export function waitUntil(promise) {
  globalThis[PENDING_KEY] ??= new Set();
  const set = globalThis[PENDING_KEY];
  const tracked = Promise.resolve(promise)
    .catch(() => {})
    .finally(() => set.delete(tracked));
  set.add(tracked);
  return promise;
}

export async function drainPending() {
  const set = globalThis[PENDING_KEY];
  if (!set || set.size === 0) return;
  await Promise.all([...set]);
}

// ── (3) SIGTERM graceful drain ──────────────────────────────────────────────
// A single executable has no supervisor, so the drain lives IN the process:
//   1. Arm a hardcap timer (GRACE_MS) that force-stops + exits 1 if drain hangs.
//   2. `server.stop()` (no arg) — stop accepting new conns, let in-flight
//      requests FINISH; the returned Promise resolves when they do (the drain).
//   3. Await after()/waitUntil background tasks.
//   4. Stop the metrics listener LAST — load-bearing: it is what holds the
//      event loop open so the `unref()`ed hardcap can fire (and, secondarily,
//      it keeps a scrape answerable throughout the drain). See the DO-NOT-
//      REORDER note at the drain site.
//   5. Exit 0. `server.stop(true)` (force) is the hardcap path only.
// Idempotent: a second signal while draining is ignored.
/**
 * @param {{
 *   appServers: Array<{ stop: (force?: boolean) => Promise<void> | void }>,
 *   metricsServer?: { stop: (force?: boolean) => Promise<void> | void },
 *   drainTasks?: () => Promise<void>,
 *   graceMs?: number,
 *   log?: (msg: string) => void,
 *   exit?: (code: number) => void,
 * }} opts
 */
export function createGracefulShutdown({
  appServers,
  metricsServer,
  drainTasks = drainPending,
  graceMs = 25_000,
  log = () => {},
  exit = (code) => process.exit(code),
}) {
  let started = false;
  return async function shutdown(signal) {
    if (started) return;
    started = true;
    log(`SIGNAL:${signal} draining (graceMs=${graceMs})`);

    const hardcap = setTimeout(() => {
      log('HARDCAP: drain exceeded grace, forcing stop');
      for (const s of appServers) {
        try {
          s.stop(true);
        } catch {
          /* already stopped */
        }
      }
      exit(1);
    }, graceMs);
    // Never let the hardcap timer itself keep the loop alive.
    if (typeof hardcap.unref === 'function') hardcap.unref();

    try {
      await Promise.all(appServers.map((s) => s.stop()));
      await drainTasks();
      // ── DO NOT REORDER: the metrics listener is stopped LAST, and that is
      // LOAD-BEARING, not cosmetic (#448). The hardcap timer above is
      // `unref()`ed, so it can only fire while something ELSE keeps the event
      // loop alive; during the drain that something is this metrics listener.
      // Stop it before the app drain / `drainTasks()` and the loop can empty,
      // bun exits before the hardcap fires, and a hung request is silently NOT
      // force-terminated within grace — the SIGTERM guarantee regresses with
      // every unit test still green. (Serving a scrape throughout the drain is
      // the second, lesser reason.) Guarded by test/sigterm-hardcap-e2e.test.ts.
      if (metricsServer) await metricsServer.stop();
      clearTimeout(hardcap);
      log('DRAINED cleanly');
      exit(0);
    } catch (err) {
      clearTimeout(hardcap);
      log(`DRAIN-ERROR ${err}`);
      exit(1);
    }
  };
}
