#!/usr/bin/env node
/**
 * scripts/rename-for-ghp.mjs — stage the two publishable packages for the interim
 * GitHub Packages (npm.pkg.github.com) release channel.
 *
 * WHY THIS EXISTS
 * ---------------
 * The canonical future home for these packages is npmjs under the `@knext/*`
 * scope (see docs/RELEASING.md + .github/workflows/release.yml). That path is
 * blocked on a human NPM_TOKEN. As an interim channel (maintainer directive:
 * "use github packages for now until I make it public on npm") we also publish
 * to GitHub Packages — but GHP REQUIRES the package scope to match the owning
 * org (`getknext-dev`), and `publishConfig` CANNOT override a package name or a
 * dependency name. So we must physically rewrite `@knext/*` → `@getknext-dev/*`.
 *
 * THE DIST HAZARD (do not remove the loud-failure guard below)
 * ------------------------------------------------------------
 * `@knext/lib` is EXTERNALIZED in packages/kn-next/tsup.config.ts, so the
 * COMPILED output hardcodes `@knext/lib/...` import specifiers
 * (dist/adapters/node-server.js, dist/adapters/next-adapter.js, ...). Renaming
 * only package.json would publish an `@getknext-dev/core` whose runtime code
 * still imports the never-published `@knext/lib`. So we ALSO rewrite every
 * `@knext/` string occurrence inside staged dist files. If a future build
 * layout stops externalizing lib (zero occurrences), this script FAILS LOUDLY
 * rather than silently shipping a broken or mis-renamed package.
 *
 * SAFETY: this script NEVER mutates the working tree. It copies the publish-
 * relevant files (package.json, dist/, LICENSE, README*) into a staging dir and
 * rewrites the COPIES. The release workflow then `npm publish`es from staging.
 *
 * The pure helpers (`rewriteScopeString`, `rewriteManifest`, `stageForGhp`) are
 * unit-tested in tests/rename-for-ghp.test.ts.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The old (npmjs, canonical) scope prefix and the interim GHP org scope. */
export const OLD_SCOPE = '@knext/';
export const NEW_SCOPE = '@getknext-dev/';
/** GitHub Packages npm registry. */
export const GHP_REGISTRY = 'https://npm.pkg.github.com';

/** dist file extensions whose contents may contain a hardcoded `@knext/` import. */
const REWRITABLE_DIST_SUFFIXES = ['.js', '.cjs', '.mjs', '.d.ts', '.d.cts', '.d.mts', '.map'];

/** The publish set. `requireDistRewrites` guards the externalization hazard. */
export const DEFAULT_PACKAGES = [
  { name: '@knext/lib', dir: 'packages/lib', requireDistRewrites: false },
  { name: '@knext/core', dir: 'packages/kn-next', requireDistRewrites: true },
];

/**
 * Replace every `@knext/` occurrence with `@getknext-dev/`.
 * @param {string} content
 * @returns {{ content: string, count: number }}
 */
export function rewriteScopeString(content) {
  const parts = content.split(OLD_SCOPE);
  return { content: parts.join(NEW_SCOPE), count: parts.length - 1 };
}

/**
 * Resolve a pnpm `workspace:` protocol specifier to a concrete semver range.
 * We publish from a staging dir OUTSIDE the pnpm workspace with `npm publish`,
 * which (unlike `pnpm publish`) does NOT rewrite `workspace:*` — so we must do it
 * here or the published manifest carries an uninstallable `workspace:^`.
 * @param {string} spec e.g. "workspace:^" / "workspace:~" / "workspace:*" / "workspace:1.2.3"
 * @param {string|undefined} version the target package's version
 */
function resolveWorkspaceSpec(spec, version) {
  if (typeof spec !== 'string' || !spec.startsWith('workspace:')) return spec;
  const range = spec.slice('workspace:'.length);
  if (!version) {
    throw new Error(`[rename-for-ghp] cannot resolve "${spec}" — target package version unknown.`);
  }
  if (range === '' || range === '*') return version;
  if (range === '^') return `^${version}`;
  if (range === '~') return `~${version}`;
  // Explicit range/version after the protocol (e.g. workspace:^1.2.3).
  return range;
}

/**
 * Rewrite the `@knext/*` keys of one dependency map (preserving version
 * specifiers) and resolve any `workspace:` specifier for in-repo packages using
 * `versionByName` (keyed by the ORIGINAL @knext/* name).
 */
function rewriteDepMap(deps, versionByName = {}) {
  if (!deps || typeof deps !== 'object') return { deps, rewritten: 0 };
  const out = {};
  let rewritten = 0;
  for (const [key, val] of Object.entries(deps)) {
    const isKnext = key.startsWith(OLD_SCOPE);
    const newKey = isKnext ? NEW_SCOPE + key.slice(OLD_SCOPE.length) : key;
    const resolved =
      typeof val === 'string' && val.startsWith('workspace:')
        ? resolveWorkspaceSpec(val, versionByName[key])
        : val;
    out[newKey] = resolved;
    if (isKnext) rewritten += 1;
  }
  return { deps: out, rewritten };
}

/**
 * Rewrite a parsed package.json manifest for the GHP channel (pure — returns a
 * new object): rename `name`, rewrite inter-package dep keys, strip
 * `publishConfig.provenance` (GHP has no OIDC), and pin `publishConfig.registry`.
 * @param {Record<string, any>} manifest
 * @returns {Record<string, any>}
 */
export function rewriteManifest(manifest, versionByName = {}) {
  const out = { ...manifest };

  if (typeof out.name === 'string' && out.name.startsWith(OLD_SCOPE)) {
    out.name = NEW_SCOPE + out.name.slice(OLD_SCOPE.length);
  }

  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    if (out[field]) {
      out[field] = rewriteDepMap(out[field], versionByName).deps;
    }
  }

  // Strip provenance (fails outside npmjs/OIDC) and point publish at GHP.
  const publishConfig = { ...(out.publishConfig ?? {}) };
  delete publishConfig.provenance;
  publishConfig.registry = GHP_REGISTRY;
  out.publishConfig = publishConfig;

  return out;
}

/** Recursively list every file under `dir` (absolute paths). */
function walkFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walkFiles(full));
    } else {
      found.push(full);
    }
  }
  return found;
}

function isRewritableDistFile(path) {
  return REWRITABLE_DIST_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

/**
 * Stage one package for GHP: copy publish-relevant files into `stagingDir`, then
 * rewrite the copies. Returns a per-package report.
 */
function stagePackage(pkg, rootDir, stagingRoot, versionByName) {
  const srcDir = join(rootDir, pkg.dir);
  const shortName = basename(pkg.name); // 'lib' | 'core'
  const stagingDir = join(stagingRoot, shortName);

  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  // 1. Manifest.
  const srcManifestPath = join(srcDir, 'package.json');
  const manifest = JSON.parse(readFileSync(srcManifestPath, 'utf8'));
  const renamed = rewriteManifest(manifest, versionByName);
  writeFileSync(join(stagingDir, 'package.json'), `${JSON.stringify(renamed, null, 2)}\n`);

  // 2. dist/ (the runtime output). Fatal if absent — nothing to publish.
  const srcDist = join(srcDir, 'dist');
  if (!existsSync(srcDist)) {
    throw new Error(
      `[rename-for-ghp] ${pkg.name}: dist/ not found at ${srcDist} — build the package before staging.`,
    );
  }
  const stagedDist = join(stagingDir, 'dist');
  cpSync(srcDist, stagedDist, { recursive: true });

  // 3. LICENSE + README (best-effort — copy whatever variants exist).
  for (const name of ['LICENSE', 'LICENSE.md', 'README', 'README.md']) {
    const from = join(srcDir, name);
    if (existsSync(from)) cpSync(from, join(stagingDir, name));
  }

  // 4. Rewrite hardcoded @knext/ import strings inside staged dist files.
  let distOccurrences = 0;
  let distFilesRewritten = 0;
  for (const file of walkFiles(stagedDist)) {
    if (!isRewritableDistFile(file)) continue;
    const original = readFileSync(file, 'utf8');
    const { content, count } = rewriteScopeString(original);
    if (count > 0) {
      writeFileSync(file, content);
      distOccurrences += count;
      distFilesRewritten += 1;
    }
  }

  // 5. Loud guard: core externalizes @knext/lib, so its dist MUST contain
  // occurrences. Zero means the build layout changed and this script is silently
  // obsolete — refuse to ship a possibly-broken package.
  if (pkg.requireDistRewrites && distOccurrences === 0) {
    throw new Error(
      `[rename-for-ghp] ${pkg.name}: found ZERO ${OLD_SCOPE} occurrences in dist/ to rewrite. ` +
        `This package externalizes ${OLD_SCOPE}lib in its build, so its compiled output MUST ` +
        `hardcode ${OLD_SCOPE}lib imports. Zero occurrences means the externalization layout ` +
        `changed and this script is out of date — publishing now would ship a broken package. ` +
        `Aborting.`,
    );
  }

  return {
    name: pkg.name,
    newName: renamed.name,
    stagingDir,
    distFilesRewritten,
    distOccurrences,
    provenanceStripped: manifest.publishConfig?.provenance === true,
  };
}

/**
 * Stage all packages for the GHP channel.
 * @param {{ rootDir: string, stagingRoot: string, packages?: typeof DEFAULT_PACKAGES }} opts
 * @returns {{ stagingRoot: string, order: string[], staged: Record<string, object> }}
 */
export function stageForGhp({ rootDir, stagingRoot, packages = DEFAULT_PACKAGES }) {
  mkdirSync(stagingRoot, { recursive: true });

  // Collect in-repo versions first so `workspace:` deps can be resolved to a
  // concrete range (keyed by the ORIGINAL @knext/* name).
  const versionByName = {};
  for (const pkg of packages) {
    const manifest = JSON.parse(readFileSync(join(rootDir, pkg.dir, 'package.json'), 'utf8'));
    versionByName[pkg.name] = manifest.version;
  }

  const staged = {};
  const order = [];
  for (const pkg of packages) {
    staged[pkg.name] = stagePackage(pkg, rootDir, stagingRoot, versionByName);
    order.push(pkg.name);
  }
  return { stagingRoot, order, staged };
}

// ---------------------------------------------------------------------------
// CLI entry: stage into <repoRoot>/.ghp-staging and print a machine-readable
// report the release-ghp.yml workflow consumes (it publishes from each
// staging dir, lib before core).
// ---------------------------------------------------------------------------
function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const rootDir = join(here, '..');
  const stagingRoot = process.env.GHP_STAGING_DIR
    ? process.env.GHP_STAGING_DIR
    : join(rootDir, '.ghp-staging');

  rmSync(stagingRoot, { recursive: true, force: true });
  const report = stageForGhp({ rootDir, stagingRoot });

  for (const name of report.order) {
    const r = report.staged[name];
    console.log(
      `[rename-for-ghp] staged ${r.name} → ${r.newName} at ${r.stagingDir} ` +
        `(dist rewrites: ${r.distOccurrences} occurrence(s) in ${r.distFilesRewritten} file(s))`,
    );
  }
  // Emit the ordered staging dirs so the workflow can publish lib then core.
  const stagingDirs = report.order.map((name) => report.staged[name].stagingDir);
  writeFileSync(
    join(stagingRoot, 'staging-order.json'),
    `${JSON.stringify(stagingDirs, null, 2)}\n`,
  );
  console.log(`[rename-for-ghp] publish order: ${stagingDirs.join(' , ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
}
