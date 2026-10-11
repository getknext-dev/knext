// The PUBLISHED entry for `@getknext/core/adapters/cache-handler` (tsup builds
// this file to `dist/adapters/cache-handler.js`).
//
// `./cache-handler.js` is the IMPLEMENTATION and, deliberately, the test-only
// entry: it defines and exports the `__`-prefixed test seams, because a seam
// must be defined in the module whose state it resets, and the suites load that
// module by path with a cache-busting query (`cache-handler.js?x=…`) to get a
// fresh instance each time — a facade re-exporting from it would bind to the
// singleton instead. This file re-exports everything EXCEPT the seams, so none
// of them is reachable from the published subpath.
//
// Do NOT write `export *` here: it would carry the seams back out.
// `scripts/scan-published-seams.mjs` reds on that, and
// `packages/kn-next/src/__tests__/test-seam-split.test.ts` checks that this
// file lists exactly the implementation's non-seam exports.
export { default } from './cache-handler.js';
export { CacheHandler, ioredisClient, nativeRedisClient } from './cache-handler.js';
