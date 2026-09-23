/**
 * The vinext-axis compat lane's toolchain install must satisfy EVERY peer that
 * vinext declares — not just react.
 *
 * ## The defects this guards
 *
 * ### First edge (compat run 34030824905: 310 passed / 468 failed)
 *
 * Every failure was the identical `npm ERESOLVE`:
 *
 *   peer react@"^19.2.6" from vinext@1.0.0-beta.9
 *   Found: react@19.2.4
 *
 * `scripts/e2e-deploy-vinext.sh` pinned `react-server-dom-webpack@19.2.6` but not
 * `react`/`react-dom`; each corpus fixture pulls `react@19.2.4` transitively via
 * `next@16.2`, which does not satisfy vinext-beta.9's `react@^19.2.6` peer, so
 * `npm install` aborts before the fixture ever builds.
 *
 * ### Second edge (hidden behind the first)
 *
 * npm reports only ONE conflict edge at a time, so fixing the react family only
 * uncovered the next: the script pinned `@vitejs/plugin-rsc@0.5.26`, but
 * vinext-beta.9 declares `@vitejs/plugin-rsc@^0.5.34`. That peer is `optional`,
 * but because the toolchain install pulls the package EXPLICITLY, npm enforces
 * the range anyway — so every fixture install still hard-failed on plugin-rsc.
 * Verified out-of-band: with `@vitejs/plugin-rsc@0.5.34` the full toolchain
 * install resolves cleanly (178 packages, `npm install --dry-run` exit 0); with
 * 0.5.26 it exits 1 on the plugin-rsc `peerOptional` conflict.
 *
 * ## Why pins, not `--legacy-peer-deps`
 *
 * `--legacy-peer-deps`/`--force` would make the ERESOLVE go away while leaving a
 * REAL version skew between vinext's compiled transforms and the app's packages —
 * a latent correctness hazard the lane exists to surface honestly. Pinning each
 * peer at a version inside vinext's declared range keeps the toolchain coherent.
 *
 * ## What this guard asserts
 *
 * The single toolchain `npm install` must pin EVERY package that is also a vinext
 * peer at a version that SATISFIES vinext-beta.9's declared peer range. This is
 * the real success condition — a future peer bump the script does not follow (as
 * plugin-rsc's `^0.5.34` was not) reds the guard, not just react drift. Plus the
 * React family stays coherent (all three move together) and the install never
 * falls back to `--legacy-peer-deps`/`--force`.
 *
 * vinext's peer ranges are hardcoded below because `vinext` is not resolvable in
 * the unit test env. They are keyed to `VINEXT_VERSION`; the guard fails if the
 * script's pinned vinext version drifts from the version these ranges describe,
 * forcing a maintainer to re-read the peers when vinext bumps.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_SCRIPT = 'scripts/e2e-deploy-vinext.sh';

/**
 * vinext@1.0.0-beta.11's declared `peerDependencies` (from `npm view vinext@…`),
 * restricted to the packages `e2e-deploy-vinext.sh` installs. When VINEXT_VERSION
 * bumps, re-run `npm view vinext@<v> peerDependencies` and update BOTH the ranges
 * and PEER_VINEXT_VERSION below.
 *
 * Re-verified for beta.11 (#1309): the ranges below are UNCHANGED from beta.9 —
 * `npm view vinext@1.0.0-beta.11 peerDependencies` returns the identical set.
 */
const PEER_VINEXT_VERSION = '1.0.0-beta.11';
const VINEXT_PEER_RANGES: Record<string, string> = {
  vite: '^8.0.0',
  react: '^19.2.6',
  'react-dom': '^19.2.6',
  '@vitejs/plugin-rsc': '^0.5.34',
  'react-server-dom-webpack': '^19.2.6',
};

/**
 * The scss/sass fixtures ship `sass@1.54.0` (Next.js's own pin), but the vinext
 * toolchain's `vite@8.2.2` declares `peerOptional sass@^1.70.0`. 1.54.0 does NOT
 * satisfy `^1.70.0`, so the toolchain `npm install` aborts with
 * `npm error Conflicting peer dependency: sass` (ERESOLVE) before the fixture
 * builds — reddening every `app-dir/scss` fixture (29 in the v16.2.0 window) as an
 * INSTALL artifact, not a real vinext SCSS incompatibility. The lane must pin
 * `sass` at a version satisfying BOTH `next@16.2`'s `^1.3.0` and `vite@8`'s
 * `^1.70.0` peers. Same class as the react/plugin-rsc edges above; evidence in
 * compat run 34434002596 shard logs (`peerOptional sass@"^1.70.0" from vite@8.2.2`).
 */
const SASS_PEER_RANGES: Record<string, string> = {
  next: '^1.3.0',
  vite: '^1.70.0',
};

/** Script body with full-line comments removed — a prose mention in the header
 *  must not satisfy an assertion about the executable install command. */
function code(): string {
  return readFileSync(resolve(repoRoot, DEPLOY_SCRIPT), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * Defaults of `VAR="${ENV:-default}"` shell assignments, so a `"pkg@${VAR}"`
 * token in the install command can be resolved to the concrete pinned version.
 */
function shellVarDefaults(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of code().split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)="\$\{[A-Za-z0-9_]+:-([^}]+)\}"/);
    if (m) vars[m[1] as string] = m[2] as string;
  }
  return vars;
}

/**
 * The single `npm install` invocation that pulls the vinext toolchain, as one
 * logical line (backslash-newline continuations folded). Selected by the vinext
 * package it installs, so an unrelated `npm install` elsewhere cannot match.
 */
function toolchainInstall(): string {
  const folded = code().replace(/\\\n/g, ' ');
  const lines = folded
    .split('\n')
    .filter((l) => /\bnpm\s+i(nstall)?\b/.test(l) && /vinext@/.test(l));
  if (lines.length !== 1) {
    throw new Error(`expected exactly one vinext toolchain npm install, found ${lines.length}`);
  }
  return lines[0] as string;
}

/** The raw `<pkg>@<spec>` right-hand side in the install command (may be a
 *  `${VAR}` reference or a literal version). */
function pinnedSpec(install: string, pkg: string): string | undefined {
  // Anchored on a word boundary so `react@` does not match inside `react-dom@`
  // or `react-server-dom-webpack@`.
  const re = new RegExp(`(?:^|[\\s"'])${pkg.replace(/[-/@.]/g, '\\$&')}@([^\\s"']+)`);
  return install.match(re)?.[1];
}

/** Resolve a spec token to a concrete version, dereferencing `${VAR}`. */
function resolvePin(spec: string | undefined, vars: Record<string, string>): string | undefined {
  if (!spec) return undefined;
  const varMatch = spec.match(/^\$\{([A-Za-z0-9_]+)\}$/);
  return varMatch ? vars[varMatch[1] as string] : spec;
}

/** The concrete pinned version of `pkg` in the toolchain install. */
function pinnedVersion(pkg: string): string | undefined {
  return resolvePin(pinnedSpec(toolchainInstall(), pkg), shellVarDefaults());
}

/**
 * Minimal caret-range satisfaction for exact versions — sufficient because every
 * vinext peer range is a caret range and every script pin is an exact version.
 *   ^1.2.3 -> >=1.2.3 <2.0.0
 *   ^0.5.34 -> >=0.5.34 <0.6.0   (0.x locks the minor)
 *   ^0.0.3 -> >=0.0.3 <0.0.4     (0.0.x locks the patch)
 */
function caretSatisfies(version: string, range: string): boolean {
  const caret = range.match(/^\^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/);
  const ver = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/);
  if (!caret || !ver) return false;
  const [, cMaj, cMin, cPat] = caret.map(Number) as unknown as number[];
  const [, vMaj, vMin, vPat] = ver.map(Number) as unknown as number[];

  const cmp = (a: number, b: number) => a - b;
  // lower bound: version >= caret base
  const geBase =
    cmp(vMaj, cMaj) > 0 ||
    (vMaj === cMaj && (cmp(vMin, cMin) > 0 || (vMin === cMin && cmp(vPat, cPat) >= 0)));
  if (!geBase) return false;

  // upper bound depends on the left-most non-zero component of the caret base
  if (cMaj > 0) return vMaj === cMaj;
  if (cMin > 0) return vMaj === 0 && vMin === cMin;
  return vMaj === 0 && vMin === 0 && vPat === cPat;
}

describe('the vinext toolchain install satisfies every vinext peer', () => {
  it('pins vinext at the version these peer ranges were read from', () => {
    // If vinext bumps, the hardcoded VINEXT_PEER_RANGES may be stale — force a
    // re-read rather than silently validating pins against an old range set.
    expect(
      pinnedVersion('vinext'),
      `VINEXT_VERSION in ${DEPLOY_SCRIPT} != ${PEER_VINEXT_VERSION}: re-run ` +
        '`npm view vinext@<v> peerDependencies` and update VINEXT_PEER_RANGES',
    ).toBe(PEER_VINEXT_VERSION);
  });

  it('pins every vinext peer it installs at a version satisfying vinext’s range', () => {
    for (const [pkg, range] of Object.entries(VINEXT_PEER_RANGES)) {
      const version = pinnedVersion(pkg);
      expect(version, `${pkg} is not pinned in the toolchain install`).toBeDefined();
      expect(
        caretSatisfies(version as string, range),
        `${pkg}@${version} does NOT satisfy vinext-beta.9's peer ${pkg}@"${range}" — ` +
          'npm ERESOLVE will abort every fixture install before it can build',
      ).toBe(true);
    }
  });

  it('pins react and react-dom in the toolchain install (not left transitive)', () => {
    expect(
      pinnedVersion('react'),
      'react is unpinned — the corpus fixture pulls react@19.2.4 via next@16.2, ' +
        'which does not satisfy vinext-beta.9’s react@^19.2.6 peer',
    ).toBeDefined();
    expect(
      pinnedVersion('react-dom'),
      'react-dom is unpinned — the same ERESOLVE that kills the react peer kills react-dom',
    ).toBeDefined();
  });

  it('keeps the whole React family coherent at one version', () => {
    // A pin that leaves react and react-dom on DIFFERENT versions, or off the
    // version the RSC transform was built against, reintroduces the skew a plain
    // --legacy-peer-deps would. Assert all three move together.
    const rsd = pinnedVersion('react-server-dom-webpack');
    expect(pinnedVersion('react')).toEqual(rsd);
    expect(pinnedVersion('react-dom')).toEqual(rsd);
  });

  it('does not fall back to --legacy-peer-deps/--force to mask a skew', () => {
    // Either flag would make an ERESOLVE go away while leaving the real version
    // skew in place — an honesty regression for a lane whose point is an honest
    // number. If a future change adopts one, this test says so loudly.
    const install = toolchainInstall();
    expect(install).not.toContain('--legacy-peer-deps');
    expect(install).not.toContain('--force');
  });

  it('pins sass so the scss fixtures install (vite@8 peer sass@^1.70.0)', () => {
    // The scss fixtures ship sass@1.54.0; vite@8.2.2 needs sass@^1.70.0. Without
    // a lane pin, npm ERESOLVE aborts every scss fixture install before it builds.
    expect(
      pinnedVersion('sass'),
      'sass is unpinned — the app-dir/scss fixtures ship sass@1.54.0, which does ' +
        'not satisfy vite@8’s peerOptional sass@^1.70.0; npm ERESOLVE aborts every ' +
        'scss fixture install before it can build (29 fixtures in the v16.2.0 window)',
    ).toBeDefined();
  });

  it('pins sass at a version satisfying BOTH next and vite peer ranges', () => {
    const version = pinnedVersion('sass');
    for (const [pkg, range] of Object.entries(SASS_PEER_RANGES)) {
      expect(
        caretSatisfies(version as string, range),
        `sass@${version} does NOT satisfy ${pkg}’s peer sass@"${range}" — the ` +
          'scss fixture install will still ERESOLVE',
      ).toBe(true);
    }
  });

  it('pins @babel/plugin-transform-runtime on the 7.x line (the babel fixture ERESOLVE)', () => {
    // The `babel` fixture ships @babel/preset-flow@7.25.9, whose peer is
    // @babel/core@^7.0.0-0. The vinext toolchain's @vitejs/plugin-react →
    // @rolldown/plugin-babel chain pulls @babel/plugin-transform-runtime@8.0.1
    // (peer @babel/core@^8.0.0) as an optional peer, so npm cannot satisfy
    // @babel/core (7 vs 8) and every install aborts with `npm ERESOLVE`
    // (`Conflicting peer dependency: @babel/core@8.0.1`, compat run 34473981569
    // shard 12). @rolldown/plugin-babel@0.2.4's peerOptional range is
    // `^7.29.0 || ^8.0.0-rc.1`, so pinning transform-runtime on the 7.x line
    // satisfies rolldown AND aligns @babel/core@7 with preset-flow — same class
    // as the sass/plugin-rsc pins, NOT --legacy-peer-deps.
    const version = pinnedVersion('@babel/plugin-transform-runtime');
    expect(
      version,
      '@babel/plugin-transform-runtime is unpinned — the babel fixture ERESOLVEs on ' +
        'the @babel/core 7-vs-8 conflict before it can build',
    ).toBeDefined();
    expect(
      caretSatisfies(version as string, '^7.29.0'),
      `@babel/plugin-transform-runtime@${version} is not on the 7.x line satisfying ` +
        "@rolldown/plugin-babel's peer `^7.29.0` — the babel/core 7-vs-8 ERESOLVE returns",
    ).toBe(true);
  });

  it('pins a TypeScript loader (tsx/jiti) for postcss.config.ts fixtures', () => {
    // The `postcss-config-ts` fixture ships a `postcss.config.ts`; loading it
    // needs a TS loader or the build dies with `'tsx' or 'jiti' is required for
    // the TypeScript configuration files` (compat run 34473981569 shard 11).
    // The node lane never hits this — postcss under next resolves it — but the
    // vite toolchain has no TS loader unless the lane installs one.
    const tsx = pinnedVersion('tsx');
    const jiti = pinnedVersion('jiti');
    expect(
      tsx ?? jiti,
      'neither tsx nor jiti is pinned — postcss.config.ts fixtures fail to build with ' +
        "`'tsx' or 'jiti' is required for the TypeScript configuration files`",
    ).toBeDefined();
  });

  it('pins @mdx-js/rollup so mdx fixtures compile their .mdx modules', () => {
    // vinext does not bundle an MDX loader: an app with `.mdx` modules needs
    // @mdx-js/rollup registered in the vite config, or the build dies with
    // `[vinext] Encountered MDX module … but no MDX plugin is configured`
    // (compat run 34473981569 shard 11/12). The plugin is registered in the
    // generated vite.config.mjs (guarded in compat-vinext-lane.test.ts); it
    // must also be INSTALLED, or that import throws.
    expect(
      pinnedVersion('@mdx-js/rollup'),
      '@mdx-js/rollup is unpinned — the generated vite config imports it, so mdx ' +
        'fixtures (and any generated-config fixture) fail to build without it installed',
    ).toBeDefined();
  });

  it('sanity: the caret-satisfaction helper is not vacuously true', () => {
    // Guards the guard — if caretSatisfies always returned true the peer check
    // above would be decoration.
    expect(caretSatisfies('0.5.34', '^0.5.34')).toBe(true);
    expect(caretSatisfies('0.5.40', '^0.5.34')).toBe(true);
    expect(caretSatisfies('0.5.26', '^0.5.34')).toBe(false);
    expect(caretSatisfies('0.6.0', '^0.5.34')).toBe(false);
    expect(caretSatisfies('19.2.6', '^19.2.6')).toBe(true);
    expect(caretSatisfies('19.2.4', '^19.2.6')).toBe(false);
    expect(caretSatisfies('20.0.0', '^19.2.6')).toBe(false);
    expect(caretSatisfies('8.2.2', '^8.0.0')).toBe(true);
  });
});
