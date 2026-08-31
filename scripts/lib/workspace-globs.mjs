/**
 * The workspace globs, as DECLARED — one definition for every guard that checks
 * a hardcoded list against them.
 *
 * Three guards each read `pnpm-workspace.yaml`'s `packages:` block directly:
 * `next-version-floor`, `publish-preflight` and `release-policy-matrix`. Each
 * asserts the same class of thing — "this hardcoded list still matches what the
 * workspace declares" — and each re-derived the declaration its own way, so
 * removing pnpm broke all three separately.
 *
 * They now share this. The value is not just fewer copies: a guard that reads
 * the declaration through the same helper as its siblings cannot disagree with
 * them about what the workspace IS, which is the failure that would let a
 * package quietly fall outside every one of them.
 *
 * The declaration moved from `pnpm-workspace.yaml` to `package.json`'s
 * `workspaces` array when the repo left pnpm. That is the same information in
 * the format bun and npm both read, so the guards' subject is unchanged.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @returns {string[]} the declared globs, e.g. `['apps/*', 'packages/*']`
 */
export function workspaceGlobs() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const globs = pkg.workspaces;
  if (!Array.isArray(globs) || globs.length === 0) {
    // Refuse rather than return nothing. Every caller uses this to check a
    // hardcoded list against the declaration; an empty declaration makes those
    // checks pass vacuously, which is worse than the guard failing loudly.
    throw new Error(
      'package.json declares no `workspaces` array — the guards that compare ' +
        'hardcoded package lists against it would silently pass',
    );
  }
  return globs;
}

/**
 * The top-level directories the globs cover, e.g. `['apps', 'packages']`.
 *
 * Several guards want the ROOTS rather than the globs, and each was slicing the
 * strings itself. Deriving it here keeps "what counts as a workspace root" in
 * one place too.
 */
export function workspaceRoots() {
  return [...new Set(workspaceGlobs().map((g) => g.split('/')[0]))].sort();
}
