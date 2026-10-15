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
 * `CacheHandler.forUseCache()` injects. It does NOT share an entry format, a
 * tag store or an outage mode, because Next's two contracts differ on all three:
 *
 *  - Entry: `<prefix>:uc:<kind>:<cacheKey>` holds one JSON envelope (metadata +
 *    the body as base64). `<cacheKey>` is Next's own key, stored opaque. By
 *    default it embeds `deploymentId || buildId`, so two builds do not read each
 *    other's entries and no foreign-build check is needed. Under Next's
 *    experimental durable-entries flag the key carries a code hash instead, and an
 *    unchanged function's entry IS read by the next build -- that is the flag's
 *    purpose, and a foreign-build check here would defeat it. The ISR handler's
 *    window-withholding and liveness rules do not apply here: nothing is stripped
 *    or rewritten. A body larger than `KNEXT_USE_CACHE_MAX_ENTRY_BYTES` (2 MiB by
 *    default) is not stored.
 *  - Tags: Next's contract is TIMESTAMPS. One Redis hash, `<prefix>:uc:tags`,
 *    carries `s:<tag>` (stale at) and `e:<tag>` (expired at), epoch ms in the
 *    REDIS server's clock (`TIME`, see `clockOffset`), written by a single HSET so
 *    two pods invalidating at once cannot lose each other's field. An entry
 *    records when it was made in that same clock, so pods whose clocks disagree
 *    still agree on which came first. Stamps older than the TTL cap are pruned by
 *    a compare-and-delete script, so a stamp re-written mid-prune survives, and
 *    a replay of stamps an outage dropped is a compare-and-set script, so it
 *    never undoes a newer one. The semantics copy Next's built-in handler.
 *  - Outage: Redis down means MISS and DROP. There is no per-process store of
 *    entries of any kind -- not even Next's in-memory default -- because this is
 *    where per-user entries live and a pod-local copy would sit outside the TTL
 *    cap and never see another pod's invalidation. The one thing kept is the
 *    list of tags whose stamps did not reach Redis, replayed once the breaker
 *    closes (see "Tag stamps an outage kept from Redis").
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

/** Process-wide counters, shared by every copy of this module in the process. */
const COUNTERS_KEY = Symbol.for('knext.cache.useCache.counters');

function count(name) {
  const bag = (globalThis[COUNTERS_KEY] ??= {});
  bag[name] = (bag[name] ?? 0) + 1;
}

/**
 * The key prefix every app falls back to when it sets none. Apps that share a
 * Redis and leave the prefix unset all land on it, so nothing under it is known
 * to belong to this app: a collapse sweep under it would delete other apps'
 * caches. Both collapse sweeps (this handler's and the ISR handler's) refuse to
 * run under it.
 */
export const LEGACY_SHARED_KEY_PREFIX = 'kn-next';

/**
 * Whether a prefix-wide sweep may run under `prefix`. The bare shared default is
 * refused; so is an empty prefix (its glob would match every app's keys).
 */
export function collapseSweepAllowed(prefix) {
  return typeof prefix === 'string' && prefix !== '' && prefix !== LEGACY_SHARED_KEY_PREFIX;
}

/** The error a refused collapse logs, naming the fix. */
export function collapseRefusedMessage(what, prefix) {
  return (
    `[CacheHandler] refusing to sweep every ${what} under the Redis key prefix '${prefix}': ` +
    'it is the shared default, so other apps on this Redis may keep their keys there too, ' +
    'and the sweep would delete their cache. This app keeps its stale entries until they expire. ' +
    'Give the app its own prefix (cache.keyPrefix in knext.config, or REDIS_KEY_PREFIX).'
  );
}

/** The counter family the app's metrics port serves for this handler. */
export const USE_CACHE_METRIC = 'knext_use_cache_events_total';

/**
 * Every counter the handler increments, and the `event` label it is served under.
 * A test scans this file's counting calls against these keys in both
 * directions, so a new counter cannot be counted and never served.
 * `corrupt` and `expired` are also counted as `miss`; the others are disjoint.
 */
export const USE_CACHE_EVENTS = Object.freeze({
  hit: 'hit',
  miss: 'miss',
  corrupt: 'corrupt',
  expired: 'expired',
  set: 'stored',
  skipped: 'skipped',
  invalid: 'invalid',
  oversize: 'oversize',
  aborted: 'aborted',
  dropped: 'dropped',
  tagsUpdated: 'tags_updated',
  tagsDropped: 'tags_dropped',
  tagsReplayed: 'tags_replayed',
  tagsCollapsed: 'tags_collapsed',
  tagsCollapseRefused: 'tags_collapse_refused',
  pruneError: 'prune_error',
  error: 'error',
});

/**
 * The counters in Prometheus text: one family, one sample per event, each at 0
 * until counted (so a rate over any event exists from the first scrape). The
 * label values are the fixed set above; no key, tag or path is ever a label.
 */
export function renderUseCacheMetrics() {
  const bag = globalThis[COUNTERS_KEY] ?? {};
  const lines = [
    `# HELP ${USE_CACHE_METRIC} 'use cache' handler outcomes by event (corrupt and expired are also counted as miss).`,
    `# TYPE ${USE_CACHE_METRIC} counter`,
  ];
  for (const [name, event] of Object.entries(USE_CACHE_EVENTS)) {
    const n = Number(bag[name]);
    lines.push(`${USE_CACHE_METRIC}{event="${event}"} ${Number.isFinite(n) ? n : 0}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The metrics seam. The counters live in the Next server process; the app's
 * metrics port is served by the standalone supervisor (a separate process that
 * merges this process's loopback metrics listener) or, on the self-contained
 * runtime, in-process. Those listeners are dependency-free and cannot import
 * this module, so the render function is published on `globalThis` under a
 * namespaced `Symbol.for` key (ADR-0027), the same shape as the CDN seam, and
 * read there by literal (a test pins the literals equal). Published when a
 * handler is built, so an app without `cacheHandlers` serves nothing new.
 */
export const USE_CACHE_METRICS_SEAM_KEY = Symbol.for('knext.core.useCache.renderMetrics');

function publishMetricsSeam() {
  globalThis[USE_CACHE_METRICS_SEAM_KEY] = renderUseCacheMetrics;
}

const ENVELOPE_VERSION = 1;
const DEFAULT_MAX_TTL_SECONDS = 86_400;
// Stamps are pruned in a bounded step, at most this often per process.
const PRUNE_INTERVAL_MS = 30_000;
const PRUNE_PAGE = 100;
/**
 * Largest entry body stored, in bytes, unless `KNEXT_USE_CACHE_MAX_ENTRY_BYTES`
 * says otherwise. 2 MiB is Next's own fetch-cache item limit. The SET shares a
 * command timeout (2 s) and a circuit breaker with ISR, and Redis serves every
 * client from one thread, so a multi-megabyte write is the one entry that can time
 * out and take ISR's cache offline with it. A typical entry is kilobytes.
 */
const DEFAULT_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
// The Redis clock is re-read this often per process; a failed read is retried sooner.
const CLOCK_RESYNC_MS = 60_000;
const CLOCK_RETRY_MS = 5_000;

/**
 * Delete each stamp field (ARGV[2..]) only while its CURRENT value is still older
 * than the cutoff (ARGV[1]). The fields come from an HSCAN page read moments
 * earlier; an unconditional HDEL would also delete a stamp another pod re-wrote in
 * between, losing that invalidation. Re-checked and deleted in one script, so no
 * write can land between the check and the delete. One key, so cluster-safe.
 */
export const PRUNE_STAMPS_SCRIPT = [
  'local cutoff = tonumber(ARGV[1])',
  'local n = 0',
  'for i = 2, #ARGV do',
  "  local at = tonumber(redis.call('HGET', KEYS[1], ARGV[i]))",
  "  if at and at < cutoff then n = n + redis.call('HDEL', KEYS[1], ARGV[i]) end",
  'end',
  'return n',
].join('\n');

/**
 * Write the stamps a tag replay carries (ARGV pairs: field, ms) as a late
 * `updateTags` would, but never over a stamp that already landed. A replay
 * writes long after the call it replays, so a plain HSET could undo a newer
 * invalidation of the same tag -- from another pod, or from this pod while the
 * replay was in flight -- and an entry that invalidation expired would be served
 * again. Per field, against the CURRENT value, at the script's own `TIME` (the
 * moment it runs, after any write that reached Redis first):
 *  - `s:<tag>` moves forward to now, never back;
 *  - `e:<tag>` wants now + ms. An expiry already in effect (<= now) is never moved
 *    into the future; expire-now (ms = 0) brings it up to now. A pending expiry
 *    (> now) is never pushed later, only brought forward.
 * Checked and written in one script, so no write can land in between. One key,
 * so cluster-safe. `TIME` before a write needs Redis 5 or later.
 */
export const REPLAY_STAMPS_SCRIPT = [
  "local t = redis.call('TIME')",
  'local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)',
  'local n = 0',
  'for i = 1, #ARGV - 1, 2 do',
  '  local field = ARGV[i]',
  "  local cur = tonumber(redis.call('HGET', KEYS[1], field))",
  '  local v = nil',
  "  if string.sub(field, 1, 2) == 's:' then",
  '    if not cur or cur < now then v = now end',
  '  else',
  '    local want = now + tonumber(ARGV[i + 1])',
  '    if not cur then v = want',
  '    elseif cur <= now then',
  '      if want <= now then v = now end',
  '    elseif want < cur then v = want end',
  '  end',
  '  if v then',
  "    redis.call('HSET', KEYS[1], field, string.format('%.0f', v))",
  '    n = n + 1',
  '  end',
  'end',
  'return n',
].join('\n');

/**
 * State shared by the `default` and `remote` handlers of ONE process, keyed by the
 * `core` they share (one per evaluation of `cache-handler.js`, like the breaker):
 * the outage and size warnings fire once per process, not once per kind, the
 * Redis clock is read once for both, and one backlog of dropped tag stamps serves
 * both (Next calls `updateTags` on every kind with the same tags).
 */
const SHARED = new WeakMap();

function shared(core) {
  let state = SHARED.get(core);
  if (!state) {
    state = {
      outageWarned: false,
      oversizeWarned: false,
      pruneWarned: false,
      replayScriptWarned: false,
      clock: { offset: undefined, sampledAt: 0, retryAt: 0, inflight: null },
      replay: { tags: new Map(), generation: 0, collapsed: false, run: null, timer: null },
    };
    SHARED.set(core, state);
  }
  return state;
}

/** Entry-size ceiling in bytes; 0 = no ceiling. Read per call, like the TTL cap. */
function maxEntryBytes() {
  const raw = (process.env.KNEXT_USE_CACHE_MAX_ENTRY_BYTES ?? '').trim();
  if (raw === '') return DEFAULT_MAX_ENTRY_BYTES;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : DEFAULT_MAX_ENTRY_BYTES;
}

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

/**
 * This pod's clock, the one Next stamps an entry's `timestamp` with
 * (`performance.timeOrigin + performance.now()`).
 */
function localNowMs() {
  return performance.timeOrigin + performance.now();
}

/**
 * The offset from this pod's clock to the Redis server's (`TIME`), in ms.
 *
 * Every time that is compared ACROSS pods -- a tag stamp against the entry it may
 * invalidate -- is kept in the Redis clock's domain, so skew between pods cannot
 * let an entry outlive an invalidation (or lose a newer one). Times handed back to
 * Next are translated into the reading pod's own clock, the one Next compares
 * them against.
 *
 * One `TIME` round trip per process per minute, not per operation: the first use
 * waits for it, later re-reads run in the background on the last known offset.
 * Half the round trip is credited to the server. If it cannot be read the local
 * clock stands in (offset 0) and the read is retried a few seconds later. Not
 * routed through the breaker: the command that follows it is, and that is where a
 * connection fault belongs.
 */
async function clockOffset(core, client) {
  const clock = shared(core).clock;
  const now = Date.now();
  const due =
    clock.offset === undefined ? now >= clock.retryAt : now - clock.sampledAt >= CLOCK_RESYNC_MS;
  if (due && !clock.inflight) {
    clock.inflight = (async () => {
      try {
        const t0 = localNowMs();
        const reply = await core.command(client, 'TIME', []);
        const t1 = localNowMs();
        const serverMs = Number(reply?.[0]) * 1000 + Number(reply?.[1]) / 1000;
        if (!Number.isFinite(serverMs)) throw new Error('unexpected TIME reply');
        clock.offset = Math.round(serverMs - (t0 + t1) / 2);
        clock.sampledAt = Date.now();
      } catch {
        clock.retryAt = Date.now() + CLOCK_RETRY_MS;
      } finally {
        clock.inflight = null;
      }
    })();
  }
  if (clock.offset === undefined && clock.inflight) await clock.inflight;
  return clock.offset ?? 0;
}

/**
 * Read a stream to its end. `keep: false` still reads every chunk: a stream Next
 * handed us must be consumed, or its producer is left waiting on a reader that
 * never comes. Past `maxBytes` (0 = no limit) the chunks are no longer kept, but
 * the stream is still read to its end; the result says it was oversize. Rejects if
 * the stream errors; the caller decides what that means.
 */
async function readStream(stream, keep, maxBytes = 0) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  let oversize = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!keep || !value || oversize) continue;
      size += value.byteLength;
      if (maxBytes > 0 && size > maxBytes) {
        oversize = true;
        chunks.length = 0;
        continue;
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released: nothing to give back.
    }
  }
  return keep ? { body: oversize ? undefined : Buffer.concat(chunks), oversize } : undefined;
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

const tagsKeyOf = (core) => `${core.keyPrefix()}:uc:tags`;

/**
 * What one `updateTags` call writes for one tag, as a record a later call can be
 * merged into: `stale` = write `s:<tag>`, `expireMs` = write `e:<tag>` that many
 * ms after the write time (0 = expired now, null = leave the expiry alone).
 * Merged in call order, as consecutive HSETs would overwrite each other.
 */
function mergeStamp(prev, durations, generation) {
  const next = { generation, stale: prev?.stale ?? false, expireMs: prev?.expireMs ?? null };
  if (durations) {
    // Stale now; expired later when the profile says when. No `expire` leaves
    // the existing expiry alone, as Next's handler does.
    next.stale = true;
    if (Number.isFinite(durations.expire)) next.expireMs = durations.expire * 1000;
  } else {
    next.expireMs = 0;
  }
  return next;
}

/** The HSET fields a stamp record writes at `now` (Redis clock, epoch ms). */
function stampFields(tag, record, now) {
  const fields = [];
  if (record.stale) fields.push(`s:${tag}`, String(now));
  if (record.expireMs !== null) fields.push(`e:${tag}`, String(now + record.expireMs));
  return fields;
}

/** The (field, ms) pairs REPLAY_STAMPS_SCRIPT takes for a stamp record. */
function replayArgs(tag, record) {
  const args = [];
  if (record.stale) args.push(`s:${tag}`, '0');
  if (record.expireMs !== null) args.push(`e:${tag}`, String(record.expireMs));
  return args;
}

// ─── Tag stamps an outage kept from Redis ───
//
// With the breaker open (or Redis faulting under the write) an `updateTags`
// cannot write its stamps, and every pod keeps serving the entries they would
// have expired until the entry's TTL (24 h by default). So the tags are kept
// here, per process, and their stamps written once the breaker closes. The same
// shape as the ISR handler's replay of skipped invalidations (cache-handler.js),
// which runs alongside it for the same `revalidateTag`:
//
//  - REPLAY TIME, NEVER OVER A NEWER STAMP. The stamps are written with the time
//    of the replay (the Redis `TIME` when the write runs), so never older than
//    the call they replay. The cost is an entry written between the call and the
//    replay being expired once more: one re-render, never a stale read. They are
//    written by a compare-and-set script (REPLAY_STAMPS_SCRIPT), not an HSET:
//    by replay time a NEWER invalidation of the same tag may already be in Redis
//    -- from another pod whose breaker closed first, or from this pod while the
//    replay was in flight -- and a plain overwrite could move its expiry into the
//    future and serve again what it expired. So an expiry already in effect is
//    never moved into the future, a pending one is never pushed later, and a
//    stale stamp only moves forward. The one cost: a stale-with-window drop
//    replayed onto a tag whose expiry is already in effect marks that tag's
//    entries stale (re-rendered on the next read) but does not schedule the
//    window's later expiry.
//  - BOUNDED. At most REPLAY_MAX_TAGS distinct tags. One more and the list is
//    dropped for a COLLAPSE: the replay deletes every `'use cache'` entry under
//    this app's key prefix (a cursor SCAN, DEL per page; the stamp hash is kept).
//    Wider than needed, never stale. The ISR replay's bound and collapse.
//    REFUSED under the shared default prefix `kn-next` (LEGACY_SHARED_KEY_PREFIX):
//    other apps on the same Redis may sit under it too, and the sweep would
//    delete their entries. The refusal logs an error, counts
//    `tagsCollapseRefused`, and leaves this app's entries until their TTL.
//  - OFF THE REQUEST PATH. Started by the first connection this handler gets with
//    the breaker closed, or by a probe timer set for the moment it closes (an
//    idle pod would otherwise never replay while other pods serve the stale
//    entries). Never awaited by a caller; enrolled in the SIGTERM drain.
//  - NO STORM. One replay at a time, REPLAY_BATCH tags per script call through
//    `redisCall`: the first fault re-trips the breaker and stops the run, and the
//    rest waits for the next probe, one attempt per cooldown.
//  - PER PROCESS. A pod that restarts or scales to zero before Redis is back
//    loses the list, and those entries stay valid until their TTL (a known limit).
const REPLAY_MAX_TAGS = 1000;
const REPLAY_BATCH = 100;
const REPLAY_SCAN_COUNT = 100;
// The probe delay when the core cannot say when its breaker closes.
const REPLAY_PROBE_MS = 5_000;

function replayPending(replay) {
  return replay.collapsed || replay.tags.size > 0;
}

/** Forget the backlog and its probe. Also the test reset, through cache-handler.js. */
export function resetUseCacheTagReplay(core) {
  const replay = shared(core).replay;
  replay.tags.clear();
  replay.generation = 0;
  replay.collapsed = false;
  replay.run = null;
  if (replay.timer) clearTimeout(replay.timer);
  replay.timer = null;
}

/** Remember tags whose stamps did not reach Redis, and try to replay them. */
function recordDroppedTags(core, list, durations) {
  if (!core.redisConfigured()) return;
  const replay = shared(core).replay;
  replay.generation += 1;
  if (!replay.collapsed) {
    for (const tag of list) {
      const prev = replay.tags.get(tag);
      if (!prev && replay.tags.size >= REPLAY_MAX_TAGS) {
        replay.tags.clear();
        replay.collapsed = true;
        console.warn(
          `[CacheHandler] 'use cache' tag replay backlog passed ${REPLAY_MAX_TAGS} tags while Redis was ` +
            "unreachable; once it is back, every 'use cache' entry of this app is deleted",
        );
        break;
      }
      replay.tags.set(tag, mergeStamp(prev, durations, replay.generation));
    }
  }
  // With the breaker open this finds no client and only sets the probe.
  startTagReplay(core);
}

/** Start the replay unless one is running. Never awaited, never throws. */
function startTagReplay(core) {
  const replay = shared(core).replay;
  if (replay.run || !replayPending(replay)) return;
  replay.run = trackWrite(
    runTagReplay(core)
      .catch((err) => {
        console.error("[CacheHandler] 'use cache' tag replay stopped:", err?.message);
      })
      .finally(() => {
        replay.run = null;
        scheduleTagProbe(core);
      }),
  );
}

/**
 * Probe again when the breaker closes, while anything is left to replay. One
 * timer at a time, unref'd so it never holds the process open.
 */
function scheduleTagProbe(core) {
  if (!core.redisConfigured()) {
    // The client could not be loaded at all: there is nothing a replay could reach.
    resetUseCacheTagReplay(core);
    return;
  }
  const replay = shared(core).replay;
  if (replay.timer || replay.run || !replayPending(replay)) return;
  const wait = typeof core.retryInMs === 'function' ? core.retryInMs() : REPLAY_PROBE_MS;
  replay.timer = setTimeout(() => {
    replay.timer = null;
    startTagReplay(core);
  }, wait);
  replay.timer.unref?.();
}

async function runTagReplay(core) {
  const replay = shared(core).replay;
  const client = await core.ensureConnected();
  if (!client) return;
  if (replay.collapsed) {
    await replayCollapsedTags(core, client);
    return;
  }
  const pending = [...replay.tags];
  for (let i = 0; i < pending.length; i += REPLAY_BATCH) {
    const batch = pending.slice(i, i + REPLAY_BATCH);
    await writeReplayBatch(core, client, batch.flatMap(([tag, record]) => replayArgs(tag, record)));
    for (const [tag, record] of batch) {
      // A drop of the same tag recorded while this write was in flight is newer
      // than what was written: keep it for the next run, and count it then.
      if (replay.tags.get(tag)?.generation !== record.generation) continue;
      replay.tags.delete(tag);
      count('tagsReplayed');
    }
  }
}

/**
 * What REPLAY_STAMPS_SCRIPT writes to one field, or null to leave it: `cur` is
 * its current value (null if absent), `now` the replay time. The script's rule,
 * for the read-then-write fallback below.
 */
function replayStampValue(field, cur, ms, now) {
  if (field.startsWith('s:')) return cur === null || cur < now ? now : null;
  const want = now + ms;
  if (cur === null) return want;
  if (cur <= now) return want <= now ? now : null;
  return want < cur ? want : null;
}

/**
 * Write one batch of replayed stamps. The script is sent OUTSIDE `redisCall`: a
 * Redis that refuses scripts answers every EVAL with an error, and through the
 * breaker that would take ISR's cache offline once per cooldown, forever (the
 * prune step avoids it the same way). On any EVAL error the batch is written by
 * the same rule from the client -- HMGET the current stamps, HSET what the rule
 * allows -- through `redisCall`, so a dead link still trips the breaker and stops
 * the run there, and a refusal does not. That fallback is not atomic: a write
 * landing in its one round trip is the window the script closes.
 */
async function writeReplayBatch(core, client, args) {
  const key = tagsKeyOf(core);
  try {
    await core.command(client, 'EVAL', [REPLAY_STAMPS_SCRIPT, '1', key, ...args]);
    return;
  } catch (err) {
    const state = shared(core);
    if (!state.replayScriptWarned) {
      state.replayScriptWarned = true;
      console.warn(
        "[CacheHandler] The 'use cache' tag replay script failed; replaying by read-then-write instead:",
        err?.message,
      );
    }
  }
  const fields = args.filter((_, i) => i % 2 === 0);
  const current = await core.redisCall(() => core.command(client, 'HMGET', [key, ...fields]));
  const now = Math.round(localNowMs()) + (await clockOffset(core, client));
  const writes = [];
  for (let i = 0; i < fields.length; i++) {
    const raw = current?.[i];
    const cur = raw == null || !Number.isFinite(Number(raw)) ? null : Number(raw);
    const v = replayStampValue(fields[i], cur, Number(args[2 * i + 1]), now);
    if (v !== null) writes.push(fields[i], String(v));
  }
  if (writes.length > 0) await core.redisCall(() => core.command(client, 'HSET', [key, ...writes]));
}

/** A Redis glob matching `text` literally. */
function escapeGlob(text) {
  return text.replace(/[*?[\]\\]/g, '\\$&');
}

/**
 * The collapse: delete every `'use cache'` entry under this app's prefix, of
 * every kind. The stamp hash is kept: it is not an entry, and deleting it would
 * lose every other invalidation still inside its window.
 */
async function replayCollapsedTags(core, client) {
  const replay = shared(core).replay;
  const generation = replay.generation;
  const prefix = core.keyPrefix();
  if (!collapseSweepAllowed(prefix)) {
    // The list is already gone; nothing narrower is left to replay. Drop the
    // collapse rather than retry it every probe: the refusal cannot change.
    replay.collapsed = false;
    count('tagsCollapseRefused');
    console.error(collapseRefusedMessage("'use cache' entry", prefix));
    return;
  }
  const stamps = tagsKeyOf(core);
  const pattern = `${escapeGlob(prefix)}:uc:*`;
  let cursor = '0';
  do {
    const reply = await core.redisCall(() =>
      core.command(client, 'SCAN', [cursor, 'MATCH', pattern, 'COUNT', String(REPLAY_SCAN_COUNT)]),
    );
    cursor = String(reply?.[0] ?? '0');
    const keys = (Array.isArray(reply?.[1]) ? reply[1].map(String) : []).filter((k) => k !== stamps);
    if (keys.length > 0) await core.redisCall(() => core.command(client, 'DEL', keys));
  } while (cursor !== '0');
  // A drop recorded during the sweep may have missed it: keep the collapse.
  if (replay.generation === generation) replay.collapsed = false;
  count('tagsCollapsed');
}

/**
 * @param {object} args
 * @param {string} args.kind  Next's cache kind: `default` or `remote`.
 * @param {object} args.core  The collaborators `cache-handler.js` owns:
 *   `ensureConnected()` (client or null), `redisCall(fn)` (trips the shared
 *   breaker on a fault), `command(client, name, args)`, `keyPrefix()`,
 *   `buildId()`, `redisConfigured()` and, optionally, `retryInMs()` (how long
 *   until the breaker closes, for the tag replay's probe).
 */
export function createUseCacheHandler({ kind, core }) {
  // Handler-owned promises, one per in-flight set. They settle when the set
  // finishes and are removed in `finally`; they never hold the entry or its stream.
  const pendingSets = new Map();
  let lastPrune = 0;
  let pruneCursor = '0';
  // Whether a delete was refused in the current HSCAN cycle (cursor 0 back to 0).
  let pruneCycleFailed = false;
  const state = shared(core);
  publishMetricsSeam();

  const entryKey = (cacheKey) => `${core.keyPrefix()}:uc:${kind}:${cacheKey}`;
  const tagsKey = () => tagsKeyOf(core);

  /**
   * The connected client, or null. A client means the breaker is closed, so it
   * is also the moment a tag replay can start: started, never awaited.
   */
  async function connected() {
    const client = await core.ensureConnected();
    if (client && replayPending(state.replay)) startTagReplay(core);
    return client;
  }

  /**
   * One warning per outage per process (both kinds share it), never the cache key
   * (it can carry per-user arguments).
   */
  function noteUnavailable() {
    if (state.outageWarned) return;
    state.outageWarned = true;
    console.warn(
      core.redisConfigured()
        ? "[CacheHandler] Redis unavailable: 'use cache' entries are not cached until it returns " +
            '(there is no per-process fallback).'
        : "[CacheHandler] REDIS_URL is not set: 'use cache' entries are not cached " +
            '(there is no per-process fallback). Set REDIS_URL to share them across pods.',
    );
  }
  const noteAvailable = () => {
    state.outageWarned = false;
  };

  async function doGet(cacheKey) {
    const rkey = entryKey(cacheKey);
    const pending = pendingSets.get(rkey);
    if (pending) await pending;

    const client = await connected();
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

    // When the entry was made, in the Redis clock (see `clockOffset`). An envelope
    // written before that field existed only has the writer's own clock.
    const offset = await clockOffset(core, client);
    const madeAt = Number.isFinite(env.at) ? env.at : env.timestamp;

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
      const now = Math.round(localNowMs()) + offset;
      for (let i = 0; i < tags.length; i++) {
        const stale = Number(stamps?.[2 * i]);
        const expired = Number(stamps?.[2 * i + 1]);
        if (stamps?.[2 * i + 1] != null && Number.isFinite(expired) && expired <= now && expired > madeAt) {
          count('expired');
          count('miss');
          return undefined;
        }
        if (stamps?.[2 * i] != null && Number.isFinite(stale) && stale > madeAt) revalidate = -1;
      }
    }

    count('hit');
    return {
      value: streamFromBuffer(Buffer.from(env.body, 'base64')),
      tags: env.tags,
      stale: env.stale,
      // In THIS pod's clock: Next compares it with its own `now` and with what
      // `getExpiration` returns, which is translated the same way.
      timestamp: madeAt - offset,
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
    const maxBytes = maxEntryBytes();
    try {
      const read = await readStream(entry.value, true, maxBytes);
      if (read.oversize) {
        // Never sent: a multi-megabyte SET is the write that can outlast the
        // command timeout and open the breaker ISR shares. A miss, not an error.
        count('oversize');
        if (!state.oversizeWarned) {
          state.oversizeWarned = true;
          console.warn(
            `[CacheHandler] A 'use cache' entry larger than ${maxBytes} bytes was not stored ` +
              '(KNEXT_USE_CACHE_MAX_ENTRY_BYTES sets the ceiling, 0 removes it). Further ones are ' +
              'counted, not logged.',
          );
        }
        return;
      }
      body = read.body;
    } catch {
      // A stream that errors part-way is an aborted render. Discard the partial entry.
      count('aborted');
      return;
    }

    const client = await connected();
    if (!client) {
      noteUnavailable();
      count('dropped');
      return;
    }
    const offset = await clockOffset(core, client);
    const buildId = core.buildId();
    const envelope = JSON.stringify({
      v: ENVELOPE_VERSION,
      timestamp: entry.timestamp,
      // When the entry was made, in the Redis clock: what tag stamps are compared with.
      at: Math.round(entry.timestamp + offset),
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

  /**
   * One bounded prune step. `now` is in the Redis clock, like the stamps. Not
   * routed through the breaker: the tag write just before it proved the
   * connection, and a failure here (a Redis that refuses scripts, say) must not
   * take ISR's cache offline every 30 s. Each command keeps its own timeout.
   * Resolves true when cleanup is known to work: this step's delete ran, or the
   * scan finished a cycle with nothing dead and no refused delete. A page with
   * nothing dead proves nothing about a Redis that refuses scripts, so on its
   * own it does not count. False when not due, or when nothing was proved.
   */
  async function pruneStamps(client, now) {
    const tick = Date.now();
    if (tick - lastPrune < PRUNE_INTERVAL_MS) return false;
    lastPrune = tick;
    if (pruneCursor === '0') pruneCycleFailed = false;
    const reply = await core.command(client, 'HSCAN', [tagsKey(), pruneCursor, 'COUNT', String(PRUNE_PAGE)]);
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
    // Conditional: a field re-stamped since the HSCAN is no longer below the cutoff.
    if (dead.length > 0) {
      try {
        await core.command(client, 'EVAL', [PRUNE_STAMPS_SCRIPT, '1', tagsKey(), String(cutoff), ...dead]);
      } catch (err) {
        pruneCycleFailed = true;
        throw err;
      }
      return true;
    }
    return pruneCursor === '0' && !pruneCycleFailed;
  }

  async function doUpdateTags(tags, durations) {
    const list = (Array.isArray(tags) ? tags : [tags]).filter((t) => typeof t === 'string' && t.length > 0);
    if (list.length === 0) return;
    const client = await connected();
    if (!client) {
      // Kept and replayed once the breaker closes (see "Tag stamps an outage
      // kept from Redis"); it must not fail the request that asked for it.
      noteUnavailable();
      count('tagsDropped');
      recordDroppedTags(core, list, durations);
      return;
    }
    // Offset FIRST, then the clock: on a process's first call the offset read is a
    // round trip, and a clock read taken before it would stamp that much early.
    const redisOffset = await clockOffset(core, client);
    const now = Math.round(localNowMs()) + redisOffset;
    const record = mergeStamp(undefined, durations, 0);
    const fields = list.flatMap((tag) => stampFields(tag, record, now));
    try {
      await core.redisCall(() => core.command(client, 'HSET', [tagsKey(), ...fields]));
      noteAvailable();
      count('tagsUpdated');
    } catch (err) {
      // The write faulted and tripped the breaker: replayed once it closes, like
      // a call that found it open. It must not fail the request that asked for it.
      count('error');
      count('tagsDropped');
      console.error("[CacheHandler] Error updating 'use cache' tags:", err?.message);
      recordDroppedTags(core, list, durations);
      return;
    }
    try {
      if (await pruneStamps(client, now)) state.pruneWarned = false;
    } catch (err) {
      // The tags ARE updated; only the housekeeping failed, and the next step
      // retries. Counted every time, logged once per process until a prune
      // succeeds: a Redis that refuses scripts would otherwise log forever.
      count('pruneError');
      if (!state.pruneWarned) {
        state.pruneWarned = true;
        console.warn("[CacheHandler] Pruning old 'use cache' tag stamps failed (the tags were updated):", err?.message);
      }
    }
  }

  async function doGetExpiration(tags) {
    const list = (Array.isArray(tags) ? tags : []).filter((t) => typeof t === 'string' && t.length > 0);
    if (list.length === 0) return 0;
    const client = await connected();
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
    // 0 means "never revalidated". Anything else goes back to Next in this pod's
    // clock, the domain `get` returns an entry's timestamp in.
    return newest === 0 ? 0 : newest - (await clockOffset(core, client));
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
