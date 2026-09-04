/**
 * shipped-runner.ts — deploy the REAL published shape into a throwaway runner,
 * and prove it is the local one (T6a).
 *
 * Both SIGTERM e2es need the same thing: `@getknext/core` + its two workspace
 * dependencies installed the way a consumer of the published packages resolves
 * them (flat npm layout, prod deps present), outside the workspace so nothing
 * can escape upward into the repo's `node_modules`. That block used to be
 * copy-pasted into both specs, which is why the same three defects existed
 * twice:
 *
 *   1. IT PROVED PRESENCE, NOT PROVENANCE. `bun pm pack` rewrites `workspace:^`
 *      to a concrete range. When a changeset bumps `core` but not `lib`, that
 *      range may not be satisfiable by the LOCAL lib tarball — and npm quietly
 *      resolves the PUBLISHED `@getknext/lib` instead. The old assertion only
 *      checked that `node-server.js`, `prom-client` and `pino` existed, all of
 *      which they still do. So a fail-closed runtime-hardening gate could go
 *      green having exercised the shipped supervisor against a stale published
 *      dependency. {@link installShippedPackages} now reads each installed
 *      `package.json`'s version and requires it to EQUAL the workspace version.
 *   2. IT RAN INSTALL SCRIPTS. npm executes lifecycle scripts for the whole
 *      closure by default. `--ignore-scripts` removes that from a gate that
 *      runs on every PR. (The install still reaches the registry for `core`'s
 *      prod deps — that is a separate, larger fix, and it is not made worse
 *      here.)
 *   3. IT LEAKED TEMP DIRS. The cleanup loop sat below the `throw` for a failed
 *      pack, so the dirs created before the failure survived. Now `try/finally`,
 *      the shape already applied to `uploadAssets`.
 *
 * `spawn` is injected so `shipped-runner.test.ts` can drive all of the above
 * without packing anything; production callers pass nothing and get `spawnSync`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The three packages, in dependency order. `core` depends on `lib` and `db`, so
 * all three ship or npm 404s the missing member — the same reason
 * `install-smoke.mjs` packs all three.
 */
export const SHIPPED_PACKAGE_DIRS = Object.freeze([
  'packages/lib',
  'packages/db',
  'packages/kn-next',
] as const);

export interface SpawnResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type SpawnFn = (
  cmd: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv },
) => SpawnResult;

const realSpawn: SpawnFn = (cmd, args, options) => {
  const r = spawnSync(cmd, [...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

function readManifest(file: string): { name?: string; version?: string } {
  return JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
}

export interface InstallShippedOptions {
  readonly repoRoot: string;
  readonly runnerRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Where the throwaway pack dirs are created. Defaults to the OS tmpdir. */
  readonly packTmpRoot?: string;
  readonly spawn?: SpawnFn;
}

/**
 * Pack the three workspace packages and install them into `runnerRoot`.
 *
 * Throws — never warns, never returns a status — on a failed pack, a failed
 * install, a missing runtime file, or an installed `@getknext/*` whose version
 * is not the workspace's.
 */
export function installShippedPackages(options: InstallShippedOptions): void {
  const { repoRoot, runnerRoot, env, spawn = realSpawn } = options;
  // Named `…TmpRoot` deliberately: the #880 guard scans the mkdtemp ARGUMENT
  // and accepts a temp-rooted alias, because it cannot see that a hoisted
  // constant is itself `tmpdir()`. The alias is the honest description here —
  // the default IS `tmpdir()`, and the only caller that overrides it passes a
  // `mkdtempSync(join(tmpdir(), …))` path.
  const packTmpRoot = options.packTmpRoot ?? tmpdir();
  const packDirs: string[] = [];
  const tarballs: string[] = [];
  /** `@getknext/lib` → the version the WORKSPACE holds right now. */
  const workspaceVersions = new Map<string, string>();

  try {
    for (const pkg of SHIPPED_PACKAGE_DIRS) {
      const manifest = readManifest(join(repoRoot, pkg, 'package.json'));
      if (!manifest.name || !manifest.version) {
        throw new Error(`${pkg}/package.json has no name/version`);
      }
      workspaceVersions.set(manifest.name, manifest.version);

      // `bun pm pack`, NOT `npm pack`: core depends on lib/db via `workspace:^`,
      // which npm leaves verbatim (the install then dies with
      // EUNSUPPORTEDPROTOCOL) while bun rewrites it to a real version — the same
      // reason install-smoke.mjs packs with bun.
      const dest = mkdtempSync(join(packTmpRoot, 'knext-core-pack-'));
      packDirs.push(dest);
      const packed = spawn('bun', ['pm', 'pack', '--destination', dest], {
        cwd: join(repoRoot, pkg),
        env,
      });
      const tgz = readdirSync(dest)
        .filter((f) => f.endsWith('.tgz'))
        .map((f) => join(dest, f))
        .sort()
        .at(-1);
      if (packed.status !== 0 || !tgz) {
        throw new Error(`bun pm pack failed for ${pkg}. stderr:\n${packed.stderr}`);
      }
      tarballs.push(tgz);
    }

    const inst = spawn(
      'npm',
      // `--ignore-scripts`: this gate runs on every PR, and there is no reason
      // for a lifecycle script from anywhere in the closure to execute in it.
      ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs],
      { cwd: runnerRoot, env },
    );
    if (
      inst.status !== 0 ||
      !existsSync(join(runnerRoot, 'node_modules/@getknext/core/dist/adapters/node-server.js')) ||
      !existsSync(join(runnerRoot, 'node_modules/prom-client')) ||
      !existsSync(join(runnerRoot, 'node_modules/pino'))
    ) {
      throw new Error(
        'npm install of the packed @getknext/* tarballs did not produce a runnable ' +
          `@getknext/core (node-server.js + prom-client + pino). stderr:\n${inst.stderr}`,
      );
    }

    // PROVENANCE. Everything above is satisfied by a published tarball too.
    for (const [name, expected] of workspaceVersions) {
      const installed = join(runnerRoot, 'node_modules', ...name.split('/'), 'package.json');
      if (!existsSync(installed)) {
        throw new Error(
          `${name} is not installed in the runner at all — the packed tarball did not ` +
            'land, so whatever the e2e proves, it is not the shipped closure.',
        );
      }
      const actual = readManifest(installed).version;
      if (actual !== expected) {
        throw new Error(
          `${name} in the runner is ${actual}, but this workspace holds ${expected}.\n` +
            '  npm resolved the PUBLISHED package instead of the local tarball — most likely a\n' +
            "  changeset bumped one package's version and not the range `bun pm pack` rewrote.\n" +
            '  The e2e would otherwise have gone green against a stale published dependency.',
        );
      }
    }
  } finally {
    // `finally`, not after the throws: a pack that fails on the third package
    // used to leak the two dirs created before it.
    for (const d of packDirs) rmSync(d, { recursive: true, force: true });
  }
}
