import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  defaultRunDiff,
  defaultTagResolves,
  main,
  readPin,
} from '../scripts/published-bytes-freeze-check.mjs';

/**
 * `scripts/published-bytes-freeze-check.mjs` (#1663) — the CLI wrapper around
 * `decidePublishedBytesScope`. `tagResolves` and `runDiff` are ALWAYS injected
 * here so nothing in this file shells to `git worktree`/`bun`/a child `node`
 * process — the release-time diff machinery has its own extensive suite
 * (`tests/ga-tarball-diff.test.ts`).
 *
 * Round 2 (PR #1680 review): `main()` now takes `basePin`/`headPin`/
 * `mergeBasePin` instead of reading a single ambient pin file from
 * `repoRoot` — see `scripts/lib/published-bytes-freeze-check.mjs`'s "WHICH
 * PIN STATE" header section. `buildFixtureRoot` no longer writes a pin file
 * to disk (nothing reads it for the decision); `pin()` builds the plain
 * objects `run()` passes as `basePin`/`headPin` directly.
 */

const registry: string[] = [];

function pin(rcTag: string | null, overrideMarker?: unknown) {
  return { rcTag, ...(overrideMarker ? { publishedBytesBumpMarker: overrideMarker } : {}) };
}

function buildFixtureRoot(opts?: {
  packages?: Array<{ dir: string; name: string; version: string; private?: boolean }>;
}): string {
  const root = mkdtempSync(join(tmpdir(), 'published-bytes-freeze-fixture-'));
  registry.push(root);

  mkdirSync(join(root, '.changeset'), { recursive: true });
  writeFileSync(join(root, '.changeset', 'config.json'), JSON.stringify({ ignore: [] }));

  const packages = opts?.packages ?? [
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
    basePin: pin(null),
    headPin: pin(null),
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

describe('main — rcTag null at base (no window) passes quickly, never touches tagResolves/runDiff', () => {
  it('exits 0 with a SKIP announcement, regardless of changed files', () => {
    const root = buildFixtureRoot();
    let tagResolvesCalled = false;
    let runDiffCalled = false;
    const r = run(root, ['packages/kn-next/src/index.ts'], {
      basePin: pin(null),
      headPin: pin(null),
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

describe('main — a docs/CI-only PR passes quickly even with a window open at base', () => {
  it('exits 0 with a SKIP announcement and never packs', () => {
    const root = buildFixtureRoot();
    let runDiffCalled = false;
    const r = run(root, ['docs/RELEASING.md', '.github/workflows/ci.yml'], {
      basePin: pin('v1.0.0-rc.1'),
      headPin: pin('v1.0.0-rc.1'),
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

describe('main — a package source or README edit REDS while rcTag is set at base', () => {
  it('a clean diff (runDiff exits 0) still PASSES the check', () => {
    const root = buildFixtureRoot();
    const r = run(root, ['packages/kn-next/README.md'], {
      basePin: pin('v1.0.0-rc.1'),
      headPin: pin('v1.0.0-rc.1'),
      runDiff: () => 0,
    });
    expect(r.code).toBe(0);
    expect(r.summary).toContain('RUN');
    expect(r.summary).toContain('PASS');
  });

  it('a real content mismatch (runDiff exits 1) REDS the PR', () => {
    const root = buildFixtureRoot();
    const r = run(root, ['packages/kn-next/README.md'], {
      basePin: pin('v1.0.0-rc.1'),
      headPin: pin('v1.0.0-rc.1'),
      runDiff: () => 1,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('::error');
    expect(r.summary).toContain('FAIL');
    expect(r.summary).toMatch(/next release|new rc/);
  });

  it('invokes the diff with --rc-ref <rcTag> --ga-ref HEAD', () => {
    const root = buildFixtureRoot();
    let capturedArgv: string[] | undefined;
    run(root, ['packages/lib/src/index.ts'], {
      basePin: pin('v1.0.0-rc.1'),
      headPin: pin('v1.0.0-rc.1'),
      runDiff: (argv: string[]) => {
        capturedArgv = argv;
        return 0;
      },
    });
    expect(capturedArgv).toEqual(['--rc-ref', 'v1.0.0-rc.1', '--ga-ref', 'HEAD']);
  });
});

describe('main — fails closed when the base-pinned rcTag does not resolve to a git tag', () => {
  it('exits 1 with an ::error, and never attempts the diff', () => {
    const root = buildFixtureRoot();
    let runDiffCalled = false;
    const r = run(root, ['packages/kn-next/src/index.ts'], {
      basePin: pin('v1.0.0-rc.99'),
      headPin: pin('v1.0.0-rc.99'),
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
  it('a valid publishedBytesBumpMarker introduced by this PR skips the diff even though scope is touched', () => {
    const root = buildFixtureRoot();
    let runDiffCalled = false;
    const r = run(root, ['packages/kn-next/src/index.ts'], {
      basePin: pin('v1.0.0-rc.1'),
      headPin: pin('v1.0.0-rc.1', {
        date: '2026-09-25',
        expires: '2026-10-02',
        reason: 'intentional rc.2 (#1663 example)',
      }),
      // mergeBasePin defaults to basePin, which carries no marker — introduced.
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
    const root = buildFixtureRoot();
    const r = run(root, ['packages/kn-next/src/index.ts'], {
      basePin: pin('v1.0.0-rc.1'),
      headPin: pin('v1.0.0-rc.1', { date: '2026-08-01', expires: '2026-08-10', reason: 'stale' }),
      runDiff: () => 0,
    });
    expect(r.summary).toContain('RUN');
  });

  it('a marker INHERITED from the merge base (not introduced by this PR) does not exempt', () => {
    const marker = { date: '2026-09-25', expires: '2026-10-02', reason: 'intentional rc.2' };
    const root = buildFixtureRoot();
    const r = run(root, ['packages/kn-next/src/index.ts'], {
      basePin: pin('v1.0.0-rc.1', marker),
      headPin: pin('v1.0.0-rc.1', marker),
      mergeBasePin: pin('v1.0.0-rc.1', marker),
      runDiff: () => 0,
    });
    expect(r.summary).toContain('RUN');
  });

  it('#2342 — a marker that arrived with a MERGED-IN branch does not exempt, and the ignored marker is announced', () => {
    const marker = { date: '2026-09-25', expires: '2026-10-02', reason: 'reviewed for v2' };
    const root = buildFixtureRoot();
    let runDiffCalled = false;
    const r = run(root, ['packages/kn-next/src/index.ts'], {
      basePin: pin('v1.0.0-rc.1'),
      headPin: pin('v1.0.0-rc.1', marker),
      mergeBasePin: pin('v1.0.0-rc.1'),
      inheritedPins: [pin('v1.0.0-rc.1', marker)],
      runDiff: () => {
        runDiffCalled = true;
        return 0;
      },
    });
    expect(runDiffCalled).toBe(true);
    expect(r.out).toMatch(/::warning title=Published-bytes freeze check::MARKER IGNORED/);
    expect(r.summary).toMatch(/inherited from a branch merged into this PR/);
    expect(r.summary).toContain('RUN');
  });

  it('#2342 — the ignored-marker warning precedes the fail-closed tag lookup, so it is never lost', () => {
    const marker = { date: '2026-09-25', expires: '2026-10-02', reason: 'reviewed for v2' };
    const root = buildFixtureRoot();
    const r = run(root, ['packages/kn-next/src/index.ts'], {
      basePin: pin('v1.0.0-rc.1'),
      headPin: pin('v1.0.0-rc.1', marker),
      mergeBasePin: pin('v1.0.0-rc.1'),
      inheritedPins: [pin('v1.0.0-rc.1', marker)],
      tagResolves: () => false,
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/MARKER IGNORED[^\n]*merged into this PR/);
    expect(r.out).toMatch(/does not resolve/);
  });

  it('closing the window together with a published-bytes change still runs the diff (round 2)', () => {
    const root = buildFixtureRoot();
    let runDiffCalled = false;
    const r = run(root, ['packages/kn-next/src/index.ts'], {
      basePin: pin('v1.0.0-rc.1'),
      headPin: pin(null),
      mergeBasePin: pin('v1.0.0-rc.1'),
      runDiff: () => {
        runDiffCalled = true;
        return 0;
      },
    });
    expect(runDiffCalled).toBe(true);
    expect(r.summary).toContain('RUN');
  });

  it('closing the window with NO other change skips (round 2)', () => {
    const root = buildFixtureRoot();
    let runDiffCalled = false;
    const r = run(root, ['.github/compat-credential-ref.json'], {
      basePin: pin('v1.0.0-rc.1'),
      headPin: pin(null),
      mergeBasePin: pin('v1.0.0-rc.1'),
      runDiff: () => {
        runDiffCalled = true;
        return 0;
      },
    });
    expect(runDiffCalled).toBe(false);
    expect(r.summary).toContain('SKIP');
  });
});

describe('readPin — reads + parses the pin file at whatever is checked out at repoRoot', () => {
  it('an unparsable pin file throws rather than reading as "no window"', () => {
    const root = mkdtempSync(join(tmpdir(), 'published-bytes-freeze-badpin-'));
    registry.push(root);
    mkdirSync(join(root, '.github'), { recursive: true });
    writeFileSync(join(root, '.github', 'compat-credential-ref.json'), '{ not json');
    expect(() => readPin(root)).toThrow();
  });

  it('returns the parsed pin for a well-formed file', () => {
    const root = mkdtempSync(join(tmpdir(), 'published-bytes-freeze-goodpin-'));
    registry.push(root);
    mkdirSync(join(root, '.github'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'compat-credential-ref.json'),
      JSON.stringify({ rcTag: 'v1.0.0-rc.1' }),
    );
    expect(readPin(root)).toEqual({ rcTag: 'v1.0.0-rc.1' });
  });
});

describe('main — requires changedFiles/basePin/headPin to be provided explicitly', () => {
  it('throws rather than silently defaulting to an empty diff', () => {
    const root = buildFixtureRoot();
    expect(() =>
      main({ repoRoot: root, basePin: pin(null), headPin: pin(null) } as Parameters<
        typeof main
      >[0]),
    ).toThrow(/changedFiles/);
  });

  it('throws when basePin is not provided', () => {
    const root = buildFixtureRoot();
    expect(() =>
      main({
        repoRoot: root,
        changedFiles: [],
        headPin: pin(null),
      } as unknown as Parameters<typeof main>[0]),
    ).toThrow(/basePin/);
  });

  it('throws when headPin is not provided', () => {
    const root = buildFixtureRoot();
    expect(() =>
      main({
        repoRoot: root,
        changedFiles: [],
        basePin: pin(null),
      } as unknown as Parameters<typeof main>[0]),
    ).toThrow(/headPin/);
  });
});

// #2342: the pins at merged-in parents decide whether a head marker is the
// PR's own. A missing file would fail OPEN (every merged-in marker reads as
// introduced), so the CLI requires it, like --merge-base-pin-file.
describe('CLI — --inherited-pins-file is required and must be a JSON array (#2342)', () => {
  const SCRIPT = resolve(import.meta.dirname, '..', 'scripts/published-bytes-freeze-check.mjs');
  const cliDirs: string[] = [];
  afterEach(() => {
    for (const dir of cliDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function runCli(inherited: string | null): { status: number | null; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'published-bytes-freeze-cli-'));
    cliDirs.push(dir);
    const pinFile = join(dir, 'pin.json');
    const changedFile = join(dir, 'changed-files.txt');
    writeFileSync(pinFile, JSON.stringify({ rcTag: null }));
    writeFileSync(changedFile, 'docs/RELEASING.md\n');
    const args = [
      SCRIPT,
      '--changed-files-file',
      changedFile,
      '--base-pin-file',
      pinFile,
      '--head-pin-file',
      pinFile,
      '--merge-base-pin-file',
      pinFile,
    ];
    if (inherited !== null) {
      const f = join(dir, 'inherited-pins.json');
      writeFileSync(f, inherited);
      args.push('--inherited-pins-file', f);
    }
    const { GITHUB_STEP_SUMMARY: _drop, ...env } = process.env;
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', env, timeout: 20_000 });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  it('exit 2 when the flag is omitted, in a scenario that would otherwise exit 0', () => {
    const r = runCli(null);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/--inherited-pins-file is required/);
  });

  it('exit 2 when the file is not a JSON array', () => {
    const r = runCli('{"publishedBytesBumpMarker": {}}');
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/must be a JSON array/);
  });

  it('exit 0 with an empty array, isolating the flag as what changed', () => {
    expect(runCli('[]').status).toBe(0);
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

describe('main — release-line scope (#2098)', () => {
  it('(a) main on 1.3 against the v1.0 pin: SKIP announced with the reason, no tag lookup, no diff, no marker needed', () => {
    const root = buildFixtureRoot();
    let touched = false;
    const r = run(root, ['packages/kn-next/src/index.ts'], {
      basePin: pin('v1.0.0-rc.6'),
      headPin: pin('v1.0.0-rc.6'),
      baseVersion: '1.3.0',
      tagResolves: () => {
        touched = true;
        return true;
      },
      runDiff: () => {
        touched = true;
        return 1;
      },
    });
    expect(r.code).toBe(0);
    expect(touched).toBe(false);
    expect(r.summary).toContain('SKIP');
    expect(r.out).toContain('not the line whose bytes are credentialed');
  });

  it('(b) a base on the pinned line: a published-bytes change with no marker still FAILS when the diff fails', () => {
    const root = buildFixtureRoot();
    const r = run(root, ['packages/kn-next/src/index.ts'], {
      basePin: pin('v1.0.0-rc.6'),
      headPin: pin('v1.0.0-rc.6'),
      baseVersion: '1.0.0-rc.6',
      runDiff: () => 1,
    });
    expect(r.code).toBe(1);
    expect(r.summary).toContain('FAIL');
  });

  it('(b) a base on the pinned line with an unresolvable tag still fails closed', () => {
    const root = buildFixtureRoot();
    const r = run(root, ['packages/kn-next/src/index.ts'], {
      basePin: pin('v1.0.0-rc.6'),
      headPin: pin('v1.0.0-rc.6'),
      baseVersion: '1.0.0-rc.6',
      tagResolves: () => false,
    });
    expect(r.code).toBe(1);
  });
});

describe('main — released-base scope (#2429)', () => {
  it('a base released as 1.3.1 against the v1.3.0-rc.10 pin: SKIP announced with the reason, no tag lookup, no diff', () => {
    const root = buildFixtureRoot();
    let touched = false;
    const r = run(root, ['packages/kn-next/src/__tests__/x.test.ts'], {
      basePin: pin('v1.3.0-rc.10'),
      headPin: pin('v1.3.0-rc.10'),
      baseVersion: '1.3.1',
      tagResolves: () => {
        touched = true;
        return true;
      },
      runDiff: () => {
        touched = true;
        return 1;
      },
    });
    expect(r.code).toBe(0);
    expect(touched).toBe(false);
    expect(r.summary).toContain('SKIP');
    expect(r.out).toContain('has ended on this line');
  });

  it('a base still in the window (1.3.0-rc.10) with a byte change still FAILS when the diff fails', () => {
    const root = buildFixtureRoot();
    const r = run(root, ['packages/kn-next/src/index.ts'], {
      basePin: pin('v1.3.0-rc.10'),
      headPin: pin('v1.3.0-rc.10'),
      baseVersion: '1.3.0-rc.10',
      runDiff: () => 1,
    });
    expect(r.code).toBe(1);
    expect(r.summary).toContain('FAIL');
  });

  it('a released base BELOW the pinned rc base (1.3.1 vs v1.3.2-rc.1) with a byte change still FAILS', () => {
    const root = buildFixtureRoot();
    const r = run(root, ['packages/kn-next/src/index.ts'], {
      basePin: pin('v1.3.2-rc.1'),
      headPin: pin('v1.3.2-rc.1'),
      baseVersion: '1.3.1',
      runDiff: () => 1,
    });
    expect(r.code).toBe(1);
    expect(r.summary).toContain('FAIL');
  });
});
