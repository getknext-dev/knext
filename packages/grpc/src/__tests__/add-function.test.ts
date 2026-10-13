import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addFunction } from '../add-function';
import { runBuf } from '../buf';
import { loadConfig } from '../config';
import { runGenerate } from '../generate';
import { capture, emptyDir, PKG_DIR, readTree, removeScratchDirs } from './helpers';

afterAll(removeScratchDirs);

describe('knext add function <name> --lang go|rust', () => {
  it('scaffolds a contract that lints, generates, and passes --check', async () => {
    const app = emptyDir('add-go');
    const c = capture();
    expect(addFunction({ cwd: app, name: 'orders', lang: 'go', io: c.io }), c.err()).toBe(0);

    expect(existsSync(join(app, 'buf.yaml'))).toBe(true);
    expect(existsSync(join(app, 'proto/knext/v1/options.proto'))).toBe(true);
    const proto = readFileSync(join(app, 'proto/orders/v1/orders.proto'), 'utf8');
    expect(proto).toContain('package orders.v1;');
    expect(proto).toContain('option (knext.v1.function) = "orders";');
    expect(proto).toContain('option (knext.v1.contract_version) = "1.0.0";');
    expect(proto).toContain('service OrdersService');
    expect(proto).toContain('option idempotency_level = NO_SIDE_EFFECTS;');

    expect(loadConfig(app).functions).toEqual({ orders: { lang: 'go' } });

    expect(runBuf(['lint'], { cwd: app }).status).toBe(0);
    const gen = capture();
    expect(await runGenerate({ cwd: app, io: gen.io }), gen.err()).toBe(0);
    expect(await runGenerate({ cwd: app, check: true, io: capture().io })).toBe(0);
    expect(c.out()).toContain('knext generate');
  });

  it('vendors the options contract byte-for-byte from the package', () => {
    const app = emptyDir('add-vendor');
    expect(addFunction({ cwd: app, name: 'orders', lang: 'rust', io: capture().io })).toBe(0);
    expect(readFileSync(join(app, 'proto/knext/v1/options.proto'), 'utf8')).toBe(
      readFileSync(join(PKG_DIR, 'proto/knext/v1/options.proto'), 'utf8'),
    );
  });

  it('maps a dashed name onto a proto package, a service and the URL binding', async () => {
    const app = emptyDir('add-dashed');
    expect(addFunction({ cwd: app, name: 'user-profile', lang: 'rust', io: capture().io })).toBe(0);
    const proto = readFileSync(join(app, 'proto/user_profile/v1/user_profile.proto'), 'utf8');
    expect(proto).toContain('package user_profile.v1;');
    expect(proto).toContain('service UserProfileService');
    expect(await runGenerate({ cwd: app, io: capture().io })).toBe(0);
    const client = readFileSync(
      join(app, 'src/generated/grpc/user_profile/v1/user_profile_knext.ts'),
      'utf8',
    );
    expect(client).toContain('urlEnv: "USER_PROFILE_SERVICE_URL",');
  });

  it('adds a second function next to the first and keeps the config sorted', () => {
    const app = emptyDir('add-second');
    expect(addFunction({ cwd: app, name: 'orders', lang: 'go', io: capture().io })).toBe(0);
    expect(addFunction({ cwd: app, name: 'billing', lang: 'rust', io: capture().io })).toBe(0);
    const raw = readFileSync(join(app, 'knext.grpc.json'), 'utf8');
    expect(raw.indexOf('"billing"')).toBeLessThan(raw.indexOf('"orders"'));
    expect(loadConfig(app).functions).toEqual({
      billing: { lang: 'rust' },
      orders: { lang: 'go' },
    });
  });

  it('is byte-stable: the same command in two apps writes identical files', () => {
    const a = emptyDir('add-stable-a');
    const b = emptyDir('add-stable-b');
    expect(addFunction({ cwd: a, name: 'orders', lang: 'go', io: capture().io })).toBe(0);
    expect(addFunction({ cwd: b, name: 'orders', lang: 'go', io: capture().io })).toBe(0);
    expect(readTree(b)).toEqual(readTree(a));
  });

  it('refuses to overwrite an existing function', () => {
    const app = emptyDir('add-twice');
    expect(addFunction({ cwd: app, name: 'orders', lang: 'go', io: capture().io })).toBe(0);
    const proto = join(app, 'proto/orders/v1/orders.proto');
    writeFileSync(proto, `${readFileSync(proto, 'utf8')}// mine\n`);
    const c = capture();
    expect(addFunction({ cwd: app, name: 'orders', lang: 'rust', io: c.io })).toBe(1);
    expect(c.err()).toContain('already');
    expect(readFileSync(proto, 'utf8')).toContain('// mine');
    expect(loadConfig(app).functions.orders?.lang).toBe('go');
  });

  it('keeps an existing buf.yaml', () => {
    const app = emptyDir('add-bufyaml');
    writeFileSync(join(app, 'buf.yaml'), 'version: v2\nmodules:\n  - path: proto\n');
    expect(addFunction({ cwd: app, name: 'orders', lang: 'go', io: capture().io })).toBe(0);
    expect(readFileSync(join(app, 'buf.yaml'), 'utf8')).toBe(
      'version: v2\nmodules:\n  - path: proto\n',
    );
  });

  it('rejects a name that is not a DNS label, or that buf lint would refuse', () => {
    // `a--b` is a DNS label, but it maps to the proto package `a__b`, which
    // buf lint rejects; `-orders` and `orders-` are not labels at all.
    for (const bad of [
      'Orders',
      '1orders',
      'orders-',
      '-orders',
      'or_ders',
      'a--b',
      'user--profile',
      'a'.repeat(64),
      '',
    ]) {
      const c = capture();
      expect(addFunction({ cwd: emptyDir('add-bad'), name: bad, lang: 'go', io: c.io }), bad).toBe(
        1,
      );
      expect(c.err()).toContain('not a valid function name');
    }
  });

  it('refuses the name `knext`, which would land in the knext options package', () => {
    const c = capture();
    expect(addFunction({ cwd: emptyDir('add-knext'), name: 'knext', lang: 'go', io: c.io })).toBe(
      1,
    );
    expect(c.err()).toContain('reserved');
  });

  it('every name it accepts scaffolds a contract buf lint accepts', () => {
    // The edges of the accepted grammar: one letter, digits after a letter,
    // a digit-led segment after a hyphen, several segments, the 63-char limit.
    const longest = `a${'-b1'.repeat(20)}x`;
    expect(longest).toHaveLength(62);
    for (const name of [
      'a',
      'a1',
      'v1',
      'user-2fa',
      'orders-v2',
      'a-b-c',
      'ab-1',
      longest,
      `${longest}z`,
    ]) {
      const app = emptyDir('add-good');
      const c = capture();
      expect(addFunction({ cwd: app, name, lang: 'go', io: c.io }), `${name}: ${c.err()}`).toBe(0);
      const lint = runBuf(['lint'], { cwd: app });
      expect(lint.status, `${name}: ${lint.stdout.toString()}`).toBe(0);
    }
  });

  it('rejects a language outside the 2.0 set', () => {
    const c = capture();
    expect(
      addFunction({
        cwd: emptyDir('add-lang'),
        name: 'orders',
        lang: 'python',
        io: c.io,
      }),
    ).toBe(1);
    expect(c.err()).toContain('go, rust');
  });
});
