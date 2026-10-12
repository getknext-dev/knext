/**
 * The CDN purge pipeline (ADR-0068 D6, D7, D10) — INTERNAL.
 *
 * What it does: when the app revalidates a tag, evict that tag at the user's
 * CDN so the edge does not keep serving the old page for its whole TTL.
 *
 * Where it runs: in the ORIGIN pod that executed `revalidateTag` (D6.1). There
 * is no per-pod fan-out on v2, so there is nothing to multiply purges.
 *
 * The contract, in the order a request experiences it:
 *
 *   enqueue(tags)   synchronous, never throws, never awaits the network. It
 *                   hashes the tags (the same function the response side used),
 *                   adds them to a de-duplicating per-pod queue and returns.
 *                   The caller invokes it AFTER the Redis invalidation (D6.3),
 *                   so a CDN miss racing the purge cannot refill the edge from
 *                   the entry being invalidated.
 *   flush window    tags coalesce for ~1 s, or until a full batch is waiting.
 *   batches         <=100 tags per request (Cloudflare), sent one at a time
 *                   through a token bucket (default 5/min, bucket 25).
 *   retries         <=3 attempts per batch. 429: honour Retry-After, capped at
 *                   60 s. 5xx / network: back off 1 s then 2 s. Any other
 *                   4xx/3xx (bad token, bad zone, a redirect) is final: a retry
 *                   cannot fix it. Then give up and count it. Never unbounded.
 *   overflow        the backlog is ONE set, so it is bounded as a whole: more
 *                   than 1000 tags, or more than 5 minutes of sending at the
 *                   current rate, collapses it into ONE purge of the app tag
 *                   `kn-<p>`. A burst spread over many flush windows is bounded
 *                   exactly like a single burst. While a sender is running, tags
 *                   that arrive merge into full batches behind it.
 *   drain           every pending/in-flight purge is enrolled in the SIGTERM
 *                   drain registry (`trackWrite`), so a scale-down waits for
 *                   it, up to the registry's own hard cap.
 *   staleness       a purge that fails, is rate-limited or is lost at shutdown
 *                   leaves stale HTML for at most the edge TTL (D8). This is a
 *                   bound, never "instant": a provider 200 means "received".
 *
 * Security (D10): the token is read from the environment in ONE place, held in
 * a closure, sent only as the `Authorization` header to the row's own endpoint,
 * and never interpolated into a log line, error, metric or returned value. A
 * missing/invalid token means no request, no throw, one log line, and a
 * `skipped_no_credential` count. Redirects are never followed, so the header
 * cannot be forwarded to another host. The provider URL is a constant in
 * `rows.js` that nothing can override.
 *
 * Everything time- or IO-shaped is injectable (`env`, `fetch`, `now`, `sleep`,
 * `log`, `metrics`) so the whole pipeline is testable over real HTTP without
 * waiting, and without test-only exports from a shipped module.
 */

import { trackWrite } from '../cache-write-registry.js';
import { defaultMetricsRegistry, PURGE_METRIC } from './metrics.js';
import { EMULATOR_DUMMY_TOKEN, PURGE_ROWS } from './rows.js';
import { appTag, nextTag } from './tags.js';

/** Pending tags the queue holds before collapsing to the app tag (D6.4). */
const MAX_PENDING = 1000;
/**
 * Longest the backlog may take to drain at the current rate before it collapses
 * into one app-tag purge. A purge that lands later than the edge TTL evicts
 * nothing that was not already expiring, so past this point per-tag purging has
 * stopped buying freshness (jev 0.61 for 5 minutes over 30 s, 60 s, 120 s).
 */
const MAX_DRAIN_MS = 300_000;
/** Attempts per batch, the first one included (D6.4). */
const MAX_ATTEMPTS = 3;
/** Upper bound on any Retry-After we will sit through (D6.4). */
const RETRY_AFTER_CAP_MS = 60_000;
/** Wait after the 1st and 2nd failed attempt for 5xx/network/unparseable-429 (D6.4). */
const BACKOFF_MS = [1000, 2000];
/** Coalescing window (D6.4). */
const DEFAULT_FLUSH_INTERVAL_MS = 1000;
/** Per-request wall-clock budget; a hung provider must not wedge the queue. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** First-ready claim lifetime: one week (D7). */
const FIRST_READY_TTL_SECONDS = 604_800;
/** The operator-derived tag prefix: first 12 lowercase hex of a sha256 (D5.3). */
const PREFIX_PATTERN = /^[0-9a-f]{12}$/;
/** A bearer token is printable ASCII with no whitespace; anything else is not one. */
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;

const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `name` of an error, only if it is a plain identifier: never message, stack or cause. */
function safeErrorName(err) {
  const name = err && typeof err === 'object' ? err.name : undefined;
  return typeof name === 'string' && /^[A-Za-z0-9_.]{1,40}$/.test(name) ? name : 'Error';
}

/** Milliseconds a `Retry-After` header asks for, or `null` if it is absent/unparseable. */
function parseRetryAfter(value, nowMs) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/**
 * Resolve the purge configuration from the environment.
 *
 * Returns `{ state }` where state is one of:
 *   `disabled`      no provider configured: CDN mode is off, the module is inert
 *   `unknown`       a provider name this build has no row for
 *   `unsupported`   a known row that cannot purge yet (deferred, ADR-0068 D2)
 *   `invalid`       prefix / target / emulator endpoint failed validation
 *   `no_credential` the row needs a token and there is none usable
 *   `ready`         everything needed to send a purge
 *
 * The token, when there is one, is returned as a function so the object that
 * holds the configuration never carries it as a plain property.
 */
function resolveConfig(env) {
  const provider = (env.KNEXT_CDN_PROVIDER ?? '').trim();
  if (provider === '') return { state: 'disabled' };

  const row = Object.hasOwn(PURGE_ROWS, provider) ? PURGE_ROWS[provider] : undefined;
  if (!row) return { state: 'unknown', provider: 'unknown' };
  if (!row.purge) return { state: 'unsupported', provider: row.name };

  const spec = row.purge;
  const prefix = (env.KNEXT_CDN_TAG_PREFIX ?? '').trim();
  if (!PREFIX_PATTERN.test(prefix)) {
    return { state: 'invalid', provider: row.name, why: 'tag prefix is missing or malformed' };
  }
  const target = (env.KNEXT_CDN_PURGE_TARGET ?? '').trim();
  if (!spec.targetPattern.test(target)) {
    return { state: 'invalid', provider: row.name, why: 'purge target is missing or malformed' };
  }
  const base = spec.base(env);
  if (base === null) {
    return { state: 'invalid', provider: row.name, why: 'purge endpoint is not an accepted cluster-local address' };
  }

  let token;
  if (spec.credential === 'dummy') {
    token = EMULATOR_DUMMY_TOKEN;
  } else {
    const raw = (env.KNEXT_CDN_PURGE_TOKEN ?? '').trim();
    if (!TOKEN_PATTERN.test(raw)) return { state: 'no_credential', provider: row.name };
    token = raw;
  }

  const rpmRaw = Number(env.KNEXT_CDN_PURGE_RPM);
  const rpm = Number.isInteger(rpmRaw) && rpmRaw >= 1 && rpmRaw <= 6000 ? rpmRaw : spec.rpm;

  return {
    state: 'ready',
    provider: row.name,
    prefix,
    batchSize: spec.batchSize,
    rpm,
    bucket: spec.bucket,
    url: `${base}/zones/${target}/purge_cache`,
    bearer: () => token,
  };
}

/**
 * Build a purger.
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]  default `process.env`, read on first use
 * @param {typeof fetch} [options.fetch]
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {{ info: Function, warn: Function, error: Function }} [options.log]
 * @param {ReturnType<typeof import('./metrics.js').createMetricsRegistry>} [options.metrics]
 * @param {number} [options.flushIntervalMs]
 * @param {number} [options.requestTimeoutMs]
 */
export function createCdnPurger(options = {}) {
  const getEnv = () => options.env ?? process.env;
  const doFetch = (...args) => (options.fetch ?? globalThis.fetch)(...args);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepReal;
  const log = options.log ?? console;
  const metrics = options.metrics ?? defaultMetricsRegistry();
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  let config;
  const cfg = () => {
    config ??= resolveConfig(getEnv());
    return config;
  };

  // ── logging: a failure of the logger must never reach the request path ──────
  const say = (level, message) => {
    try {
      log[level](`[CdnPurge] ${message}`);
    } catch {}
  };
  const saidOnce = new Set();
  const sayOnce = (key, level, message) => {
    if (saidOnce.has(key)) return;
    saidOnce.add(key);
    say(level, message);
  };

  const count = (provider, result) => {
    try {
      metrics.inc(PURGE_METRIC, { provider, result });
    } catch {}
  };

  /** Count + log-once a call that cannot purge. Returns the `skipped` reason. */
  const skip = (c) => {
    const reason = c.state;
    if (reason === 'no_credential') {
      count(c.provider, 'skipped_no_credential');
      sayOnce(
        'no_credential',
        'error',
        `purge skipped for provider=${c.provider}: no usable purge credential is mounted; cached pages stay stale until the edge TTL expires`,
      );
    } else if (reason === 'unsupported') {
      count(c.provider, 'skipped_unsupported');
      sayOnce(
        `unsupported:${c.provider}`,
        'warn',
        `purge is not implemented for provider=${c.provider} yet; edge cache directives are still emitted, but pages stay stale until the edge TTL expires`,
      );
    } else if (reason === 'invalid') {
      count(c.provider, 'skipped_invalid_target');
      sayOnce('invalid', 'error', `purge skipped for provider=${c.provider}: ${c.why}`);
    } else if (reason === 'unknown') {
      count('unknown', 'skipped_unsupported');
      sayOnce('unknown', 'warn', 'purge skipped: KNEXT_CDN_PROVIDER names a provider this build does not know');
    }
    return reason;
  };

  // ── queue state ─────────────────────────────────────────────────────────────
  /**
   * Every encoded tag not yet handed to the sender: the ONLY backlog. There is
   * no second queue behind it, so "outstanding work" and `pending.size` are the
   * same number and the bounds below cannot be sidestepped by spreading a burst
   * over several flush windows.
   * @type {Set<string>}
   */
  const pending = new Set();
  /** True while the backlog has been replaced by one app-tag purge not yet sent. */
  let collapsed = false;
  let timer = null;
  /** The single sender: takes <=batchSize tags at a time until the backlog is empty. */
  let worker = null;
  /** The deferred registered with the SIGTERM drain while any purge work exists. */
  let idle = null;

  const settle = () => {
    if (idle && pending.size === 0 && timer === null && worker === null) {
      const done = idle;
      idle = null;
      done.resolve();
    }
  };
  const track = () => {
    if (idle) return;
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    idle = { promise, resolve };
    trackWrite(promise);
  };

  // ── token bucket ────────────────────────────────────────────────────────────
  let tokens = null;
  let refilledAt = 0;
  /** Tokens in hand right now, refill included, without taking one. */
  function availableTokens(c) {
    if (tokens === null) return c.bucket;
    return Math.min(c.bucket, tokens + ((now() - refilledAt) * c.rpm) / 60_000);
  }
  async function acquire(c) {
    if (tokens === null) {
      tokens = c.bucket;
      refilledAt = now();
    }
    for (;;) {
      const t = now();
      tokens = Math.min(c.bucket, tokens + ((t - refilledAt) * c.rpm) / 60_000);
      refilledAt = t;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - tokens) * 60_000) / c.rpm));
    }
  }

  // ── one HTTP attempt ────────────────────────────────────────────────────────
  /**
   * @returns {Promise<{ kind: 'ok' | 'ratelimited' | 'retry' | 'fatal', status?: number, retryAfterMs?: number | null, reason?: string }>}
   */
  async function attempt(c, batch) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await doFetch(c.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${c.bearer()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tags: batch }),
        // Never follow a redirect: the token must not be replayed at another host.
        redirect: 'manual',
        signal: controller.signal,
      });
      const status = response.status;
      const retryAfter = response.headers.get('retry-after');
      try {
        await response.body?.cancel();
      } catch {}
      if (status >= 200 && status < 300) return { kind: 'ok', status };
      if (status === 429) return { kind: 'ratelimited', status, retryAfterMs: parseRetryAfter(retryAfter, now()) };
      if (status >= 500) return { kind: 'retry', status };
      return { kind: 'fatal', status };
    } catch (err) {
      return { kind: 'retry', reason: safeErrorName(err) };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Send one batch with the bounded retry policy, then count exactly one outcome. */
  async function sendBatch(c, batch) {
    let last = { kind: 'retry' };
    let attempts = 0;
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
      attempts = n;
      await acquire(c);
      last = await attempt(c, batch);
      if (last.kind === 'ok' || last.kind === 'fatal' || n === MAX_ATTEMPTS) break;
      const asked = last.kind === 'ratelimited' ? last.retryAfterMs : null;
      await sleep(Math.min(asked ?? BACKOFF_MS[n - 1], RETRY_AFTER_CAP_MS));
    }
    if (last.kind === 'ok') {
      count(c.provider, 'ok');
      return;
    }
    count(c.provider, last.kind === 'ratelimited' ? 'ratelimited' : 'failed');
    const what = last.status === undefined ? `error=${last.reason ?? 'Error'}` : `status=${last.status}`;
    say('warn', `purge gave up: provider=${c.provider} ${what} tags=${batch.length} attempts=${attempts}; stale until the edge TTL`);
  }

  /** Take up to `size` tags off the backlog. */
  function take(size) {
    const batch = [];
    for (const tag of pending) {
      batch.push(tag);
      pending.delete(tag);
      if (batch.length >= size) break;
    }
    return batch;
  }

  async function runWorker(c) {
    try {
      while (pending.size > 0) {
        const batch = take(c.batchSize);
        if (collapsed && batch.includes(appTag(c.prefix))) collapsed = false;
        await sendBatch(c, batch);
      }
    } catch {
      // Nothing above throws; this keeps the worker's promise from rejecting.
    }
  }

  /** Start the sender if it is not running. Returns a promise for "backlog sent". */
  function kick() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const c = cfg();
    if (worker === null && pending.size > 0 && c.state === 'ready') {
      worker = runWorker(c).finally(() => {
        worker = null;
        // A tag that arrived between the loop's last check and here still needs a sender.
        if (pending.size > 0) schedule(c);
        else settle();
      });
    }
    settle();
    return worker ?? Promise.resolve();
  }

  function schedule(c) {
    track();
    // A running sender picks up whatever arrives, in full batches.
    if (worker !== null) return;
    if (pending.size >= c.batchSize) {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(kick, 0);
    } else if (timer === null) {
      timer = setTimeout(kick, flushIntervalMs);
    }
  }

  /**
   * Is the backlog past what we are willing to carry? Two bounds (D6.4, D8):
   *   - count: more than MAX_PENDING tags outstanding;
   *   - time: the requests needed to send it, minus the tokens in hand, take
   *     longer than MAX_DRAIN_MS at the configured rate.
   * Retry waits are not projected (they are bounded per batch by MAX_ATTEMPTS and
   * the Retry-After cap); a long stall shows up as backlog and trips the count.
   */
  function overBudget(c) {
    if (pending.size > MAX_PENDING) return true;
    const requests = Math.ceil(pending.size / c.batchSize);
    return (Math.max(0, requests - availableTokens(c)) * 60_000) / c.rpm > MAX_DRAIN_MS;
  }

  function add(c, encoded) {
    if (collapsed) return;
    pending.add(encoded);
    if (overBudget(c)) {
      pending.clear();
      pending.add(appTag(c.prefix));
      collapsed = true;
      sayOnce('overflow', 'warn', "purge backlog exceeded its bound; collapsing it into one purge of this app's tag");
    }
  }

  /** Next may pass a single string or an array; keep only non-empty strings. */
  const normalize = (tags) =>
    (Array.isArray(tags) ? tags : [tags]).filter((t) => typeof t === 'string' && t !== '');

  /** Atomically claim the first-ready key; true only for the one pod that won. */
  async function claim(client, key) {
    let reply;
    if (typeof client.send === 'function') {
      reply = await client.send('SET', [key, '1', 'NX', 'EX', String(FIRST_READY_TTL_SECONDS)]);
    } else if (typeof client.set === 'function') {
      reply = await client.set(key, '1', 'EX', FIRST_READY_TTL_SECONDS, 'NX');
    } else {
      throw new Error('unsupported redis client');
    }
    return reply === 'OK' || reply === true;
  }

  const attempted = new Set();

  return {
    /**
     * Queue a purge for the Next tags `revalidateTag` received. Synchronous and
     * total: never throws, never returns a promise, never waits on the network.
     *
     * @param {unknown} tags a tag, or an array of tags, as Next passes them
     * @returns {{ queued: number, skipped?: string }}
     */
    enqueue(tags) {
      try {
        const list = normalize(tags);
        if (list.length === 0) return { queued: 0 };
        const c = cfg();
        if (c.state === 'disabled') return { queued: 0, skipped: 'disabled' };
        if (c.state !== 'ready') return { queued: 0, skipped: skip(c) };
        for (const tag of list) add(c, nextTag(c.prefix, tag));
        schedule(c);
        return { queued: list.length };
      } catch {
        return { queued: 0, skipped: 'error' };
      }
    },

    /**
     * Purge this app's whole edge presence once per build, across the cluster.
     *
     * `SET knext:cdn:purged:<p>:<buildId> 1 NX EX 604800` in the app's own
     * Redis; the one pod that wins queues a purge of the app tag, the rest do
     * nothing. Without Redis, or if Redis errors, there is no first-ready
     * purge — the edge TTL bounds staleness. Once per process per build.
     *
     * @param {string} buildId
     * @param {object | (() => Promise<object | null | undefined>) | null | undefined} redis
     *        an ioredis-shaped (`set`) or Bun-native-shaped (`send`) client, or an async getter for one
     * @returns {Promise<{ purged: boolean, reason?: string }>}
     */
    async firstReady(buildId, redis) {
      try {
        const c = cfg();
        if (c.state === 'disabled') return { purged: false, reason: 'disabled' };
        if (c.state !== 'ready') return { purged: false, reason: skip(c) };
        if (typeof buildId !== 'string' || buildId === '') return { purged: false, reason: 'no_build_id' };
        if (attempted.has(buildId)) return { purged: false, reason: 'already_attempted' };
        const client = typeof redis === 'function' ? await redis() : redis;
        if (!client) return { purged: false, reason: 'no_redis' };
        const won = await claim(client, `knext:cdn:purged:${c.prefix}:${buildId}`);
        // Only a reply (win OR lose) uses up the attempt: an error or a missing client must not.
        attempted.add(buildId);
        if (!won) return { purged: false, reason: 'already_purged' };
        add(c, appTag(c.prefix));
        schedule(c);
        return { purged: true };
      } catch {
        sayOnce('first_ready', 'warn', 'first-ready purge skipped: the dedup claim failed; stale until the edge TTL');
        return { purged: false, reason: 'redis_error' };
      }
    },

    /** Send everything queued now and resolve when every purge in flight has settled. */
    async flush() {
      await kick();
    },

    /** Non-secret state, for diagnostics. */
    status() {
      const c = cfg();
      return { state: c.state, provider: c.provider ?? null, pending: pending.size, collapsed };
    },
  };
}
