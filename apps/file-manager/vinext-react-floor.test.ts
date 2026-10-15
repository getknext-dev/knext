import { describe, expect, it } from 'bun:test';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * vinext's build checks the app's React before it starts, and when it is below
 * the version vinext needs it runs `<package manager> add react@latest
 * react-dom@latest` IN THE MIDDLE OF THE BUILD. The build then resolves React
 * from two installs, and the server bundle carries TWO copies of the RSC
 * renderer. Pages still render, but the first `'use cache'` entry serialised
 * after a page render throws "Currently React only supports one RSC renderer at
 * a time" -- `/api/files/stats` answered 503 on every request after `/setup`.
 *
 * So the app's declared AND installed React must already satisfy vinext, which
 * this checks with vinext's own function (the one its build calls): an empty
 * upgrade list means the build will not touch the install.
 */

const APP = import.meta.dir;
const VINEXT = dirname(dirname(realpathSync(join(APP, 'node_modules/vinext/dist/index.js'))));

type Upgrade = (root: string, options?: { fromManifest?: boolean }) => string[];
const { getReactUpgradeDeps } = (await import(
  pathToFileURL(join(VINEXT, 'dist/utils/react-version.js')).href
)) as { getReactUpgradeDeps: Upgrade };

describe("file-manager's React satisfies vinext, so the build never upgrades it mid-build", () => {
  it('the declared react / react-dom ranges are at or above vinext minimum', () => {
    expect(getReactUpgradeDeps(APP, { fromManifest: true })).toEqual([]);
  });

  it('the INSTALLED react (what the lockfile resolved) is at or above vinext minimum', () => {
    expect(getReactUpgradeDeps(APP)).toEqual([]);
  });
});

/**
 * React and the RSC renderer vinext uses (`react-server-dom-webpack`) ship in
 * lockstep: a renderer from one React minor running against `react` from
 * another is an unsupported pairing. A caret range on react let the workspace
 * hoist react to the next minor while the renderer stayed behind, so every
 * resolution of react / react-dom / react-server-dom-webpack in the lockfile --
 * hoisted or nested under a workspace -- must share one major.minor.
 */
const LOCK = await Bun.file(join(APP, '../../bun.lock')).text();
const REACT_PKGS = ['react', 'react-dom', 'react-server-dom-webpack'];

function resolvedReactVersions(lock: string): Map<string, string[]> {
  const byPkg = new Map<string, string[]>(REACT_PKGS.map((p) => [p, []]));
  // A packages entry: `    "<path/>name": ["name@version", ...`
  const entry = /^ {4}"(?:[^"]*\/)?([^"/]+)": \["([^"@]+)@(\d+\.\d+\.\d+[^"]*)"/gm;
  for (const [, key, name, version] of lock.matchAll(entry)) {
    if (key === name) byPkg.get(name)?.push(version);
  }
  return byPkg;
}

const minorOf = (v: string) => v.split('.').slice(0, 2).join('.');

describe('react, react-dom and the RSC renderer resolve to one React minor in bun.lock', () => {
  const resolved = resolvedReactVersions(LOCK);

  it('the lockfile resolves each of react, react-dom and react-server-dom-webpack', () => {
    for (const pkg of REACT_PKGS) expect(resolved.get(pkg)?.length ?? 0).toBeGreaterThan(0);
  });

  it('every resolution shares a single major.minor', () => {
    const minors = new Set([...resolved.values()].flat().map(minorOf));
    expect([...minors]).toHaveLength(1);
  });
});

/**
 * Some lanes stage file-manager outside the repo and install WITHOUT the
 * lockfile, so the declared ranges alone decide the versions. If any of the
 * three may float to a newer minor than the others, a fresh install picks e.g.
 * react-server-dom-webpack 19.3.x (peer react ^19.3) next to react 19.2.x and
 * npm refuses with ERESOLVE. So each must be pinned (exact or `~`) to the same
 * major.minor.
 */
const MANIFEST = (await Bun.file(join(APP, 'package.json')).json()) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe("file-manager's declared React ranges cannot drift apart on a lockfile-less install", () => {
  const declared: Record<string, string> = {
    ...MANIFEST.dependencies,
    ...MANIFEST.devDependencies,
  };

  it('react, react-dom and react-server-dom-webpack are each pinned to one minor (exact or ~)', () => {
    const pinnedMinors = REACT_PKGS.map((pkg) => {
      const m = /^~?(\d+\.\d+)\.\d+$/.exec(declared[pkg] ?? '');
      return m ? m[1] : `${pkg}: unpinned ${declared[pkg] ?? '(missing)'}`;
    });
    expect(new Set(pinnedMinors).size).toBe(1);
    expect(pinnedMinors[0]).toMatch(/^\d+\.\d+$/);
  });
});
