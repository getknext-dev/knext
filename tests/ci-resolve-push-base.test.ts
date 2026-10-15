import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { resolvePushBase } from '../scripts/ci-resolve-push-base.mjs';

/**
 * A push that CREATES a branch carries an all-zero `github.event.before`
 * (#2381). ci.yml runs on push to `integration/**`, so the first push of a new
 * release line handed that zero sha to `grpc-contracts` (buf breaking) and to
 * `file-manager-e2e-round` (the path-scoping diff). Both fail closed on an
 * unresolvable base, so every new line's first run was red.
 *
 * `scripts/ci-resolve-push-base.mjs` resolves the base for both. On a
 * branch-creation push it falls back to the merge-base with `origin/main`
 * (fetching it when the checkout lacks it). Every other base passes through
 * unchanged, so the consumers' fail-closed checks still see an empty,
 * all-zero or unresolvable base as the error it is.
 */

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts/ci-resolve-push-base.mjs');
const ZERO = '0'.repeat(40);

const scratchDirs: string[] = [];
afterAll(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(repo: string, file: string, msg: string): string {
  writeFileSync(join(repo, file), `${msg}\n`);
  git(repo, 'add', file);
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg);
  return git(repo, 'rev-parse', 'HEAD');
}

/**
 * `origin` has main = A, B. The clone checks out a new `integration/v9` branch
 * from B with one more commit C, and main moves on to D upstream afterwards,
 * so the merge-base (B) differs from both HEAD and origin/main's tip.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'knext-push-base-'));
  scratchDirs.push(dir);
  const origin = join(dir, 'origin');
  git(dir, 'init', '-q', '-b', 'main', origin);
  git(origin, 'config', 'user.email', 't@example.invalid');
  git(origin, 'config', 'user.name', 't');
  commit(origin, 'a.txt', 'A');
  const forkPoint = commit(origin, 'b.txt', 'B');
  const clone = join(dir, 'clone');
  git(dir, 'clone', '-q', origin, clone);
  git(clone, 'config', 'user.email', 't@example.invalid');
  git(clone, 'config', 'user.name', 't');
  git(clone, 'switch', '-q', '-c', 'integration/v9');
  const head = commit(clone, 'c.txt', 'C');
  commit(origin, 'd.txt', 'D');
  return { dir, origin, clone, forkPoint, head };
}

const created = (before = ZERO) => ({ eventName: 'push', created: 'true', before });

describe('resolvePushBase: a branch-creation push falls back to the merge-base with main', () => {
  it('uses the merge-base with origin/main, not the zero sha, HEAD or main tip', () => {
    const fx = fixture();
    const r = resolvePushBase({ ...created(), cwd: fx.clone });
    expect(r.sha).toBe(fx.forkPoint);
    expect(r.sha).not.toBe(fx.head);
    expect(r.reason).toMatch(/merge-base/);
  });

  it('fetches origin/main when the checkout does not have it', () => {
    const fx = fixture();
    git(fx.clone, 'update-ref', '-d', 'refs/remotes/origin/main');
    const r = resolvePushBase({ ...created(), cwd: fx.clone });
    expect(r.sha).toBe(fx.forkPoint);
    expect(git(fx.clone, 'rev-parse', '--verify', 'refs/remotes/origin/main')).toBeTruthy();
  });

  it('FAILS when main cannot be fetched (no silent pass)', () => {
    const fx = fixture();
    git(fx.clone, 'update-ref', '-d', 'refs/remotes/origin/main');
    git(fx.clone, 'remote', 'set-url', 'origin', join(fx.dir, 'nowhere'));
    expect(() => resolvePushBase({ ...created(), cwd: fx.clone })).toThrow(/origin\/main/);
  });

  it('FAILS when the branch shares no history with main', () => {
    const fx = fixture();
    git(fx.clone, 'switch', '-q', '--orphan', 'integration/v10');
    commit(fx.clone, 'z.txt', 'Z');
    expect(() => resolvePushBase({ ...created(), cwd: fx.clone })).toThrow(/merge-base/);
  });
});

describe('resolvePushBase: every other base passes through for the consumer to fail closed on', () => {
  it.each([
    ['an all-zero before on a push that did NOT create the branch', 'push', 'false', ZERO],
    ['an empty base on a push', 'push', 'false', ''],
    ['an unresolvable base on a push', 'push', 'false', 'deadbeef'.repeat(5)],
    ['a created push whose before is not zero', 'push', 'true', 'deadbeef'.repeat(5)],
    ['a created flag on a pull_request event', 'pull_request', 'true', ZERO],
    ['an ordinary pull_request base', 'pull_request', '', 'abc123'],
  ])('%s', (_label, eventName, isCreated, before) => {
    const fx = fixture();
    const r = resolvePushBase({ eventName, created: isCreated, before, cwd: fx.clone });
    expect(r.sha).toBe(before);
    expect(r.reason).toMatch(/pass/);
  });
});

describe('the CLI writes the step output and fails closed', () => {
  function runCli(cwd: string, env: Record<string, string>) {
    const out = join(cwd, '..', `gh-output-${Math.random().toString(36).slice(2)}`);
    writeFileSync(out, '');
    const r = spawnSync('node', [SCRIPT], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: out, ...env },
    });
    return { status: r.status, log: `${r.stdout}${r.stderr}`, output: readFileSync(out, 'utf8') };
  }

  it('a created push writes sha=<merge-base> to GITHUB_OUTPUT', () => {
    const fx = fixture();
    const r = runCli(fx.clone, { EVENT_NAME: 'push', PUSH_CREATED: 'true', RAW_BASE_SHA: ZERO });
    expect(r.status, r.log).toBe(0);
    expect(r.output).toBe(`sha=${fx.forkPoint}\n`);
  });

  it('a pass-through writes the raw base unchanged', () => {
    const fx = fixture();
    const r = runCli(fx.clone, { EVENT_NAME: 'push', PUSH_CREATED: 'false', RAW_BASE_SHA: ZERO });
    expect(r.status, r.log).toBe(0);
    expect(r.output).toBe(`sha=${ZERO}\n`);
  });

  it('an unresolvable fallback exits non-zero and writes no output', () => {
    const fx = fixture();
    git(fx.clone, 'update-ref', '-d', 'refs/remotes/origin/main');
    git(fx.clone, 'remote', 'set-url', 'origin', join(fx.dir, 'nowhere'));
    const r = runCli(fx.clone, { EVENT_NAME: 'push', PUSH_CREATED: 'true', RAW_BASE_SHA: ZERO });
    expect(r.status).not.toBe(0);
    expect(r.log).toContain('::error::');
    expect(r.output).toBe('');
  });
});

describe('ci.yml wires the resolver into both base consumers', () => {
  type Step = {
    id?: string;
    name?: string;
    run?: string;
    uses?: string;
    env?: Record<string, string>;
  };
  const ci = parse(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const CONSUMERS: Record<string, string> = {
    'grpc-contracts': 'buf breaking (the knext options contract, against the base commit)',
    'file-manager-e2e-round': 'Assert every e2e-round leg concluded success (path-scoped)',
  };

  it.each(Object.entries(CONSUMERS))('%s resolves its base before using it', (jobId, consumer) => {
    const steps = ci.jobs[jobId]?.steps ?? [];
    const resolverIdx = steps.findIndex((s) => s.run?.includes('scripts/ci-resolve-push-base.mjs'));
    const consumerIdx = steps.findIndex((s) => s.name === consumer);
    const checkoutIdx = steps.findIndex((s) => s.uses?.startsWith('actions/checkout@'));
    expect(resolverIdx, `${jobId}: no resolver step`).toBeGreaterThan(-1);
    expect(consumerIdx, `${jobId}: consumer step missing`).toBeGreaterThan(-1);
    expect(resolverIdx).toBeGreaterThan(checkoutIdx);
    expect(resolverIdx).toBeLessThan(consumerIdx);

    const resolver = steps[resolverIdx];
    expect(resolver.id).toBeTruthy();
    expect(resolver.env?.EVENT_NAME).toBe('${{ github.event_name }}');
    expect(resolver.env?.PUSH_CREATED).toBe('${{ github.event.created }}');
    expect(resolver.env?.RAW_BASE_SHA).toContain('github.event.before');
    expect(steps[consumerIdx].env?.BASE_SHA).toBe(`\${{ steps.${resolver.id}.outputs.sha }}`);
  });
});
