import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('main — every outcome is announced, never a silent green', () => {
  const tagsRc12 = ['v0.1.0', 'v1.0.0-rc.1', 'v1.0.0-rc.2'];

  function runMain(opts: {
    rcTag: string | null;
    version: string;
    tags: string[];
    diffExit?: number;
  }) {
    const root = buildFixtureRoot({ rcTag: opts.rcTag, packages: trio(opts.version) });
    const summaryPath = join(root, 'step-summary.md');
    const logs: string[] = [];
    let capturedArgv: string[] | undefined;
    const code = main({
      repoRoot: root,
      log: (...args: unknown[]) => {
        logs.push(String(args[0]));
      },
      runDiff: (argv: string[]) => {
        capturedArgv = argv;
        return opts.diffExit ?? 0;
      },
      listGitTags: () => opts.tags,
      summaryPath,
    });
    const summary = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : '';
    return { code, out: logs.join('\n'), capturedArgv, summary };
  }

  it('GA 1.0.0 with rc tags -> RUNS against the HIGHEST rc tag vs HEAD, propagating the diff exit', () => {
    const r = runMain({ rcTag: 'v1.0.0-rc.2', version: '1.0.0', tags: tagsRc12, diffExit: 1 });
    expect(r.code).toBe(1);
    expect(r.capturedArgv).toEqual(['--rc-ref', 'v1.0.0-rc.2', '--ga-ref', 'HEAD']);
    expect(r.out).toContain('::notice');
    expect(r.summary).toContain('RUN');
    expect(r.summary).toContain('FAIL');
  });

  it('GA 1.0.0 with rcTag CLEARED (window closed) -> still RUNS, and a clean diff is recorded as PASS', () => {
    const r = runMain({ rcTag: null, version: '1.0.0', tags: tagsRc12, diffExit: 0 });
    expect(r.code).toBe(0);
    expect(r.capturedArgv).toEqual(['--rc-ref', 'v1.0.0-rc.2', '--ga-ref', 'HEAD']);
    expect(r.summary).toContain('RUN');
    expect(r.summary).toContain('PASS');
  });

  it('rcTag pinned at rc.1 while rc.2 exists -> FAILS (exit 1) with ::error and never diffs', () => {
    const r = runMain({ rcTag: 'v1.0.0-rc.1', version: '1.0.0', tags: tagsRc12 });
    expect(r.code).toBe(1);
    expect(r.capturedArgv).toBeUndefined();
    expect(r.out).toContain('::error');
    expect(r.summary).toContain('FAIL');
  });

  for (const version of ['1.0.1', '1.1.0', '2.0.0', '0.4.4']) {
    it(`GA ${version} after 1.0.0 (rcTag still pinned) -> SKIPS with a notice + summary, never blocks`, () => {
      const r = runMain({ rcTag: 'v1.0.0-rc.2', version, tags: tagsRc12 });
      expect(r.code).toBe(0);
      expect(r.capturedArgv).toBeUndefined();
      expect(r.out).toContain('::notice');
      expect(r.out).toContain(`no release candidate was cut for ${version}`);
      expect(r.summary).toContain('SKIP');
      expect(r.summary).toContain('not claimed as credentialed');
    });
  }

  it('a prerelease -> SKIPS with a notice + summary', () => {
    const r = runMain({ rcTag: 'v1.0.0-rc.1', version: '1.0.0-rc.2', tags: tagsRc12 });
    expect(r.code).toBe(0);
    expect(r.capturedArgv).toBeUndefined();
    expect(r.out).toContain('::notice');
    expect(r.summary).toContain('SKIP');
  });

  it('an unset GITHUB_STEP_SUMMARY (local run) still announces on stdout and does not crash', () => {
    const root = buildFixtureRoot({ rcTag: null, packages: trio('1.0.1') });
    const logs: string[] = [];
    const code = main({
      repoRoot: root,
      log: (...args: unknown[]) => {
        logs.push(String(args[0]));
      },
      runDiff: () => 0,
      listGitTags: () => tagsRc12,
      summaryPath: undefined,
    });
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('::notice');
  });

  it('the default tag lister fails CLOSED outside a git repo (an unanswerable question is never a skip)', () => {
    const root = buildFixtureRoot({ rcTag: null, packages: trio('1.0.0') });
    expect(() => main({ repoRoot: root, log: () => {}, runDiff: () => 0 })).toThrow();
  });
});
