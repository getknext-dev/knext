/**
 * Quiet, bounded options for the app's own secondary Redis clients (#802).
 *
 * A near-copy of `@getknext/lib`'s internal `src/redis/quiet.ts`: that module is
 * deliberately NOT a public subpath (adding one is a public-API change), so the
 * app carries its own. The two are held to the same contract by their own tests
 * — see `src/app/api/cache/events/redis-client.test.ts` and
 * `packages/lib/src/__tests__/health-redis-client.test.ts`.
 *
 * Why it exists: ledger row 3's Appendix C caught this app's module-scope
 * cache-events client printing four `[ioredis] Unhandled error event:
 * connect ETIMEDOUT` lines on a stalled pod — no error listener, dialling at
 * module evaluation, retrying on ioredis's unbounded default. Lazy +
 * listened-to + bounded, with recovery on demand.
 */

const MAX_RECONNECT_ATTEMPTS = 5;
const BACKOFF_STEP_MS = 200;
const BACKOFF_CAP_MS = 2000;

export interface QuietRedisClient {
  status?: string;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  connect(): Promise<unknown>;
}

export function quietRedisOptions(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    retryStrategy: (times: number): number | null =>
      times > MAX_RECONNECT_ATTEMPTS ? null : Math.min(times * BACKOFF_STEP_MS, BACKOFF_CAP_MS),
    ...overrides,
  };
}

/** A DSN never belongs in a log line — drop URL/userinfo-shaped tokens. */
const sanitize = (message: string): string =>
  message
    .split(/\s+/)
    .filter((token) => !token.includes('://') && !token.includes('@'))
    .join(' ')
    .slice(0, 200);

const errorClass = (err: unknown): string => {
  const e = err as { code?: unknown; name?: unknown } | undefined;
  if (typeof e?.code === 'string' && e.code) return e.code;
  if (typeof e?.name === 'string' && e.name) return e.name;
  return 'Error';
};

/** Log each error CLASS once — a reconnect loop repeats a class; a new class is news. */
export function attachQuietErrorListener(client: QuietRedisClient, tag: string): void {
  const seen = new Set<string>();
  try {
    client.on('error', (...args: unknown[]) => {
      const err = args[0];
      const cls = errorClass(err);
      if (seen.has(cls)) return;
      seen.add(cls);
      const message = sanitize(String((err as { message?: unknown })?.message ?? ''));
      console.error(
        `[redis:${tag}] connection error (${cls}): ${message} — further ${cls} errors suppressed`,
      );
    });
  } catch {
    // Fail-open: quieting the logs is never worth taking down the route.
  }
}

/**
 * Re-dial a client whose bounded retry gave up, so bounding the loop does not
 * strand it in `end` for the pod's life. Cost is paid per demand, never by a
 * background loop. Never throws.
 */
export function ensureDialable(client: QuietRedisClient): void {
  try {
    if (client.status === 'end' || client.status === 'close') {
      void Promise.resolve(client.connect()).catch(() => {});
    }
  } catch {
    // The caller's own error handling owns the outcome.
  }
}
