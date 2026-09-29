import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  findViolations,
  nonBuiltinPackagesFor,
  REPO_ROOT,
  resolveScriptPath,
  trackedWorkflowFiles,
} from '../scripts/workflow-script-install-guard.mjs';

/**
 * GUARD TESTS for `scripts/workflow-script-install-guard.mjs` (#1639a).
 *
 * The bug this generalizes a fix for: `release.yml`'s `ga-tarball-diff` job
 * once ran `node scripts/ga-tarball-diff-gate.mjs` with NO `bun install` step
 * first, crashed resolving a missing `tar` import, and silently SKIPPED the
 * rc.1 publish (#1621, root cause #1622). This guard scans every workflow for
 * that exact shape — a `scripts/*.mjs` step whose import closure reaches a
 * real npm package, with no install step earlier in the same job — and fails
 * closed on anything it cannot resolve.
 */

const fixtures: string[] = [];

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'workflow-install-guard-fixture-'));
  fixtures.push(root);
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  return root;
}

function writeWorkflow(root: string, name: string, yaml: string): void {
  writeFileSync(join(root, '.github', 'workflows', name), yaml);
}

function writeScript(root: string, relPath: string, source: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, source);
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe('non-vacuity: the scan sees the real workflow corpus', () => {
  it('tracks a real number of workflow files, not an empty/broken glob', () => {
    expect(trackedWorkflowFiles().length).toBeGreaterThan(15);
  });

  it('the real repo has zero violations today — this assertion is itself the regression guard', () => {
    // Not a tautology: findViolations() walks 35+ real scripts' real import
    // closures against the real workflow corpus. A future PR that adds a
    // `scripts/*.mjs` step reaching a real package with no earlier install
    // step reds exactly this assertion.
    expect(findViolations()).toEqual([]);
  });
});

describe('resolveScriptPath honors working-directory precedence (real case: ci.yml compat-smoke)', () => {
  it('a step-level working-directory changes which file a bare scripts/x.mjs resolves to', () => {
    // Real, not hypothetical: repo root has NO scripts/compat-smoke.mjs — only
    // apps/file-manager/scripts/compat-smoke.mjs exists. Without honoring
    // working-directory, this resolves to a file that does not exist and the
    // whole scan throws (fail-closed) on the real corpus — which it does not,
    // proving the precedence chain is load-bearing, not decorative.
    const resolved = resolveScriptPath(
      'scripts/compat-smoke.mjs',
      { workingDirectory: 'apps/file-manager' },
      {},
      {},
      REPO_ROOT,
    );
    expect(resolved).toBe('apps/file-manager/scripts/compat-smoke.mjs');
    expect(existsSync(join(REPO_ROOT, resolved))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'scripts/compat-smoke.mjs'))).toBe(false);
  });

  it('falls through job- then workflow-level working-directory, then defaults to repo root', () => {
    expect(
      resolveScriptPath('scripts/a.mjs', {}, { workingDirectory: 'apps/x' }, {}, REPO_ROOT),
    ).toBe('apps/x/scripts/a.mjs');
    expect(
      resolveScriptPath('scripts/a.mjs', {}, {}, { workingDirectory: 'apps/y' }, REPO_ROOT),
    ).toBe('apps/y/scripts/a.mjs');
    expect(resolveScriptPath('scripts/a.mjs', {}, {}, {}, REPO_ROOT)).toBe('scripts/a.mjs');
  });
});

describe('nonBuiltinPackagesFor — the spawnSync boundary is real, not assumed', () => {
  it('ga-tarball-diff-gate.mjs reaches zero non-builtin packages (it spawns ga-tarball-diff.mjs as a CHILD PROCESS instead of importing it)', () => {
    // This is the exact real file that motivated this guard (#1621/#1622) —
    // its own header comment explains it spawns a separate `node` process
    // specifically so `tar` never enters ITS module graph. Checked here
    // against the real file, not merely asserted in a comment.
    expect(nonBuiltinPackagesFor('scripts/ga-tarball-diff-gate.mjs')).toEqual([]);
  });

  it('ga-tarball-diff.mjs itself DOES reach a non-builtin package (tar) — the closure walker is not vacuously empty everywhere', () => {
    const packages = nonBuiltinPackagesFor('scripts/ga-tarball-diff.mjs');
    expect(packages.length).toBeGreaterThan(0);
  });
});

describe('findViolations reproduces the #1621/#1622 shape on a fixture', () => {
  it('flags a job that runs a package-reaching script with no install step', () => {
    const root = makeFixture();
    writeScript(root, 'scripts/needs-a-package.mjs', "import 'some-fake-npm-package';\n");
    writeWorkflow(
      root,
      'publish.yml',
      [
        'name: publish',
        'on: push',
        'jobs:',
        '  publish:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: checkout',
        '        uses: actions/checkout@v4',
        '      - name: run the gate',
        '        run: node scripts/needs-a-package.mjs',
        '',
      ].join('\n'),
    );
    const violations = findViolations({
      workflowsDir: join(root, '.github', 'workflows'),
      repoRoot: root,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      workflow: 'publish.yml',
      jobId: 'publish',
      script: 'scripts/needs-a-package.mjs',
      packages: ['some-fake-npm-package'],
    });
  });

  it('the SAME job is clean once an install step precedes the script step', () => {
    const root = makeFixture();
    writeScript(root, 'scripts/needs-a-package.mjs', "import 'some-fake-npm-package';\n");
    writeWorkflow(
      root,
      'publish.yml',
      [
        'name: publish',
        'on: push',
        'jobs:',
        '  publish:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: checkout',
        '        uses: actions/checkout@v4',
        '      - name: install deps',
        '        run: bun install --frozen-lockfile',
        '      - name: run the gate',
        '        run: node scripts/needs-a-package.mjs',
        '',
      ].join('\n'),
    );
    const violations = findViolations({
      workflowsDir: join(root, '.github', 'workflows'),
      repoRoot: root,
    });
    expect(violations).toEqual([]);
  });

  it('a script reaching only builtins/relative imports never violates, install step or not', () => {
    const root = makeFixture();
    writeScript(
      root,
      'scripts/no-deps.mjs',
      "import { readFileSync } from 'node:fs';\nreadFileSync;\n",
    );
    writeWorkflow(
      root,
      'lint.yml',
      [
        'name: lint',
        'on: push',
        'jobs:',
        '  lint:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: run',
        '        run: node scripts/no-deps.mjs',
        '',
      ].join('\n'),
    );
    const violations = findViolations({
      workflowsDir: join(root, '.github', 'workflows'),
      repoRoot: root,
    });
    expect(violations).toEqual([]);
  });

  it('fails closed on an unresolvable relative import rather than skipping the step', () => {
    const root = makeFixture();
    writeScript(root, 'scripts/broken.mjs', "import { x } from './does-not-exist.mjs';\nx;\n");
    writeWorkflow(
      root,
      'broken.yml',
      [
        'name: broken',
        'on: push',
        'jobs:',
        '  broken:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: run',
        '        run: node scripts/broken.mjs',
        '',
      ].join('\n'),
    );
    expect(() =>
      findViolations({ workflowsDir: join(root, '.github', 'workflows'), repoRoot: root }),
    ).toThrow(/cannot resolve/);
  });

  it('honors a step-level working-directory when deciding which file to walk', () => {
    const root = makeFixture();
    writeScript(root, 'apps/x/scripts/needs-a-package.mjs', "import 'some-fake-npm-package';\n");
    writeWorkflow(
      root,
      'nested.yml',
      [
        'name: nested',
        'on: push',
        'jobs:',
        '  nested:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: run',
        '        working-directory: apps/x',
        '        run: node scripts/needs-a-package.mjs',
        '',
      ].join('\n'),
    );
    const violations = findViolations({
      workflowsDir: join(root, '.github', 'workflows'),
      repoRoot: root,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].script).toBe('apps/x/scripts/needs-a-package.mjs');
  });
});
