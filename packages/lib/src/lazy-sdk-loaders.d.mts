// Hand-written companion types for `lazy-sdk-loaders.mjs` (plain,
// unprocessed JS — see that file's banner comment for why). `unknown` return
// types are deliberate: `clients.ts` casts the result to the real SDK shape
// it needs at each call site, same as it did when the `require(...)` call
// lived inline.
export declare function loadCerbosSdk(): unknown;
export declare function loadMinioSdk(): unknown;
