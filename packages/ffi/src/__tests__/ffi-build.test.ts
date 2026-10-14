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
import type { ZigDeps } from '../supply-chain';
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
import { type FakeToolchainOptions, fakeToolchain, supplyFixture } from './toolchain-fake';

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
  zig: string | undefined;
}

/**
 * An app with knext.ffi.json, a crate, and a committed wrapper generated from
 * `records`. `libFor(triple)` is what the fake cross-build produces.
 */
function app(
  opts: {
    records?: Record<string, unknown>[];
    committed?: Record<string, unknown>[] | null;
    libFor?: (triple: string, auditable: boolean) => Uint8Array;
    missing?: 'cargo' | 'rustup' | 'target';
    buildFails?: boolean;
    /** The fake toolchain (versions, zig on PATH). Default: everything at its pin. */
    toolchain?: FakeToolchainOptions;
    /** Injected zig download (only reached with no zig on PATH). */
    zigFetch?: ZigDeps['fetch'];
    /** cargo deny check advisories: its exit and JSON stream (default: clean). */
    advisories?: { status: number; stream: string };
    /** cargo deny check bans licenses sources exit (default 0). */
    policyStatus?: number;
    /** rust/advisory-allowlist.json, written when given. */
    allowlist?: unknown;
    /** Cargo.lock (default: CARGO_LOCK). */
    lock?: string;
    sbomFails?: boolean;
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
  writeFileSync(join(cwd, 'rust', 'Cargo.lock'), opts.lock ?? CARGO_LOCK);
  if (opts.allowlist !== undefined) {
    writeFileSync(join(cwd, 'rust', 'advisory-allowlist.json'), JSON.stringify(opts.allowlist));
  }
  // What the cross-build links: the musl fixture, carrying cargo-auditable's
  // real crate list only when the build ran through `cargo auditable`.
  const libFor =
    opts.libFor ??
    ((triple: string, auditable: boolean) =>
      Buffer.concat([
        auditable
          ? supplyFixture(triple === ARM64 ? 'libaudit_musl_arm64.so' : 'libaudit_musl_x64.so')
          : elf(triple === ARM64 ? 'libmusl_arm64.so' : 'libmusl_x64.so'),
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

  const tc = fakeToolchain(opts.toolchain);
  const calls: Call[] = [];
  const crateToml = join(cwd, 'rust', 'Cargo.toml');
  const run: Runner = (cmd, args, o) => {
    calls.push({
      cmd,
      args: [...args],
      cwd: o.cwd,
      rustflags: o.env?.RUSTFLAGS,
      zig: o.env?.CARGO_ZIGBUILD_ZIG_COMMAND,
    });
    const probe = tc.answer(cmd, args);
    if (probe) return probe;
    const enoent = () => ({
      status: null,
      stdout: '',
      error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    });
    const key = `${cmd} ${args.join(' ')}`;
    if (key === 'cargo --version')
      return opts.missing === 'cargo' ? enoent() : { status: 0, stdout: 'cargo 1.90.0\n' };
    // The real cargo-zigbuild 0.23.4 refuses `cargo zigbuild --version` (exit 2).
    if (key === 'cargo zigbuild --version') return { status: 2, stdout: '' };
    if (cmd === 'cargo' && args[0] === 'deny') {
      if (args.includes('advisories')) {
        const a = opts.advisories ?? { status: 0, stream: '' };
        return { status: a.status, stdout: '', stderr: a.stream };
      }
      return { status: opts.policyStatus ?? 0, stdout: '' };
    }
    if (cmd === 'cargo' && args[0] === 'cyclonedx') {
      if (opts.sbomFails) return { status: 1, stdout: '' };
      const name = args[args.indexOf('--override-filename') + 1] as string;
      const triple = args[args.indexOf('--target') + 1] as string;
      const bom = JSON.parse(supplyFixture('cargo-cyclonedx-zone.cdx.json').toString('utf8'));
      bom.metadata.properties[0].value = triple;
      writeFileSync(join(o.cwd, `${name}.json`), `${JSON.stringify(bom, null, 2)}\n`);
      return { status: 0, stdout: '' };
    }
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
    const zb = args.indexOf('zigbuild');
    if (cmd === 'cargo' && (zb === 0 || (zb === 1 && args[0] === 'auditable'))) {
      if (opts.buildFails) return { status: 101, stdout: '' };
      const triple = args[args.indexOf('--target') + 1] as string;
      const out = join(cwd, 'rust', 'target', triple, 'release', 'libzone.so');
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, libFor(triple, args[0] === 'auditable'));
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
    const code = await runBuild({
      cwd,
      argv,
      io: c.io,
      deps: {
        run,
        env: tc.env,
        zig: {
          cacheDir: join(cwd, '.zig-cache'),
          host: { platform: 'linux', arch: 'x64' },
          fetch:
            opts.zigFetch ??
            (() => {
              throw new Error('no zig download expected');
            }),
        },
      },
    });
    return { code, out: c.out(), err: c.err() };
  };
  return { cwd, calls, build, native: join(cwd, 'native'), tc };
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
  const cases: [string, NonNullable<Parameters<typeof app>[0]>, string][] = [
    ['cargo', { missing: 'cargo' }, 'https://rustup.rs'],
    [
      'cargo-zigbuild',
      { toolchain: { versions: { 'cargo-zigbuild': null } } },
      'cargo install --locked --version 0.23.4 cargo-zigbuild',
    ],
    ['rustup', { missing: 'rustup' }, 'https://rustup.rs'],
    ['target', { missing: 'target' }, `rustup target add ${X64}`],
  ];
  for (const [missing, opts, install] of cases) {
    it(`a missing ${missing} is a usage error naming the install command`, async () => {
      const a = app(opts);
      const r = await a.build(ARGV);
      expect(r.code).toBe(1);
      expect(r.err).toContain(install);
      expect(existsSync(a.native)).toBe(false);
    });
  }

  it('runs cargo auditable zigbuild --release --locked --target <triple> in the crate, with -crt-static off and the verified zig', async () => {
    const a = app();
    const r = await a.build(ARGV);
    expect(r.code, r.err).toBe(0);
    const zb = a.calls.filter((c) => c.cmd === 'cargo' && c.args.includes('zigbuild'));
    expect(zb).toHaveLength(1);
    const call = zb[0] as Call;
    expect(call.args.slice(0, 6)).toEqual([
      'auditable',
      'zigbuild',
      '--release',
      '--locked',
      '--target',
      X64,
    ]);
    expect(call.cwd).toBe(join(a.cwd, 'rust'));
    expect(call.rustflags).toContain('-C target-feature=-crt-static');
    expect(call.zig).toBe(a.tc.zigBin as string);
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
        zigbuild: 'cargo-zigbuild 0.23.4',
        target: triple,
        profile: 'release',
        knextFfiRev: '0123456789abcdef0123456789abcdef01234567',
        library: { file: 'libzone.so', sha256: sha(readFileSync(lib)) },
        tools: {
          zig: { version: '0.15.2', source: 'path', sha256: null },
          'cargo-zigbuild': '0.23.4',
          'cargo-deny': '0.20.2',
          'cargo-auditable': '0.7.7',
          'cargo-cyclonedx': '0.5.9',
        },
        advisoriesAccepted: [],
        sbom: {
          file: 'sbom.cdx.json',
          sha256: sha(readFileSync(join(a.native, 'ffi', triple, 'sbom.cdx.json'))),
        },
      });
      expect(readdirSync(join(a.native, 'ffi', triple)).sort()).toEqual([
        'libzone.so',
        'provenance.json',
        'sbom.cdx.json',
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
// ---------------------------------------------------------------------------
// Supply chain (ADR-0069 D16), through `knext ffi build`. cargo-deny's output
// here is the real 0.20.2 output for a crate depending on smallvec 1.6.0
// (RUSTSEC-2021-0003), replayed; the tools are fakes (toolchain-fake.ts).
// ---------------------------------------------------------------------------

const VULN = supplyFixture('cargo-deny-advisory.jsonl').toString('utf8');
const allowSmallvec = (expires: string) => ({
  allow: [
    {
      id: 'RUSTSEC-2021-0003',
      justification: 'insert_many is never called from the exported functions',
      added: '2026-10-01',
      expires,
    },
  ],
});
const cargoBuilds = (calls: Call[]) =>
  calls.filter((c) => c.cmd === 'cargo' && c.args.includes('zigbuild'));

describe('knext ffi build: the build-tool pins (D16)', () => {
  const tools: [string, string][] = [
    ['cargo-zigbuild', 'cargo install --locked --version 0.23.4 cargo-zigbuild'],
    ['cargo-deny', 'cargo install --locked --version 0.20.2 cargo-deny'],
    ['cargo-auditable', 'cargo install --locked --version 0.7.7 cargo-auditable'],
    ['cargo-cyclonedx', 'cargo install --locked --version 0.5.9 cargo-cyclonedx'],
  ];
  for (const [crate, install] of tools) {
    it(`refuses ${crate} at another version, printing the exact install command, before any build`, async () => {
      const a = app({ toolchain: { versions: { [crate]: '0.1.0' } } });
      const r = await a.build(ARGV);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`${crate} 0.1.0 is installed`);
      expect(r.err).toContain(`Install the pinned version with: ${install}`);
      expect(cargoBuilds(a.calls)).toEqual([]);
      expect(existsSync(a.native)).toBe(false);
    });
  }

  it('refuses a zig on PATH at another version', async () => {
    const a = app({ toolchain: { zig: '0.13.0' } });
    const r = await a.build(ARGV);
    expect(r.code).toBe(1);
    expect(r.err).toContain('zig 0.13.0 is on PATH');
    expect(r.err).toContain(
      'https://ziglang.org/download/0.15.2/zig-x86_64-linux-0.15.2.tar.xz (sha256 02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239)',
    );
    expect(cargoBuilds(a.calls)).toEqual([]);
  });

  it('with no zig on PATH, refuses a download whose sha256 is not the pin', async () => {
    const a = app({
      toolchain: { zig: null },
      zigFetch: async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode('not zig').buffer as ArrayBuffer,
      }),
    });
    const r = await a.build(ARGV);
    expect(r.code).toBe(1);
    expect(r.err).toContain('zig 0.15.2 failed verification: sha256 mismatch');
    expect(r.err).toContain(
      'expected 02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239',
    );
    expect(cargoBuilds(a.calls)).toEqual([]);
  });
});

describe('knext ffi build: cargo deny (D16)', () => {
  it('runs cargo deny check in the crate before the build', async () => {
    const a = app();
    const r = await a.build(ARGV);
    expect(r.code, r.err).toBe(0);
    const order = a.calls
      .filter((c) => c.cmd === 'cargo' && ['deny', 'auditable'].includes(c.args[0] as string))
      .map((c) => `${c.args[0]} ${c.args.at(-1)}`);
    expect(order).toEqual([
      'deny sources',
      'deny advisories',
      `auditable ${'--message-format=json-render-diagnostics'}`,
    ]);
    for (const c of a.calls.filter((c) => c.args[0] === 'deny')) {
      expect(c.cwd).toBe(join(a.cwd, 'rust'));
    }
  });

  it('a crate depending on a crate with a known RustSec advisory fails the build, and nothing is built or staged', async () => {
    const a = app({ advisories: { status: 1, stream: VULN } });
    const r = await a.build(ARGV);
    expect(r.code).toBe(1);
    expect(r.err).toContain('RUSTSEC-2021-0003 in smallvec@1.6.0');
    expect(r.err).toContain('advisory-allowlist.json');
    expect(cargoBuilds(a.calls)).toEqual([]);
    expect(existsSync(a.native)).toBe(false);
  });

  it('the same crate with a dated, justified allowlist entry passes, and provenance records it', async () => {
    const a = app({
      advisories: { status: 1, stream: VULN },
      allowlist: allowSmallvec('2999-12-31'),
    });
    const r = await a.build(ARGV);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain('accepted RUSTSEC-2021-0003 in smallvec@1.6.0');
    const prov = JSON.parse(readFileSync(join(a.native, 'ffi', X64, 'provenance.json'), 'utf8'));
    expect(prov.advisoriesAccepted).toEqual(['RUSTSEC-2021-0003']);
  });

  it('an expired entry fails it again', async () => {
    const a = app({
      advisories: { status: 1, stream: VULN },
      allowlist: allowSmallvec('2000-01-01'),
    });
    const r = await a.build(ARGV);
    expect(r.code).toBe(1);
    expect(r.err).toContain('entry expired on 2000-01-01');
    expect(existsSync(a.native)).toBe(false);
  });

  it('a failed bans/licenses/sources check fails the build', async () => {
    const a = app({ policyStatus: 4 });
    const r = await a.build(ARGV);
    expect(r.code).toBe(1);
    expect(r.err).toContain('cargo deny check bans licenses sources failed (exit 4)');
    expect(cargoBuilds(a.calls)).toEqual([]);
  });

  it('a git source other than getknext-dev/knext is refused before cargo runs', async () => {
    const a = app({
      lock: `${CARGO_LOCK}
[[package]]
name = "itoa"
version = "1.0.11"
source = "git+https://github.com/dtolnay/itoa?tag=1.0.11#8f392032fadf15b5e6b9b7b6add21875575d67af"
`,
    });
    const r = await a.build(ARGV);
    expect(r.code).toBe(1);
    expect(r.err).toContain('git dependencies from https://github.com/dtolnay/itoa');
    expect(a.calls.filter((c) => c.cmd === 'cargo' && c.args[0] === 'deny')).toEqual([]);
    expect(cargoBuilds(a.calls)).toEqual([]);
  });
});

describe('knext ffi build: cargo auditable and the SBOM (D16)', () => {
  it('refuses a library that carries no cargo-auditable data, and stages nothing', async () => {
    const a = app({
      libFor: (triple) =>
        Buffer.concat([
          elf(triple === ARM64 ? 'libmusl_arm64.so' : 'libmusl_x64.so'),
          blob(KITCHEN_SINK),
        ]),
    });
    const r = await a.build(ARGV);
    expect(r.code).toBe(1);
    expect(r.err).toContain('carries no cargo-auditable data');
    expect(existsSync(a.native)).toBe(false);
  });

  it('stages a valid CycloneDX SBOM per target at native/ffi/<triple>/sbom.cdx.json', async () => {
    const a = app();
    const r = await a.build(['--target', X64, '--target', ARM64, '--native-dir', 'native']);
    expect(r.code, r.err).toBe(0);
    for (const triple of [X64, ARM64]) {
      const bom = JSON.parse(readFileSync(join(a.native, 'ffi', triple, 'sbom.cdx.json'), 'utf8'));
      expect(bom.bomFormat).toBe('CycloneDX');
      expect(bom.specVersion).toBe('1.5');
      expect(bom.metadata.component.name).toBe('zone');
      expect(bom.metadata.properties[0]).toEqual({
        name: 'cdx:rustc:sbom:target:triple',
        value: triple,
      });
    }
    // cargo cyclonedx writes beside Cargo.toml; nothing is left there.
    expect(readdirSync(join(a.cwd, 'rust')).filter((f) => f.includes('sbom'))).toEqual([]);
  });

  it('the staged SBOM is hashed into native/.integrity.json by core’s writer', async () => {
    const a = app();
    const r = await a.build(ARGV);
    expect(r.code, r.err).toBe(0);
    // Core's writer, unchanged (ADR-0069 D14): it hashes whatever `knext ffi
    // build` staged. Loaded by path at run time so this package's typecheck
    // (rootDir: packages/ffi) does not pull core's sources in.
    const corePath = join(PKG_DIR, '..', 'kn-next', 'src', 'cli', 'native-integrity.ts');
    const core = (await import(corePath)) as {
      writeNativeIntegrityManifest(nativeDir: string, lockfile: string | undefined): void;
    };
    core.writeNativeIntegrityManifest(a.native, undefined);
    const manifest = JSON.parse(readFileSync(join(a.native, '.integrity.json'), 'utf8'));
    const sbom = readFileSync(join(a.native, 'ffi', X64, 'sbom.cdx.json'));
    expect(manifest.files[`ffi/${X64}/sbom.cdx.json`]).toBe(sha(sbom));
    expect(manifest.files[`ffi/${X64}/provenance.json`]).toBe(
      sha(readFileSync(join(a.native, 'ffi', X64, 'provenance.json'))),
    );
  });

  it('a failed cargo cyclonedx fails the build and stages nothing', async () => {
    const a = app({ sbomFails: true });
    const r = await a.build(ARGV);
    expect(r.code).toBe(1);
    expect(r.err).toContain('cargo cyclonedx failed');
    expect(existsSync(a.native)).toBe(false);
  });
});
