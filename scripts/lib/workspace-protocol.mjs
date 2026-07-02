/**
 * scripts/lib/workspace-protocol.mjs — shared pure guard (#147 A3-3 fix round 1).
 *
 * WHY THIS EXISTS: baseline compat run 28558576615 burned 16 shards because the
 * packed @knext/core tarball still carried pnpm's raw `workspace:^` dep on
 * @knext/lib (`npm pack` does NOT rewrite the workspace protocol — only
 * `pnpm pack` / `pnpm publish` do). npm then fails any install of that tarball
 * with EUNSUPPORTEDPROTOCOL. This helper lets both gates (install-smoke and the
 * compat preflight) inspect a packed manifest and NAME the leak directly,
 * instead of surfacing it as a downstream npm error 472 tests deep.
 */

/** The manifest fields npm resolves specs from. */
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/**
 * Find every dependency whose spec uses the pnpm `workspace:` protocol.
 * @param {Record<string, unknown>} manifest a parsed package.json object
 * @returns {Array<{field: string, name: string, spec: string}>}
 */
export function findWorkspaceProtocolDeps(manifest) {
  const hits = [];
  for (const field of DEP_FIELDS) {
    const deps = manifest?.[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === 'string' && spec.startsWith('workspace:')) {
        hits.push({ field, name, spec });
      }
    }
  }
  return hits;
}
