/**
 * scripts/lib/knext-closure.mjs — pure helpers for the dependency-graph-derived
 * adapter-tarball set (#255/#256 hardening; shared by scripts/e2e-preflight.mjs).
 *
 * WHY NOT A HARDCODED LIST: `pnpm pack` rewrites `workspace:^` → `^x.y.z`, so a
 * FUTURE @knext/* workspace dep added to @knext/core never trips a
 * workspace:-spec check — the packed manifest looks perfectly publishable. And
 * because the @knext scope is not ours on npmjs yet (#53), the scratch install
 * only fails loudly while that name is UNPUBLISHED; a squatted @knext/x would
 * make the preflight pass silently WITH FOREIGN CODE (dependency confusion).
 * Two guards close that:
 *   1. derive the required tarball set from the @knext/* dependency closure of
 *      @knext/core (walking the packed manifests) — a member without a local
 *      tarball fails BEFORE any npm install runs;
 *   2. after the scratch install, assert every @knext/* entry in the lockfile
 *      resolved from a LOCAL tarball (file:), never a registry URL.
 */

const KNEXT_SCOPE = '@knext/';

/** `@knext/db` → `knext-db` (the `pnpm pack` tarball filename prefix). */
export function tarballPrefix(name) {
  if (!name.startsWith('@')) return name;
  return name.slice(1).replace('/', '-');
}

/**
 * The @knext/* dependency names one INSTALL of `manifest` pulls in:
 * `dependencies` + `optionalDependencies` + `peerDependencies` (npm ≥7
 * auto-installs peers). `devDependencies` are excluded — they never install
 * from a packed tarball.
 * @param {Record<string, any>} manifest parsed package.json
 * @returns {string[]}
 */
export function knextDepsOf(manifest) {
  const names = new Set();
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const key of Object.keys(manifest?.[field] ?? {})) {
      if (key.startsWith(KNEXT_SCOPE)) names.add(key);
    }
  }
  return [...names];
}

/**
 * Verify every @knext/* package in a scratch-install lockfile (npm
 * package-lock.json, lockfileVersion 3 layout) resolved from a LOCAL tarball
 * and belongs to the derived closure. Returns `{ problems: string[] }` —
 * empty means clean.
 * @param {{ packages?: Record<string, { resolved?: string, version?: string }> }} lockfile
 * @param {Set<string>} allowedNames the derived @knext/* closure (including the root)
 */
export function assertLocalKnextResolutions(lockfile, allowedNames) {
  const problems = [];
  const packages = lockfile?.packages ?? {};
  for (const [path, entry] of Object.entries(packages)) {
    // The installed package name is the segment after the LAST `node_modules/`
    // (nested paths like `node_modules/@knext/lib/node_modules/pino` are pino,
    // not an @knext package).
    const name = path.split('node_modules/').pop() ?? '';
    if (!name.startsWith(KNEXT_SCOPE)) continue;
    if (!allowedNames.has(name)) {
      problems.push(
        `${name}@${entry?.version ?? '?'} appeared in the scratch install but is NOT in the ` +
          `@knext/* dependency closure derived from the packed tarballs — an unexpected ` +
          `(possibly registry-squatted) package`,
      );
      continue;
    }
    const resolved = entry?.resolved;
    if (typeof resolved === 'string' && /^https?:\/\//i.test(resolved)) {
      problems.push(
        `${name}@${entry?.version ?? '?'} resolved from a REGISTRY URL (${resolved}) instead of ` +
          `the local tarball — the @knext scope is unclaimed on npmjs (#53), so this is ` +
          `dependency confusion, not a valid install`,
      );
    }
  }
  return { problems };
}
