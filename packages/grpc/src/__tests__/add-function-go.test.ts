import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { addFunction } from '../add-function';
import {
  GO_TEMPLATE_EXCLUDES,
  goTemplateDir,
  goTemplateFiles,
  isExcluded,
  scaffoldedFromTemplate,
} from '../scaffold-go';
import { capture, emptyDir, removeScratchDirs } from './helpers';

afterAll(removeScratchDirs);

function walk(dir: string): string[] {
  const out: string[] = [];
  const rec = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) rec(p);
      else out.push(relative(dir, p).split('\\').join('/'));
    }
  };
  rec(dir);
  return out.sort();
}

const hasGo = spawnSync('go', ['version']).status === 0;

describe('knext add function <name> --lang go scaffolds templates/go', () => {
  it('writes the server project with the name and module path substituted', () => {
    const app = emptyDir('go-scaffold');
    const c = capture();
    expect(
      addFunction({
        cwd: app,
        name: 'user-profile',
        lang: 'go',
        module: 'acme.dev/user-profile',
        io: c.io,
      }),
      c.err(),
    ).toBe(0);
    const root = join(app, 'functions', 'user-profile');
    const files = walk(root);
    for (const f of [
      'go.mod',
      'main.go',
      'Dockerfile',
      'internal/auth/token.go',
      'internal/rpc/rpc.go',
      'internal/items/items.go',
    ]) {
      expect(files).toContain(f);
    }
    expect(files).toContain('proto/user_profile/v1/user_profile.proto');
    expect(files).toContain('gen/user_profile/v1/user_profile.pb.go');
    expect(readFileSync(join(root, 'go.mod'), 'utf8')).toContain('module acme.dev/user-profile\n');
    expect(readFileSync(join(root, 'main.go'), 'utf8')).toContain(
      '"acme.dev/user-profile/internal/rpc"',
    );
    expect(readFileSync(join(root, 'buf.gen.yaml'), 'utf8')).toContain('acme.dev/user-profile/gen');
    expect(readFileSync(join(root, 'internal/items/items.go'), 'utf8')).toContain(
      'user_profilev1connect.UserProfileServiceHandler',
    );
    // The zone side still gets its contract and config entry.
    expect(existsSync(join(app, 'proto/user_profile/v1/user_profile.proto'))).toBe(true);
    expect(readFileSync(join(app, 'knext.grpc.json'), 'utf8')).toContain('"user-profile"');
  });

  it('leaves no template placeholder behind', () => {
    const app = emptyDir('go-placeholders');
    expect(addFunction({ cwd: app, name: 'orders', lang: 'go', io: capture().io })).toBe(0);
    const root = join(app, 'functions', 'orders');
    const stale = [
      'example.com/function',
      'ExampleService',
      'examplev1',
      'example.v1',
      'example/v1',
      'example.proto',
    ];
    for (const f of walk(root)) {
      if (f.endsWith('.sum')) continue;
      const text = readFileSync(join(root, f), 'utf8');
      for (const s of stale) expect(text.includes(s), `${f} still contains ${s}`).toBe(false);
    }
    expect(readFileSync(join(root, 'go.mod'), 'utf8')).toContain('module example.com/orders\n');
    expect(existsSync(join(root, 'proto/example'))).toBe(false);
  });

  it('refuses an existing function directory without writing anything', () => {
    const app = emptyDir('go-exists');
    expect(addFunction({ cwd: app, name: 'orders', lang: 'go', io: capture().io })).toBe(0);
    const c = capture();
    expect(addFunction({ cwd: app, name: 'orders', lang: 'go', io: c.io })).toBe(1);
    expect(c.err()).toContain('already exists');
  });

  it('refuses a module path that is not a Go module path', () => {
    const app = emptyDir('go-badmodule');
    const c = capture();
    expect(addFunction({ cwd: app, name: 'orders', lang: 'go', module: 'a b"', io: c.io })).toBe(1);
    expect(c.err()).toContain('module');
    expect(existsSync(join(app, 'functions'))).toBe(false);
  });

  it.skipIf(!hasGo)(
    'the scaffolded function builds, passes its tests and serves health',
    () => {
      const app = emptyDir('go-build');
      expect(addFunction({ cwd: app, name: 'orders', lang: 'go', io: capture().io })).toBe(0);
      const root = join(app, 'functions', 'orders');
      const build = spawnSync('go', ['build', './...'], { cwd: root });
      expect(build.stderr.toString(), 'go build').toBe('');
      expect(build.status).toBe(0);
      const test = spawnSync('go', ['test', '-count=1', './...'], { cwd: root });
      const text = test.stdout.toString() + test.stderr.toString();
      expect(test.status, text).toBe(0);
      // The protocol matrix calls the health check with no token on every protocol.
      const health = spawnSync(
        'go',
        ['test', '-count=1', '-v', '-run', 'TestProtocolMatrix', './internal/rpc'],
        { cwd: root },
      );
      expect(health.stdout.toString()).toContain('--- PASS: TestProtocolMatrix');
    },
    300_000,
  );
});

describe('the Go scaffold copies templates/go minus a counted exclude list', () => {
  it('the exclude list is exactly the reviewed, counted set', () => {
    expect(GO_TEMPLATE_EXCLUDES.map((e) => e.path)).toEqual([
      'README.md',
      'e2e',
      'gen',
      'internal/auth/verifier_test.go',
      'internal/rpc/rpc_vectors_test.go',
      'internal/testvectors',
      'proto',
    ]);
    expect(GO_TEMPLATE_EXCLUDES.length).toBe(7);
  });

  it('every template file is copied, regenerated or on the exclude list', () => {
    const all = walk(goTemplateDir());
    const copied = goTemplateFiles();
    const dropped = all.filter((f) => !copied.includes(f));
    expect(
      dropped.filter((f) => !isExcluded(f)),
      'silently dropped',
    ).toEqual([]);
    expect(copied.filter(isExcluded)).toEqual([]);
    expect(copied.length + dropped.length).toBe(all.length);
    expect(copied.length).toBeGreaterThan(0);
  });

  it('what lands on disk is the copied set plus proto/ and gen/ and nothing else', () => {
    const app = emptyDir('go-guard');
    expect(addFunction({ cwd: app, name: 'orders', lang: 'go', io: capture().io })).toBe(0);
    const root = join(app, 'functions', 'orders');
    const onDisk = walk(root);
    expect(onDisk.filter((f) => !f.startsWith('proto/') && !f.startsWith('gen/'))).toEqual(
      [...scaffoldedFromTemplate()].sort(),
    );
  });
});
