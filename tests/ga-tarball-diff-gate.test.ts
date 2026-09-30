import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { main, readCredentialRcTag, readTargetVersion } from '../scripts/ga-tarball-diff-gate.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

  // #1616 — when the caller supplies a pack-once artifact dir (the live
  // wiring is `PACK_ONCE_GA_DIR`, exercised here via the injected `gaDir`
  // opt so the test never touches env), the gate diffs against THAT dir
  // instead of rebuilding+packing HEAD.
  it('with gaDir set -> RUNS against the pack-once artifact instead of --ga-ref HEAD', () => {
    const root = buildFixtureRoot({ rcTag: 'v1.0.0-rc.2', packages: trio('1.0.0') });
    const summaryPath = join(root, 'step-summary.md');
    let capturedArgv: string[] | undefined;
    const code = main({
      repoRoot: root,
      log: () => {},
      runDiff: (argv: string[]) => {
        capturedArgv = argv;
        return 0;
      },
      listGitTags: () => tagsRc12,
      summaryPath,
      gaDir: '/tmp/pack-once-artifact',
    });
    expect(code).toBe(0);
    expect(capturedArgv).toEqual([
      '--rc-ref',
      'v1.0.0-rc.2',
      '--ga-dir',
      '/tmp/pack-once-artifact',
    ]);
    const summary = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : '';
    expect(summary).toContain('pack-once artifact');
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

/**
 * The live CI failure (release run 36418444586, main): `ga-tarball-diff`
 * checks out, sets up node + bun, then runs `node scripts/ga-tarball-diff-gate.mjs`
 * WITHOUT an install step. The gate statically imports `ga-tarball-diff.mjs` ->
 * `lib/tar-entries.mjs` -> `tar` (a root devDependency), so even a SKIP decision
 * crashed with `ERR_MODULE_NOT_FOUND` and the publish job never ran.
 *
 * This block asserts the WORKFLOW WIRING half of the fix: a dependency-install
 * step must appear in the `ga-tarball-diff` job BEFORE the step that runs the
 * gate script. The predicate is tested on fixtures first (both failure shapes
 * — missing, and present-but-after — must be caught), then applied to the live
 * `release.yml`.
 */
describe('release.yml — deps are installed before the ga-tarball-diff gate runs (unblocks rc.1 publish)', () => {
  type Step = { name?: string; run?: string };

  /**
   * True iff some step's `run` matches an install command, and it appears
   * BEFORE the (first) step whose `run` invokes the gate script. Throws if no
   * step invokes the gate at all — a fixture/job missing the very thing under
   * test proves nothing.
   */
  function installPrecedesGate(steps: Step[]): boolean {
    const isInstall = (s: Step) =>
      typeof s.run === 'string' && /\bbun install --frozen-lockfile\b/.test(s.run);
    const isGateInvocation = (s: Step) =>
      typeof s.run === 'string' && /ga-tarball-diff-gate\.mjs/.test(s.run);

    const gateIdx = steps.findIndex(isGateInvocation);
    if (gateIdx === -1) {
      throw new Error('fixture/job has no step invoking ga-tarball-diff-gate.mjs');
    }
    const installIdx = steps.findIndex(isInstall);
    return installIdx !== -1 && installIdx < gateIdx;
  }

  it('predicate: an install step before the gate step passes', () => {
    expect(
      installPrecedesGate([
        { name: 'Checkout code', run: undefined },
        { name: 'Install dependencies', run: 'bun install --frozen-lockfile' },
        { name: 'Run the gate', run: 'node scripts/ga-tarball-diff-gate.mjs' },
      ]),
    ).toBe(true);
  });

  it('predicate: a MISSING install step fails (the live #1615-class defect)', () => {
    expect(
      installPrecedesGate([
        { name: 'Checkout code', run: undefined },
        { name: 'Run the gate', run: 'node scripts/ga-tarball-diff-gate.mjs' },
      ]),
    ).toBe(false);
  });

  it('predicate: an install step placed AFTER the gate step fails', () => {
    expect(
      installPrecedesGate([
        { name: 'Run the gate', run: 'node scripts/ga-tarball-diff-gate.mjs' },
        { name: 'Install dependencies', run: 'bun install --frozen-lockfile' },
      ]),
    ).toBe(false);
  });

  it('predicate: an unrelated install (different package/job) does not satisfy it', () => {
    expect(
      installPrecedesGate([
        { name: 'npm install (wrong installer)', run: 'npm ci' },
        { name: 'Run the gate', run: 'node scripts/ga-tarball-diff-gate.mjs' },
      ]),
    ).toBe(false);
  });

  it('the live release.yml ga-tarball-diff job installs dependencies before invoking the gate', () => {
    const workflowPath = join(REPO_ROOT, '.github', 'workflows', 'release.yml');
    const doc = parse(readFileSync(workflowPath, 'utf8')) as {
      jobs: Record<string, { steps: Step[] }>;
    };
    const job = doc.jobs['ga-tarball-diff'];
    expect(job, 'release.yml no longer has a ga-tarball-diff job').toBeDefined();
    expect(installPrecedesGate(job.steps)).toBe(true);
  });
});

/**
 * The OTHER half of the fix: even with the install step restored, the gate's
 * SKIP/FAIL decisions should not need `tar` to be installed at all — a
 * prerelease or "no rc cut" answer is knowable from git tags and package.json
 * alone. Proven here by literally recreating the crash's precondition (a copy
 * of the gate + its dependency chain with no `node_modules` anywhere above
 * it) and observing the difference between a RUN decision (needs `tar`,
 * expected to fail in this isolated copy — proving the copy really lacks
 * `tar`) and a SKIP decision (must NOT need it).
 */
describe('ga-tarball-diff-gate.mjs — a SKIP decision never needs the tar-dependent diff module', () => {
  const registry: string[] = [];

  afterEach(() => {
    for (const dir of registry.splice(0)) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Builds an isolated copy of the gate script + its transitive `.mjs`
   * dependency chain under a fresh tmpdir that has no `node_modules`
   * anywhere above it in the filesystem, so a bare `import 'tar'` cannot
   * resolve — exactly the CI failure's precondition. Also lays down a
   * fixture repo (git tags, `.github/compat-credential-ref.json`,
   * `.changeset/config.json`, `packages/*`) directly at the copy's root,
   * since the gate's default `repoRoot` is `dirname(scripts)/..`.
   */
  function buildIsolatedCopy(opts: { version: string; tags: string[] }): string {
    const root = mkdtempSync(join(tmpdir(), 'ga-gate-isolated-'));
    registry.push(root);

    const scriptsDir = join(root, 'scripts');
    const libDir = join(scriptsDir, 'lib');
    mkdirSync(libDir, { recursive: true });
    for (const rel of [
      'ga-tarball-diff-gate.mjs',
      'ga-tarball-diff.mjs',
      'publish-preflight.mjs',
      'lib/ga-tarball-diff.mjs',
      'lib/tar-entries.mjs',
    ]) {
      cpSync(join(REPO_ROOT, 'scripts', rel), join(scriptsDir, rel));
    }

    mkdirSync(join(root, '.github'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'compat-credential-ref.json'),
      JSON.stringify({ rcTag: null }),
    );
    mkdirSync(join(root, '.changeset'), { recursive: true });
    writeFileSync(join(root, '.changeset', 'config.json'), JSON.stringify({ ignore: [] }));
    for (const name of ['core', 'lib', 'db']) {
      const dir = join(root, 'packages', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: `@getknext/${name}`, version: opts.version, private: false }),
      );
    }

    const git = (args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'commit.gpgsign=false',
          '-c',
          'tag.gpgSign=false',
          '-c',
          'tag.forceSignAnnotated=false',
          ...args,
        ],
        { cwd: root, stdio: 'pipe', encoding: 'utf8' },
      );
    git(['init', '--quiet']);
    git(['config', 'user.email', 'ga-gate-fixture@example.invalid']);
    git(['config', 'user.name', 'ga-gate-fixture']);
    writeFileSync(join(root, '.gitkeep'), '');
    git(['add', '.gitkeep']);
    git(['commit', '--quiet', '-m', 'fixture root commit']);
    for (const tag of opts.tags) {
      git(['tag', tag]);
    }

    return root;
  }

  // Deliberately the literal `node` binary, matching how release.yml actually
  // invokes the gate (`node scripts/ga-tarball-diff-gate.mjs`) — NOT
  // `process.execPath`, which under `bun test` resolves to the `bun`
  // executable rather than Node. Also deliberately a RELATIVE script path
  // (with `cwd: root`), matching that same real invocation: `os.tmpdir()`
  // is under `/var/folders` on macOS, a symlink to `/private/var/folders` —
  // an ABSOLUTE argv path through that symlink makes the script's own
  // `import.meta.url === file://${process.argv[1]}` entrypoint check fail
  // (`import.meta.url` resolves the realpath, `process.argv[1]` does not),
  // so the gate would silently never run and this test would prove nothing.
  function runIsolated(root: string) {
    return spawnSync('node', [join('scripts', 'ga-tarball-diff-gate.mjs')], {
      cwd: root,
      encoding: 'utf8',
    });
  }

  it('control: a RUN decision in this isolated copy fails on the missing tar package (proves the copy has no node_modules)', () => {
    // version 1.0.0 with a matching v1.0.0-rc.1 tag -> decision RUN.
    const root = buildIsolatedCopy({ version: '1.0.0', tags: ['v1.0.0-rc.1'] });
    const result = runIsolated(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/Cannot find package 'tar'|ERR_MODULE_NOT_FOUND/);
  });

  it('a SKIP decision (no rc cut for this GA tuple) exits 0 without ever needing tar', () => {
    // version 1.0.1 with only a v1.0.0-rc.1 tag (no rc for 1.0.1's own tuple) -> decision SKIP.
    const root = buildIsolatedCopy({ version: '1.0.1', tags: ['v1.0.0-rc.1'] });
    const result = runIsolated(root);
    expect(result.stderr, `stderr: ${result.stderr}`).not.toMatch(/tar/);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::notice');
  });

  it('a SKIP decision (prerelease target) exits 0 without ever needing tar', () => {
    const root = buildIsolatedCopy({ version: '1.0.0-rc.2', tags: ['v1.0.0-rc.1'] });
    const result = runIsolated(root);
    expect(result.stderr, `stderr: ${result.stderr}`).not.toMatch(/tar/);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::notice');
  });
});
