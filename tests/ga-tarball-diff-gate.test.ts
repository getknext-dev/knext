import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, readCredentialRcTag, readTargetVersion } from '../scripts/ga-tarball-diff-gate.mjs';

/**
 * `scripts/ga-tarball-diff-gate.mjs` (#1562) — the `release.yml` wiring that
 * decides WHEN to invoke `scripts/ga-tarball-diff.mjs`, given
 * `.github/compat-credential-ref.json`'s `rcTag` and the checked-out tree's
 * own version. `runDiff` is always INJECTED in these tests so nothing here
 * spawns `git worktree`/`bun` — the real diff script has its own extensive
 * suite (`tests/ga-tarball-diff.test.ts`).
 */

const registry: string[] = [];

/** A fixture repo root: `.github/compat-credential-ref.json`, `.changeset/config.json`, `packages/*`. */
function buildFixtureRoot(opts: {
  rcTag: string | null;
  packages: Array<{ name: string; version: string; private?: boolean }>;
}): string {
  const root = mkdtempSync(join(tmpdir(), 'ga-diff-gate-fixture-'));
  registry.push(root);

  mkdirSync(join(root, '.github'), { recursive: true });
  writeFileSync(
    join(root, '.github', 'compat-credential-ref.json'),
    JSON.stringify({ rcTag: opts.rcTag }),
  );

  mkdirSync(join(root, '.changeset'), { recursive: true });
  writeFileSync(join(root, '.changeset', 'config.json'), JSON.stringify({ ignore: [] }));

  for (const pkg of opts.packages) {
    const dir = join(root, 'packages', pkg.name.replace('@getknext/', ''));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: pkg.name, version: pkg.version, private: pkg.private ?? false }),
    );
  }

  return root;
}

const trio = (version: string) => [
  { name: '@getknext/core', version },
  { name: '@getknext/lib', version },
  { name: '@getknext/db', version },
];

afterEach(() => {
  for (const dir of registry.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe('readCredentialRcTag', () => {
  it('returns null when rcTag is null', () => {
    const root = buildFixtureRoot({ rcTag: null, packages: trio('1.0.0-rc.1') });
    expect(readCredentialRcTag(root)).toBeNull();
  });

  it('returns the tag string when set', () => {
    const root = buildFixtureRoot({ rcTag: 'v1.0.0-rc.1', packages: trio('1.0.0-rc.1') });
    expect(readCredentialRcTag(root)).toBe('v1.0.0-rc.1');
  });
});

describe('readTargetVersion', () => {
  it('returns the single version the publishable @getknext/* group is at', () => {
    const root = buildFixtureRoot({ rcTag: null, packages: trio('1.0.0-rc.2') });
    expect(readTargetVersion(root)).toBe('1.0.0-rc.2');
  });

  it('ignores a private package even if its version differs', () => {
    const root = buildFixtureRoot({
      rcTag: null,
      packages: [...trio('1.0.0-rc.2'), { name: '@getknext/ui', version: '9.9.9', private: true }],
    });
    expect(readTargetVersion(root)).toBe('1.0.0-rc.2');
  });

  it('throws when the fixed group is not at one version (incoherent tree)', () => {
    const root = buildFixtureRoot({
      rcTag: null,
      packages: [
        { name: '@getknext/core', version: '1.0.0-rc.2' },
        { name: '@getknext/lib', version: '1.0.0-rc.1' },
        { name: '@getknext/db', version: '1.0.0-rc.2' },
      ],
    });
    expect(() => readTargetVersion(root)).toThrow(/not at one version/);
  });
});

describe('main', () => {
  it('is a NO-OP (exit 0) and never invokes the diff when rcTag is null', () => {
    const root = buildFixtureRoot({ rcTag: null, packages: trio('1.0.0-rc.1') });
    const logs: string[] = [];
    let diffCalled = false;
    const code = main({
      repoRoot: root,
      log: (...args: unknown[]) => {
        logs.push(String(args[0]));
      },
      runDiff: () => {
        diffCalled = true;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(diffCalled).toBe(false);
    expect(logs.join('\n')).toContain('NO-OP');
  });

  it('SKIPS (exit 0, no diff invoked) an ordinary mid-window rc bump', () => {
    const root = buildFixtureRoot({ rcTag: 'v1.0.0-rc.1', packages: trio('1.0.0-rc.2') });
    const logs: string[] = [];
    let diffCalled = false;
    const code = main({
      repoRoot: root,
      log: (...args: unknown[]) => {
        logs.push(String(args[0]));
      },
      runDiff: () => {
        diffCalled = true;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(diffCalled).toBe(false);
    expect(logs.join('\n')).toContain('SKIP');
  });

  it('RUNS the diff for a GA cut, forwarding --rc-ref/--ga-ref HEAD, and propagates its exit code', () => {
    const root = buildFixtureRoot({ rcTag: 'v1.0.0-rc.3', packages: trio('1.0.0') });
    let capturedArgv: string[] | undefined;
    const code = main({
      repoRoot: root,
      log: () => {},
      runDiff: (argv: string[]) => {
        capturedArgv = argv;
        return 1; // propagate a failing diff verbatim
      },
    });
    expect(code).toBe(1);
    expect(capturedArgv).toEqual(['--rc-ref', 'v1.0.0-rc.3', '--ga-ref', 'HEAD']);
  });

  it('RUNS the diff when the target is identical to the credentialed rc (first publish)', () => {
    const root = buildFixtureRoot({ rcTag: 'v1.0.0-rc.1', packages: trio('1.0.0-rc.1') });
    let capturedArgv: string[] | undefined;
    const code = main({
      repoRoot: root,
      log: () => {},
      runDiff: (argv: string[]) => {
        capturedArgv = argv;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(capturedArgv).toEqual(['--rc-ref', 'v1.0.0-rc.1', '--ga-ref', 'HEAD']);
  });
});
