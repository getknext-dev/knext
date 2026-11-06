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
// `createRequire(runtimeAnchor())` instead.
//
// The anchor is NOT `import.meta.url`: a webpack build rewrites that to the
// build machine's absolute path (as a file URL) and ships it in the server
// chunk (path leak, non-reproducible output, and a base that does not exist in
// the image). `runtimeAnchor()` asks the engine for this file's name at call
// time instead. It is a deliberate COPY of `runtime-anchor.ts` (this file is
// unprocessed and cannot import a transpiled sibling); keep the two in step,
// the build-path test over a webpack bundle of the real lib covers both.
import { createRequire } from 'node:module';

const REAL_LOCATION = /^(?:file:\/\/|\/(?!\$bunfs\/)|[A-Za-z]:[\\/])/;
const BUN_VIRTUAL = /(?:\$bunfs|~BUN)/;

function ownFileName() {
  const previousPrepare = Error.prepareStackTrace;
  const previousLimit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 1;
    Error.prepareStackTrace = (_error, sites) => sites;
    const sites = new Error().stack;
    if (!Array.isArray(sites)) return undefined;
    return sites[0]?.getFileName() ?? undefined;
  } catch {
    return undefined;
  } finally {
    Error.prepareStackTrace = previousPrepare;
    Error.stackTraceLimit = previousLimit;
  }
}

function runtimeAnchor() {
  const file = ownFileName();
  if (file !== undefined && REAL_LOCATION.test(file) && !BUN_VIRTUAL.test(file)) return file;
  return `${process.cwd()}/`;
}

/** Lazily load `@cerbos/grpc`. See the file banner for why this is unbundled. */
export function loadCerbosSdk() {
  return typeof require === 'function'
    ? require('@cerbos/grpc')
    : createRequire(runtimeAnchor())('@cerbos/grpc');
}

/** Lazily load `minio`. See the file banner for why this is unbundled. */
export function loadMinioSdk() {
  return typeof require === 'function' ? require('minio') : createRequire(runtimeAnchor())('minio');
}
