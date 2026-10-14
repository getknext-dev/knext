/**
 * `knext ffi build --target <triple>… --native-dir <dir>` (ADR-0069 D14 steps
 * 1–5): cross-build with cargo zigbuild, the libc check, staging under
 * `native/ffi/<triple>/` with provenance, and the drift check against the
 * committed wrapper.
 *
 * Every program is run through an injected runner, so these tests need no
 * Rust toolchain: the fake `cargo zigbuild` "builds" by copying a real musl
 * (or glibc) fixture library with a manifest blob appended, and prints the
 * compiler-artifact line cargo would. The real cross-build is FFI-4's job.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Runner, runBuild, SUPPORTED_TARGETS } from '../build';
import { serializeConfig } from '../config';
import { generateFiles } from '../generate';
import {
  blob,
  capture,
  D,
  emptyDir,
  fn,
  KITCHEN_SINK,
  PKG_DIR,
  removeScratchDirs,
} from './helpers';

afterAll(removeScratchDirs);

const X64 = 'x86_64-unknown-linux-musl';
const ARM64 = 'aarch64-unknown-linux-musl';
const elf = (name: string) => readFileSync(join(PKG_DIR, 'fixtures', 'elf', name));
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

const CARGO_LOCK = `version = 4

[[package]]
name = "knext-ffi"
version = "0.1.0"
source = "git+https://github.com/getknext-dev/knext?rev=0123456789abcdef0123456789abcdef01234567#0123456789abcdef0123456789abcdef01234567"

[[package]]
name = "zone"
version = "0.3.1"
`;

interface Call {
  cmd: string;
  args: string[];
  cwd: string;
  rustflags: string | undefined;
}

/**
 * An app with knext.ffi.json, a crate, and a committed wrapper generated from
 * `records`. `libFor(triple)` is what the fake cross-build produces.
 */
function app(
  opts: {
    records?: Record<string, unknown>[];
    committed?: Record<string, unknown>[] | null;
    libFor?: (triple: string) => Uint8Array;
    missing?: 'cargo' | 'zigbuild' | 'zig' | 'rustup' | 'target';
    buildFails?: boolean;
  } = {},
) {
  const cwd = emptyDir('build');
  const records = opts.records ?? KITCHEN_SINK;
  writeFileSync(
    join(cwd, 'knext.ffi.json'),
    serializeConfig({ version: 1, crate: 'rust', out: 'src/generated/ffi' }),
  );
  mkdirSync(join(cwd, 'rust'), { recursive: true });
  writeFileSync(
    join(cwd, 'rust', 'Cargo.toml'),
    '[package]\nname = "zone"\nversion = "0.3.1"\n\n[lib]\ncrate-type = ["cdylib"]\n',
  );
  writeFileSync(join(cwd, 'rust', 'Cargo.lock'), CARGO_LOCK);
  const libFor =
    opts.libFor ??
    ((triple: string) =>
      Buffer.concat([
        elf(triple === ARM64 ? 'libmusl_arm64.so' : 'libmusl_x64.so'),
        blob(records),
      ]));

  // The committed wrapper, rendered from `committed` records (default: the same ones).
  const committed = opts.committed === undefined ? records : opts.committed;
  if (committed !== null) {
    const hostLib = join(emptyDir('host'), 'libzone.dylib');
    writeFileSync(hostLib, blob(committed));
    const files = generateFiles(hostLib, { version: 1, crate: 'rust', out: 'src/generated/ffi' });
    for (const [rel, text] of files) {
      const p = join(cwd, 'src', 'generated', 'ffi', rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
  }

  const calls: Call[] = [];
  const crateToml = join(cwd, 'rust', 'Cargo.toml');
  const run: Runner = (cmd, args, o) => {
    calls.push({ cmd, args: [...args], cwd: o.cwd, rustflags: o.env?.RUSTFLAGS });
    const enoent = () => ({
      status: null,
      stdout: '',
      error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    });
    const key = `${cmd} ${args.join(' ')}`;
    if (key === 'cargo --version')
      return opts.missing === 'cargo' ? enoent() : { status: 0, stdout: 'cargo 1.90.0\n' };
    // The real cargo-zigbuild 0.23 rejects `cargo zigbuild --version` with
    // exit 2; only the bare binary answers --version. The fake mirrors both.
    if (key === 'cargo zigbuild --version') return { status: 2, stdout: '' };
    if (key === 'cargo-zigbuild --version') {
      return opts.missing === 'zigbuild'
        ? enoent()
        : { status: 0, stdout: 'cargo-zigbuild 0.20.1\n' };
    }
    if (key === 'zig version')
      return opts.missing === 'zig' ? enoent() : { status: 0, stdout: '0.13.0\n' };
    if (key === 'rustup target list --installed') {
      if (opts.missing === 'rustup') return enoent();
      return {
        status: 0,
        stdout:
          opts.missing === 'target'
            ? 'aarch64-apple-darwin\n'
            : `aarch64-apple-darwin\n${X64}\n${ARM64}\n`,
      };
    }
    if (key === 'rustc -V') return { status: 0, stdout: 'rustc 1.90.0 (1159e78c4 2025-09-14)\n' };
    if (cmd === 'cargo' && args[0] === 'zigbuild') {
      if (opts.buildFails) return { status: 101, stdout: '' };
      const triple = args[args.indexOf('--target') + 1] as string;
      const out = join(cwd, 'rust', 'target', triple, 'release', 'libzone.so');
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, libFor(triple));
      const msg = {
        reason: 'compiler-artifact',
        package_id: 'path+file:///x/rust#zone@0.3.1',
        manifest_path: crateToml,
        target: { kind: ['cdylib'], crate_types: ['cdylib'], name: 'zone' },
        filenames: [out],
      };
      return {
        status: 0,
        stdout: `${JSON.stringify(msg)}\n{"reason":"build-finished","success":true}\n`,
      };
    }
    throw new Error(`unexpected program: ${key}`);
  };

  const build = async (argv: string[]) => {
    const c = capture();
    const code = await runBuild({ cwd, argv, io: c.io, deps: { run } });
    return { code, out: c.out(), err: c.err() };
  };
  return { cwd, calls, build, native: join(cwd, 'native') };
}

const ARGV = ['--target', X64, '--native-dir', 'native'];

describe('knext ffi build: arguments', () => {
  it('supports exactly the two musl image targets', () => {
    expect([...SUPPORTED_TARGETS]).toEqual([X64, ARM64]);
  });

  it('requires --target and --native-dir, and refuses an unknown target', async () => {
    const a = app();
    let r = await a.build(['--native-dir', 'native']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('--target');
    r = await a.build(['--target', X64]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('--native-dir');
    r = await a.build(['--target', 'x86_64-unknown-linux-gnu', '--native-dir', 'native']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('x86_64-unknown-linux-gnu');
    expect(r.err).toContain(X64);
    expect(a.calls).toEqual([]);
  });

  it('fails plainly without knext.ffi.json', async () => {
    const cwd = emptyDir('noconf');
    const c = capture();
    const code = await runBuild({
      cwd,
      argv: ARGV,
      io: c.io,
      deps: { run: () => ({ status: 0, stdout: '' }) },
    });
    expect(code).toBe(1);
    expect(c.err()).toContain('knext.ffi.json');
  });
});

describe('knext ffi build: the toolchain (D14 step 2)', () => {
  const cases: [NonNullable<Parameters<typeof app>[0]>['missing'], string][] = [
    ['cargo', 'https://rustup.rs'],
    ['zigbuild', 'cargo install --locked cargo-zigbuild'],
    ['zig', 'zig'],
    ['rustup', 'https://rustup.rs'],
    ['target', `rustup target add ${X64}`],
  ];
  for (const [missing, install] of cases) {
    it(`a missing ${missing} is a usage error naming the install command`, async () => {
      const a = app({ missing });
      const r = await a.build(ARGV);
      expect(r.code).toBe(1);
      expect(r.err).toContain(install);
      expect(existsSync(a.native)).toBe(false);
    });
  }

  it('runs cargo zigbuild --release --locked --target <triple> in the crate, with -crt-static off', async () => {
    const a = app();
    const r = await a.build(ARGV);
    expect(r.code, r.err).toBe(0);
    const zb = a.calls.filter(
      (c) => c.cmd === 'cargo' && c.args[0] === 'zigbuild' && c.args[1] !== '--version',
    );
    expect(zb).toHaveLength(1);
    const call = zb[0] as Call;
    expect(call.args.slice(0, 5)).toEqual(['zigbuild', '--release', '--locked', '--target', X64]);
    expect(call.cwd).toBe(join(a.cwd, 'rust'));
    expect(call.rustflags).toContain('-C target-feature=-crt-static');
  });

  it('a failed cross-build exits 1 and stages nothing', async () => {
    const a = app({ buildFails: true });
    const r = await a.build(ARGV);
    expect(r.code).toBe(1);
    expect(r.err).toContain('cargo zigbuild failed');
    expect(existsSync(a.native)).toBe(false);
  });

  it('refuses a crate without a committed Cargo.lock (every build is --locked)', async () => {
    const a = app();
    rmSync(join(a.cwd, 'rust', 'Cargo.lock'));
    const r = await a.build(ARGV);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Cargo.lock');
  });
});

describe('knext ffi build: the libc check (D14 step 3)', () => {
  it('refuses a glibc-linked library by name and stages nothing', async () => {
    const a = app({ libFor: () => Buffer.concat([elf('libglibc_x64.so'), blob(KITCHEN_SINK)]) });
    const r = await a.build(ARGV);
    expect(r.code).toBe(1);
    expect(r.err).toContain('libc.so.6');
    expect(existsSync(a.native)).toBe(false);
  });
});

describe('knext ffi build: staging (D14 step 4)', () => {
  it('writes native/ffi/<triple>/lib<name>.so and provenance.json, byte-for-byte the built library', async () => {
    const a = app();
    const r = await a.build(['--target', X64, '--target', ARM64, '--native-dir', 'native']);
    expect(r.code, r.err).toBe(0);
    for (const triple of [X64, ARM64]) {
      const lib = join(a.native, 'ffi', triple, 'libzone.so');
      expect(readFileSync(lib)).toEqual(
        readFileSync(join(a.cwd, 'rust', 'target', triple, 'release', 'libzone.so')),
      );
      const prov = JSON.parse(
        readFileSync(join(a.native, 'ffi', triple, 'provenance.json'), 'utf8'),
      );
      expect(prov).toEqual({
        version: 1,
        crate: { name: 'zone', version: '0.3.1' },
        cargoLockSha256: sha(CARGO_LOCK),
        rustc: 'rustc 1.90.0 (1159e78c4 2025-09-14)',
        zigbuild: 'cargo-zigbuild 0.20.1',
        target: triple,
        profile: 'release',
        knextFfiRev: '0123456789abcdef0123456789abcdef01234567',
        library: { file: 'libzone.so', sha256: sha(readFileSync(lib)) },
      });
      expect(readdirSync(join(a.native, 'ffi', triple)).sort()).toEqual([
        'libzone.so',
        'provenance.json',
      ]);
    }
  });

  it('clears only native/ffi/: a staged sharp tree and a hand-written file survive, a stale triple does not', async () => {
    const a = app();
    const sharp = join(a.native, 'sharp-linuxmusl-x64', 'lib', 'sharp-linuxmusl-x64.node');
    mkdirSync(dirname(sharp), { recursive: true });
    writeFileSync(sharp, 'addon');
    writeFileSync(join(a.native, 'NOTES.md'), 'mine');
    writeFileSync(join(a.native, '.integrity.json'), '{"previous":true}');
    const stale = join(a.native, 'ffi', ARM64, 'libold.so');
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, 'old');

    const r = await a.build(ARGV);
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(sharp, 'utf8')).toBe('addon');
    expect(readFileSync(join(a.native, 'NOTES.md'), 'utf8')).toBe('mine');
    // The integrity manifest is core's to rewrite after the compile, not this step's.
    expect(readFileSync(join(a.native, '.integrity.json'), 'utf8')).toBe('{"previous":true}');
    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(join(a.native, 'ffi'))).toEqual([X64]);
  });

  it('an absolute --native-dir is honoured', async () => {
    const a = app();
    const dir = join(emptyDir('abs'), 'native');
    const r = await a.build(['--target', X64, '--native-dir', dir]);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(dir, 'ffi', X64, 'libzone.so'))).toBe(true);
  });
});

describe('knext ffi build: the drift check (D14 step 5)', () => {
  it('passes when the committed wrapper was generated from the same library', async () => {
    const a = app();
    const r = await a.build(ARGV);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('native/ffi');
  });

  it('fails on a stale committed wrapper, says to run knext ffi generate, and leaves no staged library', async () => {
    const older = [
      fn('greet', [['name', D.t('string'), '&str']], D.t('string'), { retRust: 'String' }),
    ];
    const a = app({ committed: older });
    const r = await a.build(ARGV);
    expect(r.code).toBe(1);
    expect(r.err).toContain('run `knext ffi generate`');
    expect(existsSync(join(a.native, 'ffi'))).toBe(false);
  });

  it('fails when the wrapper was never generated', async () => {
    const a = app({ committed: null });
    const r = await a.build(ARGV);
    expect(r.code).toBe(1);
    expect(r.err).toContain('run `knext ffi generate`');
  });
});
