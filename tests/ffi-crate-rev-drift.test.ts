import { afterAll, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * `scripts/check-ffi-crate-rev.mjs` (#2364): `knext ffi init` writes a crate
 * whose `knext-ffi` git dependency is pinned to `packages/ffi/package.json`
 * `knextFfi.crateRev`. A change under `crates/knext-ffi/` or
 * `crates/knext-ffi-macros/` that lands without moving that pin ships to
 * init'd zones only partially (the #2363 float refusal did exactly that).
 *
 * The rule (a PR cannot pin its own merge commit):
 *   - drift between the pin and the PR's MERGE BASE = an earlier crate change
 *     merged without a bump -> exit 1, naming the commit to pin;
 *   - crate changes made BY this PR -> a ::warning:: asking for the follow-up
 *     bump, exit 0 (otherwise every crate PR would be permanently red);
 *   - anything unresolvable (pin missing from history — a shallow checkout —
 *     or no merge base) -> exit 2, never a pass.
 *
 * Each case runs the real script as a child process against a throwaway git
 * repo, the way `ratchet-floor-guard-cli-e2e.test.ts` proves its guard.
 */

const REPO_ROOT = resolve(__dirname, '..');
const GUARD_SCRIPT = resolve(REPO_ROOT, 'scripts/check-ffi-crate-rev.mjs');

const tempRepos: string[] = [];

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function commitAll(dir: string, message: string): string {
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '--no-gpg-sign', '-qm', message], { cwd: dir, stdio: 'pipe' });
  return git(dir, 'rev-parse', 'HEAD').trim();
}

function write(dir: string, rel: string, body: string): void {
  const path = join(dir, rel);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

function setPin(dir: string, rev: string): void {
  write(
    dir,
    'packages/ffi/package.json',
    `${JSON.stringify({ name: '@getknext/ffi', private: true, knextFfi: { crateRev: rev } }, null, 2)}\n`,
  );
}

/** A repo whose `main` has the crates, pinned to the commit that wrote them. */
function makeRepo(): { dir: string; pinned: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ffi-crate-rev-drift-'));
  tempRepos.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  cpSync(GUARD_SCRIPT, join(dir, 'scripts', 'check-ffi-crate-rev.mjs'));
  write(dir, 'crates/knext-ffi/src/wire.rs', '// v1\n');
  write(dir, 'crates/knext-ffi-macros/src/lib.rs', '// v1\n');
  write(dir, 'crates/knext-ffi-fixture/src/lib.rs', '// v1\n');
  const pinned = commitAll(dir, 'crates v1');
  setPin(dir, pinned);
  commitAll(dir, 'pin crates v1');
  return { dir, pinned };
}

function runGuard(dir: string, env: Record<string, string>) {
  const clean = { ...process.env };
  delete clean.GITHUB_EVENT_NAME;
  delete clean.GITHUB_BASE_REF;
  delete clean.FFI_CRATE_REV_BASE_REF;
  const res = spawnSync('node', ['scripts/check-ffi-crate-rev.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...clean, ...env },
  });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

afterAll(() => {
  for (const dir of tempRepos) rmSync(dir, { recursive: true, force: true });
});

describe('scripts/check-ffi-crate-rev.mjs — crateRev must cover every merged crate change (#2364)', () => {
  it('passes when the crates at the merge base equal the crates at the pin', () => {
    const { dir } = makeRepo();
    git(dir, 'switch', '-qc', 'feature');
    write(dir, 'README.md', 'unrelated\n');
    commitAll(dir, 'unrelated');
    const { status, out } = runGuard(dir, { FFI_CRATE_REV_BASE_REF: 'main' });
    expect(status, out).toBe(0);
    expect(out).toMatch(/covers/);
  });

  it('fails when an earlier merged change to crates/knext-ffi/ was never pinned', () => {
    const { dir } = makeRepo();
    write(dir, 'crates/knext-ffi/src/wire.rs', '// v2 finite_float\n');
    const landed = commitAll(dir, 'crate change merged without a bump');
    git(dir, 'switch', '-qc', 'feature');
    write(dir, 'README.md', 'unrelated\n');
    commitAll(dir, 'unrelated');
    const { status, out } = runGuard(dir, { FFI_CRATE_REV_BASE_REF: 'main' });
    expect(status, out).toBe(1);
    expect(out).toContain('crates/knext-ffi/src/wire.rs');
    expect(out).toContain(landed);
  });

  it('fails on an unpinned change to crates/knext-ffi-macros/ too', () => {
    const { dir } = makeRepo();
    write(dir, 'crates/knext-ffi-macros/src/lib.rs', '// v2\n');
    commitAll(dir, 'macros change merged without a bump');
    git(dir, 'switch', '-qc', 'feature');
    const { status, out } = runGuard(dir, { FFI_CRATE_REV_BASE_REF: 'main' });
    expect(status, out).toBe(1);
    expect(out).toContain('crates/knext-ffi-macros/src/lib.rs');
  });

  it('ignores crates outside knext-ffi/ and knext-ffi-macros/ (the fixture is not a dependency of an init crate)', () => {
    const { dir } = makeRepo();
    write(dir, 'crates/knext-ffi-fixture/src/lib.rs', '// v2\n');
    commitAll(dir, 'fixture change');
    git(dir, 'switch', '-qc', 'feature');
    const { status, out } = runGuard(dir, { FFI_CRATE_REV_BASE_REF: 'main' });
    expect(status, out).toBe(0);
  });

  it('passes the bump PR that moves the pin onto the merged crate change', () => {
    const { dir } = makeRepo();
    write(dir, 'crates/knext-ffi/src/wire.rs', '// v2\n');
    const landed = commitAll(dir, 'crate change merged without a bump');
    git(dir, 'switch', '-qc', 'bump');
    setPin(dir, landed);
    commitAll(dir, 'bump crateRev');
    const { status, out } = runGuard(dir, { FFI_CRATE_REV_BASE_REF: 'main' });
    expect(status, out).toBe(0);
  });

  it('only WARNS on crate changes made by the PR itself (it cannot pin its own merge commit)', () => {
    const { dir } = makeRepo();
    git(dir, 'switch', '-qc', 'feature');
    write(dir, 'crates/knext-ffi/src/wire.rs', '// v2 in this PR\n');
    commitAll(dir, 'crate change in this PR');
    const { status, out } = runGuard(dir, { FFI_CRATE_REV_BASE_REF: 'main' });
    expect(status, out).toBe(0);
    expect(out).toContain('::warning');
    expect(out).toContain('crates/knext-ffi/src/wire.rs');
  });

  it('still fails a PR that changes the crates when the base already carries an unpinned change', () => {
    const { dir } = makeRepo();
    write(dir, 'crates/knext-ffi/src/wire.rs', '// v2\n');
    commitAll(dir, 'unpinned');
    git(dir, 'switch', '-qc', 'feature');
    write(dir, 'crates/knext-ffi-macros/src/lib.rs', '// v2 in this PR\n');
    commitAll(dir, 'crate change in this PR');
    const { status } = runGuard(dir, { FFI_CRATE_REV_BASE_REF: 'main' });
    expect(status).toBe(1);
  });

  it('push mode (GITHUB_EVENT_NAME=push) reports pin-vs-HEAD drift as a warning naming the commit to pin', () => {
    const { dir } = makeRepo();
    write(dir, 'crates/knext-ffi/src/wire.rs', '// v2\n');
    const landed = commitAll(dir, 'crate change pushed');
    const { status, out } = runGuard(dir, { GITHUB_EVENT_NAME: 'push' });
    expect(status, out).toBe(0);
    expect(out).toContain('::warning');
    expect(out).toContain(landed);
  });

  it('FAILS CLOSED (exit 2) when the pinned commit is not in the local history (shallow checkout)', () => {
    const { dir } = makeRepo();
    git(dir, 'switch', '-qc', 'feature');
    setPin(dir, 'f'.repeat(40));
    commitAll(dir, 'pin a commit this clone does not have');
    const { status, out } = runGuard(dir, { FFI_CRATE_REV_BASE_REF: 'main' });
    expect(status, out).toBe(2);
    expect(out).toMatch(/fetch-depth/);
  });

  it('FAILS CLOSED (exit 2) when the base ref cannot be resolved', () => {
    const { dir } = makeRepo();
    const { status, out } = runGuard(dir, { FFI_CRATE_REV_BASE_REF: 'origin/no-such-branch' });
    expect(status, out).toBe(2);
    expect(out).toContain('base ref origin/no-such-branch does not resolve');
  });

  it('FAILS CLOSED (exit 2) with no base ref and no push event (never compares HEAD with itself)', () => {
    const { dir } = makeRepo();
    const { status, out } = runGuard(dir, {});
    expect(status, out).toBe(2);
    expect(out).toMatch(/no base ref/);
  });

  it('fails a pin that is not a full 40-hex SHA', () => {
    const { dir } = makeRepo();
    setPin(dir, 'e48de68c4');
    commitAll(dir, 'short pin');
    const { status } = runGuard(dir, { FFI_CRATE_REV_BASE_REF: 'main' });
    expect(status).toBe(1);
  });

  it('fails a pin that is not an ancestor of HEAD', () => {
    const { dir, pinned } = makeRepo();
    git(dir, 'switch', '-qc', 'side');
    write(dir, 'side.txt', 'x\n');
    const side = commitAll(dir, 'side');
    git(dir, 'switch', '-q', 'main');
    git(dir, 'switch', '-qc', 'feature');
    setPin(dir, side);
    commitAll(dir, 'pin a commit off this branch');
    expect(side).not.toBe(pinned);
    const { status, out } = runGuard(dir, { FFI_CRATE_REV_BASE_REF: 'main' });
    expect(status, out).toBe(1);
  });
});

describe('.github/workflows/rust-crates.yml — the guard runs with the history it needs (#2364)', () => {
  const wf = readFileSync(resolve(REPO_ROOT, '.github/workflows/rust-crates.yml'), 'utf8');
  const job = wf.slice(wf.indexOf('\n  crate-rev:'));

  it('has a crate-rev job that runs the guard', () => {
    expect(wf).toContain('\n  crate-rev:');
    expect(job).toContain('node scripts/check-ffi-crate-rev.mjs');
  });

  it('checks out full history (the pin and the merge base must both resolve)', () => {
    const run = job.indexOf('node scripts/check-ffi-crate-rev.mjs');
    expect(job.slice(0, run)).toMatch(/fetch-depth:\s*0\b/);
  });

  it('runs no step with continue-on-error (a red guard must red the lane)', () => {
    expect(job).not.toMatch(/continue-on-error/);
  });
});
