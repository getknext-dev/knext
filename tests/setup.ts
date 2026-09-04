import { mock } from 'bun:test';

/**
 * Preloaded before every `bun test` run (see `bunfig.toml`).
 *
 * Pins the Postgres driver, and nothing else.
 *
 * `@getknext/lib` picks its driver by RUNTIME: Bun's native `Bun.SQL` when
 * `globalThis.Bun` exists, `pg` otherwise. That is right for production and
 * wrong for a test suite, because moving the suite from vitest (Node) to
 * `bun test` silently flips which driver every test exercises.
 *
 * Not hypothetical: four `getDbRO()` tests began failing on an EMPTY list of
 * constructed pools — they mock `pg` and assert the DSNs it was handed, and
 * under Bun the code had correctly stopped using `pg` at all. Nothing in the
 * failure named the cause.
 *
 * So the suite pins `pg`, the driver those assertions were written against. The
 * Bun path keeps its own direct coverage in
 * `packages/lib/src/__tests__/bun-sql-pool.test.ts`, which drives the facade
 * with an injected client and therefore needs no particular runtime. A test that
 * specifically wants the Bun driver sets `KNEXT_DB_DRIVER=bun` itself; an
 * existing value is never overwritten.
 *
 * NOTE for the ongoing bun:test migration: source aliases (`@getknext/lib` ->
 * packages/lib/src, as `vitest.config.ts` does) do NOT belong here. Registering
 * them with `mock.module` in a preload collides with the test files' own
 * `mock.module` calls for the same specifiers — measured, it took packages/db
 * from 5 failures to 8. Bun needs a real resolver alias (tsconfig `paths`), not
 * a preload mock.
 */

if (!process.env.KNEXT_DB_DRIVER) {
  process.env.KNEXT_DB_DRIVER = 'pg';
}

// ── `server-only` ────────────────────────────────────────────────────────────
//
// A bare specifier the Next compiler provides at build time
// (next/dist/compiled/server-only). It is not resolvable at the repo root, so
// any server-only module — the observability Prometheus client, the Cerbos
// wrapper — fails to import under `bun test`. vitest aliased it to a stub for
// exactly this reason.
//
// A module mock is safe here where the workspace aliases were not: nothing in
// the suite mocks `server-only` itself, so there is no collision with a test's
// own registration. The real guard still applies under `next build`.
mock.module('server-only', () => ({}));
