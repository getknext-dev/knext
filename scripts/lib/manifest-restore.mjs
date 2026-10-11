/**
 * manifest-restore.mjs — snapshot every workspace `package.json` and put the
 * exact bytes back, however the process ends.
 *
 * `install-smoke.mjs` rewrites `workspace:^` to literal versions in the working
 * tree so `npm pack` ships installable manifests. That rewrite is ephemeral by
 * intent; leaving it behind meant a later `git commit -a` committed it.
 *
 * Restore runs on: normal return, a thrown error, `process.exit()` (which skips
 * `finally`, hence the `exit` listener), SIGINT and SIGTERM. Restore is
 * synchronous and idempotent so it is safe in an `exit` listener.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Read the raw bytes of every `<root>/<dir>/package.json` under `repoRoot`. */
function snapshot(repoRoot, roots) {
  const saved = new Map();
  for (const root of roots) {
    const base = join(repoRoot, root);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(base, entry.name, 'package.json');
      if (existsSync(manifest)) saved.set(manifest, readFileSync(manifest));
    }
  }
  return saved;
}

/**
 * Snapshot now; return an idempotent `restore()`. Also arms exit/signal hooks.
 *
 * @param {string} repoRoot
 * @param {string[]} roots workspace root dirs, e.g. `['apps', 'packages']`
 * @returns {() => void} restore
 */
export function guardManifests(repoRoot, roots) {
  const saved = snapshot(repoRoot, roots);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const [path, data] of saved) {
      try {
        writeFileSync(path, data);
      } catch {
        // keep restoring the rest
      }
    }
  };
  process.on('exit', restore);
  for (const [sig, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    process.once(sig, () => {
      restore();
      process.exit(code);
    });
  }
  return restore;
}

/** Run `fn`, restoring the manifests afterwards on success OR failure. */
export async function withManifestsRestored(repoRoot, roots, fn) {
  const restore = guardManifests(repoRoot, roots);
  try {
    return await fn();
  } finally {
    restore();
  }
}
