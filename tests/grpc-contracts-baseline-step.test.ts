import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * The `buf breaking` step of ci.yml's grpc-contracts job (#2047) must FAIL
 * CLOSED. The one case allowed to pass without comparing is a base commit
 * that resolves and genuinely has no `packages/grpc` (the PR that introduced
 * the package). An empty, all-zero or unresolvable base is an error, never a
 * "nothing to compare".
 *
 * The step's own script is extracted from ci.yml and executed with `bash -e`
 * (the Actions default) in a throwaway git repository, with a fake `bun` on
 * PATH that records whether the comparison was reached.
 */

const ROOT = resolve(import.meta.dirname, '..');
const STEP_NAME = 'buf breaking (the knext options contract, against the base commit)';

interface Step {
  name?: string;
  run?: string;
  'working-directory'?: string;
}
const workflow = parse(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, { steps: Step[] }>;
};
const step = workflow.jobs['grpc-contracts']?.steps.find((s) => s.name === STEP_NAME);

const scratchDirs: string[] = [];
afterAll(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repo with commit A (no packages/grpc) and commit B (with it). */
function fixtureRepo(): {
  repo: string;
  withoutGrpc: string;
  withGrpc: string;
  bunLog: string;
  bin: string;
} {
  const repo = mkdtempSync(join(tmpdir(), 'knext-grpc-ci-step-'));
  scratchDirs.push(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@example.invalid');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), 'x\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'A');
  const withoutGrpc = git(repo, 'rev-parse', 'HEAD');
  mkdirSync(join(repo, 'packages', 'grpc'), { recursive: true });
  writeFileSync(join(repo, 'packages', 'grpc', 'buf.yaml'), 'version: v2\n');
  git(repo, 'add', 'packages/grpc/buf.yaml');
  git(repo, 'commit', '-q', '-m', 'B');
  const withGrpc = git(repo, 'rev-parse', 'HEAD');

  const bin = join(repo, '.fakebin');
  mkdirSync(bin);
  const bunLog = join(repo, '.bun-calls');
  writeFileSync(join(bin, 'bun'), `#!/bin/sh\necho "$@" >> '${bunLog}'\nexit 0\n`);
  chmodSync(join(bin, 'bun'), 0o755);
  return { repo, withoutGrpc, withGrpc, bunLog, bin };
}

function runWith(base: 'WITHOUT' | 'WITH' | string) {
  const fx = fixtureRepo();
  const sha = base === 'WITHOUT' ? fx.withoutGrpc : base === 'WITH' ? fx.withGrpc : base;
  const r = spawnSync('bash', ['-e', '-c', step?.run ?? 'exit 99'], {
    cwd: join(fx.repo, step?.['working-directory'] ?? '.'),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fx.bin}:${process.env.PATH}`, BASE_SHA: sha },
  });
  const calls = existsSync(fx.bunLog) ? readFileSync(fx.bunLog, 'utf8') : '';
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls, sha };
}

describe('grpc-contracts: the buf breaking baseline step fails closed', () => {
  it('the step exists, runs in packages/grpc, and reads BASE_SHA', () => {
    expect(step, `ci.yml grpc-contracts must have the step "${STEP_NAME}"`).toBeDefined();
    expect(step?.['working-directory']).toBe('packages/grpc');
    expect(step?.run).toContain('BASE_SHA');
  });

  it('a base that has packages/grpc runs the comparison against that commit', () => {
    const { status, calls, sha, out } = runWith('WITH');
    expect(status, out).toBe(0);
    expect(calls).toContain('scripts/verified-buf.ts breaking --against');
    expect(calls).toContain(`ref=${sha},subdir=packages/grpc`);
  });

  it('a base that resolves and predates packages/grpc passes without comparing, and says so', () => {
    const { status, calls, out } = runWith('WITHOUT');
    expect(status, out).toBe(0);
    expect(out).toContain('predates packages/grpc');
    expect(calls).toBe('');
  });

  it.each([
    ['an unresolvable commit', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
    ['the all-zero sha of a new-branch push', '0000000000000000000000000000000000000000'],
    ['an empty base', ''],
    ['a garbage ref', 'not-a-ref'],
  ])('%s FAILS, without claiming the package is absent', (_label, base) => {
    const { status, calls, out } = runWith(base);
    expect(status, out).not.toBe(0);
    expect(out).not.toContain('predates packages/grpc');
    expect(calls).toBe('');
  });
});
