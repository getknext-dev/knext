import { loadRedisCtor } from './ioredis-ctor';
import { attachQuietErrorListener, type QuietRedisClient, quietRedisOptions } from './quiet';

/**
 * One place that decides which Redis client this process gets.
 *
 * Bun ships a native Redis client, and the app targets Bun (ADR-0048), so
 * prefer it there: it is native, it needs no ioredis in the bundle, and — the
 * part that actually forced this — ioredis cannot be loaded from inside a
 * `bun build --compile` binary at all. Its transitive dynamic
 * `require('@ioredis/commands')` is unresolvable there, which is why
 * `redis/ioredis-ctor.ts` exists.
 *
 * On Node this MUST stay ioredis. `@getknext/lib` is published and
 * `install-smoke.yml` proves it runs with no bun on PATH.
 *
 * ## Why this is shared rather than inlined per call site
 *
 * There were two copies of this preference already — one in the deep-health
 * client, one about to be written into the cache-events route — and they had
 * begun to drift: the health copy constructed `Bun.RedisClient` with NO options
 * at all, silently dropping the bounded connect timeout and the capped retry
 * budget that `quietRedisOptions()` exists to enforce. A client that retries
 * forever is exactly the failure #802 was filed about.
 *
 * ## The options do NOT carry across verbatim
 *
 * ioredis and Bun spell the same intent differently, so the mapping is explicit
 * and tested. Passing ioredis's object straight to Bun would silently apply
 * none of it — every key would be ignored as unknown, and the client would come
 * up with Bun's defaults while the code read as though it were bounded.
 */

/**
 * The ambient scope `Bun.RedisClient` is looked up on. Injectable ONLY so this
 * can be tested in both directions: under `bun test`, `globalThis.Bun` is
 * readonly AND non-configurable, so neither assignment nor
 * `Object.defineProperty` can stand it up or take it away. A function reading
 * the global directly is observable in one direction only — always true on Bun,
 * always false on Node — which is not a probe.
 */
export interface BunRedisScope {
  Bun?: { RedisClient?: unknown };
}

/** Is the Bun-native Redis client available in this process? */
export function bunRedisAvailable(scope: BunRedisScope = globalThis as BunRedisScope): boolean {
  return typeof scope.Bun?.RedisClient === 'function';
}

/**
 * Translate the ioredis-shaped quiet options into Bun's vocabulary.
 *
 * Deliberately narrow: only the three properties that carry real intent are
 * mapped, and anything unrecognised is dropped rather than forwarded. Silently
 * forwarding an ioredis key that Bun ignores is how a "bounded" client ends up
 * unbounded.
 */
export function toBunRedisOptions(
  quiet: Record<string, unknown> = quietRedisOptions(),
): Record<string, unknown> {
  const options: Record<string, unknown> = {};

  // Same unit (ms) on both sides, different name.
  if (typeof quiet.connectTimeout === 'number') {
    options.connectionTimeout = quiet.connectTimeout;
  }

  // ioredis expresses "stop after N reconnects" through a retryStrategy that
  // returns null; Bun takes a plain attempt cap. The cap is what the strategy
  // encoded, so state it directly.
  options.maxRetries = MAX_RECONNECT_ATTEMPTS;

  // ioredis's `lazyConnect: true` means "do not dial at construction". Bun is
  // lazy by default, so there is nothing to set — but the intent is asserted in
  // tests so a future default change is caught rather than assumed.
  options.autoReconnect = true;

  return options;
}

/** Mirrors the cap encoded in `quietRedisOptions().retryStrategy`. */
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * The Redis commands this codebase actually issues.
 *
 * Deliberately a short, explicit list rather than an index signature: both
 * ioredis and Bun satisfy these structurally, and naming them means adding a
 * command is a decision someone makes rather than something that silently
 * typechecks against `any`. `QuietRedisClient` stays free of them so the quiet
 * helpers keep working on any client shape.
 */
export interface RedisCommands {
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  del(key: string): Promise<unknown>;
  ping(): Promise<unknown>;
}

/** What callers get back: lifecycle plus the commands they may issue. */
export type KnextRedisClient = QuietRedisClient & RedisCommands;

/** The constructor shape both clients satisfy, structurally. */
type RedisCtor = new (url: string, options?: Record<string, unknown>) => KnextRedisClient;

/**
 * Build a Redis client for a secondary (non-critical) use: cache events, deep
 * health, anything that must never take the pod down when Redis is unwell.
 *
 * `ctorOverride` exists for tests — the Node path resolves ioredis through a
 * computed specifier so no bundler can follow it, and that is precisely what a
 * module-id mock cannot intercept.
 */
export function createRedisClient(
  url: string,
  tag: string,
  overrides: Record<string, unknown> = {},
  ctorOverride?: RedisCtor,
  // Injectable for the same reason `bunRedisAvailable` takes one: the Bun
  // global cannot be stubbed under `bun test`, so without this the Bun branch
  // and the ioredis branch are not both reachable from one runtime.
  scope: BunRedisScope = globalThis as BunRedisScope,
): KnextRedisClient {
  const quiet = quietRedisOptions(overrides);

  if (!ctorOverride && bunRedisAvailable(scope)) {
    const bun = scope.Bun as { RedisClient?: RedisCtor } | undefined;
    // Bind the constructor to a plain local FIRST. `new (bun?.RedisClient)(...)`
    // is a SyntaxError — "constructor in/after an optional chaining is not
    // allowed" — and it is one an older parser will happily accept, so this
    // read as working code right up until a different bundler saw it.
    const BunRedis = bun?.RedisClient as RedisCtor;
    const client = new BunRedis(url, toBunRedisOptions(quiet));
    // Not optional. Failing open is right; failing open SILENTLY is what turns
    // a Redis blip into an unexplained log flood (#802).
    attachQuietErrorListener(client, tag);
    return client;
  }

  const Ctor = ctorOverride ?? (loadRedisCtor() as unknown as RedisCtor);
  const client = new Ctor(url, quiet);
  attachQuietErrorListener(client, tag);
  return client;
}
