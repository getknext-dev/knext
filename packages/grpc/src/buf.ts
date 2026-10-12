/**
 * The pinned, checksum-verified `buf` binary.
 *
 * buf arrives through npm: `@bufbuild/buf` (an exact dependency of this
 * package) pulls the binary for the current platform from a per-platform
 * package. That pins the VERSION and, through the lockfile's integrity hash,
 * the tarball. This module adds the CHECKSUM half: the sha256 of every
 * supported platform's binary is recorded below and checked before buf first
 * runs in a process, so a corrupted or substituted install is refused rather
 * than executed.
 *
 * What the check does NOT cover, stated rather than implied: the verified
 * result is cached per process, keyed on path + size + mtime, so a binary
 * replaced by one of the same size with its mtime restored, during a single
 * `knext generate` run, is not re-hashed. Re-hashing on every exec would cost
 * ~40-130 ms per call (the binary is ~53 MB) and still leave a gap between the
 * hash and the spawn. Either way the attacker needs write access to
 * node_modules, where they could equally rewrite this file, so the checksum
 * is an install-integrity check, not a defence against a live local attacker.
 *
 * The digests were taken from the npm tarballs and match the `sha256.txt` buf
 * publishes with the same GitHub release (v1.73.0). A version bump changes the
 * dependency, `BUF_VERSION` and all four digests in one edit;
 * `buf-pin.test.ts` reds if any of them disagree with each other or with the
 * installed binary.
 *
 * Only the npm route is used. buf's own `bin/buf` shim and its postinstall
 * script are bypassed: the platform package is resolved directly.
 */

import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const BUF_VERSION = '1.73.0';

/** Supported platforms: the npm package carrying the binary, and its sha256. */
export const BUF_SHA256 = {
  'darwin-arm64': {
    npmPackage: '@bufbuild/buf-darwin-arm64',
    sha256: '6e6df0fef4522e4e43dfe7c341873c3f2c29ceb45a9dfa5e0bad5580b8b2022f',
  },
  'darwin-x64': {
    npmPackage: '@bufbuild/buf-darwin-x64',
    sha256: 'ff78d0ebf34180ebfa81d370275851ec630fcb088bf33e213fd723d0fd7444a6',
  },
  'linux-arm64': {
    npmPackage: '@bufbuild/buf-linux-aarch64',
    sha256: '902b75267db7f4391e99b7fa0756050e5354234cc0437ef50eee9c788950c7a3',
  },
  'linux-x64': {
    npmPackage: '@bufbuild/buf-linux-x64',
    sha256: '8f2986298ad08f0cc1bf999b9797b7c383adf32d7edf0f73d6f1e1a701baeac1',
  },
} as const;

export type BufPlatform = keyof typeof BUF_SHA256;

/** Thrown when the buf binary on disk is not the pinned one. */
export class BufIntegrityError extends Error {
  override name = 'BufIntegrityError';
}

/** The pin key for a platform/arch pair, or `undefined` if unsupported. */
export function bufPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): BufPlatform | undefined {
  const key = `${platform}-${arch}`;
  return Object.hasOwn(BUF_SHA256, key) ? (key as BufPlatform) : undefined;
}

/** Fail unless the file's sha256 equals `expected`. */
export function verifyBufBinary(path: string, expected: string): void {
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (digest !== expected) {
    throw new BufIntegrityError(
      `the buf binary at ${path} does not match the pinned sha256 for buf ${BUF_VERSION} ` +
        `(expected ${expected}, got ${digest}). Reinstall dependencies; do not run it.`,
    );
  }
}

/**
 * Verified paths, keyed by path + size + mtime, so a run hashes buf once. See
 * the module comment for what this cache does not catch.
 */
const verified = new Map<string, string>();

export interface ResolveOptions {
  readonly platform?: string;
  readonly arch?: string;
  /**
   * The file module resolution starts from (default: this module). Tests point
   * it at a throwaway install tree to exercise the real resolve-and-verify path.
   */
  readonly from?: string;
}

/**
 * Locate the installed buf binary for this platform and verify it against the
 * pin. Throws on an unsupported platform, a missing install, a version other
 * than the pinned one, or a checksum mismatch.
 */
export function resolveBufBinary(opts: ResolveOptions = {}): string {
  const platform = bufPlatform(opts.platform, opts.arch);
  if (!platform) {
    throw new Error(
      `buf is not supported on ${opts.platform ?? process.platform}-${opts.arch ?? process.arch} ` +
        `by knext (supported: ${Object.keys(BUF_SHA256).join(', ')}).`,
    );
  }
  const { npmPackage, sha256 } = BUF_SHA256[platform];
  const require = createRequire(opts.from ?? import.meta.url);
  let manifestPath: string;
  try {
    const bufManifest = require.resolve('@bufbuild/buf/package.json');
    manifestPath = createRequire(bufManifest).resolve(`${npmPackage}/package.json`);
  } catch {
    throw new Error(
      `the buf binary package ${npmPackage}@${BUF_VERSION} is not installed. ` +
        'Install dependencies again (optional dependencies must not be omitted).',
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string };
  if (manifest.version !== BUF_VERSION) {
    throw new BufIntegrityError(
      `${npmPackage} is ${manifest.version ?? 'unversioned'}, but knext pins buf ${BUF_VERSION}.`,
    );
  }
  const bin = join(dirname(manifestPath), 'bin', 'buf');
  const st = statSync(bin);
  const key = `${bin}:${st.size}:${st.mtimeMs}`;
  if (verified.get(bin) !== key) {
    verifyBufBinary(bin, sha256);
    verified.set(bin, key);
  }
  return bin;
}

export interface RunBufOptions {
  readonly cwd: string;
  /** Bytes for buf's stdin, if any. */
  readonly input?: Buffer;
  /** Where to resolve the binary from; see {@link ResolveOptions}. */
  readonly resolve?: ResolveOptions;
}

export type BufResult = Pick<SpawnSyncReturns<Buffer>, 'status' | 'stdout'> & {
  readonly stderr: string;
};

/**
 * Run the verified buf with `args`: the binary is resolved and checked against
 * the pin first, and a mismatch throws before anything is executed. stdout
 * stays bytes (images are binary).
 */
export function runBuf(args: readonly string[], opts: RunBufOptions): BufResult {
  const bin = resolveBufBinary(opts.resolve);
  const r = spawnSync(bin, [...args], {
    cwd: opts.cwd,
    input: opts.input,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr.toString() };
}
