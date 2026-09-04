/**
 * bun-app-closure.mjs — resolve ONE app's transitive production closure out of a
 * bun workspace install, and project a workspace-wide SBOM onto it (C1, #785).
 *
 * WHY THIS EXISTS, and why `precompile-closure.mjs`'s tree walk is not enough.
 *
 * ADR-0042 C6 gates the vinext path on an SBOM + HIGH/CRITICAL scan of the
 * PRE-COMPILE closure, because `bun build --compile` produces a binary that syft
 * and Trivy cannot read. That gate shipped scoped to `examples/bun-exec`, which
 * is its own install root: `bun install` there yields a plain `node_modules` and
 * `syft scan dir:` sees everything.
 *
 * `apps/file-manager` — the app `supply-chain.yml` builds, pushes to GHCR and
 * cosign-attests — is not like that. It is a WORKSPACE member, and bun installs
 * the workspace into an ISOLATED store:
 *
 *   apps/file-manager/node_modules/next
 *     -> ../../../node_modules/.bun/next@16.2.11+03abd7c11e755afe/node_modules/next
 *
 * and `next`'s own dependencies are SIBLINGS of it inside that
 * `next@…/node_modules` directory, not children of it. Three measurements on the
 * real tree (2026-09-04), each stated as what it counts:
 *
 *   - `installedPackages('apps/file-manager/node_modules')` → 56 packages. Below
 *     the gate's floor of 100, and not the transitive closure at all.
 *   - `syft scan dir:apps/file-manager/node_modules` → 0 npm components. syft
 *     does not follow symlinks that escape the scan root.
 *   - `syft scan dir:node_modules` (workspace root) → 2064 npm components and
 *     all six toolchain anchors — but it is the WHOLE workspace. grype over it
 *     reports 90 HIGH/CRITICAL, dominated by Go binaries vendored inside dev
 *     CLIs and by test-only packages (vitest, happy-dom) that are never compiled
 *     into the app binary. Gating the publish lane on that means ~40 allowlist
 *     entries for code that does not ship — an allowlist that large is how a
 *     gate becomes a rubber stamp.
 *
 * So: enumerate the app's own closure by following DECLARED dependency edges
 * through the store (`resolveAppClosure`), scan the workspace tree once with
 * syft, and keep only the components that closure contains
 * (`filterSbomToClosure`). Every package.json is read OFF DISK — nothing here
 * resolves versions from a lockfile — so C6's "the installed tree, not the
 * lockfile" property survives the projection.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM. The closure is the app's declared
 * dependency graph, which is a SUPERSET of what `vite build` actually bundles
 * (tree-shaking is not modelled) and a SUBSET of the builder image's filesystem
 * (the rest of the workspace's dev tooling is present at build time but is not
 * compiled in). It is the app's dependencies, resolved as installed — not "the
 * exact bytes inside the binary", which no tool can enumerate today.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Read a package.json, or null if it is absent/unparseable. */
function readPackageJson(dir) {
  const path = join(dir, 'package.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The `node_modules` directory a resolved package lives IN — one level up for
 * `foo`, two for `@scope/foo`. That directory is where bun puts the package's
 * own dependencies, so it is the resolution root for its edges.
 */
function containingNodeModules(realPath) {
  const one = dirname(realPath);
  if (basename(one) === 'node_modules') return one;
  const two = dirname(one);
  if (basename(two) === 'node_modules') return two;
  return null;
}

/** Resolve `name` from a `node_modules` dir, following symlinks. */
function resolveDependency(nodeModulesDir, name) {
  if (nodeModulesDir === null) return null;
  const candidate = join(nodeModulesDir, name);
  if (!existsSync(join(candidate, 'package.json'))) return null;
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

/**
 * The dependency edges a manifest declares, each flagged `optional` or not.
 *
 * `optionalDependencies` and `peerDependencies` are legitimately absent from an
 * install and MUST NOT be reported as unresolved — `esbuild` alone declares 25
 * per-platform optional deps, of which one is installed. Reporting those as
 * problems is how a real missing dependency gets lost in the noise.
 */
function declaredEdges(pkg, { includeDev }) {
  const edges = [];
  const add = (names, optional) => {
    for (const name of names) edges.push({ name, optional });
  };
  add(Object.keys(pkg?.dependencies ?? {}), false);
  add(Object.keys(pkg?.optionalDependencies ?? {}), true);
  add(Object.keys(pkg?.peerDependencies ?? {}), true);
  if (includeDev) add(Object.keys(pkg?.devDependencies ?? {}), false);
  return edges;
}

/**
 * Every package in `appDir`'s transitive closure, as `name@version` → real path.
 *
 * The app's own devDependencies are included by DEFAULT and that is deliberate:
 * for a vinext app the build toolchain (`vite`, `nitro`, `@vitejs/plugin-rsc`,
 * `react-server-dom-webpack`) is declared under `devDependencies` and its code
 * ends up inside the compiled server. Transitive packages contribute only their
 * runtime edges (`dependencies` / `optionalDependencies` / `peerDependencies`),
 * which is what npm resolution does and what keeps every dependency's own test
 * harness out of the scan.
 *
 * A missing `appDir` THROWS. Returning an empty closure would scan clean, and a
 * gate that answers "clean" when it was pointed at nothing is precisely the
 * vacuity ADR-0042 C6 exists to prevent.
 */
export function resolveAppClosure(appDir, { includeDev = true } = {}) {
  if (!existsSync(appDir) || !statSync(appDir).isDirectory()) {
    throw new Error(`app directory ${appDir} does not exist — nothing to resolve a closure from`);
  }
  const appPkg = readPackageJson(appDir);
  if (appPkg === null) {
    throw new Error(`${appDir} has no readable package.json — cannot resolve its closure`);
  }

  const packages = new Map();
  const unresolved = [];
  const seen = new Set();

  const queue = declaredEdges(appPkg, { includeDev }).map((edge) => ({
    ...edge,
    roots: [join(appDir, 'node_modules')],
    requestedBy: appPkg.name ?? appDir,
  }));

  while (queue.length > 0) {
    const { roots, name, optional, requestedBy } = queue.pop();
    // Nearest root wins, exactly as node resolution does; a miss is only a miss
    // when EVERY root fails, otherwise a package with a nested `node_modules`
    // would report a false miss for every dep it resolves from the store.
    let real = null;
    for (const root of roots) {
      real = resolveDependency(root, name);
      if (real !== null) break;
    }
    if (real === null) {
      if (!optional) unresolved.push(`${name} (required by ${requestedBy})`);
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);

    const pkg = readPackageJson(real);
    if (pkg?.name === undefined) continue;
    const id = `${pkg.name}@${pkg.version ?? '0.0.0'}`;
    packages.set(id, real);

    // Resolution roots for this package's OWN edges, nearest first: a nested
    // `node_modules` (a version conflict bun could not hoist), then the store
    // directory the package itself lives in, where bun puts its siblings.
    const nested = join(real, 'node_modules');
    const childRoots = [existsSync(nested) ? nested : null, containingNodeModules(real)].filter(
      (root) => root !== null,
    );
    if (childRoots.length === 0) continue;
    for (const edge of declaredEdges(pkg, { includeDev: false })) {
      queue.push({ ...edge, roots: childRoots, requestedBy: id });
    }
  }

  return { packages, unresolved };
}

/**
 * Keep only the npm components a closure contains.
 *
 * Non-npm components are dropped on purpose: the compiled artifact embeds
 * JavaScript, and the Go/rust binaries syft finds vendored inside dev CLIs are
 * neither in the closure nor in the image. (The one native artifact that DOES
 * ship — the sharp addon under `native/` — is a separate, known gap tracked as
 * C2; it is not covered by any SBOM, and pretending an npm SBOM covers it would
 * be the same false-assurance this whole change is removing.)
 *
 * `missing` is the coverage signal: closure members syft never catalogued. The
 * caller turns a non-trivial `missing` into a failure — a projection that keeps
 * three components out of six hundred must not read as a clean scan.
 */
export function filterSbomToClosure(sbom, closureKeys) {
  const components = sbom?.components ?? [];
  const kept = [];
  const present = new Set();
  for (const component of components) {
    if (typeof component?.purl !== 'string' || !component.purl.startsWith('pkg:npm/')) continue;
    const key = `${component.name}@${component.version}`;
    if (!closureKeys.has(key)) continue;
    kept.push(component);
    present.add(key);
  }
  const missing = [...closureKeys].filter((key) => !present.has(key)).sort();
  return { sbom: { ...sbom, components: kept }, kept, missing };
}
