import { afterAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  BUF_SHA256,
  BUF_VERSION,
  BufIntegrityError,
  bufPlatform,
  resolveBufBinary,
  runBuf,
  verifyBufBinary,
} from '../buf';

const PKG_DIR = resolve(import.meta.dir, '..', '..');
const REPO_ROOT = resolve(PKG_DIR, '..', '..');

const scratchDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'knext-grpc-bufpin-'));
  scratchDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * buf is pinned twice over: by VERSION (an exact npm dependency, so the
 * lockfile's integrity hash covers the tarball) and by CHECKSUM (the sha256 of
 * each platform binary, which must also match buf's own release sha256.txt).
 * The binary is verified before every run, so a swapped binary on disk is
 * refused rather than executed.
 */
describe('buf pin — version and checksum', () => {
  it('pins an exact version, the same one the package depends on', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(BUF_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies['@bufbuild/buf']).toBe(BUF_VERSION);
  });

  it('every pinned platform is in the lockfile at the pinned version', () => {
    const lock = readFileSync(join(REPO_ROOT, 'bun.lock'), 'utf8');
    for (const npmName of Object.values(BUF_SHA256).map((p) => p.npmPackage)) {
      expect(lock, npmName).toContain(`"${npmName}@${BUF_VERSION}"`);
    }
  });

  it('carries a sha256 for each supported platform, and nothing else', () => {
    expect(Object.keys(BUF_SHA256).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
    ]);
    for (const { sha256 } of Object.values(BUF_SHA256)) expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the binary installed on this machine matches its pinned checksum', () => {
    const bin = resolveBufBinary();
    const digest = createHash('sha256').update(readFileSync(bin)).digest('hex');
    const platform = bufPlatform();
    expect(platform).toBeDefined();
    expect(digest).toBe(BUF_SHA256[platform as keyof typeof BUF_SHA256].sha256);
  });

  it('runs the pinned version', () => {
    const r = runBuf(['--version'], { cwd: PKG_DIR });
    expect(r.status).toBe(0);
    expect(r.stdout.toString().trim()).toBe(BUF_VERSION);
  });

  /**
   * A throwaway install tree laid out like node_modules: `@bufbuild/buf` plus
   * this platform's binary package, holding `binary` as `bin/buf`. runBuf
   * resolves from it exactly as it resolves from the real install.
   */
  function fakeInstall(binary: Buffer | string): { root: string; from: string } {
    const root = scratch();
    const platform = bufPlatform() as keyof typeof BUF_SHA256;
    const { npmPackage } = BUF_SHA256[platform];
    const bufDir = join(root, 'node_modules', '@bufbuild', 'buf');
    const platDir = join(root, 'node_modules', ...npmPackage.split('/'));
    mkdirSync(bufDir, { recursive: true });
    mkdirSync(join(platDir, 'bin'), { recursive: true });
    writeFileSync(
      join(bufDir, 'package.json'),
      JSON.stringify({ name: '@bufbuild/buf', version: BUF_VERSION }),
    );
    writeFileSync(
      join(platDir, 'package.json'),
      JSON.stringify({ name: npmPackage, version: BUF_VERSION }),
    );
    writeFileSync(join(platDir, 'bin', 'buf'), binary);
    chmodSync(join(platDir, 'bin', 'buf'), 0o755);
    return { root, from: join(root, 'index.js') };
  }

  it('runBuf runs a genuine binary from an install tree (control for the case below)', () => {
    const { root, from } = fakeInstall(readFileSync(resolveBufBinary()));
    const r = runBuf(['--version'], { cwd: root, resolve: { from } });
    expect(r.status).toBe(0);
    expect(r.stdout.toString().trim()).toBe(BUF_VERSION);
  });

  it('runBuf refuses a tampered binary on the real resolve path, BEFORE executing it', () => {
    const marker = join(scratch(), 'tampered-binary-ran');
    const { root, from } = fakeInstall(`#!/bin/sh\ntouch '${marker}'\n`);
    expect(() => runBuf(['--version'], { cwd: root, resolve: { from } })).toThrow(
      BufIntegrityError,
    );
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses a binary whose bytes differ from the pin', () => {
    const tampered = join(scratch(), 'buf');
    copyFileSync(resolveBufBinary(), tampered);
    appendFileSync(tampered, Buffer.from([0]));
    const platform = bufPlatform() as keyof typeof BUF_SHA256;
    expect(() => verifyBufBinary(tampered, BUF_SHA256[platform].sha256)).toThrow(BufIntegrityError);
    expect(() => verifyBufBinary(tampered, BUF_SHA256[platform].sha256)).toThrow(/sha256/);
  });

  it('refuses an unsupported platform instead of running something unverified', () => {
    expect(bufPlatform('win32', 'x64')).toBeUndefined();
    expect(bufPlatform('linux', 'arm')).toBeUndefined();
    expect(() => resolveBufBinary({ platform: 'win32', arch: 'x64' })).toThrow(/not supported/);
  });
});
