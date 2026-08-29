/**
 * Reset `@getknext/db` and the pools underneath it between tests.
 *
 * Replaces `vi.resetModules()`, which `bun:test` deliberately has no equivalent
 * for. That is the better position: a registry reset hides which state a module
 * owns and stops working silently once any of it moves onto `globalThis`
 * (ADR-0027) — one clients test already carried the comment "survives
 * vi.resetModules()".
 *
 * It lives HERE, inside the package, rather than in `tests/helpers/`, because
 * module identity matters. `@getknext/db`'s source imports
 * `@getknext/lib/clients` by package specifier; a helper elsewhere in the repo
 * cannot resolve that specifier (bun does not link a workspace package into the
 * root `node_modules` unless something depends on it) and had to reach lib by
 * relative source path instead. That yields a SECOND module instance with its
 * own pool singletons, so the reset cleared state the tests never touched.
 * Same specifier, same instance.
 *
 * The imports are DYNAMIC and that is load-bearing: a static import pulls lib —
 * and through it `pg` — into the graph before the test file's `mock.module`
 * calls run, so the mocks apply to nothing. That is the hazard
 * `scripts/scan-mock-hoisting.mjs` exists to find.
 */
export async function resetDbState(): Promise<void> {
  const db = await import('../index');
  const clients = await import('@getknext/lib/clients');

  // drizzle clients first: they hold pool references, so clearing them before
  // the pools close means nothing hands out a client over a pool mid-teardown.
  db.resetDbClients();

  // Each call is guarded because a test may have replaced `@getknext/lib/clients`
  // with a narrow fake — `db.test.ts` mocks it down to getDbPool/getDbPoolRO.
  // Calling straight through then throws on the first missing function and the
  // whole file fails in `beforeEach`, which reads as the code under test being
  // broken rather than as the helper over-reaching. Resetting what is there is
  // exactly right: state that does not exist needs no reset.
  const call = async (fn: unknown): Promise<void> => {
    if (typeof fn === 'function') await (fn as () => unknown | Promise<unknown>)();
  };

  await call(clients.closeDbPool);
  await call(clients.closeDbPoolRO);
  await call(clients.resetDbActivity);
  await call(clients.resetDbWakeSingleflight);
  await call(clients.resetPoolInstrumentor);
}
