/**
 * The host `cargo build` behind `knext ffi generate` / `check`: which artifact
 * is the zone's library, and plain messages when cargo is missing or fails.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostBuild, pickCdylib } from '../cargo';
import { FfiUsageError } from '../config';
import { emptyDir, removeScratchDirs } from './helpers';

afterAll(removeScratchDirs);

const artifact = (manifest: string, kinds: string[], filenames: string[]) =>
  JSON.stringify({
    reason: 'compiler-artifact',
    manifest_path: manifest,
    target: { kind: kinds, crate_types: kinds, name: 'x' },
    filenames,
  });

describe('pickCdylib', () => {
  const crate = '/app/rust/Cargo.toml';

  it('picks the cdylib of the zone crate, ignoring dependencies and non-artifact lines', () => {
    const lines = [
      JSON.stringify({ reason: 'build-script-executed' }),
      artifact('/registry/serde/Cargo.toml', ['lib'], ['/t/libserde.rlib']),
      artifact(crate, ['lib', 'cdylib'], ['/t/libzone.rlib', '/t/libzone.dylib']),
      'not json',
      JSON.stringify({ reason: 'build-finished', success: true }),
    ];
    expect(pickCdylib(lines.join('\n'), crate)).toBe('/t/libzone.dylib');
  });

  it('accepts a .so', () => {
    expect(pickCdylib(artifact(crate, ['cdylib'], ['/t/libzone.so']), crate)).toBe('/t/libzone.so');
  });

  it('no cdylib: says to set crate-type = ["cdylib"]', () => {
    expect(() => pickCdylib(artifact(crate, ['lib'], ['/t/libzone.rlib']), crate)).toThrow(
      /builds no cdylib.*crate-type = \["cdylib"\]/,
    );
  });

  it('a workspace that builds a cdylib elsewhere is not the zone library', () => {
    expect(() =>
      pickCdylib(artifact('/app/rust/other/Cargo.toml', ['cdylib'], ['/t/libother.so']), crate),
    ).toThrow(FfiUsageError);
  });
});

describe('hostBuild', () => {
  function crateDir(): string {
    const dir = join(emptyDir('crate'), 'rust');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "zone"\n');
    return dir;
  }
  function fakeCargo(script: string): string {
    const bin = emptyDir('bin');
    const p = join(bin, 'cargo');
    writeFileSync(p, `#!/bin/sh\n${script}\n`);
    chmodSync(p, 0o755);
    return bin;
  }

  it('missing cargo is a usage error naming rustup', () => {
    expect(() => hostBuild(crateDir(), { PATH: emptyDir('empty-path') })).toThrow(
      /cargo was not found on PATH\. Install Rust from https:\/\/rustup\.rs/,
    );
  });

  it('runs cargo build --release with JSON messages in the crate and returns the cdylib', () => {
    const dir = crateDir();
    const bin = fakeCargo(
      `echo "$PWD|$*" > "$PWD/args.txt"\n` +
        `printf '%s\\n' '${artifact(join(dir, 'Cargo.toml'), ['cdylib'], ['/t/libzone.so'])}'`,
    );
    expect(hostBuild(dir, { PATH: `${bin}:/usr/bin:/bin` })).toBe('/t/libzone.so');
  });

  it('a failing build is a usage error with the exit code', () => {
    const bin = fakeCargo('echo "error[E0425]: oops" >&2\nexit 101');
    expect(() => hostBuild(crateDir(), { PATH: `${bin}:/usr/bin:/bin` })).toThrow(
      /cargo build failed \(exit 101\)/,
    );
  });
});
