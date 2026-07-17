import { GRPC as Cerbos } from '@cerbos/grpc';
import * as Minio from 'minio';
import { Pool } from 'pg';

// Singleton instances
let cerbosClient: Cerbos | null = null;
let minioClient: Minio.Client | null = null;
let pgPool: Pool | null = null;
let pgPoolRO: Pool | null = null;

// ── Pool-instrumentor seam (dependency inversion, #317) ───────────────────────
// This module stays OTel-free (mirroring `./context`'s `setTraceIdProvider`): an
// OTel-aware layer (`@knext/core/adapters/tracing`) installs an instrumentor
// that is invoked ONCE per pool as it is created, with the pool and its role.
// The tracing adapter uses it to wrap the pool's first `connect()` in a
// `knext.db_wake` span so the scale-zero-pg 0→1 DB wake shows up on the request
// trace WITHOUT any app code. Default is a no-op — an app that has not opted
// into tracing pays nothing, and pool creation is unchanged.

/** Which scale-zero-pg endpoint a pool talks to. */
export type PoolRole = 'writer' | 'reader';

/** Instrument a freshly-created pool (e.g. wrap its first connect for tracing). */
export type PoolInstrumentor = (pool: Pool, role: PoolRole) => void;

const NO_POOL_INSTRUMENTOR: PoolInstrumentor = () => {};

// The instrumentor is stored on a well-known `globalThis` key rather than a
// plain module-level `let` (#352). In the Next.js standalone build,
// `instrumentation.ts` compiles in a SEPARATE webpack layer from the app server
// bundles and `@knext/lib` is bundled (not externalized) into each — so
// `instrumentation-node`'s `@knext/lib/clients` and the app's server-component
// `@knext/lib/clients` are TWO PHYSICAL module copies with independent
// module-level state. A module-level `let` written by the copy that runs
// `setPoolInstrumentor(...)` is invisible to the copy whose `getDbPool()` reads
// it → the pool is never wrapped → `knext_db_wake_*` never fires. Anchoring the
// state on the single shared `globalThis` makes set-from-copy-A visible to
// read-from-copy-B, whatever the bundling. `Symbol.for` uses the cross-realm
// registry so the key is stable across every copy.
const POOL_INSTRUMENTOR_KEY = Symbol.for('knext.lib.clients.poolInstrumentor');

type PoolInstrumentorGlobal = Record<symbol, PoolInstrumentor | undefined>;

const instrumentorGlobal = globalThis as unknown as PoolInstrumentorGlobal;

const getPoolInstrumentor = (): PoolInstrumentor =>
  instrumentorGlobal[POOL_INSTRUMENTOR_KEY] ?? NO_POOL_INSTRUMENTOR;

/**
 * Install the pool instrumentor. Called once at startup by an OTel-aware app so
 * new pools get a `knext.db_wake` span around their first connect, without this
 * package taking an OTel dependency. State lives on `globalThis` so it is shared
 * even when this module is duplicated across bundles (#352).
 */
export const setPoolInstrumentor = (fn: PoolInstrumentor): void => {
  instrumentorGlobal[POOL_INSTRUMENTOR_KEY] = fn;
};

/** Reset the pool instrumentor to the default no-op. Mainly for tests. */
export const resetPoolInstrumentor = (): void => {
  delete instrumentorGlobal[POOL_INSTRUMENTOR_KEY];
};

// ── Writer-pool ACTIVITY tracking (#348 gate fix) ─────────────────────────────
// The deep-health scrape (:9091, every ~30s) must dial Postgres ONLY when the
// app has actually used the writer pool RECENTLY — otherwise `SELECT 1` on every
// scrape re-arms the scale-zero-pg gateway's 60s DB idle timer and the DB never
// sleeps while the pod is up, BREAKING scale-to-zero. So we record the wall-clock
// instant of the last writer-pool query/connect, and expose it so the scrape hook
// can SKIP the DB dial when the pool has been idle past the budget.
//
// Anchored on `globalThis` (like the instrumentor above, #352): in the standalone
// build `@knext/lib` is bundled into multiple webpack layers, so a module-level
// `let` written by the app-server copy (which issues the queries) would be
// invisible to the copy the scrape hook reads. A shared `globalThis` slot makes
// the timestamp visible across every copy. This tracking is INDEPENDENT of OTel —
// the pool is used (and must be tracked) whether or not tracing is enabled.
const DB_ACTIVITY_KEY = Symbol.for('knext.lib.clients.lastDbActivityAt');

type DbActivityGlobal = Record<symbol, number | undefined>;

const activityGlobal = globalThis as unknown as DbActivityGlobal;

/**
 * Recency budget (ms) for "the app used the DB recently enough that the scrape
 * may dial it". Deliberately BELOW the scale-zero-pg gateway's 60s DB idle
 * window so an idle app's DB is never kept awake by the scrape: if the pool has
 * been idle longer than this, the gateway is already letting the DB sleep, and
 * the scrape must not re-wake it. Env-overridable via DB_ACTIVITY_BUDGET_MS.
 */
const DEFAULT_DB_ACTIVITY_BUDGET_MS = 45_000;

/** The resolved recency budget (env-overridable, clamped positive). */
export const DB_ACTIVITY_BUDGET_MS = ((): number => {
  const raw = process.env.DB_ACTIVITY_BUDGET_MS;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_DB_ACTIVITY_BUDGET_MS;
})();

/** Record that the writer pool was just used (called by the activity wrapper). */
const markDbActivity = (): void => {
  activityGlobal[DB_ACTIVITY_KEY] = Date.now();
};

/**
 * The wall-clock instant (ms) the writer pool was last used, or `undefined` if
 * it has never been used this process (never woken). Cross-copy via globalThis.
 */
export const getLastDbActivityAt = (): number | undefined => activityGlobal[DB_ACTIVITY_KEY];

/**
 * True iff the writer pool was used within `budgetMs` (default
 * {@link DB_ACTIVITY_BUDGET_MS}). A never-used pool is NOT recently active, so
 * an app that hasn't touched its DB never has the DB woken by the scrape.
 */
export const isDbRecentlyActive = (budgetMs = DB_ACTIVITY_BUDGET_MS): boolean => {
  const last = activityGlobal[DB_ACTIVITY_KEY];
  if (last === undefined) return false;
  return Date.now() - last <= budgetMs;
};

/** Reset the DB-activity timestamp (tests only). */
export const resetDbActivity = (): void => {
  delete activityGlobal[DB_ACTIVITY_KEY];
};

/**
 * Wrap a pool's `query`/`connect` so each successful-or-attempted use stamps
 * `lastDbActivityAt`. Best-effort + transparent: it delegates to the original
 * and never changes the return value or error propagation (fail-open — a hiccup
 * in activity tracking must never break the DB path). Kept SEPARATE from the
 * OTel db-wake instrumentor so activity is tracked even when tracing is off.
 */
const trackPoolActivity = (pool: Pool): Pool => {
  try {
    const originalQuery = pool.query;
    if (typeof originalQuery === 'function') {
      pool.query = function trackedQuery(this: unknown, ...args: unknown[]) {
        markDbActivity();
        return (originalQuery as (...a: unknown[]) => unknown).apply(this ?? pool, args);
      } as Pool['query'];
    }
    const originalConnect = pool.connect;
    if (typeof originalConnect === 'function') {
      pool.connect = function trackedConnect(this: unknown, ...args: unknown[]) {
        markDbActivity();
        return (originalConnect as (...a: unknown[]) => unknown).apply(this ?? pool, args);
      } as Pool['connect'];
    }
  } catch {
    // Fail-open: activity tracking is observability sugar, never break the pool.
  }
  return pool;
};

// ── Single-flight the DB wake (#339) ──────────────────────────────────────────
// Cold-start under concurrency was ~5x slower than a single cold request (OKE:
// 6.4s single, ~32s at concurrency 20). Root cause: N concurrent first-connects
// each independently open a socket to the scale-zero-pg gateway and each blocks
// on the same 0→1 `compute-<app>` wake — the burst contends on one wake with no
// coordination. We single-flight it: the FIRST client acquisition (connect() OR
// query()) on a cold pool runs the real acquisition and PUBLISHES its in-flight
// promise; every concurrent first-caller AWAITS that single shared promise
// instead of triggering its own wake, then proceeds warm. Once the wake resolves
// the pool is latched `woken` and later acquisitions pass straight through.
//
// Fail-open + retry-safe (mirrors the db-wake latch, #336): a REJECTED wake does
// NOT latch `woken` and clears the in-flight slot, so the next acquisition
// single-flights a FRESH wake (a cold gateway that timed out then succeeds on
// retry still collapses its own burst). Nothing here changes success/error
// propagation or return values — a hiccup in single-flight never breaks the DB
// path (the wrapper delegates to the original and only GATES cold callers).
//
// Anchored on `globalThis` via `Symbol.for` (ADR-0027, #352), NOT a module-level
// `let`: in the standalone build `@knext/lib` is bundled into multiple webpack
// layers, so a bare `let` would split the single-flight state per copy and let
// two copies each trigger a wake. The shared globalThis cell keeps ONE wake for
// the whole process regardless of bundle duplication.
const DB_WAKE_SF_KEY = Symbol.for('knext.lib.clients.dbWakeSingleflight');

interface WakeSingleflight {
  /** A cold acquisition has SUCCEEDED — permanent; later acquisitions are warm. */
  woken: boolean;
  /** The shared in-flight wake, or null when no wake is running / already woken. */
  inflight: Promise<unknown> | null;
}

type WakeSingleflightGlobal = Record<symbol, WakeSingleflight | undefined>;

const wakeSfGlobal = globalThis as unknown as WakeSingleflightGlobal;

const getWakeSingleflight = (): WakeSingleflight => {
  let sf = wakeSfGlobal[DB_WAKE_SF_KEY];
  if (!sf) {
    sf = { woken: false, inflight: null };
    wakeSfGlobal[DB_WAKE_SF_KEY] = sf;
  }
  return sf;
};

/** True once the writer pool's 0→1 wake has succeeded this process (cross-copy). */
export const isDbWoken = (): boolean => getWakeSingleflight().woken;

/** Reset the DB-wake single-flight state (tests only). */
export const resetDbWakeSingleflight = (): void => {
  delete wakeSfGlobal[DB_WAKE_SF_KEY];
};

/**
 * Wrap a pool's `connect`/`query` so the FIRST cold acquisition is single-flighted:
 * concurrent first-callers share ONE wake instead of each triggering a 0→1 wake.
 *
 * Contract (see the block comment above):
 *  - Warm (`woken`) → straight pass-through, zero added latency.
 *  - Cold, no wake in flight → THIS caller runs the real acquisition, publishes
 *    its promise as the shared in-flight; on success latches `woken` + clears the
 *    slot; on failure clears the slot WITHOUT latching (retry re-wakes, #336).
 *  - Cold, a wake already in flight → await the shared in-flight (ignoring its
 *    rejection), then run this caller's own (now-warm) acquisition.
 *
 * Fail-open: if patching throws, the original pool is returned unchanged.
 */
const singleflightWake = (pool: Pool): Pool => {
  try {
    const sf = getWakeSingleflight();

    // Run `op` as the wake leader (publishes in-flight) or a warm follower.
    const gate = <R>(op: () => R): R | Promise<R> => {
      if (sf.woken) {
        return op();
      }
      if (sf.inflight) {
        // A wake is already running — wait for it (ignore its outcome; our own op
        // reports the real result), then acquire warm.
        return sf.inflight.then(
          () => op(),
          () => op(),
        );
      }
      // We are the wake leader: run the real op and publish it as the shared wake.
      let result: R;
      try {
        result = op();
      } catch (err) {
        // Synchronous throw before any promise — leave unlatched so a retry re-wakes.
        sf.inflight = null;
        throw err;
      }
      if (result != null && typeof (result as { then?: unknown }).then === 'function') {
        const promise = result as unknown as Promise<unknown>;
        sf.inflight = promise.then(
          (value) => {
            sf.woken = true;
            sf.inflight = null;
            return value;
          },
          (err) => {
            // #336: a failed wake must NOT latch `woken`; clear so the retry re-wakes.
            sf.inflight = null;
            throw err;
          },
        );
        // Swallow the published promise's rejection so an awaiting sibling that
        // maps it through `.then(_, _)` never produces an unhandled rejection; the
        // leader itself still sees the original rejection via `result`.
        sf.inflight.catch(() => {});
        return result;
      }
      // Synchronous success (e.g. a mock) — treat as woken immediately.
      sf.woken = true;
      sf.inflight = null;
      return result;
    };

    const originalConnect = pool.connect;
    if (typeof originalConnect === 'function') {
      pool.connect = function singleflightConnect(this: unknown, ...args: unknown[]) {
        return gate(() =>
          (originalConnect as (...a: unknown[]) => unknown).apply(this ?? pool, args),
        );
      } as Pool['connect'];
    }
    const originalQuery = pool.query;
    if (typeof originalQuery === 'function') {
      pool.query = function singleflightQuery(this: unknown, ...args: unknown[]) {
        return gate(() =>
          (originalQuery as (...a: unknown[]) => unknown).apply(this ?? pool, args),
        );
      } as Pool['query'];
    }
  } catch {
    // Fail-open: single-flight is a latency optimization, never break the pool.
  }
  return pool;
};

/**
 * Run the installed instrumentor over a newly-created pool. Best-effort: a
 * misbehaving instrumentor must never break pool creation (fail-open) — the
 * pool is far more important than its span.
 */
const instrumentPool = (pool: Pool, role: PoolRole): Pool => {
  try {
    getPoolInstrumentor()(pool, role);
  } catch {
    // Instrumentation is observability sugar; never let it sink the DB path.
  }
  return pool;
};

export const getCerbosClient = () => {
  if (!cerbosClient) {
    const target = process.env.CERBOS_URL || 'cerbos.default.svc.cluster.local:3593';
    cerbosClient = new Cerbos(target, { tls: false });
  }
  return cerbosClient;
};

export const getMinioClient = () => {
  if (!minioClient) {
    minioClient = new Minio.Client({
      endPoint: process.env.MINIO_ENDPOINT || 'minio.default.svc.cluster.local',
      port: Number.parseInt(process.env.MINIO_PORT || '9000', 10),
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey: process.env.MINIO_ACCESS_KEY || 'minio',
      secretKey: process.env.MINIO_SECRET_KEY || 'minio123',
    });
  }
  return minioClient;
};

// Scale-to-zero-sane pool defaults. Under Knative each pod owns its own pool,
// and a zone can scale to `maxScale` pods — so the cluster opens up to
// `maxScale × DB_POOL_MAX` backend connections. We therefore keep each pod's
// pool SMALL (many small pools, not a few large ones) and let a transaction-mode
// pooler in front (PGS-2) bound the real Postgres connections. `max: 5` keeps
// `maxScale(10) × 5 = 50` well under a typical `max_connections` of 100–200.
// A finite idle timeout lets idle connections drop quickly so a freshly-scaled
// pod doesn't hold backend slots it isn't using. Both are env-overridable per
// zone (DB_POOL_MAX / DB_POOL_IDLE_TIMEOUT_MS) — see the Postgres-under-
// scale-to-zero guide.
const DEFAULT_DB_POOL_MAX = 5;
const DEFAULT_DB_POOL_IDLE_TIMEOUT_MS = 10_000;
// pg's default connect timeout is 0 = wait indefinitely: that survives a cold
// scale-to-zero DB wake, but it also hangs every request forever when the DB
// is truly unreachable. A bounded 15s fails fast with a clear pool error while
// leaving ~6x margin over the ~2.5s scale-zero-pg cold wake (the
// postgres-binding guide's contract: connect timeout >= 10s). Env-overridable
// per zone (DB_POOL_CONNECT_TIMEOUT_MS).
const DEFAULT_DB_POOL_CONNECT_TIMEOUT_MS = 15_000;

const toFinitePositiveInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const getDbPool = () => {
  if (!pgPool) {
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: toFinitePositiveInt(process.env.DB_POOL_MAX, DEFAULT_DB_POOL_MAX),
      idleTimeoutMillis: toFinitePositiveInt(
        process.env.DB_POOL_IDLE_TIMEOUT_MS,
        DEFAULT_DB_POOL_IDLE_TIMEOUT_MS,
      ),
      connectionTimeoutMillis: toFinitePositiveInt(
        process.env.DB_POOL_CONNECT_TIMEOUT_MS,
        DEFAULT_DB_POOL_CONNECT_TIMEOUT_MS,
      ),
    });
    // Wrapping order matters — each wrap is a layer, and the LAST wrap is the
    // OUTERMOST (runs first on a call). We want, from outermost → innermost:
    //   1. activity tracking (#348/#361): stamp lastDbActivityAt BEFORE anything
    //      else, so even a cold caller that is about to be GATED by single-flight,
    //      or one whose query later REJECTS, still counts as activity → the
    //      stuck-`waking` alert keeps probing during an outage.
    //   2. single-flight the 0→1 wake (#339): collapse N concurrent first-connects
    //      onto ONE wake; warm callers pass straight through.
    //   3. db-wake tracing instrumentor (no-op unless an app opted in).
    // So we wrap in reverse: instrument (inner) → single-flight → activity (outer).
    instrumentPool(pgPool, 'writer');
    singleflightWake(pgPool);
    trackPoolActivity(pgPool);
  }
  return pgPool;
};

/**
 * Drain and close the singleton Postgres pool, letting in-flight transactions
 * commit-or-rollback before the connections close. Safe to call when no pool was
 * ever created (no-op). Intended to be wired into the runtime's SIGTERM drain
 * (see `registerShutdownDrain` in @knext/kn-next) so scale-down doesn't sever
 * transactions. Resets the singleton so a later `getDbPool()` reconnects.
 */
export const closeDbPool = async (): Promise<void> => {
  if (!pgPool) {
    return;
  }
  const pool = pgPool;
  pgPool = null;
  await pool.end();
};

/**
 * Read-only pool over `DATABASE_URL_RO` — the scale-zero-pg RO gateway
 * (port 55434), a **bounded-staleness** endpoint (~9s ceiling, NO
 * read-your-writes). Reads are a deliberate, explicit opt-in: nothing is
 * auto-routed (scale-zero-pg `docs/connecting.md`), so the writer pool
 * (`getDbPool`) and this reader stay two distinct singletons and the caller
 * picks which one a query uses.
 *
 * Returns `null` when `DATABASE_URL_RO` is unset — an app without a read
 * replica simply has no RO pool (callers such as `@knext/db`'s `getDbRO()`
 * fall back to the writer). Otherwise mirrors the writer pool's scale-to-zero
 * contract (ADR-0019): small `max` (many small pools under `maxScale`), idle
 * timeout < the gateway's 60s idle (no dead sockets), connect timeout >= 10s
 * (tolerates the ~2.5s cold wake). Independently tunable via `DB_POOL_RO_MAX`,
 * `DB_POOL_RO_IDLE_TIMEOUT_MS`, `DB_POOL_RO_CONNECT_TIMEOUT_MS`.
 */
export const getDbPoolRO = (): Pool | null => {
  const connectionString = process.env.DATABASE_URL_RO;
  if (!connectionString) {
    return null;
  }
  if (!pgPoolRO) {
    pgPoolRO = new Pool({
      connectionString,
      max: toFinitePositiveInt(process.env.DB_POOL_RO_MAX, DEFAULT_DB_POOL_MAX),
      idleTimeoutMillis: toFinitePositiveInt(
        process.env.DB_POOL_RO_IDLE_TIMEOUT_MS,
        DEFAULT_DB_POOL_IDLE_TIMEOUT_MS,
      ),
      connectionTimeoutMillis: toFinitePositiveInt(
        process.env.DB_POOL_RO_CONNECT_TIMEOUT_MS,
        DEFAULT_DB_POOL_CONNECT_TIMEOUT_MS,
      ),
    });
    // Wrap the fresh RO pool for db-wake tracing (no-op unless opted in).
    instrumentPool(pgPoolRO, 'reader');
  }
  return pgPoolRO;
};

/**
 * Drain and close the singleton read-only Postgres pool, mirroring
 * `closeDbPool`. Safe to call when no RO pool was ever created (no-op) — e.g.
 * when `DATABASE_URL_RO` was unset. The runtime's SIGTERM drain closes this
 * alongside the writer pool. Resets the singleton so a later `getDbPoolRO()`
 * reconnects.
 */
export const closeDbPoolRO = async (): Promise<void> => {
  if (!pgPoolRO) {
    return;
  }
  const pool = pgPoolRO;
  pgPoolRO = null;
  await pool.end();
};
