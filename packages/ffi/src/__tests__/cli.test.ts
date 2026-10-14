/**
 * The module core loads for `knext ffi …` (ADR-0069 D12): the dispatch
 * protocol core checks, help for every subcommand, the Beta line on every run,
 * and routing to init / generate / check / build.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BETA_NOTICE,
  CORE_PEER_RANGE,
  DISPATCH_PROTOCOL,
  FFI_VERSION,
  helpText,
  run,
  SUBCOMMANDS,
} from '../cli';
import { capture, emptyDir, PKG_DIR, removeScratchDirs } from './helpers';

afterAll(removeScratchDirs);

const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
  version: string;
  peerDependencies: Record<string, string>;
};

describe('the dispatch protocol core checks', () => {
  it('protocol 1, the package version, and the core peer range from package.json', () => {
    expect(DISPATCH_PROTOCOL).toBe(1);
    expect(FFI_VERSION).toBe(pkg.version);
    expect(CORE_PEER_RANGE).toBe(pkg.peerDependencies['@getknext/core'] as string);
  });

  it('offers exactly init, generate, check and build', () => {
    expect([...SUBCOMMANDS]).toEqual(['init', 'generate', 'check', 'build']);
  });
});

describe('help', () => {
  it('the group help names every subcommand, Beta, Bun only, and the optional package', () => {
    const h = helpText('');
    for (const s of [
      'knext ffi init',
      'knext ffi generate',
      'knext ffi check',
      'knext ffi build',
      'Beta',
      'Bun only',
    ]) {
      expect(h).toContain(s);
    }
  });

  for (const sub of ['init', 'generate', 'check', 'build']) {
    it(`knext ffi ${sub} --help exits 0 with its own usage`, async () => {
      const c = capture();
      expect(await run('ffi', [sub, '--help'], { ...c.io, cwd: emptyDir('help') })).toBe(0);
      expect(c.out()).toContain(`Usage: knext ffi ${sub}`);
    });
  }

  it('knext ffi --help and -h exit 0 with the group help', async () => {
    for (const flag of ['--help', '-h']) {
      const c = capture();
      expect(await run('ffi', [flag], c.io)).toBe(0);
      expect(c.out()).toContain('knext ffi init');
    }
  });
});

describe('routing', () => {
  it('no subcommand: usage, exit 1', async () => {
    const c = capture();
    expect(await run('ffi', [], c.io)).toBe(1);
    expect(c.err()).toContain('Usage: knext ffi <init|generate|check|build>');
  });

  it('an unknown subcommand: exit 1, naming it', async () => {
    const c = capture();
    expect(await run('ffi', ['frob'], c.io)).toBe(1);
    expect(c.err()).toContain('unknown subcommand "frob"');
  });

  it('a verb this package does not provide: exit 1', async () => {
    const c = capture();
    expect(await run('generate', [], c.io)).toBe(1);
    expect(c.err()).toContain('@getknext/ffi does not provide the "generate" command');
  });

  it('every run prints one line naming the Beta status and the upstream bun:ffi status', async () => {
    expect(BETA_NOTICE).toContain('Beta');
    expect(BETA_NOTICE).toContain('bun:ffi');
    expect(BETA_NOTICE).toContain('experimental');
    const c = capture();
    await run('ffi', ['check'], { ...c.io, cwd: emptyDir('beta') });
    expect(c.err().split('\n')[0]).toBe(BETA_NOTICE);
  });

  it('strict flags: an unknown flag is a usage error, exit 1', async () => {
    const c = capture();
    expect(await run('ffi', ['check', '--frob'], { ...c.io, cwd: emptyDir('flags') })).toBe(1);
    expect(c.err()).toContain('knext ffi check:');
  });

  it('init and check reach their implementations', async () => {
    const cwd = emptyDir('route');
    const c = capture();
    expect(await run('ffi', ['init'], { ...c.io, cwd, crateRev: 'b'.repeat(40) })).toBe(0);
    expect(readFileSync(join(cwd, 'knext.ffi.json'), 'utf8')).toContain('"version": 1');
    const d = capture();
    expect(
      await run('ffi', ['check'], {
        ...d.io,
        cwd,
        buildLibrary: () => {
          throw new Error('cargo ran');
        },
      }),
    ).toBe(1);
    expect(d.err()).toContain('cargo ran');
  });

  it('build: delegates to the build module with its argv', async () => {
    const seen: unknown[] = [];
    const c = capture();
    const code = await run('ffi', ['build', '--target', 'x86_64-unknown-linux-musl'], {
      ...c.io,
      cwd: '/app',
      loadBuild: async () => ({
        runBuild: async (opts: { cwd: string; argv: readonly string[] }) => {
          seen.push(opts.cwd, opts.argv);
          return 4;
        },
      }),
    });
    expect(code).toBe(4);
    expect(seen).toEqual(['/app', ['--target', 'x86_64-unknown-linux-musl']]);
  });

  it('build: when this version has no build module, exit 1 saying so', async () => {
    const c = capture();
    const missing = Object.assign(new Error("Cannot find module './build'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const code = await run('ffi', ['build'], {
      ...c.io,
      loadBuild: async () => {
        throw missing;
      },
    });
    expect(code).toBe(1);
    expect(c.err()).toContain(
      '`knext ffi build` is not available in this version of @getknext/ffi',
    );
  });
});
