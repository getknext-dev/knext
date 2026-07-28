/**
 * Next.js Custom CacheHandler — Redis-backed with in-memory fallback
 *
 * Implements the Next.js CacheHandler interface for Knative deployments.
 * When REDIS_URL is set: stores ISR/data cache in Redis for multi-pod consistency.
 * When REDIS_URL is not set: falls back to in-memory Map (dev mode).
 *
 * All operations are logged to global.cacheEvents for the Cache Monitor UI.
 *
 * IMPORTANT: Next.js 16 uses Map (segmentData) and Buffer (rscData) in cache
 * entries. JSON.stringify destroys these types, so we use custom serialization.
 *
 * Reference: https://nextjs.org/docs/app/api-reference/config/next-config-js/incrementalCacheHandlerPath
 */

// ─── Cache Event Logger ───

if (!globalThis.cacheEvents) globalThis.cacheEvents = [];
if (!globalThis.cacheEventCounter) globalThis.cacheEventCounter = 0;

const MAX_EVENTS = 200;

function logCacheEvent(type, source, key, options) {
  const event = {
    id: `evt-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    timestamp: new Date().toISOString(),
    type,
    source,
    key,
    ...(options || {}),
  };

  console.log(`[Cache] ${type} ${key} (${source})`);

  if (useRedis) {
    ensureConnected()
      .then((client) => {
        if (client) {
          const pipeline = client.pipeline();
          pipeline.lpush(`${KEY_PREFIX}:cache-events`, JSON.stringify(event));
          pipeline.ltrim(`${KEY_PREFIX}:cache-events`, 0, MAX_EVENTS - 1);
          pipeline.exec().catch(() => {});
        }
      })
      .catch(() => {});
  } else {
    globalThis.cacheEvents.unshift(event);
    if (globalThis.cacheEvents.length > MAX_EVENTS) {
      globalThis.cacheEvents = globalThis.cacheEvents.slice(0, MAX_EVENTS);
    }
  }

  const _emoji =
    {
      HIT: '✅',
      MISS: '❌',
      SET: '💾',
      DELETE: '🗑️',
      INVALIDATE: '🔄',
      REVALIDATE: '♻️',
    }[type] || '📝';
}

// ─── Redis Client (lazy, only when REDIS_URL is set) ───

const REDIS_URL = process.env.REDIS_URL;
// REDIS_KEY_PREFIX is set by the deploy path (manifest generator / operator) to the
// app name, so each app owns an isolated ISR keyspace. If Redis is in use but the var
// is unset, the fallback below ('kn-next') will NOT match the app-name keyspace other
// pods read/write — a silent split keyspace = cache misses + cross-app collisions.
// Surface it loudly rather than diverging quietly (see architecture review #2).
if (REDIS_URL && !process.env.REDIS_KEY_PREFIX) {
  console.warn(
    "[cache-handler] REDIS_KEY_PREFIX is unset while REDIS_URL is set — falling back " +
      "to 'kn-next'. ISR cache keys may not match the deploy-time prefix (app name); " +
      'set REDIS_KEY_PREFIX to avoid a split keyspace.',
  );
}
const KEY_PREFIX = process.env.REDIS_KEY_PREFIX || 'kn-next';

function envMs(name, fallback) {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// ─── Fault budgets (T14) ───
//
// Every one of these bounds a way Redis can fail WITHOUT rejecting. A refused
// connection announces itself; a socket that accepts and then answers nothing
// does not, and that is the fault that costs capacity rather than latency:
// without a budget, each request parks a command on a connection that will
// never reply, and the pod runs out of sockets/handles long before it runs out
// of patience.
//
//  - CONNECT_TIMEOUT_MS  — the whole connect+handshake, not just the TCP SYN.
//    ioredis's own `connectTimeout` covers the socket only, so a server that
//    completes the TCP handshake and then ignores the ready-check INFO leaves
//    `connect()` pending forever.
//  - COMMAND_TIMEOUT_MS  — a command issued on an established-but-dead socket.
//  - RETRY_COOLDOWN_MS   — the circuit breaker. Without it, every request pays
//    the full budget again and re-opens a connection: N requests → N hung
//    sockets. With it, one probe per cooldown and everything else fails fast to
//    origin.
const CONNECT_TIMEOUT_MS = envMs('REDIS_CONNECT_TIMEOUT_MS', 5000);
const COMMAND_TIMEOUT_MS = envMs('REDIS_COMMAND_TIMEOUT_MS', 2000);
const RETRY_COOLDOWN_MS = envMs('REDIS_RETRY_COOLDOWN_MS', 5000);

let Redis;
let redis;
let connectPromise;
let useRedis = !!REDIS_URL;
// While `Date.now() < unhealthyUntil` the breaker is OPEN: ensureConnected()
// returns null immediately and every caller degrades to origin/memory.
let unhealthyUntil = 0;

// In-memory fallback
const memoryCache = new Map();

/**
 * Trip the breaker and drop the current client.
 *
 * Dropping matters as much as the cooldown: ioredis's retryStrategy would
 * otherwise keep a doomed connection (and its pending commands) alive, so the
 * "one probe per cooldown" property would not hold.
 */
function markUnhealthy(reason) {
  unhealthyUntil = Date.now() + RETRY_COOLDOWN_MS;
  const dying = redis;
  redis = undefined;
  connectPromise = null;
  if (dying) {
    try {
      dying.disconnect();
    } catch {
      // Already gone.
    }
  }
  if (reason) console.error('[CacheHandler] Redis unhealthy, failing open:', reason);
}

async function getRedis() {
  if (!redis && REDIS_URL) {
    if (!Redis) {
      try {
        const mod = await import('ioredis');
        Redis = mod.default || mod;
      } catch {
        useRedis = false;
        return null;
      }
    }
    redis = new Redis(REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 100, 5000),
      connectTimeout: CONNECT_TIMEOUT_MS,
      // A command must never outlive its budget — see the note above.
      commandTimeout: COMMAND_TIMEOUT_MS,
      // Do NOT buffer commands issued while disconnected. An offline queue is
      // exactly the unbounded structure that turns a cache outage into a memory
      // leak; the handler's contract is to fail open, not to remember.
      enableOfflineQueue: false,
    });
    redis.on('error', (err) => {
      console.error('[CacheHandler] Redis error:', err.message);
    });
  }
  return redis;
}

/**
 * Wait for the client to reach `ready` — not merely `connect`.
 *
 * This distinction is the bug it fixes: `client.connect()` resolves on the TCP
 * connect event, BEFORE ioredis's ready-check completes. Checking
 * `status === 'ready'` right after awaiting it therefore lost the race and
 * silently returned null, so the first cache operations after boot went to the
 * in-memory fallback while a perfectly healthy Redis sat idle — a split cache
 * that reports success.
 *
 * There is deliberately NO timer of its own here, and the reason is measured
 * rather than assumed. Both halves of the wait are already bounded:
 *
 *   - before the TCP handshake, by ioredis's `connectTimeout` (it clears that
 *     timer on the socket's `connect` event — Redis.js:179);
 *   - after it, by `commandTimeout`, because the ready-check `INFO` is itself a
 *     command. `cache-handler-failure-modes.test.ts`'s busy-but-never-ready
 *     server proves this: removing `commandTimeout` makes it hang.
 *
 * An extra timer here duplicated that second bound exactly, so it could never
 * be mutation-proved — a guard that stays green when its subject is removed is
 * decoration, and decoration in a fault path reads as coverage that is not there.
 *
 * Resolves with the client, or null (breaker tripped). Never rejects.
 */
function waitForReady(client) {
  return new Promise((resolve) => {
    let settled = false;

    const cleanup = () => {
      client.removeListener('ready', onReady);
      client.removeListener('error', onFail);
      client.removeListener('end', onFail);
    };
    const done = (ok, reason) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!ok) markUnhealthy(reason);
      resolve(ok ? client : null);
    };
    function onReady() {
      done(true);
    }
    function onFail(err) {
      done(false, err?.message || 'connection ended');
    }

    client.on('ready', onReady);
    client.on('error', onFail);
    client.on('end', onFail);

    if (client.status === 'ready') {
      done(true);
      return;
    }
    if (client.status === 'wait' || client.status === 'end' || client.status === 'close') {
      client.connect().catch((err) => done(false, err?.message));
    }
  });
}

async function ensureConnected() {
  if (!useRedis) return null;
  // Breaker open — fail open to origin/memory without touching the socket.
  if (Date.now() < unhealthyUntil) return null;
  const client = await getRedis();
  if (!client) return null;
  if (client.status === 'ready') return client;
  if (!connectPromise) {
    connectPromise = waitForReady(client).then((result) => {
      connectPromise = null;
      return result;
    });
  }
  return await connectPromise;
}

/**
 * Run one Redis command, tripping the breaker if it faults.
 *
 * The fault this exists for is the ESTABLISHED-but-dead connection: the
 * handshake completed, so `waitForReady` is satisfied, and then the server
 * stops answering. `commandTimeout` bounds each individual command, but without
 * tripping the breaker EVERY subsequent request pays that budget again — the
 * queue of outstanding commands grows with traffic, which is a capacity failure,
 * not a latency one. One fault is enough to fail open until the cooldown.
 *
 * Deliberately NOT applied to deserialization: a corrupt payload is a data
 * fault, not a connection fault, and must not take the cache offline.
 */
async function redisCall(fn) {
  try {
    return await fn();
  } catch (err) {
    markUnhealthy(err?.message);
    throw err;
  }
}

// ─── Key Builders ───

function cacheKey(key) {
  return `${KEY_PREFIX}:cache:${key}`;
}

function tagKey(tag) {
  return `${KEY_PREFIX}:tag:${tag}`;
}

// ─── Serialization Helpers ───
// Next.js 16 cache entries contain Map (segmentData) and Buffer (rscData)
// that JSON.stringify/parse can't round-trip. These helpers preserve types.

function serializeCacheValue(data) {
  if (!data || typeof data !== 'object') return data;
  const serialized = { ...data };
  // segmentData: Map<string, Buffer> → Array<[string, base64]>
  if (data.segmentData instanceof Map) {
    serialized.segmentData = Array.from(data.segmentData.entries()).map(([k, v]) => [
      k,
      Buffer.isBuffer(v) ? v.toString('base64') : v,
    ]);
    serialized.__segmentDataSerialized = true;
  }
  // rscData: Buffer → base64 string
  if (Buffer.isBuffer(data.rscData)) {
    serialized.rscData = data.rscData.toString('base64');
    serialized.__rscDataSerialized = true;
  }
  return serialized;
}

function deserializeCacheValue(data) {
  if (!data || typeof data !== 'object') return data;
  // Reconstitute the value inside the cache entry wrapper
  const value = data.value;
  if (!value || typeof value !== 'object') return data;
  // segmentData: Array<[string, base64]> → Map<string, Buffer>
  if (value.__segmentDataSerialized && Array.isArray(value.segmentData)) {
    value.segmentData = new Map(value.segmentData.map(([k, v]) => [k, Buffer.from(v, 'base64')]));
    value.__segmentDataSerialized = undefined;
  }
  // rscData: base64 string → Buffer
  if (value.__rscDataSerialized && typeof value.rscData === 'string') {
    value.rscData = Buffer.from(value.rscData, 'base64');
    value.__rscDataSerialized = undefined;
  }
  return data;
}

/**
 * Clone cache value for in-memory storage, preserving Map and Buffer types.
 * Next.js may mutate cache values after set(), so we need our own copy.
 */
function cloneCacheValue(data) {
  if (!data || typeof data !== 'object') return data;
  const cloned = { ...data };
  // Deep-clone segmentData Map to preserve type and avoid shared references
  if (data.segmentData instanceof Map) {
    cloned.segmentData = new Map(data.segmentData);
  }
  // Clone Buffer to avoid shared memory
  if (Buffer.isBuffer(data.rscData)) {
    cloned.rscData = Buffer.from(data.rscData);
  }
  return cloned;
}

// ─── In-flight write accounting (T13) ───
//
// Atomicity guarantees an interrupted write is never PARTIAL. It does not give
// a shutdown path any way to know a write is still outstanding — so a
// revalidation write that had already started could still be abandoned on
// SIGTERM, losing an entry that was seconds from committing.
//
// `drainCacheWrites()` is that handle. It is what a SIGTERM path awaits (see
// `registerShutdownDrain` in adapters/shutdown.ts) so in-flight ISR writes
// settle before exit, and it is BOUNDED so a hung cache can never push the pod
// past its terminationGracePeriod — the grace cap, not the cache, decides when
// the process dies.
const inFlightWrites = new Set();

function trackWrite(promise) {
  inFlightWrites.add(promise);
  promise.then(
    () => inFlightWrites.delete(promise),
    () => inFlightWrites.delete(promise),
  );
  return promise;
}

/**
 * Await every in-flight cache write, or `timeoutMs`, whichever comes first.
 * Never rejects: a failed write must not turn a graceful shutdown into a crash.
 *
 * @param {number} [timeoutMs] hard cap; keep below the pod's grace period.
 * @returns {Promise<void>}
 */
export async function drainCacheWrites(timeoutMs = 5000) {
  if (inFlightWrites.size === 0) return;
  const settled = Promise.allSettled([...inFlightWrites]);
  let timer;
  const capped = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();
  });
  await Promise.race([settled, capped]);
  if (timer) clearTimeout(timer);
}

/** How many cache writes are currently in flight. Exposed for tests/telemetry. */
export function inFlightCacheWriteCount() {
  return inFlightWrites.size;
}

// ─── CacheHandler Class ───

class CacheHandler {
  constructor(options) {
    this.options = options;
    ensureConnected().catch(() => {});
  }

  async get(key) {
    const startTime = Date.now();
    const client = await ensureConnected();
    const source = client ? 'redis' : 'memory';

    try {
      if (client) {
          const data = await redisCall(() => client.get(cacheKey(key)));
          if (!data) {
            logCacheEvent('MISS', source, key, {
              durationMs: Date.now() - startTime,
            });
            return null;
          }
          const parsed = deserializeCacheValue(JSON.parse(data));
          logCacheEvent('HIT', source, key, {
            durationMs: Date.now() - startTime,
          });
          return parsed;
      }

      // In-memory fallback
      const entry = memoryCache.get(key);
      if (!entry) {
        logCacheEvent('MISS', source, key, {
          durationMs: Date.now() - startTime,
        });
        return null;
      }
      logCacheEvent('HIT', source, key, { durationMs: Date.now() - startTime });
      return entry;
    } catch (error) {
      logCacheEvent('MISS', source, key, {
        durationMs: Date.now() - startTime,
        details: `Error: ${error.message}`,
      });
      return null;
    }
  }

  // Registered in the in-flight set so a SIGTERM drain can await it (T13).
  // Next may or may not await this call; the accounting must not depend on it.
  set(key, data, ctx) {
    return trackWrite(this.#set(key, data, ctx));
  }

  async #set(key, data, ctx) {
    const startTime = Date.now();
    const client = await ensureConnected();
    const source = client ? 'redis' : 'memory';

    try {
      if (data === null) {
        if (client) await client.del(cacheKey(key));
        memoryCache.delete(key);
        logCacheEvent('DELETE', source, key, {
          durationMs: Date.now() - startTime,
        });
        return;
      }

      const ttl = ctx?.revalidate || 3600;

      if (client) {
        // Redis path: serialize Map/Buffer → JSON-safe types for JSON.stringify
        const redisEntry = {
          value: serializeCacheValue(data),
          lastModified: Date.now(),
          tags: ctx?.tags || [],
        };

        // ─── ATOMICITY GUARD (T13) ───
        //
        // One logical `set` is N+1 writes: the entry, plus one membership per
        // tag in the index `revalidateTag` reads. `multi()` is a MULTI/EXEC
        // TRANSACTION, not a pipeline, and the difference is the whole point:
        //
        //   pipeline — commands are applied as they ARRIVE. A process death
        //     (SIGTERM on scale-down) part-way through the transmission leaves
        //     the entry written with its tag index missing, so revalidateTag
        //     can never find it and the stale page survives to its TTL.
        //   multi/exec — Redis buffers the queued commands and applies them
        //     only at EXEC. A transmission that stops short applies NOTHING.
        //
        // Under scale-to-zero this is the COMMON path, not a tail case: SIGTERM
        // is correlated with the last request before idleness, which is exactly
        // when revalidation writes. Anyone replacing `multi()` with `pipeline()`
        // reintroduces the torn write — cache-handler-sigterm-atomicity.test.ts
        // reds on it.
        const tx = client.multi();
        tx.set(cacheKey(key), JSON.stringify(redisEntry), 'EX', ttl);
        if (ctx?.tags?.length) {
          for (const tag of ctx.tags) {
            tx.sadd(tagKey(tag), key);
          }
        }
        await redisCall(() => tx.exec());
      } else {
        // In-memory fallback path: store original data with Map/Buffer types preserved
        // Only used when Redis is NOT available, to avoid unbounded memory growth
        // and stale entries on revalidateTag (which only clears Redis).
        const memEntry = {
          value: cloneCacheValue(data),
          lastModified: Date.now(),
          tags: ctx?.tags || [],
        };
        memoryCache.set(key, memEntry);
      }

      logCacheEvent('SET', source, key, {
        durationMs: Date.now() - startTime,
        details: `TTL: ${ttl}s, Tags: [${(ctx?.tags || []).join(', ')}]`,
      });
    } catch (error) {
      console.error('[CacheHandler] Error setting cache:', key, error.message);
    }
  }

  // A tag invalidation is a write too — drainable on the same terms as `set`.
  revalidateTag(tags) {
    return trackWrite(this.#revalidateTag(tags));
  }

  async #revalidateTag(tags) {
    const startTime = Date.now();
    const tagList = Array.isArray(tags) ? tags : [tags];
    const client = await ensureConnected();
    const source = client ? 'redis' : 'memory';

    try {
      if (client) {
        for (const tag of tagList) {
            const tKey = tagKey(tag);
            const keys = await redisCall(() => client.smembers(tKey));
            if (keys.length > 0) {
              // Same atomicity guard as `set` (T13): dropping the entries and
              // the tag index must be all-or-nothing, or a death mid-batch
              // leaves the tag set pointing at keys that no longer exist (or,
              // worse, entries that survive an invalidation that reported
              // success).
              const tx = client.multi();
              for (const k of keys) tx.del(cacheKey(k));
              tx.del(tKey);
              await redisCall(() => tx.exec());
            }
            logCacheEvent('INVALIDATE', source, `tag:${tag}`, {
              durationMs: Date.now() - startTime,
              details: `Invalidated ${keys.length} keys`,
              tag,
            });
          }
          return;
      }

      // In-memory fallback: iterate and delete matching entries
      for (const tag of tagList) {
        let count = 0;
        for (const [key, value] of memoryCache) {
          if (value.tags?.includes(tag)) {
            memoryCache.delete(key);
            count++;
          }
        }
        logCacheEvent('INVALIDATE', source, `tag:${tag}`, {
          durationMs: Date.now() - startTime,
          details: `Invalidated ${count} keys`,
          tag,
        });
      }
    } catch (error) {
      console.error('[CacheHandler] Error revalidating tags:', tagList, error.message);
    }
  }

  resetRequestCache() {}
}

export default CacheHandler;
