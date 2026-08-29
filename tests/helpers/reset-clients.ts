/**
 * Reset `@getknext/lib/clients` between tests, without a module-registry reset.
 *
 * vitest offered `vi.resetModules()`, which threw away the module registry so a
 * later `await import(...)` rebuilt every module-level singleton. `bun:test`
 * has no equivalent, and that is a deliberate design position rather than a
 * gap: a registry reset hides which state a module actually owns, so it works
 * right up until some of that state moves onto `globalThis` — at which point it
 * silently stops resetting and nothing tells you.
 *
 * That is not hypothetical here. `clients.ts` anchors its activity tracker on
 * `globalThis` (ADR-0027, because Next duplicates `@getknext/lib` across
 * webpack layers), and one of these tests already carried the comment
 * "survives vi.resetModules() — clear it so each test starts from 'never
 * used'". The registry reset was already insufficient; this makes the real
 * reset set explicit.
 *
 * Test-only on purpose. Every function called here is ALREADY exported by
 * `clients.ts` for exactly this reason, so nothing is added to the published
 * surface of `@getknext/lib` to support testing.
 */

/**
 * Return the clients module to its just-imported state.
 *
 * Order matters: the pools are closed FIRST so nothing in flight can re-stamp
 * activity or re-arm the wake single-flight after those have been cleared.
 *
 * The import is DYNAMIC, and that is load-bearing rather than stylistic. A
 * static import here pulls in `clients.ts` — and therefore `pg` — at the moment
 * this helper is imported, which is BEFORE the test file's `mock.module('pg')`
 * has run. The mock then applies to nothing, and the tests dial a real
 * Postgres: measured at ~8s per case, failing on a connect timeout rather than
 * on anything that names the cause.
 *
 * That is the same hoisting hazard `scripts/scan-mock-hoisting.mjs` exists to
 * find, introduced by the very helper written to ease the migration. Keeping
 * the import inside the function is what makes it land after the mocks.
 */
export async function resetClients(): Promise<void> {
  const clients = await import('../../packages/lib/src/clients');
  await clients.closeDbPool();
  await clients.closeDbPoolRO();
  clients.resetDbActivity();
  clients.resetDbWakeSingleflight();
  clients.resetPoolInstrumentor();
}
