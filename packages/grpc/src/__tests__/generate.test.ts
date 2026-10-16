import { afterAll, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { generateFiles, previouslyWritten, runGenerate, writeFileAtomic } from '../generate';
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
      'orders/v1/catalog_knext.ts',
      'orders/v1/catalog_knext_server.ts',
      'orders/v1/catalog_pb.ts',
      'orders/v1/orders_knext.ts',
      'orders/v1/orders_knext_actions.ts',
      'orders/v1/orders_knext_server.ts',
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

  it('does not depend on the working directory it runs from', () => {
    // CI checks out into /home/runner/work/knext/knext. An import that climbs
    // out of the output root (the authorize() hook) must not be resolved
    // against that path, or `../../knext/authorize` collapses into the
    // checkout's own `knext` directory and the import loses a segment.
    const nested = join(emptyDir('cwd'), 'knext', 'knext');
    mkdirSync(nested, { recursive: true });
    const before = process.cwd();
    process.chdir(nested);
    try {
      expect(generateFiles(FIXTURE_ZONE)).toEqual(readTree(join(FIXTURE_ZONE, OUT)));
    } finally {
      process.chdir(before);
    }
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
    'NODE_MODULES/gen',
    'src/Node_Modules/gen',
  ])('refuses out: %p', async (out) => {
    const zone = copyFixtureZone('own-refuse');
    setConfig(zone, { out });
    const c = capture();
    expect(await runGenerate({ cwd: zone, io: c.io })).toBe(1);
    expect(c.err()).toContain('"out"');
  });

  it('a record entry naming a directory is skipped, not a crash', async () => {
    const zone = copyFixtureZone('own-direntry');
    const manifest = join(zone, OUT, '.knext-generated.json');
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    m.files.push('orders');
    writeFileSync(manifest, JSON.stringify(m));
    const check = capture();
    // The record changed, so --check reports drift on it, but nothing crashes.
    expect(await runGenerate({ cwd: zone, check: true, io: check.io })).toBe(1);
    expect(check.err()).not.toMatch(/stale\s+orders\n/);
    expect(check.err()).not.toMatch(/EPERM|EISDIR|\n\s+at\s/);
    const c = capture();
    expect(await runGenerate({ cwd: zone, io: c.io }), c.err()).toBe(0);
    expect(existsSync(join(zone, OUT, 'orders/v1/orders_knext.ts'))).toBe(true);
  });
});

describe('knext generate never writes through a symlink', () => {
  /** A directory outside the fixture zone, holding one file. */
  function outsideDir(): { dir: string; file: string } {
    const dir = emptyDir('outside');
    const file = join(dir, 'precious.ts');
    writeFileSync(file, 'export const untouched = true;\n');
    return { dir, file };
  }

  it('refuses a generated file that is a symlink to a file outside, and leaves it alone', async () => {
    const zone = copyFixtureZone('w-filelink');
    const { file } = outsideDir();
    const target = join(zone, OUT, 'orders/v1/orders_knext.ts');
    unlinkSync(target);
    symlinkSync(file, target);
    const c = capture();
    expect(await runGenerate({ cwd: zone, io: c.io })).toBe(1);
    expect(c.err()).toContain('symlink');
    expect(c.err()).toContain('orders/v1/orders_knext.ts');
    expect(c.err()).not.toMatch(/\n\s+at\s/);
    expect(readFileSync(file, 'utf8')).toBe('export const untouched = true;\n');
  });

  it('refuses a directory symlink inside out that leads outside, writing nothing there', async () => {
    const zone = copyFixtureZone('w-dirlink');
    const { dir } = outsideDir();
    rmSync(join(zone, OUT, 'orders'), { recursive: true });
    symlinkSync(dir, join(zone, OUT, 'orders'));
    const c = capture();
    expect(await runGenerate({ cwd: zone, io: c.io })).toBe(1);
    expect(c.err()).toContain('outside');
    // Not a file written, and not even an empty directory created out there.
    expect(readdirSync(dir)).toEqual(['precious.ts']);
    expect(readTree(dir)).toEqual(new Map([['precious.ts', 'export const untouched = true;\n']]));
  });

  it('refuses an out directory that is itself a symlink to somewhere outside the app', async () => {
    const zone = copyFixtureZone('w-outlink');
    const { dir } = outsideDir();
    setConfig(zone, { out: 'gen' });
    symlinkSync(dir, join(zone, 'gen'));
    const c = capture();
    expect(await runGenerate({ cwd: zone, io: c.io })).toBe(1);
    expect(readTree(dir)).toEqual(new Map([['precious.ts', 'export const untouched = true;\n']]));
  });

  it('does not even create the output directory under a parent that leads outside', async () => {
    const zone = copyFixtureZone('w-parentlink');
    const { dir } = outsideDir();
    setConfig(zone, { out: 'link/gen' });
    symlinkSync(dir, join(zone, 'link'));
    const c = capture();
    expect(await runGenerate({ cwd: zone, io: c.io })).toBe(1);
    expect(c.err()).toContain('outside the app');
    expect(existsSync(join(dir, 'gen'))).toBe(false);
  });

  it('checks every target before writing any of them', async () => {
    const zone = copyFixtureZone('w-allornothing');
    const { file } = outsideDir();
    rmSync(join(zone, OUT), { recursive: true });
    mkdirSync(join(zone, OUT, 'orders/v1'), { recursive: true });
    // orders_pb.ts sorts after the knext/ files, so a write-as-you-go loop
    // would have written those first.
    symlinkSync(file, join(zone, OUT, 'orders/v1/orders_pb.ts'));
    expect(await runGenerate({ cwd: zone, io: capture().io })).toBe(1);
    expect(existsSync(join(zone, OUT, 'knext/v1/options_pb.ts'))).toBe(false);
  });

  it('replaces a hardlinked generated file instead of writing through its shared inode', async () => {
    const zone = copyFixtureZone('w-hardlink');
    const { file } = outsideDir();
    const target = join(zone, OUT, 'orders/v1/orders_knext.ts');
    unlinkSync(target);
    linkSync(file, target);
    expect(statSync(target).ino).toBe(statSync(file).ino);
    const c = capture();
    expect(await runGenerate({ cwd: zone, io: c.io }), c.err()).toBe(0);
    // The outside twin keeps its bytes; the target now holds the generated code.
    expect(readFileSync(file, 'utf8')).toBe('export const untouched = true;\n');
    expect(readFileSync(target, 'utf8')).toBe(
      readFileSync(join(FIXTURE_ZONE, OUT, 'orders/v1/orders_knext.ts'), 'utf8'),
    );
    expect(statSync(target).ino).not.toBe(statSync(file).ino);
    // No temp file is left behind next to the target.
    expect(readdirSync(join(zone, OUT, 'orders/v1')).sort()).toEqual(
      readdirSync(join(FIXTURE_ZONE, OUT, 'orders/v1')).sort(),
    );
  });

  it('regenerating keeps an existing file mode (0600 stays 0600)', () => {
    const dir = emptyDir('w-atomic-mode');
    const target = join(dir, 'target.ts');
    writeFileSync(target, 'old\n');
    chmodSync(target, 0o600);
    writeFileAtomic(target, 'export {};\n');
    expect(readFileSync(target, 'utf8')).toBe('export {};\n');
    expect(statSync(target).mode & 0o7777).toBe(0o600);
  });

  it('regenerating clears setuid, as an in-place write did (4755 becomes 0755)', () => {
    const dir = emptyDir('w-atomic-setuid');
    const target = join(dir, 'target.ts');
    writeFileSync(target, 'old\n');
    chmodSync(target, 0o4755);
    expect(statSync(target).mode & 0o7777).toBe(0o4755);
    writeFileAtomic(target, 'export {};\n');
    expect(statSync(target).mode & 0o7777).toBe(0o755);
  });

  it('a read-only generated file is still replaced, and stays read-only', () => {
    const dir = emptyDir('w-atomic-readonly');
    const target = join(dir, 'target.ts');
    writeFileSync(target, 'old\n');
    chmodSync(target, 0o444);
    writeFileAtomic(target, 'export {};\n');
    expect(readFileSync(target, 'utf8')).toBe('export {};\n');
    expect(statSync(target).mode & 0o7777).toBe(0o444);
  });

  it('a failed write leaves no temp file behind', () => {
    const dir = emptyDir('w-atomic-fail');
    // rename() cannot replace a non-empty directory, so the write fails after
    // the temp file was created.
    mkdirSync(join(dir, 'target.ts', 'occupied'), { recursive: true });
    expect(() => writeFileAtomic(join(dir, 'target.ts'), 'export {};\n')).toThrow();
    expect(readdirSync(dir)).toEqual(['target.ts']);
  });

  it('still writes normally into a real directory, including new subdirectories', async () => {
    const zone = copyFixtureZone('w-normal');
    rmSync(join(zone, OUT), { recursive: true });
    const c = capture();
    expect(await runGenerate({ cwd: zone, io: c.io }), c.err()).toBe(0);
    expect(readTree(join(zone, OUT))).toEqual(readTree(join(FIXTURE_ZONE, OUT)));
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
