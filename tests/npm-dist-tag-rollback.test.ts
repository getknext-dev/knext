import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildRollbackCommands,
  discoverGroupPackageNames,
  EXPECTED_GROUP_SIZE,
  executeCommands,
  validateTargetPublished,
} from '../scripts/npm-dist-tag-rollback.mjs';

/**
 * `scripts/npm-dist-tag-rollback.mjs` — the tool `docs/RELEASING.md`'s
 * rollback runbook (issue #1673) points at for "move `latest` back to 0.4.3 on
 * all four packages together". No network, ever: registry probes and command
 * execution are both injected here, and the ONE fake-`npm`-on-PATH suite below
 * proves the process-wiring layer without touching the real registry.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const PACKAGES = ['@getknext/core', '@getknext/lib', '@getknext/db', 'kn-next'];

describe('discoverGroupPackageNames — reads the real fixed group from this repo', () => {
  it('finds exactly the four publishable packages this repo ships as a set', () => {
    const names = discoverGroupPackageNames(REPO_ROOT);
    expect(names.length).toBe(EXPECTED_GROUP_SIZE);
    for (const name of PACKAGES) expect(names).toContain(name);
  });
});

describe('validateTargetPublished — refuses a rollback target that is not real', () => {
  it('says allPublished=true only when EVERY package has the target version', () => {
    const { allPublished, missing } = validateTargetPublished({
      packageNames: PACKAGES,
      targetVersion: '0.4.3',
      viewSucceeds: () => true,
    });
    expect(allPublished).toBe(true);
    expect(missing).toEqual([]);
  });

  it('lists every package missing the target version, not just the first', () => {
    const { allPublished, missing } = validateTargetPublished({
      packageNames: PACKAGES,
      targetVersion: '0.4.3',
      viewSucceeds: (spec) => spec.startsWith('@getknext/core') || spec.startsWith('@getknext/lib'),
    });
    expect(allPublished).toBe(false);
    expect(missing).toEqual(['@getknext/db', 'kn-next']);
  });

  it('refuses (allPublished=false) when the target is missing for even one package', () => {
    // Both halves: a near-total success (3 of 4) must still read as a refusal,
    // not be rounded up to "close enough".
    const { allPublished } = validateTargetPublished({
      packageNames: PACKAGES,
      targetVersion: '0.4.3',
      viewSucceeds: (spec) => spec !== 'kn-next@0.4.3',
    });
    expect(allPublished).toBe(false);
  });
});

describe('buildRollbackCommands — always the full group, never a subset', () => {
  const commands = buildRollbackCommands({
    packageNames: PACKAGES,
    target: '0.4.3',
    broken: '1.0.0',
    distTag: 'latest',
    registry: 'https://registry.npmjs.org/',
  });

  it('emits one dist-tag command per package, for all four', () => {
    const distTagCmds = commands.filter((c) => c.kind === 'dist-tag');
    expect(distTagCmds.length).toBe(EXPECTED_GROUP_SIZE);
    expect(distTagCmds.map((c) => c.name).sort()).toEqual([...PACKAGES].sort());
  });

  it('emits one deprecate command per package, for all four', () => {
    const deprecateCmds = commands.filter((c) => c.kind === 'deprecate');
    expect(deprecateCmds.length).toBe(EXPECTED_GROUP_SIZE);
    expect(deprecateCmds.map((c) => c.name).sort()).toEqual([...PACKAGES].sort());
  });

  it('the dist-tag argv moves the exact target version onto the exact tag', () => {
    const core = commands.find((c) => c.kind === 'dist-tag' && c.name === '@getknext/core');
    expect(core?.argv).toEqual([
      'npm',
      'dist-tag',
      'add',
      '@getknext/core@0.4.3',
      'latest',
      '--registry',
      'https://registry.npmjs.org/',
    ]);
  });

  it('the deprecate argv names the broken version, not the target', () => {
    const core = commands.find((c) => c.kind === 'deprecate' && c.name === '@getknext/core');
    expect(core?.argv[0]).toBe('npm');
    expect(core?.argv[1]).toBe('deprecate');
    expect(core?.argv[2]).toBe('@getknext/core@1.0.0');
    expect(core?.argv[3]).toContain('0.4.3');
  });

  it('respects a non-"latest" dist-tag — the rehearsal shape from issue #1673', () => {
    const rc = buildRollbackCommands({
      packageNames: PACKAGES,
      target: '0.4.3',
      broken: '1.0.0-rc.2',
      distTag: 'rc',
      registry: 'https://registry.npmjs.org/',
    });
    const distTagCmds = rc.filter((c) => c.kind === 'dist-tag');
    for (const cmd of distTagCmds) expect(cmd.argv).toContain('rc');
    expect(distTagCmds.every((c) => !c.argv.includes('latest'))).toBe(true);
  });
});

describe('executeCommands — aborts at the first failure and reports the partial state', () => {
  const commands = [
    {
      name: 'a',
      kind: 'dist-tag',
      argv: ['npm', 'dist-tag', 'add', 'a@1', 'latest'],
      description: 'a',
    },
    {
      name: 'b',
      kind: 'dist-tag',
      argv: ['npm', 'dist-tag', 'add', 'b@1', 'latest'],
      description: 'b',
    },
    {
      name: 'c',
      kind: 'dist-tag',
      argv: ['npm', 'dist-tag', 'add', 'c@1', 'latest'],
      description: 'c',
    },
  ];

  it('reports ok=true and every command completed when all succeed', () => {
    const { ok, completed, failed } = executeCommands(commands, () => ({ status: 0 }));
    expect(ok).toBe(true);
    expect(completed.length).toBe(3);
    expect(failed).toBeNull();
  });

  it('stops at the first non-zero exit and does not run the rest', () => {
    let calls = 0;
    const { ok, completed, failed } = executeCommands(commands, (argv) => {
      calls += 1;
      return { status: argv.includes('b@1') ? 1 : 0 };
    });
    expect(ok).toBe(false);
    expect(completed.length).toBe(1); // only "a" completed before "b" failed
    expect(failed?.name).toBe('b');
    expect(calls).toBe(2); // "c" was never invoked
  });
});

describe('fake-npm process wiring — the CLI end-to-end, no network', () => {
  let tmpDir: string;
  let fakeNpmPath: string;
  const REAL_PATH = process.env.PATH;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'knext-rollback-fake-npm-'));
    fakeNpmPath = join(tmpDir, 'npm');
    writeFileSync(
      fakeNpmPath,
      `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === 'view') {
  // Every version probed by the tests below resolves as published.
  process.stdout.write('0.4.3\\n');
  process.exit(0);
}
if (argv[0] === 'dist-tag' || argv[0] === 'deprecate') {
  process.exit(0);
}
process.exit(1);
`,
    );
    chmodSync(fakeNpmPath, 0o755);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a dry run (no --execute) prints the plan and exits 0 without invoking npm mutation commands', () => {
    const marker = join(tmpDir, 'ran.marker');
    // Fake npm records every dist-tag/deprecate invocation to a marker file so
    // the dry-run assertion below has real, not assumed, evidence.
    writeFileSync(
      fakeNpmPath,
      `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
if (argv[0] === 'view') { process.stdout.write('0.4.3\\n'); process.exit(0); }
if (argv[0] === 'dist-tag' || argv[0] === 'deprecate') {
  appendFileSync(${JSON.stringify(marker)}, argv[0] + '\\n');
  process.exit(0);
}
process.exit(1);
`,
    );
    chmodSync(fakeNpmPath, 0o755);

    const run = spawnSync(
      'node',
      [
        resolve(REPO_ROOT, 'scripts/npm-dist-tag-rollback.mjs'),
        '--to',
        '0.4.3',
        '--broken',
        '1.0.0',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${tmpDir}:${REAL_PATH}` },
      },
    );

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('DRY RUN');
    expect(run.stdout).toContain('dist-tag add');
    // The mutation commands must NEVER have actually run in a dry run — both
    // halves: the plan text is present above, AND no mutating call was made.
    const { existsSync } = require('node:fs');
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses (exit 1) when the rollback target is not published for one package', () => {
    writeFileSync(
      fakeNpmPath,
      `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === 'view') {
  const spec = argv[1];
  if (spec === '@getknext/db@0.4.3') process.exit(1); // simulate: not published
  process.stdout.write('0.4.3\\n');
  process.exit(0);
}
process.exit(0);
`,
    );
    chmodSync(fakeNpmPath, 0o755);

    const run = spawnSync(
      'node',
      [
        resolve(REPO_ROOT, 'scripts/npm-dist-tag-rollback.mjs'),
        '--to',
        '0.4.3',
        '--broken',
        '1.0.0',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${tmpDir}:${REAL_PATH}` },
      },
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('not published');
    expect(run.stderr).toContain('@getknext/db');
  });

  it('with --execute, actually invokes the fake npm dist-tag/deprecate commands and exits 0', () => {
    const marker = join(tmpDir, 'ran.marker');
    writeFileSync(
      fakeNpmPath,
      `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
if (argv[0] === 'view') { process.stdout.write('0.4.3\\n'); process.exit(0); }
if (argv[0] === 'dist-tag' || argv[0] === 'deprecate') {
  appendFileSync(${JSON.stringify(marker)}, argv[0] + ' ' + argv[1] + '\\n');
  process.exit(0);
}
process.exit(1);
`,
    );
    chmodSync(fakeNpmPath, 0o755);

    const run = spawnSync(
      'node',
      [
        resolve(REPO_ROOT, 'scripts/npm-dist-tag-rollback.mjs'),
        '--to',
        '0.4.3',
        '--broken',
        '1.0.0',
        '--execute',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${tmpDir}:${REAL_PATH}` },
      },
    );

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('All commands succeeded');
    const { readFileSync } = require('node:fs');
    const marked = readFileSync(marker, 'utf8');
    // All four dist-tag adds AND all four deprecates actually ran.
    expect((marked.match(/dist-tag/g) ?? []).length).toBe(EXPECTED_GROUP_SIZE);
    expect((marked.match(/deprecate/g) ?? []).length).toBe(EXPECTED_GROUP_SIZE);
  });
});
