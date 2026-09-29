import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  defaultRunDiff,
  defaultTagResolves,
  main,
} from '../scripts/published-bytes-freeze-check.mjs';

/**
 * `scripts/published-bytes-freeze-check.mjs` (#1663) — the CLI wrapper around
 * `decidePublishedBytesScope`. `tagResolves` and `runDiff` are ALWAYS injected
 * here so nothing in this file shells to `git worktree`/`bun`/a child `node`
 * process — the release-time diff machinery has its own extensive suite
 * (`tests/ga-tarball-diff.test.ts`).
 */

const registry: string[] = [];

function buildFixtureRoot(opts: {
  rcTag: string | null;
  overrideMarker?: unknown;
  packages?: Array<{ dir: string; name: string; version: string; private?: boolean }>;
}): string {
  const root = mkdtempSync(join(tmpdir(), 'published-bytes-freeze-fixture-'));
  registry.push(root);

  mkdirSync(join(root, '.github'), { recursive: true });
  writeFileSync(
    join(root, '.github', 'compat-credential-ref.json'),
    JSON.stringify({
      rcTag: opts.rcTag,
      ...(opts.overrideMarker ? { publishedBytesBumpMarker: opts.overrideMarker } : {}),
    }),
  );

  mkdirSync(join(root, '.changeset'), { recursive: true });
  writeFileSync(join(root, '.changeset', 'config.json'), JSON.stringify({ ignore: [] }));

  const packages = opts.packages ?? [
    { dir: 'packages/kn-next', name: '@getknext/core', version: '1.0.0-rc.1' },
    { dir: 'packages/lib', name: '@getknext/lib', version: '1.0.0-rc.1' },
    { dir: 'packages/db', name: '@getknext/db', version: '1.0.0-rc.1' },
  ];
  for (const pkg of packages) {
    mkdirSync(join(root, pkg.dir), { recursive: true });
    writeFileSync(
      join(root, pkg.dir, 'package.json'),
      JSON.stringify({ name: pkg.name, version: pkg.version, private: pkg.private ?? false }),
    );
  }

  return root;
}

afterEach(() => {
  for (const dir of registry.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function run(
  root: string,
  changedFiles: string[],
  overrides: Partial<Parameters<typeof main>[0]> = {},
) {
  const summaryPath = join(root, 'step-summary.md');
  const logs: string[] = [];
  const code = main({
    repoRoot: root,
    changedFiles,
    log: (...args: unknown[]) => logs.push(String(args[0])),
    now: new Date('2026-09-30T00:00:00Z'),
    tagResolves: () => true,
    runDiff: () => 0,
    summaryPath,
    ...overrides,
  });
  const summary = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : '';
  return { code, out: logs.join('\n'), summary };
}

describe('main — rcTag null (no window) passes quickly, never touches tagResolves/runDiff', () => {
  it('exits 0 with a SKIP announcement, regardless of changed files', () => {
    const root = buildFixtureRoot({ rcTag: null });
    let tagResolvesCalled = false;
    let runDiffCalled = false;
    const r = run(root, ['packages/kn-next/src/index.ts'], {
      tagResolves: () => {
        tagResolvesCalled = true;
        return true;
      },
      runDiff: () => {
        runDiffCalled = true;
        return 0;
      },
    });
    expect(r.code).toBe(0);
    expect(tagResolvesCalled).toBe(false);
    expect(runDiffCalled).toBe(false);
    expect(r.out).toContain('::notice');
    expect(r.summary).toContain('SKIP');
  });
});

describe('main — a docs/CI-only PR passes quickly even with a window open', () => {
  it('exits 0 with a SKIP announcement and never packs', () => {
    const root = buildFixtureRoot({ rcTag: 'v1.0.0-rc.1' });
    let runDiffCalled = false;
    const r = run(root, ['docs/RELEASING.md', '.github/workflows/ci.yml'], {
      runDiff: () => {
        runDiffCalled = true;
        return 0;
      },
    });
    expect(r.code).toBe(0);
    expect(runDiffCalled).toBe(false);
    expect(r.summary).toContain('SKIP');
  });
});

describe('main — a package source or README edit REDS while rcTag is set', () => {
  it('a clean diff (runDiff exits 0) still PASSES the check', () => {
    const root = buildFixtureRoot({ rcTag: 'v1.0.0-rc.1' });
    const r = run(root, ['packages/kn-next/README.md'], { runDiff: () => 0 });
    expect(r.code).toBe(0);
    expect(r.summary).toContain('RUN');
    expect(r.summary).toContain('PASS');
  });

  it('a real content mismatch (runDiff exits 1) REDS the PR', () => {
    const root = buildFixtureRoot({ rcTag: 'v1.0.0-rc.1' });
    const r = run(root, ['packages/kn-next/README.md'], { runDiff: () => 1 });
    expect(r.code).toBe(1);
    expect(r.out).toContain('::error');
    expect(r.summary).toContain('FAIL');
    expect(r.summary).toMatch(/next release|new rc/);
  });

  it('invokes the diff with --rc-ref <rcTag> --ga-ref HEAD', () => {
    const root = buildFixtureRoot({ rcTag: 'v1.0.0-rc.1' });
    let capturedArgv: string[] | undefined;
    run(root, ['packages/lib/src/index.ts'], {
      runDiff: (argv: string[]) => {
        capturedArgv = argv;
        return 0;
      },
    });
    expect(capturedArgv).toEqual(['--rc-ref', 'v1.0.0-rc.1', '--ga-ref', 'HEAD']);
  });
});

describe('main — fails closed when the pinned rcTag does not resolve to a git tag', () => {
  it('exits 1 with an ::error, and never attempts the diff', () => {
    const root = buildFixtureRoot({ rcTag: 'v1.0.0-rc.99' });
    let runDiffCalled = false;
    const r = run(root, ['packages/kn-next/src/index.ts'], {
      tagResolves: () => false,
      runDiff: () => {
        runDiffCalled = true;
        return 0;
      },
    });
    expect(r.code).toBe(1);
    expect(runDiffCalled).toBe(false);
    expect(r.out).toContain('::error');
    expect(r.summary).toContain('FAIL');
    expect(r.summary).toMatch(/does not resolve/);
  });
});

describe('main — the reviewed override for an intentional rc.N+1', () => {
  it('a valid publishedBytesBumpMarker skips the diff even though scope is touched', () => {
    const root = buildFixtureRoot({
      rcTag: 'v1.0.0-rc.1',
      overrideMarker: {
        date: '2026-09-25',
        expires: '2026-10-02',
        reason: 'intentional rc.2 (#1663 example)',
      },
    });
    let runDiffCalled = false;
    const r = run(root, ['packages/kn-next/src/index.ts'], {
      runDiff: () => {
        runDiffCalled = true;
        return 0;
      },
    });
    expect(r.code).toBe(0);
    expect(runDiffCalled).toBe(false);
    expect(r.summary).toContain('SKIP');
    expect(r.summary).toMatch(/exempts/);
  });

  it('an EXPIRED marker does not exempt — the diff still runs', () => {
    const root = buildFixtureRoot({
      rcTag: 'v1.0.0-rc.1',
      overrideMarker: { date: '2026-08-01', expires: '2026-08-10', reason: 'stale' },
    });
    const r = run(root, ['packages/kn-next/src/index.ts'], { runDiff: () => 0 });
    expect(r.summary).toContain('RUN');
  });
});

describe('main — an unparsable pin file fails closed rather than reading as "no window"', () => {
  it('throws (the CLI entrypoint turns that into exit 1)', () => {
    const root = mkdtempSync(join(tmpdir(), 'published-bytes-freeze-badpin-'));
    registry.push(root);
    mkdirSync(join(root, '.github'), { recursive: true });
    writeFileSync(join(root, '.github', 'compat-credential-ref.json'), '{ not json');
    mkdirSync(join(root, '.changeset'), { recursive: true });
    writeFileSync(join(root, '.changeset', 'config.json'), JSON.stringify({ ignore: [] }));
    expect(() =>
      main({ repoRoot: root, changedFiles: ['packages/kn-next/src/index.ts'] }),
    ).toThrow();
  });
});

describe('main — requires changedFiles to be provided explicitly', () => {
  it('throws rather than silently defaulting to an empty diff', () => {
    const root = buildFixtureRoot({ rcTag: null });
    // biome-ignore lint/suspicious/noExplicitAny: deliberately calling without the required field
    expect(() => main({ repoRoot: root } as any)).toThrow(/changedFiles/);
  });
});

describe('the real ga-tarball-diff.mjs is actually reachable from the default runDiff', () => {
  it('resolves scripts/ga-tarball-diff.mjs relative to this script, not the caller cwd', () => {
    // Smoke check only — does not spawn `git worktree`/`bun`.
    const scriptPath = new URL('../scripts/ga-tarball-diff.mjs', import.meta.url).pathname;
    expect(existsSync(scriptPath)).toBe(true);
  });

  it('defaultRunDiff actually spawns a real child node process and propagates its exit code', () => {
    // Deliberately BAD args (no --rc-ref/--ga-ref/--rc-dir/--ga-dir): the real
    // ga-tarball-diff.mjs's own argv parser throws and exits 1 almost
    // instantly — this proves the wiring (the right script, the right node
    // binary, exit code propagated) without paying for a real `git
    // worktree`/`bun install`/pack, which has its own extensive suite
    // (tests/ga-tarball-diff.test.ts).
    const repoRoot = resolve(import.meta.dirname, '..');
    const logs: string[] = [];
    const code = defaultRunDiff([], {
      log: (...a: unknown[]) => logs.push(String(a[0])),
      repoRoot,
    });
    expect(code).not.toBe(0);
    expect(logs.join('\n')).toMatch(/pass exactly one of|ERROR/);
  });
});

describe('defaultTagResolves — resolves against a REAL git tag, not a mock', () => {
  const registry: string[] = [];
  afterEach(() => {
    for (const dir of registry.splice(0)) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  function buildTaggedRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'published-bytes-freeze-tagrepo-'));
    registry.push(dir);
    const git = (...a: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'commit.gpgsign=false',
          '-c',
          'tag.gpgSign=false',
          '-c',
          'tag.forceSignAnnotated=false',
          ...a,
        ],
        { cwd: dir, encoding: 'utf8' },
      );
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(dir, 'f.txt'), 'x');
    git('add', '.');
    git('commit', '-q', '-m', 'root');
    git('tag', 'v1.0.0-rc.1');
    return dir;
  }

  it('returns true for a tag that exists', () => {
    const dir = buildTaggedRepo();
    expect(defaultTagResolves(dir, 'v1.0.0-rc.1')).toBe(true);
  });

  it('returns false for a tag that does not exist, without throwing', () => {
    const dir = buildTaggedRepo();
    expect(defaultTagResolves(dir, 'v9.9.9-rc.9')).toBe(false);
  });
});
