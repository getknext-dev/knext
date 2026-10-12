import { afterAll, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { generateFiles, previouslyWritten, runGenerate } from '../generate';
import {
  capture,
  copyFixtureZone,
  emptyDir,
  FIXTURE_ZONE,
  readTree,
  removeScratchDirs,
} from './helpers';

afterAll(removeScratchDirs);

const OUT = join('src', 'generated', 'grpc');

describe('knext generate — byte-stable output', () => {
  it('two runs over the same contract produce identical bytes', async () => {
    const a = copyFixtureZone('stable-a');
    const b = copyFixtureZone('stable-b');
    rmSync(join(a, OUT), { recursive: true, force: true });
    rmSync(join(b, OUT), { recursive: true, force: true });

    const first = capture();
    expect(await runGenerate({ cwd: a, io: first.io }), first.err()).toBe(0);
    const second = capture();
    expect(await runGenerate({ cwd: b, io: second.io }), second.err()).toBe(0);
    // ...and a third run over the first directory's existing output.
    const third = capture();
    expect(await runGenerate({ cwd: a, io: third.io }), third.err()).toBe(0);

    const treeA = readTree(join(a, OUT));
    const treeB = readTree(join(b, OUT));
    expect([...treeA.keys()]).toEqual([
      '.knext-generated.json',
      'knext/v1/options_pb.ts',
      'orders/v1/orders_knext.ts',
      'orders/v1/orders_pb.ts',
    ]);
    expect(treeB).toEqual(treeA);
  });

  it('in-memory generation is deterministic and matches the committed fixture output', () => {
    const once = generateFiles(FIXTURE_ZONE);
    const twice = generateFiles(FIXTURE_ZONE);
    expect(twice).toEqual(once);
    expect(once).toEqual(readTree(join(FIXTURE_ZONE, OUT)));
  });

  it('writes nothing machine-specific into the output', () => {
    const zone = copyFixtureZone('paths');
    for (const [path, text] of generateFiles(zone)) {
      expect(text, path).not.toContain(zone);
      expect(text, path).not.toContain(FIXTURE_ZONE);
      expect(text, path).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
    }
  });
});

describe('knext generate --check — reds on drift', () => {
  it('passes when the committed output is current', async () => {
    const zone = copyFixtureZone('check-clean');
    const c = capture();
    expect(await runGenerate({ cwd: zone, check: true, io: c.io }), c.err()).toBe(0);
    expect(c.out()).toContain('up to date');
  });

  it('reds when a generated file was edited by hand', async () => {
    const zone = copyFixtureZone('check-edit');
    const file = join(zone, OUT, 'orders/v1/orders_knext.ts');
    writeFileSync(file, `${readFileSync(file, 'utf8')}// local edit\n`);
    const c = capture();
    expect(await runGenerate({ cwd: zone, check: true, io: c.io })).toBe(1);
    expect(c.err()).toContain('orders/v1/orders_knext.ts');
    expect(c.err()).toContain('changed');
    // --check never writes: the drift is still there.
    expect(readFileSync(file, 'utf8')).toContain('// local edit');
  });

  it('reds when the contract changed but the output was not regenerated', async () => {
    const zone = copyFixtureZone('check-proto');
    const proto = join(zone, 'proto/orders/v1/orders.proto');
    writeFileSync(
      proto,
      readFileSync(proto, 'utf8').replace(
        'message CancelOrderRequest {\n  string id = 1;\n}',
        'message CancelOrderRequest {\n  string id = 1;\n  string reason = 2;\n}',
      ),
    );
    const c = capture();
    expect(await runGenerate({ cwd: zone, check: true, io: c.io })).toBe(1);
    expect(c.err()).toContain('orders/v1/orders_pb.ts');
  });

  it('reds when a generated file is missing', async () => {
    const zone = copyFixtureZone('check-missing');
    unlinkSync(join(zone, OUT, 'orders/v1/orders_knext.ts'));
    const c = capture();
    expect(await runGenerate({ cwd: zone, check: true, io: c.io })).toBe(1);
    expect(c.err()).toContain('missing');
  });

  it('reds on a stale generated file the contract no longer produces', async () => {
    const zone = copyFixtureZone('check-stale');
    // The orders contract goes away; its two generated files were written by
    // the last run (they are in the manifest) and are now stale.
    unlinkSync(join(zone, 'proto/orders/v1/orders.proto'));
    const c = capture();
    expect(await runGenerate({ cwd: zone, check: true, io: c.io })).toBe(1);
    expect(c.err()).toContain('stale');
    expect(c.err()).toContain('orders/v1/orders_knext.ts');
    expect(c.err()).toContain('orders/v1/orders_pb.ts');
    // --check deletes nothing.
    expect(existsSync(join(zone, OUT, 'orders/v1/orders_knext.ts'))).toBe(true);
  });

  it('leaves hand-written files in the output directory alone', async () => {
    const zone = copyFixtureZone('check-handwritten');
    writeFileSync(join(zone, OUT, 'README.md'), 'notes\n');
    const c = capture();
    expect(await runGenerate({ cwd: zone, check: true, io: c.io }), c.err()).toBe(0);
    expect(await runGenerate({ cwd: zone, io: capture().io })).toBe(0);
    expect(existsSync(join(zone, OUT, 'README.md'))).toBe(true);
  });

  it('a regenerate fixes the drift and removes the stale files', async () => {
    const zone = copyFixtureZone('check-fix');
    unlinkSync(join(zone, 'proto/orders/v1/orders.proto'));
    expect(await runGenerate({ cwd: zone, io: capture().io })).toBe(0);
    expect(existsSync(join(zone, OUT, 'orders/v1/orders_knext.ts'))).toBe(false);
    expect(existsSync(join(zone, OUT, 'orders/v1/orders_pb.ts'))).toBe(false);
    expect(existsSync(join(zone, OUT, 'knext/v1/options_pb.ts'))).toBe(true);
    expect(await runGenerate({ cwd: zone, check: true, io: capture().io })).toBe(0);
  });
});

/** Write a `knext.grpc.json` override into a fixture copy. */
function setConfig(zone: string, patch: Record<string, unknown>): void {
  const path = join(zone, 'knext.grpc.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...patch }));
}

const FOREIGN_GENERATED =
  '// @generated by protoc-gen-es v2.16.0 with parameter "target=ts"\nexport {};\n';

describe('knext generate deletes only what it wrote', () => {
  it('out: "src" keeps a protoc-gen-es file the user generated themselves', async () => {
    const zone = copyFixtureZone('own-src');
    setConfig(zone, { out: 'src' });
    const theirs = join(zone, 'src', 'billing_pb.ts');
    writeFileSync(theirs, FOREIGN_GENERATED);

    const c = capture();
    expect(await runGenerate({ cwd: zone, io: c.io }), c.err()).toBe(0);
    expect(readFileSync(theirs, 'utf8')).toBe(FOREIGN_GENERATED);
    // ...and --check does not call it stale either.
    const check = capture();
    expect(await runGenerate({ cwd: zone, check: true, io: check.io }), check.err()).toBe(0);
    expect(existsSync(theirs)).toBe(true);
  });

  it('a generated-looking file in the output directory that this tool did not write survives', async () => {
    const zone = copyFixtureZone('own-foreign');
    const theirs = join(zone, OUT, 'orders/v1/legacy_pb.ts');
    writeFileSync(theirs, FOREIGN_GENERATED);
    expect(await runGenerate({ cwd: zone, io: capture().io })).toBe(0);
    expect(existsSync(theirs)).toBe(true);
  });

  it('a manifest entry that escapes the output directory is never deleted', async () => {
    const zone = copyFixtureZone('own-escape');
    const keep = join(zone, 'keep_pb.ts');
    writeFileSync(keep, FOREIGN_GENERATED);
    const manifest = join(zone, OUT, '.knext-generated.json');
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    m.files.push('../../../keep_pb.ts', '/etc/hosts');
    writeFileSync(manifest, JSON.stringify(m));
    expect(await runGenerate({ cwd: zone, io: capture().io })).toBe(0);
    expect(existsSync(keep)).toBe(true);
  });

  it('the manifest reader keeps only entries confined to the output directory', () => {
    const dir = emptyDir('own-reader');
    writeFileSync(
      join(dir, '.knext-generated.json'),
      JSON.stringify({
        files: [
          'ok/a_pb.ts',
          'b_knext.ts',
          '../x_pb.ts',
          'a/../../x_pb.ts',
          'a/../c_pb.ts',
          './d_pb.ts',
          '/etc/hosts',
          'e\\f_pb.ts',
          '.knext-generated.json',
          '',
          7,
        ],
      }),
    );
    expect(previouslyWritten(dir)).toEqual(['b_knext.ts', 'ok/a_pb.ts']);
  });

  it('a missing or malformed manifest owns nothing', () => {
    const dir = emptyDir('own-nomanifest');
    expect(previouslyWritten(dir)).toEqual([]);
    writeFileSync(join(dir, '.knext-generated.json'), '{ not json');
    expect(previouslyWritten(dir)).toEqual([]);
    writeFileSync(join(dir, '.knext-generated.json'), '{"files":"a.ts"}');
    expect(previouslyWritten(dir)).toEqual([]);
  });

  it('a manifest entry that reaches outside through a symlink is never deleted', async () => {
    const zone = copyFixtureZone('own-symlink');
    const outside = join(zone, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'victim_pb.ts'), FOREIGN_GENERATED);
    symlinkSync(outside, join(zone, OUT, 'link'));
    const manifest = join(zone, OUT, '.knext-generated.json');
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    m.files.push('link/victim_pb.ts');
    writeFileSync(manifest, JSON.stringify(m));
    expect(await runGenerate({ cwd: zone, io: capture().io })).toBe(0);
    expect(existsSync(join(outside, 'victim_pb.ts'))).toBe(true);
  });

  it('out: "." is refused, and nothing in node_modules is touched', async () => {
    const zone = copyFixtureZone('own-dot');
    setConfig(zone, { out: '.' });
    const nm = join(zone, 'node_modules', 'some-pkg');
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, 'thing_pb.ts'), FOREIGN_GENERATED);
    const c = capture();
    expect(await runGenerate({ cwd: zone, io: c.io })).toBe(1);
    expect(c.err()).toContain('"out"');
    expect(readFileSync(join(nm, 'thing_pb.ts'), 'utf8')).toBe(FOREIGN_GENERATED);
  });

  it.each([
    '.',
    './',
    '',
    'src/..',
    '../elsewhere',
    '/tmp/gen',
    'node_modules/gen',
    'src/node_modules/gen',
  ])('refuses out: %p', async (out) => {
    const zone = copyFixtureZone('own-refuse');
    setConfig(zone, { out });
    const c = capture();
    expect(await runGenerate({ cwd: zone, io: c.io })).toBe(1);
    expect(c.err()).toContain('"out"');
  });
});

describe('knext generate — lint and configuration', () => {
  it('runs buf lint first and fails on a lint error', async () => {
    const zone = copyFixtureZone('lint');
    const proto = join(zone, 'proto/orders/v1/orders.proto');
    writeFileSync(
      proto,
      readFileSync(proto, 'utf8').replace('message GetOrderRequest', 'message get_order_request'),
    );
    const c = capture();
    expect(await runGenerate({ cwd: zone, io: c.io })).toBe(1);
    expect(c.err()).toContain('buf lint');
  });

  it('refuses a deadline that is not shorter than the gateway timeout', async () => {
    const zone = copyFixtureZone('budget');
    const cfgPath = join(zone, 'knext.grpc.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.deadlineMs = 300_000;
    cfg.gatewayTimeoutSeconds = 300;
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const c = capture();
    expect(await runGenerate({ cwd: zone, io: c.io })).toBe(1);
    expect(c.err()).toContain('shorter than the gateway timeout');
  });

  it('explains what to do when there is no knext.grpc.json', async () => {
    const zone = copyFixtureZone('noconfig');
    unlinkSync(join(zone, 'knext.grpc.json'));
    const c = capture();
    expect(await runGenerate({ cwd: zone, io: c.io })).toBe(1);
    expect(c.err()).toContain('knext add function');
  });

  it('refuses a service file that does not name its function', async () => {
    const zone = copyFixtureZone('nofunction');
    const proto = join(zone, 'proto/orders/v1/orders.proto');
    writeFileSync(
      proto,
      readFileSync(proto, 'utf8').replace('option (knext.v1.function) = "orders";\n', ''),
    );
    const c = capture();
    expect(await runGenerate({ cwd: zone, io: c.io })).toBe(1);
    expect(c.err()).toContain('(knext.v1.function)');
  });
});
