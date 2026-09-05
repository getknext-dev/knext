/**
 * T6a — the SIGTERM e2es' `beforeAll` can silently prove the WRONG bytes.
 *
 * Both `sigterm-drain-e2e.test.ts` and `sigterm-hardcap-e2e.test.ts` open by
 * packing `packages/{lib,db,kn-next}` with `bun pm pack` and installing the
 * tarballs into a throwaway runner with `npm install --omit=dev`. Three failure
 * modes, none of which the old assertions could see, because they only checked
 * that some files EXIST:
 *
 *   1. VERSION-SKEW SUBSTITUTION. `bun pm pack` rewrites `workspace:^` to a
 *      concrete range. If a changeset bumps `core` but not `lib`, that range may
 *      not be satisfied by the LOCAL lib tarball — and npm then silently fetches
 *      the PUBLISHED `@getknext/lib` instead. The gate goes green having proved
 *      the shipped supervisor against a stale published dependency. This is the
 *      one that matters: it converts a security/runtime-hardening gate into a
 *      test of something nobody shipped.
 *   2. INSTALL SCRIPTS RUN. `npm install` executes lifecycle scripts from every
 *      package in the closure by default, inside a fail-closed gate that runs on
 *      every PR. `--ignore-scripts` is the cheap removal of that surface.
 *   3. TEMP-DIR LEAK. The `rmSync` loop sat BELOW the `throw` for a failed pack,
 *      so a pack failure leaked every dir created before it — the same shape
 *      already fixed in `asset-upload.ts`.
 *
 * This spec drives a real filesystem with an INJECTED spawn, so all three are
 * provable in milliseconds without packing anything. Both halves are asserted
 * throughout: a matching version must be ACCEPTED as well as a mismatched one
 * refused, or a helper that always throws would pass.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installShippedPackages, SHIPPED_PACKAGE_DIRS } from './e2e-support/shipped-runner';

/** A repo root with the three workspace manifests at the versions given. */
function fakeRepo(versions: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'knext-t6a-repo-'));
  for (const dir of SHIPPED_PACKAGE_DIRS) {
    const name = {
      'packages/lib': '@getknext/lib',
      'packages/db': '@getknext/db',
      'packages/kn-next': '@getknext/core',
    }[dir] as string;
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(
      join(root, dir, 'package.json'),
      JSON.stringify({ name, version: versions[name] ?? '9.9.9' }),
    );
  }
  return root;
}

interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
}

/**
 * A spawn that behaves like `bun pm pack` + `npm install` without either.
 * `installed` says what versions land in the runner's node_modules, so the
 * substitution case is expressible.
 */
function fakeSpawn(opts: {
  readonly calls: Call[];
  readonly installed: Record<string, string>;
  readonly failPackFor?: string;
  readonly runnerRoot: string;
  /**
   * `node_modules/…` path -> lock entry. Defaults to a clean local install:
   * every `installed` package top-level with a `file:` resolution. Overriding it
   * is how the registry-substitution and nested-copy cases are expressed.
   */
  readonly lockPackages?: Record<string, { version: string; resolved?: string }>;
  /** Omit `.package-lock.json` entirely. */
  readonly noLockfile?: boolean;
}) {
  return (cmd: string, args: readonly string[], options: { cwd: string }) => {
    opts.calls.push({ cmd, args });
    if (cmd === 'bun') {
      if (opts.failPackFor && options.cwd.endsWith(opts.failPackFor)) {
        return { status: 1, stdout: '', stderr: 'pack blew up' };
      }
      const dest = args[args.indexOf('--destination') + 1] as string;
      writeFileSync(join(dest, 'pkg.tgz'), 'TARBALL');
      return { status: 0, stdout: '', stderr: '' };
    }
    // npm install: materialise the closure the test declared.
    for (const [name, version] of Object.entries(opts.installed)) {
      const dir = join(opts.runnerRoot, 'node_modules', ...name.split('/'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
    }
    for (const dep of ['prom-client', 'pino']) {
      mkdirSync(join(opts.runnerRoot, 'node_modules', dep), { recursive: true });
    }
    mkdirSync(join(opts.runnerRoot, 'node_modules/@getknext/core/dist/adapters'), {
      recursive: true,
    });
    writeFileSync(
      join(opts.runnerRoot, 'node_modules/@getknext/core/dist/adapters/node-server.js'),
      '',
    );
    if (!opts.noLockfile) {
      const packages =
        opts.lockPackages ??
        Object.fromEntries(
          Object.entries(opts.installed).map(([name, version]) => [
            `node_modules/${name}`,
            { version, resolved: `file:../../tmp/knext-core-pack-XXXX/${name}-${version}.tgz` },
          ]),
        );
      writeFileSync(
        join(opts.runnerRoot, 'node_modules/.package-lock.json'),
        // Shape taken from a REAL `npm install` of these tarballs, not invented:
        // lockfileVersion 3, `packages` keyed by node_modules path, `resolved`
        // carrying `file:` for a local tarball and an `https://` registry URL
        // otherwise. The real run also nests (`@getknext/lib/node_modules/pino`),
        // which is why the nested case below is reachable rather than theoretical.
        JSON.stringify({ name: 'runner', lockfileVersion: 3, packages }),
      );
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

const MATCHING = {
  '@getknext/lib': '1.2.3',
  '@getknext/db': '1.2.3',
  '@getknext/core': '1.2.3',
};

describe('T6a shipped-runner install proves PROVENANCE, not just presence', () => {
  it('accepts an install whose @getknext/* versions match the workspace', () => {
    const repoRoot = fakeRepo(MATCHING);
    const runnerRoot = mkdtempSync(join(tmpdir(), 'knext-t6a-runner-'));
    const calls: Call[] = [];
    expect(() =>
      installShippedPackages({
        repoRoot,
        runnerRoot,
        env: process.env,
        spawn: fakeSpawn({ calls, installed: { ...MATCHING }, runnerRoot }),
      }),
    ).not.toThrow();
  });

  it('REFUSES a published substitution — one @getknext/* at a different version', () => {
    const repoRoot = fakeRepo(MATCHING);
    const runnerRoot = mkdtempSync(join(tmpdir(), 'knext-t6a-runner-'));
    const calls: Call[] = [];
    expect(() =>
      installShippedPackages({
        repoRoot,
        runnerRoot,
        env: process.env,
        spawn: fakeSpawn({
          calls,
          // What npm does when the rewritten range is unsatisfiable locally:
          // it fetches the published lib. Same files on disk, different bytes.
          installed: { ...MATCHING, '@getknext/lib': '0.9.0' },
          runnerRoot,
        }),
      }),
    ).toThrow(/@getknext\/lib/);
  });

  // ── The two cases a version comparison alone CANNOT see ──────────────────
  //
  // Version identity is not provenance. Both of these leave every @getknext/*
  // at exactly the workspace version, so the version check passes and the gate
  // proves bytes nobody in this repo built.

  it('REFUSES a REGISTRY tarball at the very same version', () => {
    const repoRoot = fakeRepo(MATCHING);
    const runnerRoot = mkdtempSync(join(tmpdir(), 'knext-t6a-runner-'));
    expect(() =>
      installShippedPackages({
        repoRoot,
        runnerRoot,
        env: process.env,
        spawn: fakeSpawn({
          calls: [],
          installed: { ...MATCHING },
          runnerRoot,
          lockPackages: {
            'node_modules/@getknext/core': {
              version: '1.2.3',
              resolved: 'file:../../tmp/pack/core.tgz',
            },
            'node_modules/@getknext/db': {
              version: '1.2.3',
              resolved: 'file:../../tmp/pack/db.tgz',
            },
            // Same version, published bytes. Indistinguishable to every check
            // this helper had before the lockfile was read.
            'node_modules/@getknext/lib': {
              version: '1.2.3',
              resolved: 'https://registry.npmjs.org/@getknext/lib/-/lib-1.2.3.tgz',
            },
          },
        }),
      }),
    ).toThrow(/@getknext\/lib[\s\S]*registry/i);
  });

  it('REFUSES a NESTED @getknext/* copy even when the top-level one is correct', () => {
    // npm hoists what it can and NESTS what it cannot — the real install of
    // these tarballs nests `@getknext/lib/node_modules/pino` today. A nested
    // `@getknext/*` means two copies resolve depending on who requires it, and
    // the correct top-level copy is the one every existing assertion inspects.
    const repoRoot = fakeRepo(MATCHING);
    const runnerRoot = mkdtempSync(join(tmpdir(), 'knext-t6a-runner-'));
    expect(() =>
      installShippedPackages({
        repoRoot,
        runnerRoot,
        env: process.env,
        spawn: fakeSpawn({
          calls: [],
          installed: { ...MATCHING },
          runnerRoot,
          lockPackages: {
            'node_modules/@getknext/core': {
              version: '1.2.3',
              resolved: 'file:../../tmp/pack/core.tgz',
            },
            'node_modules/@getknext/db': {
              version: '1.2.3',
              resolved: 'file:../../tmp/pack/db.tgz',
            },
            'node_modules/@getknext/lib': {
              version: '1.2.3',
              resolved: 'file:../../tmp/pack/lib.tgz',
            },
            // The second copy. Everything above it is still perfect.
            'node_modules/@getknext/core/node_modules/@getknext/lib': {
              version: '1.2.3',
              resolved: 'https://registry.npmjs.org/@getknext/lib/-/lib-1.2.3.tgz',
            },
          },
        }),
      }),
    ).toThrow(/nested/i);
  });

  it('does NOT mistake a nested non-knext dep for a nested @getknext copy', () => {
    // The other half, and a real shape: `@getknext/lib/node_modules/pino` is in
    // every genuine install of this closure. A nesting check that keyed on the
    // path containing "@getknext" rather than on the package NAME would refuse
    // every correct install — a guard nobody could keep.
    const repoRoot = fakeRepo(MATCHING);
    const runnerRoot = mkdtempSync(join(tmpdir(), 'knext-t6a-runner-'));
    expect(() =>
      installShippedPackages({
        repoRoot,
        runnerRoot,
        env: process.env,
        spawn: fakeSpawn({
          calls: [],
          installed: { ...MATCHING },
          runnerRoot,
          lockPackages: {
            'node_modules/@getknext/core': {
              version: '1.2.3',
              resolved: 'file:../../tmp/pack/core.tgz',
            },
            'node_modules/@getknext/db': {
              version: '1.2.3',
              resolved: 'file:../../tmp/pack/db.tgz',
            },
            'node_modules/@getknext/lib': {
              version: '1.2.3',
              resolved: 'file:../../tmp/pack/lib.tgz',
            },
            'node_modules/@getknext/lib/node_modules/pino': {
              version: '10.3.1',
              resolved: 'https://registry.npmjs.org/pino/-/pino-10.3.1.tgz',
            },
          },
        }),
      }),
    ).not.toThrow();
  });

  it('REFUSES an install with no .package-lock.json — provenance unverifiable', () => {
    // Fails closed. "No record" must not read as "nothing to check": that is
    // the exact shape of the presence-only assertion this replaced.
    const repoRoot = fakeRepo(MATCHING);
    const runnerRoot = mkdtempSync(join(tmpdir(), 'knext-t6a-runner-'));
    expect(() =>
      installShippedPackages({
        repoRoot,
        runnerRoot,
        env: process.env,
        spawn: fakeSpawn({ calls: [], installed: { ...MATCHING }, runnerRoot, noLockfile: true }),
      }),
    ).toThrow(/package-lock/);
  });

  it('REFUSES an install that produced no @getknext/lib at all', () => {
    const repoRoot = fakeRepo(MATCHING);
    const runnerRoot = mkdtempSync(join(tmpdir(), 'knext-t6a-runner-'));
    const installed = { ...MATCHING } as Record<string, string>;
    delete installed['@getknext/lib'];
    expect(() =>
      installShippedPackages({
        repoRoot,
        runnerRoot,
        env: process.env,
        spawn: fakeSpawn({ calls: [], installed, runnerRoot }),
      }),
    ).toThrow(/@getknext\/lib/);
  });

  it('passes --ignore-scripts to npm install', () => {
    const repoRoot = fakeRepo(MATCHING);
    const runnerRoot = mkdtempSync(join(tmpdir(), 'knext-t6a-runner-'));
    const calls: Call[] = [];
    installShippedPackages({
      repoRoot,
      runnerRoot,
      env: process.env,
      spawn: fakeSpawn({ calls, installed: { ...MATCHING }, runnerRoot }),
    });
    const install = calls.find((c) => c.cmd === 'npm');
    expect(install, 'no npm install was spawned').toBeDefined();
    expect(install?.args).toContain('--ignore-scripts');
  });

  it('removes every pack dir even when a pack FAILS mid-loop', () => {
    const repoRoot = fakeRepo(MATCHING);
    const runnerRoot = mkdtempSync(join(tmpdir(), 'knext-t6a-runner-'));
    // Pack dirs are created under an injected root so the leak is observable
    // without scanning the machine's whole tmpdir.
    const packTmpRoot = mkdtempSync(join(tmpdir(), 'knext-t6a-packroot-'));
    expect(() =>
      installShippedPackages({
        repoRoot,
        runnerRoot,
        packTmpRoot,
        env: process.env,
        spawn: fakeSpawn({
          calls: [],
          installed: { ...MATCHING },
          // The LAST package: the first two dirs exist by then, so a leak is
          // two dirs, not zero.
          failPackFor: 'packages/kn-next',
          runnerRoot,
        }),
      }),
    ).toThrow(/pack failed/);
    expect(readdirSync(packTmpRoot)).toEqual([]);
  });

  it('removes every pack dir on the SUCCESS path too', () => {
    const repoRoot = fakeRepo(MATCHING);
    const runnerRoot = mkdtempSync(join(tmpdir(), 'knext-t6a-runner-'));
    const packTmpRoot = mkdtempSync(join(tmpdir(), 'knext-t6a-packroot-'));
    installShippedPackages({
      repoRoot,
      runnerRoot,
      packTmpRoot,
      env: process.env,
      spawn: fakeSpawn({ calls: [], installed: { ...MATCHING }, runnerRoot }),
    });
    expect(readdirSync(packTmpRoot)).toEqual([]);
  });
});

/**
 * DISCOVERED, not enumerated.
 *
 * The whole defect existed twice because the block was copy-pasted, and a
 * reviewer remembering to fix both copies is exactly what failed. A test naming
 * `sigterm-drain-e2e.test.ts` and `sigterm-hardcap-e2e.test.ts` is a test that
 * stays green on the day someone adds a third — the same shape as the drift
 * `runtime-entry-copy-parity.test.ts` was written to catch. So the set comes off
 * the filesystem, and the known two are asserted only as a FLOOR (an empty scan
 * must fail, never pass vacuously).
 *
 * This file is deliberately not in the discovered set — its name carries no
 * `sigterm` — so the literals it asserts on cannot match itself.
 */
function discoverSigtermE2eSpecs(): string[] {
  return readdirSync(import.meta.dirname)
    .filter((f) => /sigterm.*e2e\.test\.tsx?$/.test(f))
    .sort();
}

describe('T6a every SIGTERM e2e goes through the shared helper', () => {
  it('the scan finds the specs it is supposed to guard', () => {
    const found = discoverSigtermE2eSpecs();
    expect(
      found.length,
      'the sigterm e2e scan found nothing — it would pass vacuously',
    ).toBeGreaterThanOrEqual(2);
    for (const known of ['sigterm-drain-e2e.test.ts', 'sigterm-hardcap-e2e.test.ts']) {
      expect(found, `the scan missed ${known}`).toContain(known);
    }
  });

  for (const spec of discoverSigtermE2eSpecs()) {
    it(`${spec} does not carry its own pack/install block`, () => {
      const text = readFileSync(join(import.meta.dirname, spec), 'utf8');
      expect(text, `${spec} does not use the shared helper`).toContain('installShippedPackages');
      expect(text, `${spec} still spawns its own bun pm pack`).not.toContain("'pm', 'pack'");
      expect(text, `${spec} still spawns its own npm install`).not.toMatch(/spawnSync\(\s*'npm'/);
    });
  }
});
