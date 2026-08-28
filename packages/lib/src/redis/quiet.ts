/**
 * Quiet, bounded options for a SECONDARY Redis client (#802).
 *
 * The cache handler is not the only Redis client in a knext app: deep health and
 * the cache-events route each own one. Ledger row 3's Appendix C caught what
 * that costs on a fresh pod with a troubled Redis — four
 * `[ioredis] Unhandled error event: connect ETIMEDOUT` lines from a client with
 * NO error listener, dialling at module evaluation and retrying on ioredis's
 * unbounded default: ~8–10 s of reconnect loop churning across the pod's life,
 * plus log noise that was initially mis-attributed to the cache path and
 * contaminated a latency investigation.
 *
 * Three properties fix that, and each is separately observable:
 *
 *  - **lazy** — a client that is only needed on demand must not dial at import.
 *  - **listened-to** — ioredis prints `Unhandled error event` only when a client
 *    has no `error` listener. One classed, once-per-class line replaces the
 *    stack-carrying spew.
 *  - **bounded** — the retry strategy gives up (`null`) instead of looping
 *    forever. Recovery is then ON DEMAND (`ensureDialable`), so retries are paid
 *    by a request that wants the data, never by a background loop.
 *
 * Never logs the target: the message is stripped of URL/userinfo-shaped tokens
 * (`.claude/rules/security.md` — secrets never appear in logs or URLs).
 */

/** ioredis gives up after this many consecutive reconnect attempts. */
const MAX_RECONNECT_ATTEMPTS = 5;
const BACKOFF_STEP_MS = 200;
const BACKOFF_CAP_MS = 2000;

/** The subset of ioredis this module touches — keeps `lib` free of its types. */
export interface QuietRedisClient {
  status?: string;
  /**
   * ioredis is an EventEmitter and has this. Bun's native client does NOT —
   * it has no `.on` at all — so this is optional, and every caller has to
   * branch. Declaring it required was how the Bun path silently ended up with
   * no error listener attached.
   */
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  /** Bun's spelling: a settable handler rather than an event subscription. */
  onclose?: unknown;
  connect(): Promise<unknown>;
}

/**
 * Options every secondary client should be constructed with. `overrides` is for
 * per-caller budgets (e.g. a health check's tighter `connectTimeout`), not for
 * re-opening the three properties above.
 */
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

/**
 * Attach an error listener that logs each error CLASS once. Rate-limiting by
 * class rather than by time is deliberate: a reconnect loop emits the same class
 * over and over (that is the noise), while a NEW class is new information and
 * must still be reported.
 */
export function attachQuietErrorListener(client: QuietRedisClient, tag: string): void {
  const seen = new Set<string>();

  const report = (err: unknown): void => {
    const cls = errorClass(err);
    if (seen.has(cls)) return;
    seen.add(cls);
    const message = sanitize(String((err as { message?: unknown })?.message ?? ''));
    console.error(
      `[redis:${tag}] connection error (${cls}): ${message} — further ${cls} errors suppressed`,
    );
  };

  try {
    // ioredis is an EventEmitter.
    if (typeof client.on === 'function') {
      client.on('error', (...args: unknown[]) => report(args[0]));
      return;
    }

    // Bun's native client is NOT an EventEmitter — it has no `.on` at all, and
    // exposes settable `onclose`/`onconnect` properties instead. This branch is
    // not a nicety: without it the whole function fell into the catch below and
    // attached NOTHING on Bun, so the #802 log-quieting was silently absent on
    // exactly the runtime the platform is moving to. Nothing failed; the noise
    // simply came back, which is the hardest kind of regression to notice.
    const bunShaped = client as { onclose?: unknown };
    if ('onclose' in client) {
      bunShaped.onclose = (err: unknown) => report(err);
      return;
    }
  } catch {
    // Fall through to the fail-open below.
  }
  // Fail-open: a client that can take neither shape (a partial stub in a test,
  // some future wrapper) must not take the health check or the route down with
  // it — quieting the logs is never worth a dependency path.
}

/**
 * Make a client usable again after its bounded retry gave up.
 *
 * Bounding the retry stops the background churn but would otherwise strand the
 * client in `end` for the pod's life. Re-dialling here moves the cost to a
 * caller that actually wants data: a bounded burst per demand, not a loop.
 * Never throws — the caller's own error handling owns the outcome.
 */
export function ensureDialable(client: QuietRedisClient): void {
  try {
    if (client.status === 'end' || client.status === 'close') {
      void Promise.resolve(client.connect()).catch(() => {});
    }
  } catch {
    // A client that refuses to be re-dialled is the caller's problem to report.
  }
}
