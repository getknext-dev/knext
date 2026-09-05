/**
 * compat-smoke-mode.mjs — how the smoke decides WHICH runtime model it is
 * exercising (T6c).
 *
 * The runner used to answer this with `SERVER_CMD === SERVER_PATH`. That is a
 * string-identity test over two independently env-overridable paths, and the
 * consequence of getting it wrong is not cosmetic:
 *
 *   single-exec  → spawn SERVER_CMD with NO script argument and NO preload, and
 *                  skip the `--version` probe in check (h) (the binary would
 *                  boot a SECOND server and the check would hang).
 *   standalone   → stage a preload, spawn `node`/`bun` WITH a server.js, probe
 *                  `--version` freely.
 *
 * So a symlink, a `./` prefix, a relative spelling or a trailing slash — all of
 * which name the same file — flip the runner into the wrong model silently. The
 * fix is to compare what the FILESYSTEM says (`realpathSync`), and to let a
 * caller state the mode explicitly so that a disagreement between the stated
 * mode and the paths is a loud failure instead of a silent flip.
 *
 * Deliberately a separate module with no side effects: `compat-smoke.mjs` starts
 * a server on import, so the decision cannot be unit-tested where it is used.
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/** The two spellings `SMOKE_MODE` accepts. Anything else is a typo, not a mode. */
export const SMOKE_MODES = Object.freeze(['single-exec', 'standalone']);

/**
 * The real path of `p`, or `null` when it does not resolve.
 *
 * `null` rather than a fallback to the lexical path: two paths that BOTH fail to
 * resolve must not compare equal just because their strings happen to match. An
 * unbuilt binary is exactly that case, and reading it as single-exec would make
 * the smoke skip the very probe that would have reported the missing build.
 */
function realOrNull(p) {
  if (typeof p !== 'string' || p === '') return null;
  try {
    return realpathSync(resolve(p));
  } catch {
    return null;
  }
}

/**
 * Decide the execution model.
 *
 * @param {object} opts
 * @param {string} opts.serverCmd  the executable the smoke spawns (`SERVER_CMD`)
 * @param {string} opts.serverPath the server artifact (`SERVER_PATH`)
 * @param {string} [opts.smokeMode] optional explicit mode (`SMOKE_MODE`)
 * @returns {{ singleExec: boolean, resolvedCmd: string|null, resolvedPath: string|null }}
 */
export function resolveSmokeMode({ serverCmd, serverPath, smokeMode }) {
  const resolvedCmd = realOrNull(serverCmd);
  const resolvedPath = realOrNull(serverPath);
  // Both must resolve AND be the same real file. `null === null` is excluded on
  // purpose (see `realOrNull`).
  const derived = resolvedCmd !== null && resolvedPath !== null && resolvedCmd === resolvedPath;

  if (smokeMode !== undefined && smokeMode !== null && smokeMode !== '') {
    if (!SMOKE_MODES.includes(smokeMode)) {
      throw new Error(
        `compat-smoke: SMOKE_MODE=${JSON.stringify(smokeMode)} is not a mode — ` +
          `expected one of ${SMOKE_MODES.join(' | ')}`,
      );
    }
    const stated = smokeMode === 'single-exec';
    if (stated !== derived) {
      throw new Error(
        `compat-smoke: SMOKE_MODE=${smokeMode} contradicts the paths.\n` +
          `  SERVER_CMD  ${serverCmd} -> ${resolvedCmd ?? '(unresolvable)'}\n` +
          `  SERVER_PATH ${serverPath} -> ${resolvedPath ?? '(unresolvable)'}\n` +
          `  the filesystem says ${derived ? 'single-exec' : 'standalone'}. Fix the ` +
          'variables rather than the mode: the two branches spawn different argv and run ' +
          'different checks, so a wrong mode does not merely mislabel the run.',
      );
    }
  }

  return { singleExec: derived, resolvedCmd, resolvedPath };
}
