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

// In-flight write accounting (T13) lives in its own module because its state
// must be anchored on `globalThis` — see the header of cache-write-registry.js.
// This module imports `trackWrite` and re-exports NOTHING new: the
// `@getknext/core/adapters/cache-handler` subpath stays default-only, because
// it exists to be handed to Next's `cacheHandler` option by path, not called.
import { trackWrite } from './cache-write-registry.js';
// Slow-dependency discrimination (cold-start ledger row 3). Observation only:
// it attaches two listeners to the connecting client and names which PHASE was
// slow (TCP connect vs the ready-check INFO). No timer, no budget, no verdict —
// see the header of slow-dep-log.js.
import { instrumentConnectTiming } from './slow-dep-log.js';

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
function __resetEnvForTests() {
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
  Redis = undefined;
  redis = undefined;
  connectPromise = undefined;
  useRedis = !!REDIS_URL;
  unhealthyUntil = 0;
  CONNECT_TIMEOUT_MS = envMs('REDIS_CONNECT_TIMEOUT_MS', 5000);
  COMMAND_TIMEOUT_MS = envMs('REDIS_COMMAND_TIMEOUT_MS', 2000);
  RETRY_COOLDOWN_MS = envMs('REDIS_RETRY_COOLDOWN_MS', 5000);
}

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

/**
 * Bun ships a native Redis client (`Bun.RedisClient`, 1.2.9+), and under the
 * ADR-0048 single-executable target that is the client we want:
 *
 *   - ioredis reaches `@ioredis/commands` through a transitive dynamic
 *     `require`, which `bun build --compile` cannot resolve. The binary builds
 *     and then dies at boot with "Cannot find package 'ioredis'". Marking it
 *     external does not help — the handler initialises eagerly, so the import
 *     really is executed.
 *   - it is native, so it costs no JavaScript at startup, which is the whole
 *     point of a 61ms cold start.
 *
 * The ioredis path stays for Node. Its specifier is deliberately NON-LITERAL
 * so a bundler cannot statically follow it into the graph; under Bun this
 * branch is never reached, and under Node the module is a direct dependency
 * that resolves normally at runtime.
 */
const IOREDIS_SPECIFIER = ['io', 'redis'].join('');

/**
 * Bun's native client, or null when not running under Bun — or when the ioredis
 * path is explicitly requested.
 *
 * `KNEXT_CACHE_REDIS_CLIENT=ioredis` forces the ioredis branch even on Bun. Two
 * reasons it earns its place rather than being a test affordance:
 *
 *  - Operationally it is the same escape hatch `KNEXT_DB_DRIVER` provides for
 *    the Postgres driver: a way to fall back to the mature client without
 *    changing runtime, which is what you want at 3am when the native one is
 *    suspected and nothing else is.
 *  - The two clients have genuinely different SHAPES — Bun's has no `.on`, it
 *    uses `onclose` — so any behaviour asserted against one says nothing about
 *    the other. Without a way to select, a suite running under Bun silently
 *    stops covering the ioredis path that Node deployments still take.
 *
 * Reads the env on every call, deliberately: `__resetEnvForTests` re-reads its
 * cached values, and a third cached copy here would be one more thing to keep
 * in sync.
 */
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

function bunRedisClient(url) {
  if (process.env.KNEXT_CACHE_REDIS_CLIENT === 'ioredis') return null;
  const B = globalThis.Bun;
  if (!B || typeof B.RedisClient !== 'function') return null;
  return new B.RedisClient(url, __nativeClientOptions());
}

async function getRedis() {
  if (!redis && REDIS_URL) {
    const native = bunRedisClient(REDIS_URL);
    if (native) {
      // Budgeted ONCE, here — see `budgetNativeClient`. Everything downstream
      // (including `nativeTxQueue`) must see one stable client identity.
      const budgeted = budgetNativeClient(native);
      budgeted.onclose = (err) => {
        if (err) console.error('[CacheHandler] Redis error:', err.message);
      };
      redis = budgeted;
      return redis;
    }
    if (!Redis) {
      try {
        const mod = await import(IOREDIS_SPECIFIER);
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
          const parsed = withCacheState(deserializeCacheValue(JSON.parse(data)));
          logCacheEvent(parsed?.cacheState === 'stale' ? 'STALE' : 'HIT', source, key, {
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
      const labelled = withCacheState(entry);
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
        logCacheEvent('DELETE', source, key, {
          durationMs: Date.now() - startTime,
        });
        return;
      }

      // NOT `ctx.revalidate` — see `__redisTtlSeconds`. Evicting at the
      // revalidate window is what made stale-while-revalidate unreachable (#886).
      const ttl = __redisTtlSeconds(ctx);
      const cacheControl = writeCacheControl(ctx);

      if (client) {
        // Redis path: serialize Map/Buffer → JSON-safe types for JSON.stringify
        const redisEntry = {
          value: serializeCacheValue(data),
          lastModified: Date.now(),
          tags: ctx?.tags || [],
          cacheControl,
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
        if (ctx?.tags?.length) {
          for (const tag of ctx.tags) {
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
          tags: ctx?.tags || [],
          cacheControl,
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
// Test seams, same contract as `__resetEnvForTests`: named so a reader cannot
// mistake them for API, exported so the value a test asserts is the value
// production uses rather than a copy of it (#886).
export {
  __resetEnvForTests,
  __nativeClientOptions,
  budgetNativeClient as __budgetNativeClient,
  __redisTtlSeconds,
  execAtomic as __execAtomic,
};
