/**
 * The supply-chain gates (ADR-0069 D16), unit by unit: the build-tool pins,
 * zig's verified download, the git-source rule, the dated advisory allowlist,
 * cargo-auditable's embedded crate list and the CycloneDX SBOM.
 *
 * What is real and what is faked, stated once:
 * - cargo-deny's output (`cargo-deny-*.jsonl`) and cargo-cyclonedx's SBOM are
 *   the bytes the pinned releases printed for a fixture crate depending on
 *   smallvec 1.6.0 (RUSTSEC-2021-0003); the tests replay them through a fake
 *   runner, so no test needs the advisory database or the network.
 * - The `.dep-v0` payloads in `libaudit_musl_*.so` were written by the pinned
 *   cargo-auditable through cargo-zigbuild for both musl targets, then copied
 *   onto the small musl fixtures; the reader parses those real bytes.
 * - The tools themselves are fakes (empty executables + the version replies
 *   the real ones give, see toolchain-fake.ts).
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Runner } from '../build';
import { runInit, TEMPLATE_DIR } from '../init';
import {
  ADVISORY_ALLOWLIST_FILE,
  ALLOWED_GIT_SOURCE,
  assertAuditable,
  assertCycloneDx,
  assertGitSources,
  buildSbom,
  CARGO_TOOL_PINS,
  cargoInstallCommand,
  checkCargoTools,
  judgeAdvisories,
  loadAdvisoryAllowlist,
  parseDenyJson,
  readAuditData,
  resolveCargoSubcommand,
  resolveZig,
  runCargoDeny,
  versionOf,
  ZIG_PIN,
  type ZigPin,
  zigbuildEnv,
  zigCacheDir,
  zigHostKey,
} from '../supply-chain';
import { capture, emptyDir, PKG_DIR, removeScratchDirs } from './helpers';
import { fakeToolchain, PINNED, supplyFixture, type ToolCrate } from './toolchain-fake';

afterAll(removeScratchDirs);

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const elf = (name: string) => readFileSync(join(PKG_DIR, 'fixtures', 'elf', name));
const VULN = supplyFixture('cargo-deny-advisory.jsonl').toString('utf8');
const IGNORED = supplyFixture('cargo-deny-ignored.jsonl').toString('utf8');

/** A runner that answers version probes from `tc` and everything else from `rest`. */
function runnerFor(
  tc: ReturnType<typeof fakeToolchain>,
  rest: Runner = (cmd, args) => {
    throw new Error(`unexpected program: ${cmd} ${args.join(' ')}`);
  },
): Runner {
  return (cmd, args, opts) => tc.answer(cmd, args) ?? rest(cmd, args, opts);
}

describe('the pin table (D16): a bump is a deliberate change here', () => {
  it('pins the four cargo tools and zig to exact versions', () => {
    expect(
      Object.fromEntries(Object.values(CARGO_TOOL_PINS).map((p) => [p.crate, p.version])),
    ).toEqual({
      'cargo-zigbuild': '0.23.4',
      'cargo-deny': '0.20.2',
      'cargo-auditable': '0.7.7',
      'cargo-cyclonedx': '0.5.9',
    });
    expect(ZIG_PIN.version).toBe('0.15.2');
  });

  it('pins one zig archive per supported build host, by sha256, from ziglang.org', () => {
    expect(ZIG_PIN.assets).toEqual({
      'linux-x86_64': {
        file: 'zig-x86_64-linux-0.15.2.tar.xz',
        sha256: '02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239',
      },
      'linux-aarch64': {
        file: 'zig-aarch64-linux-0.15.2.tar.xz',
        sha256: '958ed7d1e00d0ea76590d27666efbf7a932281b3d7ba0c6b01b0ff26498f667f',
      },
      'macos-aarch64': {
        file: 'zig-aarch64-macos-0.15.2.tar.xz',
        sha256: '3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b',
      },
    });
    expect(ZIG_PIN.baseUrl).toBe('https://ziglang.org/download/0.15.2');
  });

  it('the install command is `cargo install --locked --version <pin> <crate>`', () => {
    expect(cargoInstallCommand('zigbuild')).toBe(
      'cargo install --locked --version 0.23.4 cargo-zigbuild',
    );
    expect(cargoInstallCommand('deny')).toBe('cargo install --locked --version 0.20.2 cargo-deny');
    expect(cargoInstallCommand('auditable')).toBe(
      'cargo install --locked --version 0.7.7 cargo-auditable',
    );
    expect(cargoInstallCommand('cyclonedx')).toBe(
      'cargo install --locked --version 0.5.9 cargo-cyclonedx',
    );
  });

  it('reads the version the way each real release prints it', () => {
    expect(versionOf('cargo-zigbuild 0.23.4\n')).toBe('0.23.4');
    expect(versionOf('cargo-cyclonedx-cyclonedx 0.5.9\n')).toBe('0.5.9');
    expect(versionOf('cargo-deny 0.20.2-rc.1\n')).toBe('0.20.2-rc.1');
    expect(versionOf('error: unexpected argument')).toBeNull();
  });
});

describe('the cargo tool pins (D16)', () => {
  const tools: [ToolCrate, Parameters<typeof cargoInstallCommand>[0]][] = [
    ['cargo-zigbuild', 'zigbuild'],
    ['cargo-deny', 'deny'],
    ['cargo-auditable', 'auditable'],
    ['cargo-cyclonedx', 'cyclonedx'],
  ];

  it('accepts all four at their pins and returns the verified versions', () => {
    const tc = fakeToolchain();
    expect(checkCargoTools(runnerFor(tc), tc.cargoHome, tc.env)).toEqual(PINNED);
  });

  for (const [crate, tool] of tools) {
    it(`refuses a wrong ${crate} version with the exact install command`, () => {
      const tc = fakeToolchain({ versions: { [crate]: '0.0.1' } });
      expect(() => checkCargoTools(runnerFor(tc), tc.cargoHome, tc.env)).toThrow(
        `${crate} 0.0.1 is installed`,
      );
      expect(() => checkCargoTools(runnerFor(tc), tc.cargoHome, tc.env)).toThrow(
        `Install the pinned version with: ${cargoInstallCommand(tool)}`,
      );
    });

    it(`refuses a missing ${crate} with the exact install command`, () => {
      const tc = fakeToolchain({ versions: { [crate]: null } });
      expect(() => checkCargoTools(runnerFor(tc), tc.cargoHome, tc.env)).toThrow(
        `${crate} is not installed; ${Object.values(CARGO_TOOL_PINS).find((p) => p.crate === crate)?.purpose}. Install the pinned version with: ${cargoInstallCommand(tool)}`,
      );
    });
  }

  it('reads cargo-auditable from the cargo install record (it has no version flag)', () => {
    const tc = fakeToolchain({ noInstallRecord: true });
    expect(() => checkCargoTools(runnerFor(tc), tc.cargoHome, tc.env, ['auditable'])).toThrow(
      `could not read the version of cargo-auditable at ${join(tc.cargoHome, 'bin', 'cargo-auditable')}`,
    );
    // The other three answer --version and need no record.
    expect(checkCargoTools(runnerFor(tc), tc.cargoHome, tc.env, ['zigbuild', 'deny'])).toEqual({
      'cargo-zigbuild': PINNED['cargo-zigbuild'],
      'cargo-deny': PINNED['cargo-deny'],
    });
  });

  it('checks the binary cargo would run: $CARGO_HOME/bin before PATH', () => {
    const tc = fakeToolchain();
    const other = emptyDir('path-bin');
    writeFileSync(join(other, 'cargo-deny'), '');
    const env = { ...tc.env, PATH: other };
    expect(resolveCargoSubcommand('cargo-deny', env)).toBe(join(tc.cargoHome, 'bin', 'cargo-deny'));
    const bare = { PATH: other, CARGO_HOME: emptyDir('empty-home') };
    // A non-executable file is not a command.
    expect(resolveCargoSubcommand('cargo-deny', bare)).toBeUndefined();
  });
});

describe('zig (D16): the pinned version, verified', () => {
  const host = { platform: 'darwin', arch: 'arm64' };
  const archive = Buffer.from('a pretend zig archive');
  const testPin: ZigPin = {
    version: ZIG_PIN.version,
    baseUrl: 'https://ziglang.org/download/0.15.2',
    assets: { 'macos-aarch64': { file: 'zig-aarch64-macos-0.15.2.tar.xz', sha256: sha(archive) } },
  };
  const stem = 'zig-aarch64-macos-0.15.2';

  /** A runner whose `tar` "extracts" a zig answering `version` with `extractedVersion`. */
  function downloadRig(extractedVersion = ZIG_PIN.version) {
    const tc = fakeToolchain({ zig: null });
    const calls: string[] = [];
    let extracted: string | undefined;
    const run: Runner = (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'tar') {
        const dest = args[args.indexOf('-C') + 1] as string;
        mkdirSync(join(dest, stem), { recursive: true });
        extracted = join(dest, stem, 'zig');
        writeFileSync(extracted, '');
        return { status: 0, stdout: '' };
      }
      if (cmd.endsWith(`${stem}/zig`) && args[0] === 'version') {
        return { status: 0, stdout: `${extractedVersion}\n` };
      }
      throw new Error(`unexpected program: ${cmd}`);
    };
    const fetched: string[] = [];
    const fetchWith =
      (bytes: Uint8Array, status = 200) =>
      async (url: string) => {
        fetched.push(url);
        return {
          ok: status === 200,
          status,
          arrayBuffer: async () => new Uint8Array(bytes).buffer as ArrayBuffer,
        };
      };
    return { tc, run, calls, fetched, fetchWith, cacheDir: emptyDir('zig-cache') };
  }

  it('maps the three pinned build hosts', () => {
    expect(zigHostKey({ platform: 'linux', arch: 'x64' })).toBe('linux-x86_64');
    expect(zigHostKey({ platform: 'linux', arch: 'arm64' })).toBe('linux-aarch64');
    expect(zigHostKey({ platform: 'darwin', arch: 'arm64' })).toBe('macos-aarch64');
    expect(zigHostKey({ platform: 'win32', arch: 'x64' })).toBeUndefined();
  });

  it('caches under $KNEXT_CACHE_DIR, else $XDG_CACHE_HOME/knext, else ~/.cache/knext', () => {
    expect(zigCacheDir({ KNEXT_CACHE_DIR: '/k' }, '/h', '0.15.2')).toBe('/k/zig/0.15.2');
    expect(zigCacheDir({ XDG_CACHE_HOME: '/x' }, '/h', '0.15.2')).toBe('/x/knext/zig/0.15.2');
    expect(zigCacheDir({}, '/h', '0.15.2')).toBe('/h/.cache/knext/zig/0.15.2');
  });

  it('uses a zig on PATH whose `zig version` equals the pin, without downloading', async () => {
    const tc = fakeToolchain();
    const z = await resolveZig(runnerFor(tc), tc.cargoHome, tc.env, {
      fetch: () => {
        throw new Error('no download expected');
      },
    });
    expect(z).toEqual({
      bin: tc.zigBin as string,
      version: '0.15.2',
      source: 'path',
      sha256: null,
    });
  });

  it('refuses a zig on PATH at another version, naming the pinned download and its sha256', async () => {
    const tc = fakeToolchain({ zig: '0.13.0' });
    const err = await resolveZig(runnerFor(tc), tc.cargoHome, tc.env, { host }).catch((e) => e);
    expect(String(err)).toContain(`zig 0.13.0 is on PATH (${tc.zigBin})`);
    expect(String(err)).toContain('pins zig 0.15.2');
    expect(String(err)).toContain(
      'https://ziglang.org/download/0.15.2/zig-aarch64-macos-0.15.2.tar.xz (sha256 3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b)',
    );
  });

  it('with no zig on PATH, downloads the pinned archive, verifies it, extracts it and checks its version', async () => {
    const r = downloadRig();
    const z = await resolveZig(r.run, r.tc.cargoHome, r.tc.env, {
      host,
      pin: testPin,
      cacheDir: r.cacheDir,
      fetch: r.fetchWith(archive),
    });
    expect(r.fetched).toEqual([`${testPin.baseUrl}/zig-aarch64-macos-0.15.2.tar.xz`]);
    expect(z).toEqual({
      bin: join(r.cacheDir, stem, 'zig'),
      version: '0.15.2',
      source: 'ziglang.org',
      sha256: sha(archive),
    });
    expect(readFileSync(join(r.cacheDir, 'zig-aarch64-macos-0.15.2.tar.xz'))).toEqual(archive);

    // The next build re-hashes the cached archive and reuses it: no download, no extract.
    r.calls.length = 0;
    const again = await resolveZig(r.run, r.tc.cargoHome, r.tc.env, {
      host,
      pin: testPin,
      cacheDir: r.cacheDir,
      fetch: () => {
        throw new Error('no download expected');
      },
    });
    expect(again).toEqual(z);
    expect(r.calls.some((c) => c.startsWith('tar'))).toBe(false);
  });

  it('refuses an archive whose sha256 differs from the pin, and installs nothing', async () => {
    const r = downloadRig();
    const err = await resolveZig(r.run, r.tc.cargoHome, r.tc.env, {
      host,
      pin: testPin,
      cacheDir: r.cacheDir,
      fetch: r.fetchWith(Buffer.from('tampered')),
    }).catch((e) => e);
    expect(String(err)).toContain('zig 0.15.2 failed verification: sha256 mismatch');
    expect(String(err)).toContain(`expected ${sha(archive)}`);
    expect(String(err)).toContain(`got      ${sha(Buffer.from('tampered'))}`);
    expect(existsSync(join(r.cacheDir, 'zig-aarch64-macos-0.15.2.tar.xz'))).toBe(false);
    expect(r.calls).toEqual([]);
  });

  it('never trusts a cached archive that no longer matches: it is fetched again', async () => {
    const r = downloadRig();
    mkdirSync(r.cacheDir, { recursive: true });
    writeFileSync(join(r.cacheDir, 'zig-aarch64-macos-0.15.2.tar.xz'), 'swapped');
    await resolveZig(r.run, r.tc.cargoHome, r.tc.env, {
      host,
      pin: testPin,
      cacheDir: r.cacheDir,
      fetch: r.fetchWith(archive),
    });
    expect(r.fetched).toHaveLength(1);
    expect(readFileSync(join(r.cacheDir, 'zig-aarch64-macos-0.15.2.tar.xz'))).toEqual(archive);
  });

  it('refuses a downloaded zig that reports another version', async () => {
    const r = downloadRig('0.16.0');
    const err = await resolveZig(r.run, r.tc.cargoHome, r.tc.env, {
      host,
      pin: testPin,
      cacheDir: r.cacheDir,
      fetch: r.fetchWith(archive),
    }).catch((e) => e);
    expect(String(err)).toContain('reports 0.16.0, not the pinned 0.15.2');
    expect(existsSync(join(r.cacheDir, stem))).toBe(false);
  });

  it('refuses an HTTP failure, and a host with no pinned archive', async () => {
    const r = downloadRig();
    const http = await resolveZig(r.run, r.tc.cargoHome, r.tc.env, {
      host,
      pin: testPin,
      cacheDir: r.cacheDir,
      fetch: r.fetchWith(archive, 404),
    }).catch((e) => e);
    expect(String(http)).toContain('HTTP 404');
    const win = await resolveZig(r.run, r.tc.cargoHome, r.tc.env, {
      host: { platform: 'win32', arch: 'x64' },
    }).catch((e) => e);
    expect(String(win)).toContain('pins no zig 0.15.2 download for win32-x64');
  });

  it('hands cargo-zigbuild exactly the verified zig (else it prefers `python3 -m ziglang`)', () => {
    expect(
      zigbuildEnv({ bin: '/c/zig/zig', version: '0.15.2', source: 'ziglang.org', sha256: 'x' }),
    ).toEqual({ CARGO_ZIGBUILD_ZIG_COMMAND: '/c/zig/zig', CARGO_ZIGBUILD_ZIG_COMMAND_ARGS: '' });
  });
});

describe('git sources (D16): getknext-dev/knext only', () => {
  const lock = (source: string) =>
    `version = 4\n\n[[package]]\nname = "dep"\nversion = "1.0.0"\nsource = "${source}"\n`;

  it('accepts the knext-ffi repository and crates.io', () => {
    expect(ALLOWED_GIT_SOURCE).toBe('https://github.com/getknext-dev/knext');
    assertGitSources(
      lock(
        'git+https://github.com/getknext-dev/knext?rev=0123456789abcdef0123456789abcdef01234567#0123456789abcdef0123456789abcdef01234567',
      ),
      'rust/Cargo.lock',
    );
    assertGitSources(
      lock('registry+https://github.com/rust-lang/crates.io-index'),
      'rust/Cargo.lock',
    );
  });

  it('refuses any other git source, by name', () => {
    expect(() =>
      assertGitSources(
        lock(
          'git+https://github.com/dtolnay/itoa?tag=1.0.11#8f392032fadf15b5e6b9b7b6add21875575d67af',
        ),
        'rust/Cargo.lock',
      ),
    ).toThrow('rust/Cargo.lock has git dependencies from https://github.com/dtolnay/itoa');
    // A look-alike owner is another repository.
    expect(() =>
      assertGitSources(lock('git+https://github.com/getknext-dev/knext-fork#abc'), 'Cargo.lock'),
    ).toThrow('getknext-dev/knext-fork');
  });
});

describe('advisories (D16): a dated, justified allowlist', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    id: 'RUSTSEC-2021-0003',
    justification: 'insert_many is never called; upgrade blocked on the parser crate',
    added: '2026-10-01',
    ...over,
  });
  const crate = (allow: unknown) => {
    const dir = emptyDir('allow');
    if (allow !== undefined) {
      writeFileSync(
        join(dir, ADVISORY_ALLOWLIST_FILE),
        typeof allow === 'string' ? allow : JSON.stringify(allow),
      );
    }
    return dir;
  };

  it('parses the real cargo-deny 0.20.2 JSON for the smallvec fixture', () => {
    expect(parseDenyJson(VULN)).toEqual({
      advisories: [
        {
          id: 'RUSTSEC-2021-0003',
          crate: 'smallvec@1.6.0',
          title: 'Buffer overflow in SmallVec::insert_many',
          severity: 'error',
        },
      ],
      otherErrors: [],
    });
    // deny.toml's `ignore` turns it into a note; it is still an advisory here.
    expect(parseDenyJson(IGNORED).advisories.map((a) => [a.id, a.severity])).toEqual([
      ['RUSTSEC-2021-0003', 'note'],
    ]);
  });

  it('no file means nothing is accepted; a malformed file or entry fails closed', () => {
    expect(loadAdvisoryAllowlist(crate(undefined), 'rust')).toEqual([]);
    expect(() => loadAdvisoryAllowlist(crate('{'), 'rust')).toThrow('could not parse');
    expect(() => loadAdvisoryAllowlist(crate({}), 'rust')).toThrow('"allow" array');
    expect(() =>
      loadAdvisoryAllowlist(crate({ allow: [entry({ id: 'GHSA-x' })] }), 'rust'),
    ).toThrow('RustSec id');
    expect(() =>
      loadAdvisoryAllowlist(crate({ allow: [entry({ justification: ' ' })] }), 'rust'),
    ).toThrow('justification');
    expect(() =>
      loadAdvisoryAllowlist(crate({ allow: [entry({ added: undefined })] }), 'rust'),
    ).toThrow('"added" date');
    expect(() =>
      loadAdvisoryAllowlist(crate({ allow: [entry({ added: '2026-02-30' })] }), 'rust'),
    ).toThrow('"added" date');
    expect(() =>
      loadAdvisoryAllowlist(crate({ allow: [entry({ expires: 'next year' })] }), 'rust'),
    ).toThrow('"expires"');
  });

  it('refuses an advisory with no entry, accepts a dated one, and refuses it again once expired', () => {
    const [finding] = parseDenyJson(VULN).advisories;
    const f = [finding as NonNullable<typeof finding>];
    expect(judgeAdvisories(f, [], '2026-10-14').refused.map((r) => r.reason)).toEqual([
      `not in ${ADVISORY_ALLOWLIST_FILE}`,
    ]);
    const dated = judgeAdvisories(f, [entry({ expires: '2026-12-31' })], '2026-10-14');
    expect(dated.refused).toEqual([]);
    expect(dated.accepted.map((a) => a.id)).toEqual(['RUSTSEC-2021-0003']);
    // The expiry day itself still covers it; the day after does not.
    expect(judgeAdvisories(f, [entry({ expires: '2026-12-31' })], '2026-12-31').refused).toEqual(
      [],
    );
    expect(
      judgeAdvisories(f, [entry({ expires: '2026-12-31' })], '2027-01-01').refused.map(
        (r) => r.reason,
      ),
    ).toEqual([`its ${ADVISORY_ALLOWLIST_FILE} entry expired on 2026-12-31`]);
    // No expiry: accepted (mirrors security/npm-audit-allowlist.json).
    expect(judgeAdvisories(f, [entry()], '2099-01-01').refused).toEqual([]);
  });
});

describe('runCargoDeny: cargo deny check, replayed from the real tool', () => {
  interface Rig {
    policyStatus?: number;
    advStatus?: number;
    advStream?: string;
    allow?: unknown;
  }
  function deny(rig: Rig) {
    const crateDir = emptyDir('deny');
    writeFileSync(join(crateDir, 'deny.toml'), '# policy\n');
    if (rig.allow !== undefined) {
      writeFileSync(join(crateDir, ADVISORY_ALLOWLIST_FILE), JSON.stringify(rig.allow));
    }
    const calls: { args: string[]; captureStderr: boolean | undefined }[] = [];
    const run: Runner = (cmd, args, opts) => {
      expect(cmd).toBe('cargo');
      calls.push({ args: [...args], captureStderr: opts.captureStderr });
      if (args.includes('advisories')) {
        return { status: rig.advStatus ?? 0, stdout: '', stderr: rig.advStream ?? '' };
      }
      return { status: rig.policyStatus ?? 0, stdout: '' };
    };
    const notes: string[] = [];
    const go = () =>
      runCargoDeny({
        run,
        crateDir,
        crateLabel: 'rust',
        env: {},
        today: '2026-10-14',
        note: (l) => notes.push(l),
      });
    return { go, calls, notes, crateDir };
  }
  const allowSmallvec = (expires: string) => ({
    allow: [
      {
        id: 'RUSTSEC-2021-0003',
        justification: 'not reachable from the exported functions',
        added: '2026-10-01',
        expires,
      },
    ],
  });

  it('runs bans/licenses/sources by exit code, then advisories as JSON (all four checks, --locked)', () => {
    const d = deny({});
    expect(d.go()).toEqual([]);
    expect(d.calls).toEqual([
      {
        args: ['deny', '--locked', 'check', 'bans', 'licenses', 'sources'],
        captureStderr: undefined,
      },
      {
        args: [
          'deny',
          '--locked',
          '--format',
          'json',
          '--log-level',
          'info',
          'check',
          'advisories',
        ],
        captureStderr: true,
      },
    ]);
  });

  it('a known RustSec advisory fails the build', () => {
    const d = deny({ advStatus: 1, advStream: VULN });
    expect(d.go).toThrow(
      'RUSTSEC-2021-0003 in smallvec@1.6.0: Buffer overflow in SmallVec::insert_many',
    );
  });

  it('the same advisory with a dated, justified entry passes', () => {
    const d = deny({ advStatus: 1, advStream: VULN, allow: allowSmallvec('2026-12-31') });
    expect(d.go()).toEqual(['RUSTSEC-2021-0003']);
    expect(d.notes.join('')).toContain('accepted RUSTSEC-2021-0003 in smallvec@1.6.0');
  });

  it('an expired entry fails it again', () => {
    const d = deny({ advStatus: 1, advStream: VULN, allow: allowSmallvec('2026-10-13') });
    expect(d.go).toThrow('entry expired on 2026-10-13');
  });

  it('an advisory deny.toml ignores is still refused without an entry', () => {
    const d = deny({ advStatus: 0, advStream: IGNORED });
    expect(d.go).toThrow('RUSTSEC-2021-0003');
  });

  it('a failed policy check (bans, licenses, sources) fails the build', () => {
    const d = deny({ policyStatus: 2 });
    expect(d.go).toThrow('cargo deny check bans licenses sources failed (exit 2)');
  });

  it('an advisories failure that reports nothing (database unreachable) fails closed', () => {
    const d = deny({ advStatus: 1, advStream: '' });
    expect(d.go).toThrow('failed (exit 1) without reporting an advisory');
  });

  it('a non-advisory error (e.g. a yanked crate) cannot be allowlisted', () => {
    const yanked = `${JSON.stringify({
      type: 'diagnostic',
      fields: { severity: 'error', code: 'yanked', message: 'detected yanked crate' },
    })}\n`;
    const d = deny({ advStatus: 1, advStream: yanked, allow: allowSmallvec('2099-01-01') });
    expect(d.go).toThrow('yanked: detected yanked crate');
  });
});

describe('cargo auditable (D16): the crate list is in the library', () => {
  it('reads the real cargo-auditable payload from both musl targets', () => {
    for (const f of ['libaudit_musl_x64.so', 'libaudit_musl_arm64.so']) {
      expect(readAuditData(supplyFixture(f))).toEqual([
        { name: 'zone', version: '0.3.1', source: 'local', root: true } as never,
      ]);
    }
  });

  it('a library built without it has none, and is refused', () => {
    expect(readAuditData(elf('libmusl_x64.so'))).toBeNull();
    expect(() => assertAuditable(elf('libmusl_x64.so'), 'zone', 'libzone.so')).toThrow(
      'carries no cargo-auditable data',
    );
    expect(() => assertAuditable(Buffer.from('not an elf'), 'zone', 'x')).toThrow(
      'carries no cargo-auditable data',
    );
  });

  it('the root crate must be this crate', () => {
    assertAuditable(supplyFixture('libaudit_musl_x64.so'), 'zone', 'libzone.so');
    expect(() =>
      assertAuditable(supplyFixture('libaudit_musl_x64.so'), 'other', 'libother.so'),
    ).toThrow('does not list other as its root crate');
  });
});

describe('the CycloneDX SBOM (D16)', () => {
  const real = supplyFixture('cargo-cyclonedx-zone.cdx.json');
  const X64 = 'x86_64-unknown-linux-musl';

  it('accepts the real cargo-cyclonedx output for this crate and target', () => {
    assertCycloneDx(real, X64, 'zone');
  });

  it('refuses a document that is not a CycloneDX BOM of this crate for this target', () => {
    const bom = JSON.parse(real.toString('utf8'));
    const w = (o: unknown) => Buffer.from(JSON.stringify(o));
    expect(() => assertCycloneDx(Buffer.from('nope'), X64, 'zone')).toThrow('not JSON');
    expect(() => assertCycloneDx(w({ ...bom, bomFormat: 'SPDX' }), X64, 'zone')).toThrow(
      'bomFormat',
    );
    expect(() => assertCycloneDx(w({ ...bom, specVersion: 2 }), X64, 'zone')).toThrow(
      'specVersion',
    );
    expect(() => assertCycloneDx(w({ ...bom, components: undefined }), X64, 'zone')).toThrow(
      'components',
    );
    expect(() => assertCycloneDx(real, X64, 'other')).toThrow('describes zone, not other');
    expect(() => assertCycloneDx(real, 'aarch64-unknown-linux-musl', 'zone')).toThrow(
      `generated for ${X64}`,
    );
  });

  it('runs cargo cyclonedx for the target, returns the bytes and leaves nothing in the crate', () => {
    const crateDir = emptyDir('sbom');
    const calls: string[][] = [];
    const run: Runner = (_cmd, args, opts) => {
      calls.push([...args]);
      const name = args[args.indexOf('--override-filename') + 1] as string;
      writeFileSync(join(opts.cwd, `${name}.json`), real);
      return { status: 0, stdout: '' };
    };
    const bytes = buildSbom({ run, crateDir, triple: X64, crateName: 'zone', env: {} });
    expect(bytes).toEqual(real);
    expect(calls).toEqual([
      [
        'cyclonedx',
        '--format',
        'json',
        '--spec-version',
        '1.5',
        '--target',
        X64,
        '--override-filename',
        `knext-ffi-sbom-${X64}`,
      ],
    ]);
    expect(existsSync(join(crateDir, `knext-ffi-sbom-${X64}.json`))).toBe(false);
  });

  it('a failed run is a failure', () => {
    const run: Runner = () => ({ status: 1, stdout: '' });
    expect(() =>
      buildSbom({ run, crateDir: emptyDir('sbom'), triple: X64, crateName: 'zone', env: {} }),
    ).toThrow('cargo cyclonedx failed');
  });
});

describe('the deny.toml `knext ffi init` writes (D16)', () => {
  it('is written into the crate, and gates advisories, licenses, bans and sources', () => {
    const cwd = emptyDir('init-deny');
    const c = capture();
    expect(runInit({ cwd, io: c.io, crateRev: 'a'.repeat(40) }), c.err()).toBe(0);
    const deny = readFileSync(join(cwd, 'rust', 'deny.toml'), 'utf8');
    expect(deny).toBe(readFileSync(join(TEMPLATE_DIR, 'rust', 'deny.toml'), 'utf8'));
    const line = (key: string) =>
      deny
        .split('\n')
        .filter((l) => l.startsWith(`${key} =`))
        .map((l) => l.slice(key.length + 3).trim());
    for (const table of ['[advisories]', '[licenses]', '[bans]', '[sources]', '[graph]']) {
      expect(deny).toContain(`\n${table}\n`);
    }
    expect(line('targets')).toEqual([
      '["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"]',
    ]);
    expect(line('yanked')).toEqual(['"deny"']);
    expect(line('ignore')).toEqual(['[]']);
    expect(line('unknown-git')).toEqual(['"deny"']);
    expect(line('unknown-registry')).toEqual(['"deny"']);
    // Git sources: the knext-ffi repository only, the same one knext enforces.
    expect(line('allow-git')).toEqual([`["${ALLOWED_GIT_SOURCE}"]`]);
    expect(line('allow-registry')).toEqual(['["https://github.com/rust-lang/crates.io-index"]']);
    // It points at the dated allowlist, not at deny.toml's undated `ignore`.
    expect(deny).toContain(ADVISORY_ALLOWLIST_FILE);
  });
});
