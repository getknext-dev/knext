/**
 * Slow-dependency logging for the cache path — the Redis half of the cold-start
 * ledger's discrimination instrument (row 3, `docs/benchmarks/cold-start-ledger.md`).
 *
 * Row 3's ~1-in-8 first-request stall is compatible with three readings, two of
 * which live here and are indistinguishable in today's logs because BOTH end in
 * success (no `failing open` line):
 *
 *   - the lazy first connect is retransmit-delayed but succeeds (TCP phase);
 *   - the handshake is fast and the ready-check `INFO` is slow but stays inside
 *     the command budget (post-handshake server responsiveness).
 *
 * ioredis's `connect` event splits those two phases exactly, so each gets its
 * own dep class: `redis-connect` and `redis-ready`. Listeners only — no timer,
 * no budget, no behaviour change (the budgets in `cache-handler.js` are
 * untouched, and this never marks the client unhealthy).
 *
 * The emitter below duplicates `@getknext/lib`'s `src/slow-dep.ts` on purpose:
 * `lib` cannot import `core` (dependency cycle) and this file is loaded by Next
 * via `cacheHandler` as a path, so it stays dependency-light. Drift is held by
 * `slow-dep-format-parity.test.ts`, which asserts the two produce byte-identical
 * lines — the instrument is only useful if one grep returns all three readings.
 */

/** The grep anchor. Do not change it without changing the ledger's next row. */
export const SLOW_DEP_PREFIX = '[slow-dep]';

const DEFAULT_SLOW_DEP_LOG_MS = 500;

/** The effective threshold (ms), read at CALL time. Junk → the default. */
export function slowDepThresholdMs() {
  const parsed = Number.parseInt(process.env.SLOW_DEP_LOG_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SLOW_DEP_LOG_MS;
}

const MAX_VALUE_LEN = 120;

/** Anything URL-shaped or carrying userinfo is a credential risk — drop it. */
function looksLikeTarget(value) {
  return value.includes('://') || value.includes('@');
}

function safeExtra(extra) {
  const out = {};
  if (!extra) return out;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      if (looksLikeTarget(value)) continue;
      out[key] = value.length > MAX_VALUE_LEN ? value.slice(0, MAX_VALUE_LEN) : value;
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Emit one line iff `durationMs` EXCEEDS the threshold; returns whether it did.
 * Fail-open — the cache path must never break because logging did.
 */
export function logSlowDep(dep, op, durationMs, extra) {
  try {
    const thresholdMs = slowDepThresholdMs();
    if (!(durationMs > thresholdMs)) return false;
    const fields = {
      dep,
      op,
      durationMs: Math.round(durationMs),
      thresholdMs,
      ...safeExtra(extra),
    };
    console.warn(`${SLOW_DEP_PREFIX} ${JSON.stringify(fields)}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Time a client's connect and ready-check phases SEPARATELY, from now until the
 * client's `connect` / `ready` events.
 *
 * - `redis-connect` = attach → `connect` (TCP handshake, the retransmit-delay
 *   reading);
 * - `redis-ready`   = `connect` → `ready` (the ready-check `INFO`, the
 *   post-handshake responsiveness reading). If `connect` never fired (an
 *   already-connected client), the ready phase is measured from attach.
 *
 * Returns a detach function; the caller MUST call it when the wait settles, so
 * no listener outlives the connection attempt it was measuring.
 *
 * @param {{ on: Function, removeListener: Function }} client
 * @param {() => number} [now] injectable clock (tests)
 * @returns {() => void} detach
 */
export function instrumentConnectTiming(client, now = Date.now) {
  const startedAt = now();
  let connectedAt = null;

  const onConnect = () => {
    connectedAt = now();
    logSlowDep('redis-connect', 'client.connect', connectedAt - startedAt);
  };
  const onReady = () => {
    logSlowDep('redis-ready', 'ready-check', now() - (connectedAt ?? startedAt));
  };

  try {
    client.on('connect', onConnect);
    client.on('ready', onReady);
  } catch {
    // Fail-open: an unusual client object must not break the cache path.
    return () => {};
  }

  return () => {
    try {
      client.removeListener('connect', onConnect);
      client.removeListener('ready', onReady);
    } catch {
      // Already gone.
    }
  };
}
