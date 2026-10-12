/**
 * The shared Redis `cacheHandlers` backend for `'use cache'` (Next >= 16.4).
 *
 * Next runs `'use cache'` through `cacheHandlers` (plural), a different contract
 * from the singular `cacheHandler` that serves ISR and the response cache. On a
 * knext app only the singular one was wired and the scaffold sets
 * `cacheMaxMemorySize: 0`, so Next's built-in `'use cache'` handler was a no-op
 * in production: no error, no cache. This is the handler the adapter wires in
 * its place, so an entry is shared by every pod behind a Knative Service and
 * survives scale-to-zero.
 *
 * What it shares with the singular handler, and what it deliberately does not
 * (ADR-0066 D2). It SHARES the Redis connection, its timeouts, its circuit
 * breaker, the key prefix and the build id, through the `core` object
 * `CacheHandler.useCacheHandler()` injects. It does NOT share an entry format, a
 * tag store or an outage mode, because Next's two contracts differ on all three:
 *
 *  - Entry: `<prefix>:uc:<kind>:<cacheKey>` holds one JSON envelope (metadata +
 *    the body as base64). `<cacheKey>` is Next's own key, stored opaque. It
 *    already embeds `deploymentId || buildId`, so two builds never read each
 *    other's entries and no foreign-build check is needed (nor wanted: it would
 *    defeat the durable-entries flag). The ISR handler's window-withholding and
 *    liveness rules do not apply here: nothing is stripped or rewritten.
 *  - Tags: Next's contract is TIMESTAMPS. One Redis hash, `<prefix>:uc:tags`,
 *    carries `s:<tag>` (stale at) and `e:<tag>` (expired at), epoch ms, written
 *    by a single HSET so two pods invalidating at once cannot lose each other's
 *    field. The semantics copy Next's built-in handler.
 *  - Outage: Redis down means MISS and DROP. There is no per-process store of
 *    any kind -- not even Next's in-memory default -- because this is where
 *    per-user entries live and a pod-local copy would sit outside the TTL cap and
 *    never see another pod's invalidation.
 *
 * One `revalidateTag` already reaches both handlers: Next calls `updateTags` on
 * every configured `cacheHandlers` kind AND `revalidateTag` on the singular
 * handler for the same tags. So `updateTags` here invalidates this store and the
 * singular handler invalidates its own; neither needs the other's. A CDN purge,
 * when one is wired, belongs to the SINGULAR `revalidateTag` only (ADR-0068 D6.2)
 * -- calling it from here as well would double every purge.
 *
 * Stream contract (next@16.4.0 `cache-handlers/types.d.ts`): `set` consumes the
 * entry's value stream exactly once and never retains it (nor the pending-entry
 * promise); `get` returns a NEW stream every time; a `get` that arrives while a
 * `set` for the same key is pending waits for it; the handler owns eviction.
 */
import { trackWrite } from './cache-write-registry.js';

/** Process-wide counters, read by tests and any future exporter. */
const COUNTERS_KEY = Symbol.for('knext.cache.useCache.counters');

function count(name) {
  const bag = (globalThis[COUNTERS_KEY] ??= {});
  bag[name] = (bag[name] ?? 0) + 1;
}

const ENVELOPE_VERSION = 1;
const DEFAULT_MAX_TTL_SECONDS = 86_400;
// Stamps are pruned in a bounded step, at most this often per process.
const PRUNE_INTERVAL_MS = 30_000;
const PRUNE_PAGE = 100;

/**
 * Upper bound on a Redis TTL. Next's default `cacheLife` sets `expire` to
 * INFINITE_CACHE (~136 years), and the contract puts eviction on the handler, so
 * without a cap every entry would live until memory pressure evicts it -- per-user
 * results included. Read per call: the environment is not cached.
 */
function maxTtlSeconds() {
  const raw = Number.parseInt(process.env.KNEXT_USE_CACHE_MAX_TTL_SECONDS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_TTL_SECONDS;
}

/** Next's clock for tag stamps (`cache-handlers/default.js`). */
function nowMs() {
  return Math.round(performance.timeOrigin + performance.now());
}

/**
 * Read a stream to its end. `keep: false` still reads every chunk: a stream Next
 * handed us must be consumed, or its producer is left waiting on a reader that
 * never comes. Rejects if the stream errors; the caller decides what that means.
 */
async function readStream(stream, keep) {
  const reader = stream.getReader();
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (keep && value) chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released: nothing to give back.
    }
  }
  return keep ? Buffer.concat(chunks) : undefined;
}

function streamFromBuffer(buffer) {
  return new ReadableStream({
    start(controller) {
      if (buffer.byteLength > 0) controller.enqueue(buffer);
      controller.close();
    },
  });
}

/**
 * Why an entry cannot be stored, or null. These are CLIENT-SIDE faults: they are
 * caught before any Redis call and never reach `redisCall`, so they cannot open
 * the circuit breaker the ISR handler shares.
 */
function invalidReason(cacheKey, entry) {
  if (typeof cacheKey !== 'string' || cacheKey.length === 0) return 'cache key';
  if (!entry || typeof entry !== 'object') return 'entry';
  if (!Number.isFinite(entry.timestamp)) return 'timestamp';
  if (!Number.isFinite(entry.expire)) return 'expire';
  if (!Number.isFinite(entry.stale)) return 'stale';
  if (!Number.isFinite(entry.revalidate)) return 'revalidate';
  if (!Array.isArray(entry.tags) || !entry.tags.every((t) => typeof t === 'string')) return 'tags';
  if (!entry.value || typeof entry.value.getReader !== 'function') return 'value stream';
  return null;
}

/** A stored envelope, or null when the payload is not one (a data fault, not a connection fault). */
function parseEnvelope(raw) {
  try {
    const env = JSON.parse(raw);
    if (
      !env ||
      env.v !== ENVELOPE_VERSION ||
      typeof env.body !== 'string' ||
      !Array.isArray(env.tags) ||
      !Number.isFinite(env.timestamp) ||
      !Number.isFinite(env.expire) ||
      !Number.isFinite(env.revalidate) ||
      !Number.isFinite(env.stale)
    ) {
      return null;
    }
    return env;
  } catch {
    return null;
  }
}

/**
 * @param {object} args
 * @param {string} args.kind  Next's cache kind: `default` or `remote`.
 * @param {object} args.core  The collaborators `cache-handler.js` owns:
 *   `ensureConnected()` (client or null), `redisCall(fn)` (trips the shared
 *   breaker on a fault), `command(client, name, args)`, `keyPrefix()`,
 *   `buildId()` and `redisConfigured()`.
 */
export function createUseCacheHandler({ kind, core }) {
  // Handler-owned promises, one per in-flight set. They settle when the set
  // finishes and are removed in `finally`; they never hold the entry or its stream.
  const pendingSets = new Map();
  let lastPrune = 0;
  let pruneCursor = '0';
  let outageWarned = false;

  const entryKey = (cacheKey) => `${core.keyPrefix()}:uc:${kind}:${cacheKey}`;
  const tagsKey = () => `${core.keyPrefix()}:uc:tags`;

  /** One warning per outage, never the cache key (it can carry per-user arguments). */
  function noteUnavailable() {
    if (outageWarned) return;
    outageWarned = true;
    console.warn(
      core.redisConfigured()
        ? "[CacheHandler] Redis unavailable: 'use cache' entries are not cached until it returns " +
            '(there is no per-process fallback).'
        : "[CacheHandler] REDIS_URL is not set: 'use cache' entries are not cached " +
            '(there is no per-process fallback). Set REDIS_URL to share them across pods.',
    );
  }
  const noteAvailable = () => {
    outageWarned = false;
  };

  async function doGet(cacheKey) {
    const rkey = entryKey(cacheKey);
    const pending = pendingSets.get(rkey);
    if (pending) await pending;

    const client = await core.ensureConnected();
    if (!client) {
      noteUnavailable();
      count('miss');
      return undefined;
    }
    let raw;
    try {
      raw = await core.redisCall(() => core.command(client, 'GET', [rkey]));
    } catch {
      count('error');
      return undefined;
    }
    noteAvailable();
    if (raw === null || raw === undefined) {
      count('miss');
      return undefined;
    }
    const env = parseEnvelope(raw);
    if (!env) {
      count('corrupt');
      count('miss');
      return undefined;
    }

    // Next compares an entry against the tags it carries (its soft tags are
    // checked through `getExpiration`). Same rule as the built-in handler:
    // expired after the entry was made and not in the future = miss; stale after
    // it was made = serve once more and refresh (`revalidate: -1`).
    let revalidate = env.revalidate;
    const tags = env.tags.filter((t) => typeof t === 'string');
    if (tags.length > 0) {
      let stamps;
      try {
        stamps = await core.redisCall(() =>
          core.command(client, 'HMGET', [tagsKey(), ...tags.flatMap((t) => [`s:${t}`, `e:${t}`])]),
        );
      } catch {
        count('error');
        return undefined;
      }
      const now = nowMs();
      for (let i = 0; i < tags.length; i++) {
        const stale = Number(stamps?.[2 * i]);
        const expired = Number(stamps?.[2 * i + 1]);
        if (stamps?.[2 * i + 1] != null && Number.isFinite(expired) && expired <= now && expired > env.timestamp) {
          count('expired');
          count('miss');
          return undefined;
        }
        if (stamps?.[2 * i] != null && Number.isFinite(stale) && stale > env.timestamp) revalidate = -1;
      }
    }

    count('hit');
    return {
      value: streamFromBuffer(Buffer.from(env.body, 'base64')),
      tags: env.tags,
      stale: env.stale,
      timestamp: env.timestamp,
      expire: env.expire,
      revalidate,
    };
  }

  async function doSet(cacheKey, pendingEntry) {
    let entry;
    try {
      entry = await pendingEntry;
    } catch {
      // The render failed before there was an entry: nothing to store or drain.
      return;
    }
    const invalid = invalidReason(cacheKey, entry);
    if (invalid !== null || !(entry.expire > 0)) {
      // Not stored -- but the stream is Next's to be read, so read it.
      if (entry?.value && typeof entry.value.getReader === 'function') {
        await readStream(entry.value, false).catch(() => {});
      }
      if (invalid !== null) {
        count('invalid');
        console.warn(`[CacheHandler] 'use cache' entry not stored: invalid ${invalid}.`);
      } else {
        // `expire <= 0` is a dynamic entry: Next re-renders it on every read, and its
        // own handler skips the store in production. Never sent to Redis, which
        // rejects `SET ... EX 0` and would trip the breaker the ISR handler shares.
        count('skipped');
      }
      return;
    }

    let body;
    try {
      body = await readStream(entry.value, true);
    } catch {
      // A stream that errors part-way is an aborted render. Discard the partial entry.
      count('aborted');
      return;
    }

    const client = await core.ensureConnected();
    if (!client) {
      noteUnavailable();
      count('dropped');
      return;
    }
    const buildId = core.buildId();
    const envelope = JSON.stringify({
      v: ENVELOPE_VERSION,
      timestamp: entry.timestamp,
      stale: entry.stale,
      expire: entry.expire,
      revalidate: entry.revalidate,
      tags: entry.tags,
      ...(buildId !== undefined && { buildId }),
      body: body.toString('base64'),
    });
    const ttl = Math.max(1, Math.min(Math.ceil(entry.expire), maxTtlSeconds()));
    try {
      await core.redisCall(() => core.command(client, 'SET', [entryKey(cacheKey), envelope, 'EX', String(ttl)]));
      noteAvailable();
      count('set');
    } catch (err) {
      count('error');
      console.error("[CacheHandler] Error writing a 'use cache' entry:", err?.message);
    }
  }

  async function pruneStamps(client) {
    const now = Date.now();
    if (now - lastPrune < PRUNE_INTERVAL_MS) return;
    lastPrune = now;
    const reply = await core.redisCall(() =>
      core.command(client, 'HSCAN', [tagsKey(), pruneCursor, 'COUNT', String(PRUNE_PAGE)]),
    );
    pruneCursor = String(reply?.[0] ?? '0');
    const page = Array.isArray(reply?.[1]) ? reply[1] : [];
    // A stamp older than the TTL cap cannot affect a live entry: every entry
    // written before it has already expired.
    const cutoff = now - maxTtlSeconds() * 1000;
    const dead = [];
    for (let i = 0; i + 1 < page.length; i += 2) {
      const at = Number(page[i + 1]);
      if (Number.isFinite(at) && at < cutoff) dead.push(page[i]);
    }
    if (dead.length > 0) await core.redisCall(() => core.command(client, 'HDEL', [tagsKey(), ...dead]));
  }

  async function doUpdateTags(tags, durations) {
    const list = (Array.isArray(tags) ? tags : [tags]).filter((t) => typeof t === 'string' && t.length > 0);
    if (list.length === 0) return;
    const client = await core.ensureConnected();
    if (!client) {
      noteUnavailable();
      count('tagsDropped');
      return;
    }
    const now = nowMs();
    const fields = [];
    for (const tag of list) {
      if (durations) {
        // Stale now; expired later when the profile says when. No `expire` leaves
        // the existing expiry alone, as Next's handler does.
        fields.push(`s:${tag}`, String(now));
        if (Number.isFinite(durations.expire)) fields.push(`e:${tag}`, String(now + durations.expire * 1000));
      } else {
        fields.push(`e:${tag}`, String(now));
      }
    }
    try {
      await core.redisCall(() => core.command(client, 'HSET', [tagsKey(), ...fields]));
      noteAvailable();
      count('tagsUpdated');
      await pruneStamps(client);
    } catch (err) {
      // An invalidation lost to an outage is lost (ADR-0066 D2); it must not
      // fail the request that asked for it.
      count('error');
      console.error("[CacheHandler] Error updating 'use cache' tags:", err?.message);
    }
  }

  async function doGetExpiration(tags) {
    const list = (Array.isArray(tags) ? tags : []).filter((t) => typeof t === 'string' && t.length > 0);
    if (list.length === 0) return 0;
    const client = await core.ensureConnected();
    if (!client) return 0;
    let stamps;
    try {
      stamps = await core.redisCall(() => core.command(client, 'HMGET', [tagsKey(), ...list.map((t) => `e:${t}`)]));
    } catch {
      count('error');
      return 0;
    }
    let newest = 0;
    for (const v of stamps ?? []) {
      const at = Number(v);
      if (v != null && Number.isFinite(at) && at > newest) newest = at;
    }
    return newest;
  }

  return {
    async get(cacheKey, _softTags) {
      try {
        return await doGet(cacheKey);
      } catch {
        // Fail open to rendering, never crash a request over a cache.
        count('error');
        return undefined;
      }
    },

    // Registered in the in-flight set so a SIGTERM drain CAN await it, like the
    // ISR handler's writes. Never rejects.
    set(cacheKey, pendingEntry) {
      const rkey = typeof cacheKey === 'string' ? entryKey(cacheKey) : undefined;
      let settle = () => {};
      const mine = new Promise((resolve) => {
        settle = resolve;
      });
      if (rkey !== undefined) pendingSets.set(rkey, mine);
      const work = doSet(cacheKey, pendingEntry)
        .catch((err) => {
          count('error');
          console.error("[CacheHandler] Error writing a 'use cache' entry:", err?.message);
        })
        .finally(() => {
          if (rkey !== undefined && pendingSets.get(rkey) === mine) pendingSets.delete(rkey);
          settle();
        });
      return trackWrite(work);
    },

    // No per-process tag manifest, so nothing to refresh: every read checks the
    // live stamps, and there is no cross-pod staleness window.
    async refreshTags() {},

    async getExpiration(tags) {
      try {
        return await doGetExpiration(tags);
      } catch {
        return 0;
      }
    },

    updateTags(tags, durations) {
      return trackWrite(
        doUpdateTags(tags, durations).catch(() => {
          count('error');
        }),
      );
    },
  };
}
