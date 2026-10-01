// biome-ignore-all lint: hand-authored, intentionally NOT processed by tsup/esbuild.
//
// Why this file exists and why it is plain, untranspiled `.mjs` rather than
// `.ts` compiled alongside everything else in this package (#1777 round 3):
//
// `clients.ts` needs to lazily `require('@cerbos/grpc')` / `require('minio')`
// on first client use (see the block comment above `CERBOS_CLIENT_KEY` in
// `clients.ts`), and that `require(...)` call must stay a LITERAL, UNRENAMED,
// free reference to the ambient CommonJS `require` so that Next's output file
// tracer (`@vercel/nft`) and webpack's own require-call matching — both of
// which do real lexical-scope analysis, not text search — can see it and
// trace/bundle `minio` / `@cerbos/grpc` into a webpack standalone build.
//
// Measured directly: esbuild (tsup's bundler), whenever it bundles a free
// `require` reference into ESM output (`format: 'esm'`, which this package
// ships exclusively — see `tsup.config.ts`'s own reasoning), ALWAYS rewrites
// it to an internal `__require` shim (`var __require = (x) => typeof require
// !== "undefined" ? require : ...`), regardless of `platform` or `external`
// settings — there is no esbuild/tsup flag to suppress this. A renamed
// `__require('minio')` call is just as invisible to nft/webpack as the
// previous round's `require2('minio')` was (see `clients.ts`'s block
// comment) — same defect, different cause.
//
// esbuild only leaves a bare `require(...)` call untouched when the FILE
// CONTAINING IT is never bundled at all — i.e. the import that reaches it is
// marked `external`. This file is exactly that: `tsup.config.ts` marks
// `./lazy-sdk-loaders.mjs` external, so esbuild treats the `import` in
// `clients.ts` as an opaque, unresolved specifier and never reads this
// file's contents — so it can never transform the `require(...)` calls
// inside it. The build's `onSuccess` hook copies this file byte-for-byte
// into `dist/`, where it sits as a sibling of the bundled chunk that imports
// it (both land flat in `dist/`, so the relative specifier `./lazy-sdk-
// loaders.mjs` resolves identically in `src/` and in `dist/`).
//
// Each loader hard-codes its own specifier as a STRING LITERAL at the
// `require(` call site — never passed through a shared variable — because a
// dynamic argument is exactly as untraceable to nft/webpack as a renamed
// identifier would be.
//
// `typeof require === 'function'` is the bundler/CJS-runtime branch;
// `typeof` on an identifier with no binding in scope never throws (only
// reading past it would), so running this file directly as plain Node ESM
// (no bundler, `require` never declared) safely falls through to
// `createRequire(import.meta.url)` instead.
import { createRequire } from 'node:module';

/** Lazily load `@cerbos/grpc`. See the file banner for why this is unbundled. */
export function loadCerbosSdk() {
  return typeof require === 'function'
    ? require('@cerbos/grpc')
    : createRequire(import.meta.url)('@cerbos/grpc');
}

/** Lazily load `minio`. See the file banner for why this is unbundled. */
export function loadMinioSdk() {
  return typeof require === 'function' ? require('minio') : createRequire(import.meta.url)('minio');
}
