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
 *      dependency. {@link installShippedPackages} now reads npm's own record —
 *      `node_modules/.package-lock.json` — and requires each `@getknext/*` to
 *      have been RESOLVED FROM A `file:` TARBALL, at the workspace version, with
 *      no nested second copy. Version identity alone is deliberately not the
 *      test: a published tarball at the very same version passes that, and so
 *      does a nested copy sitting under a correct top-level one. See
 *      {@link assertLocalProvenance}.
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

/**
 * The package NAME an npm lock path addresses, and how deeply it is nested.
 *
 * `node_modules/@getknext/lib`                       -> lib, depth 1
 * `node_modules/@getknext/lib/node_modules/pino`     -> pino, depth 2
 * `node_modules/a/node_modules/@getknext/lib`        -> @getknext/lib, depth 2
 *
 * Keyed on the segment after the LAST `node_modules/`, never on "the path
 * contains @getknext" — the real install of this closure nests
 * `@getknext/lib/node_modules/pino`, so a path-substring test would refuse
 * every correct install and could not survive.
 */
function lockEntryIdentity(path: string): { name: string; depth: number } {
  const parts = path.split('node_modules/');
  return { name: parts.at(-1) ?? '', depth: parts.length - 1 };
}

/**
 * PROVENANCE — that these @getknext/* came from THIS workspace's tarballs.
 *
 * Version identity is not provenance, and that distinction is the whole point:
 * a **published tarball at the very same version** satisfies every
 * file-existence and version check, and so does npm quietly **nesting** a second
 * copy under a package while a correct one sits at the top level. Both leave the
 * e2e proving bytes nobody in this repo built, and neither is visible on disk
 * without reading what npm recorded.
 *
 * So this reads `node_modules/.package-lock.json` — npm's own record of where
 * every tree entry came from — and requires, for each of the three:
 *
 *   1. a TOP-LEVEL entry (depth 1) exists;
 *   2. its `resolved` is a `file:` URL, i.e. one of the tarballs just packed —
 *      an `https://` registry URL is the substitution being caught;
 *   3. its version is the workspace's (a stale local tarball is still wrong);
 *   4. NO nested `@getknext/*` copy exists anywhere in the tree.
 *
 * FAILS CLOSED on a missing lockfile: "no record" must not read as "nothing to
 * check", which is the exact shape of the presence-only assertion this replaced.
 */
function assertLocalProvenance(runnerRoot: string, workspaceVersions: Map<string, string>): void {
  const lockPath = join(runnerRoot, 'node_modules/.package-lock.json');
  if (!existsSync(lockPath)) {
    throw new Error(
      `npm wrote no ${lockPath} — without it there is no record of WHERE each @getknext/* came ` +
        'from, and an install whose provenance cannot be checked is not one to prove the shipped ' +
        'supervisor against.',
    );
  }
  let lock: { packages?: Record<string, { version?: string; resolved?: string }> };
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `${lockPath} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const entries = Object.entries(lock.packages ?? {});
  if (entries.length === 0) {
    throw new Error(
      `${lockPath} records no packages at all — nothing to verify provenance against.`,
    );
  }

  const topLevel = new Map<string, { version?: string; resolved?: string }>();
  for (const [path, entry] of entries) {
    const { name, depth } = lockEntryIdentity(path);
    if (!name.startsWith('@getknext/')) continue;
    if (depth > 1) {
      throw new Error(
        `a NESTED copy of ${name} is installed at ${path}.\n` +
          '  npm hoists what it can and nests what it cannot, so a second copy resolves for\n' +
          '  whoever requires it while the correct top-level copy is the one every other check\n' +
          '  inspects. The e2e would exercise whichever one the supervisor happened to load.',
      );
    }
    topLevel.set(name, entry);
  }

  for (const [name, expected] of workspaceVersions) {
    const entry = topLevel.get(name);
    if (!entry) {
      throw new Error(
        `${name} is not installed in the runner at all — the packed tarball did not land, so ` +
          'whatever the e2e proves, it is not the shipped closure.',
      );
    }
    const resolved = entry.resolved ?? '';
    if (!resolved.startsWith('file:')) {
      throw new Error(
        `${name} was resolved from ${resolved || '(nothing recorded)'}, not from a local tarball.\n` +
          '  npm went to the registry instead of using the tarball `bun pm pack` just produced —\n' +
          "  most likely a changeset bumped one package's version and left the rewritten\n" +
          '  `workspace:^` range unsatisfiable locally. The version can match exactly and the\n' +
          '  bytes still be published ones, which is why this reads the resolution and not the\n' +
          '  version alone.',
      );
    }
    if (entry.version !== expected) {
      throw new Error(
        `${name} in the runner is ${entry.version}, but this workspace holds ${expected}.\n` +
          '  The tarball that landed is not the one this tree would publish, so the e2e would\n' +
          '  have gone green against a stale local build.',
      );
    }
  }
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

    assertLocalProvenance(runnerRoot, workspaceVersions);
  } finally {
    // `finally`, not after the throws: a pack that fails on the third package
    // used to leak the two dirs created before it.
    for (const d of packDirs) rmSync(d, { recursive: true, force: true });
  }
}
