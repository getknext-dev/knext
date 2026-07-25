// Test-only stub for the bare `server-only` module.
//
// Next.js provides `server-only` from its bundled `next/dist/compiled/server-only`
// during `next build` (and enforces the server-only boundary there). The bare
// specifier is NOT resolvable at the repo root, so importing a module that does
// `import 'server-only'` (e.g. the observability Prometheus client) would fail to
// resolve under Vitest. This no-op stub — aliased in `vitest.config.ts` — lets
// those server-only modules be unit-tested without the Next compiler in the loop.
// It changes nothing at runtime: `next build` still resolves the real guard.
export {};
