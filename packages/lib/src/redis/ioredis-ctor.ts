import { createRequire } from 'node:module';
import type RedisClient from 'ioredis';

/**
 * Resolving ioredis's constructor, isolated into its own module so it can be
 * both bundler-invisible AND test-replaceable.
 *
 * ## Why this module exists at all
 *
 * Two requirements collided in `health/index.ts` and quietly broke the tests:
 *
 * 1. **ioredis must not be statically imported.** ADR-0048 compiles the server
 *    into a single Bun executable, and `bun build --compile` cannot resolve
 *    ioredis's transitive dynamic `require('@ioredis/commands')`. A static
 *    import put ioredis in the bundle graph, so the binary built cleanly and
 *    then died at boot with `Cannot find module '@ioredis/commands'`. That is
 *    measured, not theoretical — it is why the specifier is assembled below
 *    rather than written literally.
 *
 * 2. **The tests mock ioredis** with `vi.mock('ioredis', ...)`. That works by
 *    module id at resolution time, and it CANNOT intercept a `require()` of a
 *    computed string. When the loader moved inline into `health/index.ts`, the
 *    mock silently stopped applying and the health tests began dialling a REAL
 *    Redis — failing with `MaxRetriesPerRequestError` rather than anything that
 *    named the actual cause.
 *
 * Splitting the resolution into a module gives the tests a seam they can mock
 * by id (`vi.mock('../health/redis-ctor')`) while the specifier stays computed,
 * so no bundler can follow it. Both requirements hold, and neither depends on
 * the other's implementation detail.
 */

/** Assembled so no bundler can follow it. See the docblock. */
const IOREDIS_SPECIFIER = ['io', 'redis'].join('');

export type RedisCtor = new (url: string, opts?: Record<string, unknown>) => RedisClient;

/**
 * The ioredis constructor, resolved on first use.
 *
 * This package is CommonJS, so `require` is available directly. Returns the
 * constructor rather than an instance: construction options and the error
 * listener are the caller's business (they carry the #802 invariants), and
 * putting them here would split that decision across two modules.
 */
export function loadRedisCtor(): RedisCtor {
  // `createRequire`, not a bare `require`: this package ships ESM now, where
  // `require` does not exist. The specifier stays computed so no bundler can
  // follow it — that part is unchanged and still load-bearing.
  const require = createRequire(import.meta.url);
  const mod = require(IOREDIS_SPECIFIER) as { default?: RedisCtor } & RedisCtor;
  return (mod.default ?? mod) as RedisCtor;
}
