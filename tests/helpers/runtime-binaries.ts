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
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

export const NODE_BIN: string = process.versions.bun === undefined ? process.execPath : 'node';

/**
 * The DIRECTORY containing the Node executable.
 *
 * Several guards deliberately run a child with a MINIMAL `PATH` — typically
 * `dirname(process.execPath):/usr/bin:/bin` — so that a resolver which resolved
 * nothing cannot be rescued by the ambient environment. That construction
 * silently assumed `process.execPath` was Node.
 *
 * Under bun it is bun, so `node` fell off the restricted PATH entirely and the
 * child died with `env: node: No such file or directory` — a failure about the
 * harness, describing nothing about the resolver under test.
 *
 * Resolved via `which` when running under bun, because there is no Node path to
 * derive. If that fails there is no honest answer, so it throws rather than
 * returning a directory that happens to exist: a guard whose restricted PATH
 * quietly lost its subject would still run, and pass.
 */
export function nodeDir(): string {
  if (process.versions.bun === undefined) return dirname(process.execPath);
  const found = execFileSync('which', ['node'], { encoding: 'utf8' }).trim();
  if (found.length === 0) {
    throw new Error(
      'cannot locate `node` under bun — guards that restrict PATH need its ' +
        'real directory, and guessing one would let them run without it',
    );
  }
  return dirname(found);
}

/**
 * The Bun executable, or `undefined` when there is no way to find one.
 *
 * Callers must treat `undefined` as "cannot run this case" and say so — a test
 * that silently skips its own subject reports success for something it never
 * checked.
 */
export const BUN_BIN: string | undefined =
  process.versions.bun === undefined ? undefined : process.execPath;
