import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A scope inside which DB pool use does NOT count as application activity.
 *
 * Why it exists: the deep-health probe (`checkDeepHealth`) queries the tracked
 * writer pool, and the tracked pool stamps `lastDbActivityAt` on every use. The
 * metrics scrape runs that probe only while `isDbRecentlyActive()`, so a probe
 * that stamped its own activity re-armed the gate on every scrape: the probe ran
 * forever and the scale-to-zero database never slept while the pod was up. The
 * probe runs inside this scope, so it observes the database without being
 * mistaken for the app using it.
 *
 * Per async context, deliberately — NOT a process-global flag. A request the app
 * serves while a probe is in flight runs outside the scope and still stamps; a
 * global flag would drop those stamps for the probe's whole duration (up to the
 * 8 s deep-check budget) and make a busy app look idle.
 *
 * Internal: not exported from any package entry point. The store is anchored on
 * `globalThis` under a namespaced symbol (ADR-0027) so bundler-duplicated copies
 * of this module share one scope.
 */
const SCOPE_KEY = Symbol.for('knext.lib.db.activityScope');
type ScopeGlobal = Record<symbol, AsyncLocalStorage<true> | undefined>;
const scopeGlobal = globalThis as unknown as ScopeGlobal;

const scope = (): AsyncLocalStorage<true> => {
  let als = scopeGlobal[SCOPE_KEY];
  if (!als) {
    als = new AsyncLocalStorage<true>();
    scopeGlobal[SCOPE_KEY] = als;
  }
  return als;
};

/** Run `fn` with DB activity tracking suppressed for everything it awaits. */
export const runWithoutDbActivity = <T>(fn: () => T): T => scope().run(true, fn);

/** True while executing inside {@link runWithoutDbActivity}. */
export const isDbActivityUntracked = (): boolean => scope().getStore() === true;
