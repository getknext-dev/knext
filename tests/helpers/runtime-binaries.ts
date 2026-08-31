/**
 * Which executable a test means when it spawns a child (#871).
 *
 * Under vitest, `process.execPath` was always Node, so "the current runtime"
 * and "Node" were the same string and tests used them interchangeably. Under
 * `bun test` they are different binaries, and the distinction becomes
 * load-bearing:
 *
 *   - A test whose SUBJECT is Node behaviour — `NODE_COMPILE_CACHE`, the
 *     published CLI's plain-Node contract — must spawn Node whatever runs it.
 *     Spawning bun there does not fail loudly; it exercises a runtime where the
 *     feature legitimately does not apply, so assertions come back with the
 *     wrong branch's answer.
 *   - A test whose subject is BUN behaviour must spawn bun, for the same reason.
 *   - A test that genuinely means "whatever is running me" should keep using
 *     `process.execPath` and not import from here.
 *
 * Naming the choice is the point. `process.execPath` reads as a neutral detail
 * and silently encodes an assumption that stopped being true.
 */

/**
 * The Node executable.
 *
 * When Node is what is running us, its own path — exact, and immune to a
 * different `node` earlier on PATH. Under bun there is nothing to resolve from,
 * so it falls back to the name and lets PATH answer; every environment that
 * runs this suite has Node, since the published CLI is a Node program.
 */
export const NODE_BIN: string = process.versions.bun === undefined ? process.execPath : 'node';

/**
 * The Bun executable, or `undefined` when there is no way to find one.
 *
 * Callers must treat `undefined` as "cannot run this case" and say so — a test
 * that silently skips its own subject reports success for something it never
 * checked.
 */
export const BUN_BIN: string | undefined =
  process.versions.bun === undefined ? undefined : process.execPath;
