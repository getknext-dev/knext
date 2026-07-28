/**
 * In-flight ISR cache-write registry (T13) — INTERNAL.
 *
 * Why this is its own module, and why its state lives on `globalThis`.
 *
 * `cache-handler.js` is loaded by Next.js **by file path**, through the app's
 * thin `export { default } from '@getknext/core/adapters/cache-handler'` shim.
 * Nothing guarantees that the module record Next instantiates that way and the
 * one a shutdown path imports are the same instance in a real standalone
 * bundle — Next duplicates modules across webpack layers, and each copy gets
 * its own module state.
 *
 * A bare module-level `const inFlightWrites = new Set()` therefore has a
 * SILENT failure mode: the writer registers into one Set, the drain reads a
 * second, empty one, `drainCacheWrites()` resolves instantly, the writes are
 * lost, and nothing logs. That is the #352 mechanism, and ADR-0027 §3 is the
 * rule for it — anchor the mutable state on `globalThis` under a namespaced
 * `Symbol.for` key, never a bare module-level binding.
 *
 * This file already had the pattern in front of it: `cache-handler.js` anchors
 * `globalThis.cacheEvents` for exactly this reason.
 *
 * Where the duplication does and does not come from — measured, not assumed:
 * tsup hoists this module into a SHARED chunk that both `./internal/cache-drain`
 * and `adapters/cache-handler.js` import, so the PUBLISHED artifacts hold one
 * module record. The hazard is downstream, in Next's re-bundling of a handler it
 * loads by file path. The anchor is what makes the seam correct either way.
 *
 * Note honestly what a same-process test can and cannot show. It CAN produce
 * two distinct module records (`vi.resetModules()` + re-import) and prove they
 * observe the same Set — that is a real duplication of module state and it is
 * covered by `cache-write-registry-identity.test.ts`. It CANNOT reproduce the
 * webpack-layer split of a shipped standalone bundle; the build-artifact guard
 * is the only real check of that, and none covers this module today.
 */

/** Namespaced anchor key — see ADR-0027 §3. */
const IN_FLIGHT_KEY = Symbol.for('knext.core.cache.inflight');

/**
 * The one true set of in-flight writes, resolved through `globalThis` on every
 * access so duplicated copies of this module converge on a single instance.
 * Deliberately NOT cached in a module-level binding: caching it would reinstate
 * the per-copy state this indirection exists to remove.
 */
function inFlight() {
  let set = globalThis[IN_FLIGHT_KEY];
  if (!set) {
    set = new Set();
    globalThis[IN_FLIGHT_KEY] = set;
  }
  return set;
}

/**
 * Register a cache write so a shutdown path can await it. Returns the same
 * promise, so callers can `return trackWrite(...)` transparently.
 *
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<T>}
 */
export function trackWrite(promise) {
  const set = inFlight();
  set.add(promise);
  const forget = () => set.delete(promise);
  promise.then(forget, forget);
  return promise;
}

/**
 * Await every in-flight cache write, or `timeoutMs`, whichever comes first.
 * Never rejects: a failed write must not turn a graceful shutdown into a crash.
 *
 * Bounded on purpose — the pod's terminationGracePeriod, not the cache, decides
 * when the process dies.
 *
 * @param {number} [timeoutMs] hard cap; keep below the pod's grace period.
 * @returns {Promise<void>}
 */
export async function drainCacheWrites(timeoutMs = 5000) {
  const set = inFlight();
  if (set.size === 0) return;
  const settled = Promise.allSettled([...set]);
  let timer;
  const capped = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();
  });
  await Promise.race([settled, capped]);
  if (timer) clearTimeout(timer);
}

/** How many cache writes are currently in flight. */
export function inFlightCacheWriteCount() {
  return inFlight().size;
}
