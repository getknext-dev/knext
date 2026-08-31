import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The `kn-next` alias package (ergonomics ledger finding 1a): the bare name a
 * novice types (`npx kn-next`) 404'd because only @getknext/core exists on
 * npm. The alias owns the bare name and forwards to core's bin.
 *
 * These tests run the REAL shim against the workspace-linked @getknext/core —
 * behavioural, not shape-only: forwarding, exit codes, and version parity are
 * each asserted by executing the bin.
 */
const REPO_ROOT = resolve(import.meta.dirname, '..');
const ALIAS_DIR = join(REPO_ROOT, 'packages', 'kn-next-alias');
const SHIM = join(ALIAS_DIR, 'bin', 'kn-next.js');

function runShim(args: string[]) {
  return spawnSync(process.execPath, [SHIM, ...args], {
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

describe('kn-next alias package (finding 1a)', () => {
  const aliasPkg = JSON.parse(readFileSync(join(ALIAS_DIR, 'package.json'), 'utf-8'));
  const corePkg = JSON.parse(
    readFileSync(join(REPO_ROOT, 'packages', 'kn-next', 'package.json'), 'utf-8'),
  );

  it('owns the bare name and points its bin at the shim', () => {
    expect(aliasPkg.name).toBe('kn-next');
    expect(aliasPkg.bin['kn-next']).toBe('bin/kn-next.js');
    expect(aliasPkg.dependencies['@getknext/core']).toBeDefined();
    // The tarball must carry the shim: `files` allowlist includes bin.
    expect(aliasPkg.files).toContain('bin');
  });

  it('tracks the core version — the two publish in lockstep', () => {
    expect(aliasPkg.version).toBe(corePkg.version);
  });

  it('forwards --version to the real CLI (behavioural parity)', () => {
    const r = runShim(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(corePkg.version);
  });

  it('preserves the exit code and output of a failing invocation', () => {
    const r = runShim(['definitely-not-a-verb']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown command');
  });

  // NOTE, recorded rather than papered over: there is deliberately NO
  // "run the shim where core is unresolvable" test. Node resolution walks
  // every ancestor directory, so isolating a copied shim is environment-
  // dependent (a first attempt found a linked core via the walk and ran the
  // real CLI). The catch branch is five lines; its user-facing contract is
  // pinned by the message test below, and the resolution strategy itself is
  // exercised for real by the passing-path tests above.

  it('the failure message names both remedies (contract of the catch branch)', () => {
    const src = readFileSync(SHIM, 'utf-8');
    expect(src).toContain('npm install @getknext/core');
    expect(src).toContain('npx @getknext/core');
    // and the resolution strategy documents WHY it walks up (exports map).
    expect(src).toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');
  });
});
