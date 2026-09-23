// A custom ISR `cacheHandler` that imports a Next INTERNAL — the case the
// compiled executable's disk closure used to miss. Next loads this file by
// COMPUTED path at runtime (`formatDynamicImportPath(distDir, cacheHandler)`),
// so it always comes from disk; the question is whether the Next internal it
// requires is the SAME module instance the server core uses.
//
// The internal is an `*.external` AsyncLocalStorage singleton that a Pages
// Router app's route chunks never reference, so before the fix only the
// server core reached it — and the compile bundled the core's copy, leaving
// this handler with a second instance loaded from disk.
//
// Single-instance proof: Next's server core requires this module EAGERLY at
// boot, before it ever loads a cache handler. So if the core's copy is the
// on-disk one, it is already in `require.cache` when this file runs; if the
// core's copy was bundled into the executable, this require is the FIRST disk
// load — a second instance. Uncompiled Next (the control) is always `true`.
//
// The specifier is written out LITERALLY in the require: the compile scans a
// handler's literal-require closure, exactly as it scans the route chunks (a
// computed `require(name)` is invisible to it, in a handler as in a chunk).
const resolved = require.resolve('next/dist/server/app-render/after-task-async-storage.external');
const sharedInstance = Boolean(require.cache[resolved]);
const { afterTaskAsyncStorage } = require('next/dist/server/app-render/after-task-async-storage.external');

const probe = (globalThis.__knextCacheHandlerProbe ??= {
  loads: 0,
  sharedInstance,
  hasStorage: typeof afterTaskAsyncStorage?.getStore === 'function',
  gets: 0,
  hits: 0,
  sets: 0,
});
probe.loads += 1;

const store = new Map();

module.exports = class KnextProbeCacheHandler {
  async get(key) {
    probe.gets += 1;
    const entry = store.get(key);
    if (entry) probe.hits += 1;
    return entry ?? null;
  }

  async set(key, data) {
    probe.sets += 1;
    store.set(key, { value: data, lastModified: Date.now() });
  }

  async revalidateTag() {}

  resetRequestCache() {}
};
