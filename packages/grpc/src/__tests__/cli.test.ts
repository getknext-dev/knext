import { afterAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_PEER_RANGE, DISPATCH_PROTOCOL, GRPC_VERSION, helpText, run, VERBS } from '../cli';
import { capture, copyFixtureZone, emptyDir, PKG_DIR, removeScratchDirs } from './helpers';

afterAll(removeScratchDirs);

const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
  version: string;
  peerDependencies: Record<string, string>;
};

describe('the module core dispatches to', () => {
  it('exposes the protocol, its version and its core peer range from package.json', () => {
    expect(DISPATCH_PROTOCOL).toBe(1);
    expect(GRPC_VERSION).toBe(pkg.version);
    expect(CORE_PEER_RANGE).toBe(pkg.peerDependencies['@getknext/core'] as string);
  });

  it('owns exactly the generate, add and deploy verbs', () => {
    expect([...VERBS].sort()).toEqual(['add', 'deploy', 'generate']);
  });

  it.each([
    ['generate', ['--help']],
    ['generate', ['-h']],
    ['add', ['--help']],
    ['add', ['function', '--help']],
  ])('`knext %s %s` prints help and exits 0, doing nothing', async (verb, argv) => {
    const dir = emptyDir('help');
    const c = capture();
    expect(await run(verb, argv, { ...c.io, cwd: dir })).toBe(0);
    expect(c.out()).toContain(`knext ${verb}`);
    expect(c.out()).toContain('Exit code');
    expect(helpText(verb)).toBe(c.out().trimEnd());
  });

  it.each([
    ['generate', ['--zzz-not-a-real-flag']],
    ['add', ['function', 'orders', '--lang', 'go', '--zzz-not-a-real-flag']],
  ])('`knext %s` rejects an unknown flag with a plain message', async (verb, argv) => {
    const c = capture();
    expect(await run(verb, argv, { ...c.io, cwd: emptyDir('flag') })).toBe(1);
    expect(c.err()).toContain('--zzz-not-a-real-flag');
    expect(c.err()).toContain(`knext ${verb} --help`);
    expect(c.err()).not.toMatch(/\n\s+at\s/);
  });

  it('generate takes no positional arguments', async () => {
    const c = capture();
    expect(await run('generate', ['proto'], { ...c.io, cwd: emptyDir('pos') })).toBe(1);
    expect(c.err()).toContain('unexpected argument');
  });

  it('add needs the `function` noun, a name and --lang', async () => {
    const dir = emptyDir('addargs');
    for (const argv of [[], ['service', 'x'], ['function'], ['function', 'orders']]) {
      const c = capture();
      expect(await run('add', argv, { ...c.io, cwd: dir }), argv.join(' ')).toBe(1);
      expect(c.err()).toContain('knext add function <name> --lang go|rust');
    }
  });

  it('runs add function, then generate --check, end to end', async () => {
    const dir = emptyDir('e2e');
    const add = capture();
    expect(await run('add', ['function', 'orders', '--lang', 'go'], { ...add.io, cwd: dir })).toBe(
      0,
    );
    expect(await run('generate', [], { ...capture().io, cwd: dir })).toBe(0);
    const check = capture();
    expect(await run('generate', ['--check'], { ...check.io, cwd: dir }), check.err()).toBe(0);
  });

  it('passes --against through to the breaking check', async () => {
    const zone = copyFixtureZone('cli-against');
    const c = capture();
    expect(
      await run('generate', ['--check', '--against', 'deployed:shop/orders'], {
        ...c.io,
        cwd: zone,
      }),
    ).toBe(1);
    expect(c.err()).toContain('not available yet');
  });

  it('an unknown verb is refused', async () => {
    const c = capture();
    expect(await run('deploy', [], { ...c.io, cwd: emptyDir('verb') })).toBe(1);
    expect(c.err()).toContain('deploy');
  });
});
