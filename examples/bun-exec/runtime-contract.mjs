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
  const set = (globalThis[PENDING_KEY] ??= new Set());
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
//   4. Stop the metrics listener LAST, so a scrape is answerable during drain.
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
