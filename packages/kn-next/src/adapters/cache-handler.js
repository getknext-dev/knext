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
 *
 * This module is the GENERIC entry (`@getknext/core/adapters/cache-handler`)
 * AND the shared core of the per-runtime entries `cache-handler-node.js` and
 * `cache-handler-bun.js`, which subclass it to fix the Redis client (#1843; see
 * `redisClient` below).
 */

// In-flight write accounting (T13) lives in its own module because its state
// must be anchored on `globalThis` — see the header of cache-write-registry.js.
// This module imports `trackWrite` and re-exports NOTHING new from it: the
// handler subpaths stay default-only, because they exist to be handed to
// Next's `cacheHandler` option by path, not called.
import { trackWrite } from './cache-write-registry.js';
// Slow-dependency discrimination (cold-start ledger row 3). Observation only:
// it attaches two listeners to the connecting client and names which PHASE was
// slow (TCP connect vs the ready-check INFO). No timer, no budget, no verdict —
// see the header of slow-dep-log.js.
import { instrumentConnectTiming } from './slow-dep-log.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

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
          execBatch(client, [
            ['LPUSH', `${KEY_PREFIX}:cache-events`, JSON.stringify(event)],
            ['LTRIM', `${KEY_PREFIX}:cache-events`, '0', String(MAX_EVENTS - 1)],
          ]).catch(() => {});
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

let REDIS_URL = process.env.REDIS_URL;
// REDIS_KEY_PREFIX is set by the deploy path (manifest generator / operator) to the
// app name, so each app owns an isolated ISR keyspace. If Redis is in use but the var
// is unset, the fallback below ('kn-next') will NOT match the app-name keyspace other
// pods read/write — a silent split keyspace = cache misses + cross-app collisions.
// Surface it loudly rather than diverging quietly (see architecture review #2).
/**
 * The split-keyspace warning, as a function so the env reset can re-emit it.
 *
 * It used to be a bare `if` at module scope, which meant `__resetEnvForTests`
 * re-read the values but not this SIDE EFFECT — so a test that set the env and
 * reset saw the new prefix and no warning, and reported the guard as missing
 * when it was simply never re-run. A reset that restores some of what module
 * evaluation did is worse than none: it looks like a fresh module.
 */
function warnOnSplitKeyspace() {
  if (REDIS_URL && !process.env.REDIS_KEY_PREFIX) {
    console.warn(
      "[cache-handler] REDIS_KEY_PREFIX is unset while REDIS_URL is set — falling back " +
        "to 'kn-next'. ISR cache keys may not match the deploy-time prefix (app name); " +
        'set REDIS_KEY_PREFIX to avoid a split keyspace.',
    );
  }
}

warnOnSplitKeyspace();
let KEY_PREFIX = process.env.REDIS_KEY_PREFIX || 'kn-next';

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
let CONNECT_TIMEOUT_MS = envMs('REDIS_CONNECT_TIMEOUT_MS', 5000);
let COMMAND_TIMEOUT_MS = envMs('REDIS_COMMAND_TIMEOUT_MS', 2000);
let RETRY_COOLDOWN_MS = envMs('REDIS_RETRY_COOLDOWN_MS', 5000);

/**
 * Re-read every env-derived value, for tests.
 *
 * These are computed once at import, which is right for a running pod — the
 * environment does not change under it — but it made the module untestable
 * without a module-registry reset. vitest had `vi.resetModules()`; `bun:test`
 * deliberately does not, so the first value a test set won for the whole file
 * and later cases silently exercised the wrong prefix or budget.
 *
 * Exported rather than inferred: an explicit reset states exactly which state
 * this module owns, which a registry reset never did — and could not, once any
 * of it moved onto `globalThis`.
 */
/**
 * The two seams below MUTATE process-wide cache state and ship on a PUBLISHED
 * subpath (`@getknext/core/adapters/cache-handler`) — a consumer calling
 * `__setRedisClientForTests(undefined)` would silently disable every app's
 * cache. The design-gate verdict on the sprint that added them: a published
 * mutating seam must fail closed. They now require an explicit harness opt-in;
 * the pure `__`-helpers (options/budget/ttl/exec) stay ungated — they mutate
 * nothing.
 */
function assertTestSeamEnabled(name) {
  // UNCONDITIONAL in production, flag or no flag (T6b). The opt-in is an env
  // var on a published subpath, and anything that can set an env var in the
  // app's process — an npm postinstall, a compromised transitive dep, a
  // Dockerfile `ENV` copied from a blog post — could otherwise re-enable a seam
  // that repoints the process-wide cache. There is no legitimate production
  // caller of these two, so the flag has nothing to unlock here. The scan that
  // moves the seams off the published subpath entirely is still the real fix;
  // this is the half that costs nothing and closes the re-enable path today.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `knext: ${name} is a TEST-ONLY seam on a published module and is REFUSED under ` +
        'NODE_ENV=production regardless of KNEXT_TEST_SEAMS — it repoints the process-wide ' +
        'cache. Nothing legitimate calls it in a production process.',
    );
  }
  if (process.env.KNEXT_TEST_SEAMS !== '1') {
    throw new Error(
      `knext: ${name} is a TEST-ONLY seam on a published module — it repoints ` +
        'the process-wide cache and must never run in production. A test ' +
        'harness enables it with KNEXT_TEST_SEAMS=1.',
    );
  }
}

function __resetEnvForTests() {
  assertTestSeamEnabled('__resetEnvForTests');
  REDIS_URL = process.env.REDIS_URL;
  KEY_PREFIX = process.env.REDIS_KEY_PREFIX || 'kn-next';
  // Re-emit what module evaluation emits, not just what it assigns.
  warnOnSplitKeyspace();
  // EVERY piece of state module evaluation establishes, not just the env-derived
  // values. A partial reset is worse than none: it leaves the module looking
  // fresh while a live client, an in-flight connect promise, or a circuit-breaker
  // deadline survives from the previous test — which produces order-dependent
  // passes, the failure mode that reads as success.
  //
  // The client is DROPPED, not closed. Every caller is a test holding a fake;
  // making this async to `quit()` a real one would put an await in every
  // `beforeEach` for a case that does not exist. Production must not call this.
  redis = undefined;
  clientLoad = null;
  connectPromise = undefined;
  useRedis = !!REDIS_URL;
  unhealthyUntil = 0;
  CONNECT_TIMEOUT_MS = envMs('REDIS_CONNECT_TIMEOUT_MS', 5000);
  COMMAND_TIMEOUT_MS = envMs('REDIS_COMMAND_TIMEOUT_MS', 2000);
  RETRY_COOLDOWN_MS = envMs('REDIS_RETRY_COOLDOWN_MS', 5000);
}

/**
 * Install a fake Redis client, for tests.
 *
 * Without this the ENTIRE Redis branch of `get`/`set` was unreachable from a
 * unit test — it needs a live server — so the two things #886 fixed on that
 * branch (the entry's TTL, and labelling a read `stale`) were provable only
 * against the in-memory fallback, where neither exists. That is not a
 * theoretical gap: mutating the Redis-path call sites left the suite GREEN.
 *
 * Takes a NATIVE-shaped client (no `.on`), which is the shape production uses
 * on Bun, and wraps it exactly as `getRedis` does so the gate and the command
 * budget are in play too. Production must not call this.
 */
function __setRedisClientForTests(client) {
  assertTestSeamEnabled('__setRedisClientForTests');
  redis = client ? budgetNativeClient(client) : undefined;
  useRedis = !!client;
  unhealthyUntil = 0;
  connectPromise = null;
  clientLoad = null;
}

let redis;
let clientLoad = null;
let connectPromise;
let useRedis = !!REDIS_URL;
// While `Date.now() < unhealthyUntil` the breaker is OPEN: ensureConnected()
// returns null immediately and every caller degrades to origin/memory.
let unhealthyUntil = 0;

// In-memory fallback
const memoryCache = new Map();

// ─── Optimized-image variants (write-free runtime) ───
//
// With `images.customCacheHandler: true` (the knext adapter sets it when the
// app uses this handler), Next's image optimizer stores every optimized
// variant HERE instead of writing `.next/cache/images`, so the app needs no
// writable volume. On Redis they are shared and survive scale-to-zero like
// every other entry. On the in-memory fallback they are per-pod, so they live
// in their own map with a BYTE budget, evicting least-recently-used first: an
// unbounded map would grow by one encoded image per distinct
// (src, width, quality, format) a client asks for.
const imageMemory = new Map();
let imageMemoryBytes = 0;
const DEFAULT_IMAGE_MEMORY_BYTES = 32 * 1024 * 1024;

function imageMemoryBudget() {
  const raw = Number(process.env.KNEXT_IMAGE_CACHE_MEMORY_BYTES);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_IMAGE_MEMORY_BYTES;
}

function isImageValue(data) {
  return !!data && data.kind === 'IMAGE' && Buffer.isBuffer(data.buffer);
}

function dropImageFromMemory(key) {
  const entry = imageMemory.get(key);
  if (!entry) return;
  imageMemory.delete(key);
  imageMemoryBytes -= entry.value.buffer.byteLength;
}

function storeImageInMemory(key, entry) {
  dropImageFromMemory(key);
  const size = entry.value.buffer.byteLength;
  const budget = imageMemoryBudget();
  // A variant bigger than the whole budget is not cached at all — storing it
  // would evict everything else and then itself on the next write.
  if (size > budget) return false;
  while (imageMemoryBytes + size > budget && imageMemory.size > 0) {
    dropImageFromMemory(imageMemory.keys().next().value);
  }
  imageMemory.set(key, entry);
  imageMemoryBytes += size;
  return true;
}

function readImageFromMemory(key) {
  const entry = imageMemory.get(key);
  if (!entry) return undefined;
  // Map iteration order is insertion order: re-inserting marks it most recent.
  imageMemory.delete(key);
  imageMemory.set(key, entry);
  return entry;
}

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

/**
 * WHICH Redis client is a per-runtime decision, made by the ENTRY that Next
 * loads — not by this module (#1843).
 *
 *   - `cache-handler-node.js` (Node): ioredis, through a LITERAL
 *     `import('ioredis')`, so Next's standalone file tracing copies it into the
 *     node image.
 *   - `cache-handler-bun.js` (Bun): Bun's native client (`Bun.RedisClient`,
 *     1.2.9+), and no ioredis import anywhere. ioredis reaches
 *     `@ioredis/commands` through a transitive dynamic `require` that
 *     `bun build --compile` cannot resolve, so a compiled binary that executes
 *     it dies at boot; the native client also costs no JavaScript at startup.
 *   - this module's own default export (the generic subpath — vinext, `next
 *     dev`, any `next build` knext did not drive, apps whose `cache-handler.js`
 *     re-exports it): detects the runtime itself — see `RUNTIME_DETECTED`.
 *
 * `knext build`/`deploy`/`preview` export the configured runtime to
 * `next build`, and the knext adapter points `cacheHandler` at the matching
 * entry. Each entry is a subclass of {@link CacheHandler} overriding the static
 * `redisClient` — `{ name, load(url) }` — that the constructor installs as the
 * client loader. `load` returns a ready-to-use client (see
 * {@link nativeRedisClient} and {@link ioredisClient}) or throws.
 */

/**
 * The generic entry's runtime detection: Bun's native client under Bun,
 * ioredis under Node.
 *
 * The ioredis specifier here is deliberately NON-LITERAL, so this path never
 * bundles ioredis into a compiled Bun executable. That also hides it from
 * bundler tracing, which is why knext-driven builds do not come through here:
 * standalone builds get `cache-handler-node.js`/`-bun.js`, and the vinext
 * scaffold gets `vinext-cache-adapter-node`/`-bun`. What remains on this path
 * is `next dev` and apps scaffolded before the per-runtime adapters.
 *
 * `KNEXT_CACHE_REDIS_CLIENT=ioredis` forces ioredis even on Bun: the same
 * escape hatch `KNEXT_DB_DRIVER` provides for the Postgres driver, and the way
 * a suite running under Bun keeps covering the ioredis client shape (it has
 * `.on`/`.status`; Bun's has neither). Read on every call, deliberately:
 * `__resetEnvForTests` re-reads its cached values, and another cached copy
 * would be one more thing to keep in sync.
 */
const IOREDIS_SPECIFIER = ['io', 'redis'].join('');

function bunNativeAvailable() {
  if (process.env.KNEXT_CACHE_REDIS_CLIENT === 'ioredis') return false;
  const B = globalThis.Bun;
  return !!B && typeof B.RedisClient === 'function';
}

const RUNTIME_DETECTED = {
  get name() {
    return bunNativeAvailable() ? 'Bun native' : 'ioredis';
  },
  async load(url) {
    if (bunNativeAvailable()) return nativeRedisClient(globalThis.Bun, url);
    const mod = await import(IOREDIS_SPECIFIER);
    return ioredisClient(mod.default || mod, url);
  },
};

let redisClient = RUNTIME_DETECTED;

/**
 * Say so — loudly, once — when Redis is configured but its client cannot load.
 *
 * Before #1843 the standalone node image did not carry ioredis, and this case
 * fell back to the in-memory store in silence. Every cache line still logged,
 * just with a `(memory)` suffix, so the app looked healthy while ISR was
 * neither shared between pods nor kept across a scale-to-zero.
 *
 * Failing open is still right — a missing cache must not take the app down —
 * but a configured Redis that is never used is a deployment defect, not a
 * transient fault, so it is reported at error level rather than left for
 * someone to infer from log suffixes. The constructor attempts the connection
 * eagerly, so this lands at startup. Once per process without a flag: the load
 * is single-flight (`clientLoad`), and `useRedis` is cleared alongside the
 * report, so nothing retries it.
 */
function reportRedisClientUnavailable(err) {
  console.error(
    `[CacheHandler] Redis client unavailable: REDIS_URL is set but the ` +
      `${redisClient.name} Redis client could not be loaded ` +
      `(${err?.message || err}). Falling back to an in-memory cache: ISR and ` +
      'data-cache entries are NOT shared between pods and are lost on every ' +
      'scale-to-zero.',
  );
}

/**
 * A ready-to-use Bun native client for `url`, budgeted and wired exactly as
 * the handler needs it. `B` is the `Bun` global (passed in, so the entry that
 * owns the runtime decision is the only place that reads it).
 */
function nativeRedisClient(B, url) {
  // Budgeted ONCE, here — see `budgetNativeClient`. Everything downstream
  // (including `nativeTxQueue`) must see one stable client identity.
  const budgeted = budgetNativeClient(new B.RedisClient(url, __nativeClientOptions()));
  budgeted.onclose = (err) => {
    if (err) console.error('[CacheHandler] Redis error:', err.message);
  };
  return budgeted;
}

/** A ready-to-use ioredis client for `url`. `Redis` is the ioredis class. */
function ioredisClient(Redis, url) {
  const client = new Redis(url, {
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
  client.on('error', (err) => {
    console.error('[CacheHandler] Redis error:', err.message);
  });
  return client;
}

/**
 * The options handed to `Bun.RedisClient`, as their own function so the value a
 * test asserts is the value production constructs.
 *
 * `idleTimeout: 0` is load-bearing and was a real outage (#886). This used to
 * read `idleTimeout: COMMAND_TIMEOUT_MS`, on the belief that it was the
 * per-command budget ioredis's `commandTimeout` provides. It is not — Bun's
 * `idleTimeout` REAPS AN IDLE CONNECTION. Measured on bun 1.3.5 against
 * redis:7-alpine with `idleTimeout: 2000`: a 3 s gap survived, a 5 s gap and an
 * 11 s gap both failed with `ERR_REDIS_CONNECTION_CLOSED` ("Connection has
 * failed"); with the option omitted, both succeeded. `client.connected` still
 * reads `true` across the reap, so the socket dies silently and the failure
 * arrives as a command error on the next request.
 *
 * For a scale-to-zero pod every gap is longer than any command budget, so the
 * effect was a cache that flapped between Redis and the in-memory fallback —
 * two requests either side of a trip served by two different backends. That is
 * what #886 saw as "ISR is not cached at all".
 *
 * The budget the old value was mistaken for has NOT been dropped: it moved to
 * `budgetNativeClient` below, where it is what it claims to be.
 */
function __nativeClientOptions() {
  return {
    connectionTimeout: CONNECT_TIMEOUT_MS,
    // 0 = never reap. Stated explicitly rather than omitted: Bun's default is
    // not ours to assume, and this is the line that caused the outage.
    idleTimeout: 0,
    // Fail open rather than queue. An offline queue is the unbounded structure
    // that turns a cache outage into a memory leak — the same reason
    // `enableOfflineQueue: false` is set below.
    autoReconnect: true,
    maxRetries: 3,
  };
}

/**
 * Bound every command issued on the NATIVE client by `COMMAND_TIMEOUT_MS`.
 *
 * ioredis gets this from its own `commandTimeout` option; Bun's client has no
 * equivalent, and the fault it exists for is real — an established-but-dead
 * socket accepts writes and never answers, so without a bound each request
 * hangs for its whole lifetime and the outstanding-command queue grows with
 * traffic (a capacity failure, not a latency one).
 *
 * Wrapping is done by PROXY rather than by naming the four methods the handler
 * happens to call today: an enumerated list is how the fifth call site gets
 * missed. `connect` is the one deliberate exclusion — the handshake has its own,
 * longer, `CONNECT_TIMEOUT_MS`, and applying the command budget to it would turn
 * a merely slow Redis into an unreachable one.
 *
 * Created ONCE per client (in `getRedis`) because `nativeTxQueue` keys its
 * serialization chain on client identity; a fresh proxy per call would hand every
 * transaction its own empty queue and reopen the nested-MULTI bug.
 */
/**
 * The connection gate, and the raw client behind the proxy.
 *
 * On Bun's native client a MULTI lives on the CONNECTION, so ANY command issued
 * between `MULTI` and `EXEC` — a concurrent transaction OR an ordinary `GET` —
 * is queued into that transaction and answered `+QUEUED`. Serializing
 * transactions against each other is not enough: the read that broke the ISR
 * fixture was not a transaction (#886). So every command on a native client
 * takes ONE per-connection gate, and a transaction holds it for its whole
 * MULTI…EXEC span.
 */
const NATIVE_GATE = Symbol('knext.cacheHandler.nativeGate');
const NATIVE_TARGET = Symbol('knext.cacheHandler.nativeTarget');

/** Run `fn` with exclusive use of the connection the gate stands for. */
async function runGated(gate, fn) {
  if (!gate) return await fn();
  const previous = gate.tail;
  let release;
  gate.tail = new Promise((resolve) => {
    release = resolve;
  });
  // A failed predecessor must not poison the queue: its error belongs to its own
  // caller, and swallowing it here only means "the connection is free again".
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

function budgetNativeClient(client) {
  const gate = { tail: Promise.resolve() };
  return new Proxy(client, {
    get(target, prop) {
      if (prop === NATIVE_GATE) return gate;
      if (prop === NATIVE_TARGET) return target;
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      // EVERY method is re-bound to the real client, budgeted or not. Bun's
      // native methods brand-check their receiver — handing one the proxy fails
      // with "Expected this to be instanceof RedisClient", which is a hard error
      // on `connect()` and therefore an unconditional cache outage. Returning
      // the raw function for the unbudgeted case is what caused exactly that.
      const budgeted = prop !== 'connect';
      const call = (...args) => {
        const out = value.apply(target, args);
        if (!budgeted || !out || typeof out.then !== 'function') return out;
        return Promise.race([
          out,
          new Promise((_resolve, reject) =>
            setTimeout(
              () => reject(new Error(`redis command ${String(prop)} timed out`)),
              COMMAND_TIMEOUT_MS,
            ).unref?.(),
          ),
        ]);
      };
      // `connect` must not take the gate: nothing else can be in flight before
      // the handshake, and blocking on it would deadlock a reconnect.
      if (!budgeted) return call;
      return (...args) => runGated(gate, () => call(...args));
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

async function getRedis() {
  if (!redis && REDIS_URL) {
    // One load in flight at a time: the constructor's eager connect and the
    // first request race here, and two loads would build two clients.
    if (!clientLoad) {
      clientLoad = (async () => {
        try {
          redis = await redisClient.load(REDIS_URL);
        } catch (err) {
          useRedis = false;
          reportRedisClientUnavailable(err);
        } finally {
          clientLoad = null;
        }
      })();
    }
    await clientLoad;
  }
  return redis || null;
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

    // Times connect and ready SEPARATELY for the whole of this wait; detached
    // with the rest of the listeners below, so nothing outlives the attempt.
    const detachTiming = instrumentConnectTiming(client);

    const cleanup = () => {
      detachTiming();
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

/**
 * Readiness for Bun's NATIVE client, which has no EventEmitter surface at all.
 * Measured on Bun 1.4.0:
 *
 *   status: undefined   on: undefined   removeListener: undefined
 *   connected: boolean  connect: function
 *
 * `waitForReady` below is written against ioredis and calls `client.on('ready',
 * …)`, so handing it a native client threw `TypeError: client.on is not a
 * function` on EVERY cache read and write. That is worse than an outage: the
 * in-memory fallback that exists for an unavailable Redis was never reached,
 * because the failure arrived as a TypeError rather than a connection error.
 *
 * Same contract as `waitForReady`: resolves with the client or null, never
 * rejects, and trips the breaker on failure so the next call fails open
 * immediately instead of re-dialling a dead socket.
 */
async function waitForNativeReady(client) {
  if (client.connected) return client;
  try {
    await client.connect();
    return client.connected ? client : null;
  } catch (err) {
    markUnhealthy(err?.message || 'native redis connect failed');
    return null;
  }
}

/**
 * Run `commands` as ONE atomic unit, whichever client is in play.
 *
 * ioredis exposes `multi()`. Bun's native client exposes neither `multi()` nor
 * `pipeline()` — measured on 1.4.0, its prototype has only `send(command,
 * args)` — so the transaction is issued explicitly. The Redis semantics are the
 * same either way: commands queue at MULTI and apply only at EXEC.
 *
 * Atomicity is the point, not a nicety. `set` writing the entry but not its tag
 * index leaves an entry `revalidateTag` can never reach; `revalidateTag`
 * deleting the keys but not the tag set leaves the index pointing at nothing.
 *
 * On the native client the transaction lives on the CONNECTION, not on a command
 * object, so two concurrent callers interleave: the second's MULTI arrives before
 * the first's EXEC and Redis answers `ERR MULTI calls can not be nested` — while
 * its write is silently lost. That is not hypothetical. It was written here as a
 * caveat and shipped unguarded, and compat-smoke hit it four times per run: ISR
 * entries never landed, so the route was not cached at all.
 *
 * Native transactions therefore hold the connection gate for their WHOLE span —
 * and so does every ordinary command, because the queue-into-MULTI hazard is not
 * specific to writers. A `GET` issued between another caller's `MULTI` and its
 * `EXEC` is answered `+QUEUED`, which reads as a cache miss and re-renders the
 * page; that is the residual ISR miss in #886, and serializing transactions
 * against each other alone did not close it. ioredis needs no gate at all —
 * `multi()` builds a command object and batches it into a single write.
 *
 * @param {{ multi?: Function, send?: Function }} client
 * @param {string[][]} commands `[['SET', key, value, 'EX', '60'], …]`
 */
async function execAtomic(client, commands) {
  if (typeof client.multi === 'function') {
    const tx = client.multi();
    for (const [name, ...args] of commands) tx[name.toLowerCase()](...args);
    return await tx.exec();
  }
  // Taken ONCE for the whole transaction, and the sends inside it go to the RAW
  // client — routing them back through the proxy would have each of them queue
  // behind a gate this call already holds, which is a deadlock.
  const raw = client[NATIVE_TARGET] ?? client;
  return await runGated(client[NATIVE_GATE], () => runNativeTransaction(raw, commands));
}

async function runNativeTransaction(client, commands) {
  await client.send('MULTI', []);
  try {
    for (const [name, ...args] of commands) {
      await client.send(name.toUpperCase(), args.map(String));
    }
    return await client.send('EXEC', []);
  } catch (err) {
    // Never leave a half-open transaction on the connection: the next command
    // on it would silently be queued into this one.
    try {
      await client.send('DISCARD', []);
    } catch {}
    throw err;
  }
}

/**
 * Batch `commands` without transactional semantics — the event log, where
 * ordering matters and atomicity does not. Mirrors `execAtomic`'s client split:
 * `pipeline()` on ioredis, sequential `send` on the native client.
 *
 * @param {{ pipeline?: Function, send?: Function }} client
 * @param {string[][]} commands
 */
async function execBatch(client, commands) {
  if (typeof client.pipeline === 'function') {
    const pipe = client.pipeline();
    for (const [name, ...args] of commands) pipe[name.toLowerCase()](...args);
    return await pipe.exec();
  }
  for (const [name, ...args] of commands) {
    await client.send(name.toUpperCase(), args.map(String));
  }
  return undefined;
}

async function ensureConnected() {
  if (!useRedis) return null;
  // Breaker open — fail open to origin/memory without touching the socket.
  if (Date.now() < unhealthyUntil) return null;
  const client = await getRedis();
  if (!client) return null;
  // Branch on the client's SHAPE, not on an env flag: `getRedis` may hand back
  // either the native client or ioredis, and only the latter has `.on`/`.status`.
  // Reading `.status` on the native client yields undefined, which silently fell
  // through to the ioredis path — that is how this reached production.
  if (typeof client.on !== 'function') return await waitForNativeReady(client);
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

// ─── Tag resolution (#1764) ───
//
// `ctx.tags` is NOT where an APP_PAGE/APP_ROUTE/PAGES write's tags live. Next
// 16.3.5's response-cache (`response-cache/index.js`) calls
// `cacheHandler.set(key, value, ctx)` with `ctx = { cacheControl,
// isRoutePPREnabled, isFallback }` for those kinds — no `tags` field at all.
// The tags (including the implicit `_N_T_<path>` tag `revalidatePath`
// targets) live only in `value.headers['x-next-cache-tags']`, a
// comma-separated list. This is not knext's invention: Next's OWN default
// handler (`incremental-cache/file-system-cache.js`) reads that exact header
// for exactly those three kinds, precisely because `ctx.tags` is absent on
// write for them.
//
// `ctx.tags` stays the source for the FETCH (data-cache) kind, which DOES
// carry tags on ctx and never carries this header — unioning is therefore
// safe for every kind, not just the three that need it.
const NEXT_CACHE_TAGS_HEADER = 'x-next-cache-tags';

/** Tags recorded in `value.headers['x-next-cache-tags']`, if any. */
function tagsFromCacheValueHeader(value) {
  const header = value?.headers?.[NEXT_CACHE_TAGS_HEADER];
  if (typeof header !== 'string' || header.length === 0) return [];
  return header
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/** The full tag set for one write: `ctx.tags` ∪ the header's tags, de-duped. */
function resolveWriteTags(data, ctx) {
  return Array.from(new Set([...(ctx?.tags || []), ...tagsFromCacheValueHeader(data)]));
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
  // IMAGE buffer (an optimized variant): Buffer → base64 string. A plain
  // JSON.stringify would write `{ type: 'Buffer', data: [...] }`, and Next
  // sends `value.buffer` straight to the client on a hit.
  if (isImageValue(data)) {
    serialized.buffer = data.buffer.toString('base64');
    serialized.__bufferSerialized = true;
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
  // IMAGE buffer: base64 string → Buffer
  if (value.__bufferSerialized && typeof value.buffer === 'string') {
    value.buffer = Buffer.from(value.buffer, 'base64');
    value.__bufferSerialized = undefined;
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
  if (isImageValue(data)) {
    cloned.buffer = Buffer.from(data.buffer);
  }
  return cloned;
}

// ─── ISR staleness (#886) ───
//
// `revalidate` marks an entry STALE. It does not delete it. Next.js and vinext
// both keep serving the stale body while a background render replaces it, and
// vinext reads which of the three states applies off the `cacheState` field of
// whatever the handler's `get` returns (`isrGet` in vinext's isr-cache: absent =
// fresh, `"stale"` = serve and regenerate, `"expired"` = regeneration input
// only). Its own default handler computes that from `revalidateAt`/`expireAt`.
//
// This handler used to compute neither, and wrote the Redis entry with
// `EX <revalidate>` — so the entry was EVICTED at precisely the moment it should
// have become stale-but-servable, every request past the window was a cold MISS,
// and two closely-spaced requests could both miss (the first's write lands
// asynchronously) and render two different values. That is #886.

/** Seconds, from the cache-control metadata vinext attaches to a write. */
function cacheControlSeconds(ctx, field) {
  const value = ctx?.cacheControl?.[field];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Redis key TTL for one write.
 *
 * The ceiling is `expire` when the render claimed one; otherwise the entry must
 * simply outlive its revalidate window by enough to be served stale, which is
 * what `RETENTION_FLOOR_SECONDS` buys. Returning the revalidate window itself —
 * the old behaviour — makes the stale state unreachable by construction.
 */
const DEFAULT_TTL_SECONDS = 3600;
function __redisTtlSeconds(ctx) {
  const expire = cacheControlSeconds(ctx, 'expire');
  if (expire !== undefined) return expire;
  const revalidate = ctx?.revalidate;
  if (typeof revalidate === 'number' && revalidate > 0) {
    // A route may legitimately revalidate less often than the default TTL; the
    // entry must never be evicted before it is even due for revalidation.
    return Math.max(revalidate * 2, DEFAULT_TTL_SECONDS);
  }
  return DEFAULT_TTL_SECONDS;
}

/** The cache-control metadata worth persisting with an entry. */
function writeCacheControl(ctx) {
  const revalidate = cacheControlSeconds(ctx, 'revalidate') ?? ctx?.revalidate;
  const cacheControl = {};
  if (typeof revalidate === 'number' && Number.isFinite(revalidate))
    cacheControl.revalidate = revalidate;
  // `false` = never revalidate. Persisted so a woken process can hand it back
  // to Next (see seedNextCacheControl); `withCacheState` treats it as fresh.
  else if (ctx?.cacheControl?.revalidate === false) cacheControl.revalidate = false;
  const expire = cacheControlSeconds(ctx, 'expire');
  if (expire !== undefined) cacheControl.expire = expire;
  const stale = cacheControlSeconds(ctx, 'stale');
  if (stale !== undefined) cacheControl.stale = stale;
  return cacheControl;
}

/**
 * Label a stored entry fresh / stale / expired, on read.
 *
 * Returns the entry with `cacheState` set only when it is NOT fresh — absence is
 * vinext's encoding of "fresh", and inventing a `"fresh"` string would be a
 * value it does not recognise.
 */
function withCacheState(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return entry;
  const revalidate = entry.cacheControl?.revalidate;
  const expire = entry.cacheControl?.expire;
  const ageSeconds = (now - (entry.lastModified ?? now)) / 1000;
  if (typeof expire === 'number' && ageSeconds > expire) {
    return { ...entry, cacheState: 'expired' };
  }
  if (typeof revalidate === 'number' && revalidate > 0 && ageSeconds > revalidate) {
    return { ...entry, cacheState: 'stale' };
  }
  return entry;
}

// ─── Next's per-route revalidate window after a wake (#1888) ───
//
// On the Next standalone path freshness is NOT decided here. Next's
// `IncrementalCache.get` (16.3.6 `dist/server/lib/incremental-cache/index.js`)
// takes only `lastModified` + `value` from this handler and computes
// `isStale` itself (:440-451), from a window `calculateRevalidate` (:154-163)
// reads out of `SharedCacheControls` — a PROCESS-GLOBAL Map filled by
// `IncrementalCache.set` (:537-538) or, failing that, the prerender manifest.
// With neither it uses a 1-second window (:160).
//
// A path rendered at runtime (a dynamic route without generateStaticParams) is
// in no manifest, so its window lived only in the process that rendered it.
// After a scale-to-zero wake the Map is empty and every such entry older than
// a second read STALE and regenerated, though this handler had persisted the
// real window with the entry all along.
//
// So on a read, hand the persisted cacheControl back the only way Next accepts
// it: seed the shared Map — and only when this process has learnt nothing for
// the route itself, so a window from a write here (always the newest) wins.
//
// BUILD-SCOPED. Redis keys are scoped by app, not by build, so entries outlive
// a redeploy. Before this seed, the new build read an old build's entry STALE
// and regenerated it; seeding the old build's window would serve it FRESH for
// that whole window (forever for `revalidate: false`) and ignore a changed
// `revalidate`. So `set` records the writer's build id with the entry, and the
// seed applies only when it equals this process's build id. An entry without
// one (written before build ids were recorded) is never seeded.
//
// `shared-cache-controls.external` is the module Next keeps OUT of its route
// bundles precisely so every copy shares one Map; it is resolved from `next`,
// the same file the server and route chunks load. Do not count on the
// standalone-on-Bun compile's disk-closure scan to see this require: the
// package build renames `require` (tsup emits `require2(...)`), which the
// scan's literal `require(` pattern does not match. The module stays on disk —
// one instance — because Next's own `*.runtime.prod.js` requires it literally.
// Fail-open: no `next`, or a shape this does not recognise, and the read
// proceeds exactly as before — with one warning per process, so a Next release
// that renames the module is visible rather than a silent return of #1888.
let sharedCacheControlsMap;
const SHARED_CACHE_CONTROLS_MODULE =
  'next/dist/server/lib/incremental-cache/shared-cache-controls.external.js';
function nextSharedCacheControls() {
  if (sharedCacheControlsMap !== undefined) return sharedCacheControlsMap;
  sharedCacheControlsMap = null;
  let reason;
  try {
    const require = createRequire(import.meta.url);
    const mod = require(SHARED_CACHE_CONTROLS_MODULE);
    const map = mod?.SharedCacheControls?.cacheControls;
    if (map instanceof Map) sharedCacheControlsMap = map;
    else reason = 'SharedCacheControls.cacheControls is not a Map';
  } catch (err) {
    reason = err?.message || String(err);
  }
  if (reason) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        source: 'knext-cache-handler',
        event: 'next_cache_controls_unavailable',
        module: SHARED_CACHE_CONTROLS_MODULE,
        reason,
        impact:
          'ISR pages generated at request time may be served STALE on the first request after a cold start',
      }),
    );
  }
  return sharedCacheControlsMap;
}

/**
 * This process's build id — `.next/BUILD_ID`, read from where Next reads it
 * (`next-server.js`: `join(distDir, BUILD_ID_FILE)`, distDir being the parent
 * of the `serverDistDir` Next hands every cache handler). On the self-contained
 * compiled executable the same `fs` read is aliased to the embedded file.
 * `undefined` when Next did not pass `serverDistDir` (vinext) or the file is
 * unreadable — and then nothing is recorded and nothing is seeded.
 *
 * Next's CONSTANT id counts as no id. Next >= 16.2.11 writes the same
 * `.next/BUILD_ID` for EVERY build whenever a deployment id is set, so two
 * deploys would "match" and the previous build's window would be seeded after
 * a redeploy (forever for `revalidate: false`). `knext deploy` refuses such a
 * build, but `knext preview` and images built outside knext do not. This is
 * the single point both sides go through: `set` records `currentBuildId` and
 * the seed compares against it, so neither records nor seeds the constant.
 *
 * Duplicated from `NEXT_CONSTANT_BUILD_ID` in `src/cli/build-id-env.ts` — this
 * plain-JS runtime module cannot import the CLI's TypeScript.
 * `cache-handler-next-stale-after-wake.test.ts` asserts the two are equal.
 */
const NEXT_CONSTANT_BUILD_ID = 'build-TfctsWXpff2fKS';
let currentBuildId;
// Next constructs an IncrementalCache — and so this handler — PER REQUEST
// (`route-module.js` `getIncrementalCache`), so the file is read once per
// `serverDistDir`, not once per request.
const buildIdByDistDir = new Map();
function fileBuildId(options) {
  const serverDistDir = options?.serverDistDir;
  if (typeof serverDistDir !== 'string' || serverDistDir.length === 0) return undefined;
  if (buildIdByDistDir.has(serverDistDir)) return buildIdByDistDir.get(serverDistDir);
  let id;
  try {
    id = readFileSync(join(dirname(serverDistDir), 'BUILD_ID'), 'utf8').trim() || undefined;
  } catch {
    id = undefined;
  }
  if (id === NEXT_CONSTANT_BUILD_ID) id = undefined;
  buildIdByDistDir.set(serverDistDir, id);
  return id;
}

// Fallback identity when `.next/BUILD_ID` gives none (vinext, Next's constant
// id, unreadable file): the id knext injects per build, then the deployment id
// (#1417). Read per call -- never cached with the file result.
function envBuildId() {
  for (const name of ['KNEXT_BUILD_ID', 'NEXT_DEPLOYMENT_ID']) {
    const v = process.env[name]?.trim();
    if (v && v !== NEXT_CONSTANT_BUILD_ID) return v;
  }
  return undefined;
}

function resolveBuildId(options) {
  return fileBuildId(options) ?? envBuildId();
}

/** Next's `toRoute` (`dist/server/lib/to-route.js`): `/a/index` → `/a`, `/index` → `/`. */
function nextRoute(key) {
  // Next >= 16.3.7 scopes every non-FETCH entry to its source route and keys
  // BOTH the shared Map (`set`: storageKey) and this handler by the same
  // `/route-cache/<kind>/<sha256>/$<path>` string — no toRoute normalisation,
  // so the handler's key is already the Map key and must be used verbatim.
  if (key.startsWith('/route-cache/')) return key;
  return key.replace(/(?:\/index)?\/?$/, '') || '/';
}

/**
 * PPR resume state is BUILD-SCOPED (#2084). An APP_PAGE carrying `postponed`
 * state is resumed by Next against the CURRENT build's code; resuming the state
 * a previous build wrote (keys outlive a redeploy) against a changed shell makes
 * React log "Expected the resume to render ..." and fall back to client
 * rendering on every request. So such an entry is only usable by the build that
 * wrote it: a different build id, or none recorded (written before build ids
 * were), reads as a MISS and the route re-renders. Plain ISR HTML has no
 * postponed state — it is only stale, never resumed — and stays shared.
 * The id is `.next/BUILD_ID`, else `KNEXT_BUILD_ID`, else `NEXT_DEPLOYMENT_ID`.
 * Only with none of the three is there nothing to compare against, and it
 * fails open (the entry is served).
 */
function isForeignPostponedEntry(entry) {
  if (currentBuildId === undefined) return false;
  const value = entry?.value;
  if (value?.kind !== 'APP_PAGE' || !value.postponed) return false;
  return entry.buildId !== currentBuildId;
}

function seedNextCacheControl(key, entry, ctx) {
  if (typeof key !== 'string' || !key.startsWith('/')) return;
  // Next never records a window for the data cache (`!ctx.fetchCache`, :537).
  if (ctx?.kind === 'FETCH' || entry?.value?.kind === 'FETCH') return;
  const revalidate = entry?.cacheControl?.revalidate;
  if (!(revalidate === false || (typeof revalidate === 'number' && revalidate >= 0))) return;
  // Only this build's own windows — see BUILD-SCOPED above.
  if (currentBuildId === undefined || entry?.buildId !== currentBuildId) return;
  const map = nextSharedCacheControls();
  if (!map) return;
  const route = nextRoute(key);
  if (map.has(route)) return;
  const cacheControl = { revalidate };
  if (typeof entry.cacheControl.expire === 'number') cacheControl.expire = entry.cacheControl.expire;
  map.set(route, cacheControl);
}

// ─── CacheHandler Class ───

class CacheHandler {
  /** The generic entry's client; the per-runtime entries override it. */
  static redisClient = RUNTIME_DETECTED;

  constructor(options) {
    this.options = options;
    // The entry Next loaded decides the Redis client (see `redisClient`).
    redisClient = new.target.redisClient;
    // Never UN-set it: a construction without `serverDistDir` must not drop
    // the id a Next-constructed handler already resolved for this process.
    const buildId = resolveBuildId(options);
    if (buildId !== undefined) currentBuildId = buildId;
    ensureConnected().catch(() => {});
  }

  async get(key, ctx) {
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
          const parsed = withCacheState(deserializeCacheValue(JSON.parse(data)));
          if (isForeignPostponedEntry(parsed)) {
            logCacheEvent('MISS', source, key, {
              durationMs: Date.now() - startTime,
              details: 'postponed state from another build',
            });
            return null;
          }
          seedNextCacheControl(key, parsed, ctx);
          logCacheEvent(parsed?.cacheState === 'stale' ? 'STALE' : 'HIT', source, key, {
            durationMs: Date.now() - startTime,
          });
          return parsed;
      }

      // In-memory fallback
      const entry = memoryCache.get(key) ?? readImageFromMemory(key);
      if (!entry) {
        logCacheEvent('MISS', source, key, {
          durationMs: Date.now() - startTime,
        });
        return null;
      }
      if (isForeignPostponedEntry(entry)) {
        logCacheEvent('MISS', source, key, {
          durationMs: Date.now() - startTime,
          details: 'postponed state from another build',
        });
        return null;
      }
      const labelled = withCacheState(entry);
      seedNextCacheControl(key, labelled, ctx);
      logCacheEvent(labelled?.cacheState === 'stale' ? 'STALE' : 'HIT', source, key, {
        durationMs: Date.now() - startTime,
      });
      return labelled;
    } catch (error) {
      logCacheEvent('MISS', source, key, {
        durationMs: Date.now() - startTime,
        details: `Error: ${error.message}`,
      });
      return null;
    }
  }

  // Registered in the in-flight set so that a SIGTERM drain CAN await it (T13).
  // Stated conditionally on purpose: no shipping path awaits it today. On the
  // node target the shutdown supervisor is a different process from this
  // handler, so the drain is only composable on a single-process target — see
  // the `ShutdownDrain` declaration in adapters/shutdown.ts for the full scope.
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
        dropImageFromMemory(key);
        logCacheEvent('DELETE', source, key, {
          durationMs: Date.now() - startTime,
        });
        return;
      }

      // NOT `ctx.revalidate` — see `__redisTtlSeconds`. Evicting at the
      // revalidate window is what made stale-while-revalidate unreachable (#886).
      const ttl = __redisTtlSeconds(ctx);
      const cacheControl = writeCacheControl(ctx);
      // ctx.tags ∪ value.headers['x-next-cache-tags'] — see resolveWriteTags
      // above for why the header matters (#1764).
      const tags = resolveWriteTags(data, ctx);

      if (client) {
        // Redis path: serialize Map/Buffer → JSON-safe types for JSON.stringify
        const redisEntry = {
          value: serializeCacheValue(data),
          lastModified: Date.now(),
          tags,
          cacheControl,
          ...(currentBuildId !== undefined && { buildId: currentBuildId }),
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
        //
        // TOPOLOGY CAVEAT: a Redis transaction requires every key in ONE hash
        // slot, and the entry key and tag keys hash to different slots. So this
        // narrows the supported topology to a single-node (or slot-tolerant)
        // endpoint. Not a regression in practice — the handler builds a
        // single-node `new Redis(REDIS_URL)` and would already take `MOVED`
        // errors on a cluster — and `redisCall` now trips the breaker into a
        // clean fail-open rather than a hang. Stated here so it is read, not
        // discovered by whoever first points knext at a Redis Cluster.
        const commands = [
          ['SET', cacheKey(key), JSON.stringify(redisEntry), 'EX', String(ttl)],
        ];
        if (tags.length) {
          for (const tag of tags) {
            commands.push(['SADD', tagKey(tag), key]);
          }
        }
        await redisCall(() => execAtomic(client, commands));
      } else {
        // In-memory fallback path: store original data with Map/Buffer types preserved
        // Only used when Redis is NOT available, to avoid unbounded memory growth
        // and stale entries on revalidateTag (which only clears Redis).
        const memEntry = {
          value: cloneCacheValue(data),
          lastModified: Date.now(),
          tags,
          cacheControl,
          ...(currentBuildId !== undefined && { buildId: currentBuildId }),
        };
        if (isImageValue(data)) {
          // Byte-bounded, separately from ISR/data entries (see imageMemory).
          storeImageInMemory(key, memEntry);
        } else {
          memoryCache.set(key, memEntry);
        }
      }

      logCacheEvent('SET', source, key, {
        durationMs: Date.now() - startTime,
        details: `TTL: ${ttl}s, Tags: [${tags.join(', ')}]`,
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
              const commands = keys.map((k) => ['DEL', cacheKey(k)]);
              commands.push(['DEL', tKey]);
              await redisCall(() => execAtomic(client, commands));
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
// For the per-runtime entries (cache-handler-node.js, cache-handler-bun.js),
// which subclass the handler and hand it their client.
export { CacheHandler, ioredisClient, nativeRedisClient };
// Test seams, same contract as `__resetEnvForTests`: named so a reader cannot
// mistake them for API, exported so the value a test asserts is the value
// production uses rather than a copy of it (#886).
export {
  __resetEnvForTests,
  __nativeClientOptions,
  budgetNativeClient as __budgetNativeClient,
  __redisTtlSeconds,
  execAtomic as __execAtomic,
  NEXT_CONSTANT_BUILD_ID as __NEXT_CONSTANT_BUILD_ID,
  __setRedisClientForTests,
};
