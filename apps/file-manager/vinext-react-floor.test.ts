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
