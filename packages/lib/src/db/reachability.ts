/**
 * Internal (not a public entry point): how the writer pool's connect failures and
 * the deep health check agree on what a refused connection MEANS.
 *
 * The pool's wake-retry layer (`clients.ts`) retries a failed connect for
 * `DB_WAKE_RETRY_BUDGET_MS` (8 s by default) on any host, and the deep check
 * (`health/index.ts`) abandons its probe at `HEALTH_DEEP_TIMEOUT_MS` (also 8 s). A
 * refusal therefore never reached the classifier as a rejection before the check
 * timed out, and a refused bring-your-own database read `waking`. The retry layer
 * reports each failed attempt here instead, so the deep check can act on a
 * refusal the moment it happens — and the request path, with its retries, is
 * untouched.
 *
 * Observers live on `globalThis` behind a namespaced `Symbol.for` key, never a
 * module-level `let` (ADR-0027, #352): `clients` and `health` are separate
 * entries, so the standalone build can hold two copies of this module, and a
 * bare module-level set would let the pool report to one while the health check
 * listens on the other.
 */

export type AcquireFailureObserver = (error: unknown) => void;

const OBSERVERS_KEY = Symbol.for('knext.lib.db.acquireFailureObservers');

type ObserversGlobal = Record<symbol, Set<AcquireFailureObserver> | undefined>;

const observers = (): Set<AcquireFailureObserver> => {
  const g = globalThis as unknown as ObserversGlobal;
  let set = g[OBSERVERS_KEY];
  if (!set) {
    set = new Set();
    g[OBSERVERS_KEY] = set;
  }
  return set;
};

/** Subscribe to failed writer-pool connect attempts. Returns the unsubscribe. */
export function observeAcquireFailures(observer: AcquireFailureObserver): () => void {
  const set = observers();
  set.add(observer);
  return () => {
    set.delete(observer);
  };
}

/** How many observers are subscribed (tests: proves a check releases its own). */
export function acquireFailureObserverCount(): number {
  return observers().size;
}

/**
 * Report one failed connect attempt. Fail-open: an observer that throws must
 * never break the pool, so each runs in its own try/catch.
 */
export function reportAcquireFailure(error: unknown): void {
  for (const observer of [...observers()]) {
    try {
      observer(error);
    } catch {
      // A diagnostics hook is never allowed to fail a database call.
    }
  }
}

/**
 * True for a definitive "nothing is listening" failure: the TCP connect was
 * refused. Matches the node `pg` code, Bun.SQL's `ERR_POSTGRES_CONNECTION_REFUSED`,
 * and the message text either driver puts in it. Resets, DNS failures and
 * timeouts are deliberately NOT refusals — they are ambiguous, and a timed-out
 * probe stays `waking`.
 */
export function isConnectionRefused(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | undefined | null;
  const code = typeof e?.code === 'string' ? e.code.toUpperCase() : '';
  if (code === 'ECONNREFUSED' || code === 'ERR_POSTGRES_CONNECTION_REFUSED') return true;
  const message = typeof e?.message === 'string' ? e.message.toUpperCase() : '';
  return message.includes('ECONNREFUSED') || message.includes('CONNECTION REFUSED');
}

/**
 * True when the DSN points at the scale-zero-pg gateway — the scale-to-zero
 * database a `waking` Postgres state can legitimately describe. Matches the
 * host label sequence `scale-zero-pg.svc` (e.g. `pggw.scale-zero-pg.svc.cluster.local.`),
 * never a substring of the path or userinfo. There is no env marker for the
 * binding today, so the gateway host is the only in-app signal; a
 * bring-your-own database never matches it.
 */
export function isScaleToZeroDatabase(dsn: string | undefined): boolean {
  if (!dsn) return false;
  let host: string;
  try {
    host = new URL(dsn).hostname.toLowerCase();
  } catch {
    return false;
  }
  return /(^|\.)scale-zero-pg\.svc(\.|$)/.test(host);
}
