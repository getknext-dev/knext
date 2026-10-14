/**
 * The host build behind `knext ffi generate` and `knext ffi check`: a plain
 * `cargo build --release` of the zone's crate, for the machine it runs on. Its
 * only job is to produce a library whose embedded manifest (ADR-0069 D5) can be
 * scanned, and the development build `next dev` loads (D13 path 2). Image
 * builds cross-compile through `knext ffi build` instead (D14).
 *
 * Everything that knows Rust lives in this package; core never runs cargo.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { FfiUsageError } from './config';

interface Artifact {
  reason?: unknown;
  manifest_path?: unknown;
  target?: { kind?: unknown; crate_types?: unknown };
  filenames?: unknown;
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * The zone crate's cdylib, from `cargo build --message-format=json` output.
 * `cargoToml` is the crate's own Cargo.toml: a workspace member that also
 * builds a cdylib is not the zone's library.
 */
export function pickCdylib(stdout: string, cargoToml: string): string {
  const want = real(cargoToml);
  const found: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let msg: Artifact;
    try {
      msg = JSON.parse(line) as Artifact;
    } catch {
      continue;
    }
    if (msg.reason !== 'compiler-artifact' || typeof msg.manifest_path !== 'string') continue;
    if (real(msg.manifest_path) !== want) continue;
    const kinds = [msg.target?.kind, msg.target?.crate_types].flatMap((k) =>
      Array.isArray(k) ? k : [],
    );
    if (!kinds.includes('cdylib') || !Array.isArray(msg.filenames)) continue;
    for (const f of msg.filenames) {
      if (typeof f === 'string' && /\.(so|dylib)$/.test(f)) found.push(f);
    }
  }
  if (found.length === 0) {
    throw new FfiUsageError(
      `the crate at ${cargoToml} builds no cdylib for this host. Set crate-type = ["cdylib"] under [lib] in its Cargo.toml.`,
    );
  }
  return found[found.length - 1] as string;
}

/**
 * `cargo build --release` in `crateDir`; returns the built library's path.
 * Cargo's own diagnostics go to the user's terminal (stderr is inherited).
 */
export function hostBuild(crateDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const r = spawnSync('cargo', ['build', '--release', '--message-format=json-render-diagnostics'], {
    cwd: crateDir,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) {
    if ((r.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FfiUsageError(
        'cargo was not found on PATH. Install Rust from https://rustup.rs (the crate’s rust-toolchain.toml selects the version), then run this again.',
      );
    }
    throw new FfiUsageError(`could not run cargo: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new FfiUsageError(`cargo build failed (exit ${r.status}); see its errors above.`);
  }
  return pickCdylib(r.stdout, join(crateDir, 'Cargo.toml'));
}
