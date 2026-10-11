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

const REFUSED_CODES = new Set(['ECONNREFUSED', 'ERR_POSTGRES_CONNECTION_REFUSED']);

/**
 * True for a definitive "nothing is listening" failure: the TCP connect was
 * refused. It is a CONNECT-phase verdict and nothing else.
 *
 * The observer is fed every failure of every query on the writer pool, so a
 * message match would mistake an application query's error for the database
 * being down — dblink / postgres_fdw report "could not connect to server:
 * Connection refused" as a SQL error (SQLSTATE 08001) from a perfectly healthy
 * database. So only a socket errno (`pg`) or the Bun.SQL connect code counts,
 * and an error the SERVER sent (it carries a `severity`, and a five-character
 * SQLSTATE as its `code`) never does. A node multi-address failure is an
 * `AggregateError`; it is a refusal only if every address refused. Resets, DNS
 * failures and timeouts are ambiguous and are NOT refusals.
 */
export function isConnectionRefused(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; severity?: unknown; errors?: unknown };
  if (e.severity !== undefined) return false;
  if (typeof e.code === 'string' && REFUSED_CODES.has(e.code.toUpperCase())) return true;
  if (Array.isArray(e.errors) && e.errors.length > 0) {
    return e.errors.every((inner) => isConnectionRefused(inner));
  }
  return false;
}

/** The scale-to-zero service's own in-namespace names (`pggw`, `pggw-apps`). */
const IN_NAMESPACE_SERVICE_NAMES = new Set(['pggw', 'pggw-apps']);

/**
 * Whether the app's Postgres is a scale-to-zero database — the only kind a
 * `waking` state can truthfully describe, because it is the only kind that comes
 * back on its own.
 *
 * `KNEXT_DB_SCALE_TO_ZERO` is the explicit declaration and always wins: `true`
 * (also `1`, `yes`) or `false` (also `0`, `no`). It is the answer for a database
 * the host cannot identify: an IP, a pooler or ExternalName alias in front of the
 * scale-to-zero service, or one in a relocated namespace.
 *
 * Unset, fall back to the host in `dsn`: a host with a DNS label equal to
 * `scale-zero-pg` (`pggw-apps.scale-zero-pg`, `….scale-zero-pg.svc.cluster.local.`,
 * any cluster domain), or the bare in-namespace service name `pggw` / `pggw-apps`.
 * Never a substring of the path or userinfo.
 */
export function isScaleToZeroDatabase(
  dsn: string | undefined,
  declared: string | undefined = process.env.KNEXT_DB_SCALE_TO_ZERO,
): boolean {
  const flag = declared?.trim().toLowerCase();
  if (flag === 'true' || flag === '1' || flag === 'yes') return true;
  if (flag === 'false' || flag === '0' || flag === 'no') return false;
  if (!dsn) return false;
  let host: string;
  try {
    host = new URL(dsn).hostname.toLowerCase();
  } catch {
    return false;
  }
  const labels = host.split('.').filter(Boolean);
  if (labels.includes('scale-zero-pg')) return true;
  return labels.length === 1 && IN_NAMESPACE_SERVICE_NAMES.has(labels[0] as string);
}
