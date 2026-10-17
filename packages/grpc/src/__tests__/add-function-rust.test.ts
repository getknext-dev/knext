import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { addFunction } from '../add-function';
import {
  checkCrateName,
  codegenCacheDir,
  RUST_GITIGNORE,
  RUST_TEMPLATE_EXCLUDES,
  renameLockedPackage,
  resolveRustTemplateDir,
  rustTemplateDir,
  rustTemplateFiles,
  scaffoldedRustFromTemplate,
  upperSnake,
} from '../scaffold-rust';
import { isExcludedBy } from '../scaffold-template';
import { capture, emptyDir, PKG_DIR, removeScratchDirs } from './helpers';

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

const REPO_ROOT = resolve(PKG_DIR, '..', '..');
const TEMPLATE = join(REPO_ROOT, 'templates', 'rust');
/** Build output a local cargo run leaves in the template; never tracked, never copied. */
const BUILD_OUTPUT = ['.codegen', 'target'];

/** Every file git tracks under templates/rust, relative to it. */
function trackedTemplateFiles(): string[] {
  const out = spawnSync('git', ['ls-files', '-z', '--', 'templates/rust'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  expect(out.status, out.stderr).toBe(0);
  return out.stdout
    .split('\0')
    .filter(Boolean)
    .map((f) => f.slice('templates/rust/'.length))
    .sort();
}

const hasCargo = spawnSync('cargo', ['--version'], { cwd: TEMPLATE }).status === 0;
// Where Rust generation and the build are the point, CI must have the pinned
// toolchain (it does); a contributor machine without it skips those two tests only.
const needsRust = !hasCargo && !process.env.CI;
// A cold run compiles three code generators and then the whole dependency tree.
const REAL_TIMEOUT = 1_500_000;

// Real generation installs and runs the pinned plugins. Only the tests that are
// ABOUT the generated code pay for it; every other scaffold test swaps in this
// stub, so the suite does not depend on cargo, the network or the runner's speed.
const stubGen = (dir: string) => {
  mkdirSync(join(dir, 'gen'), { recursive: true });
  writeFileSync(join(dir, 'gen', 'stub.rs'), '// stub\n');
};

describe('knext add function <name> --lang rust scaffolds templates/rust', () => {
  it.skipIf(needsRust)(
    'writes the server project with the crate, service and package names substituted (real generation)',
    () => {
      const app = emptyDir('rust-scaffold');
      const c = capture();
      expect(addFunction({ cwd: app, name: 'user-profile', lang: 'rust', io: c.io }), c.err()).toBe(
        0,
      );
      const root = join(app, 'functions', 'user-profile');
      const files = walk(root);
      for (const f of [
        'Cargo.toml',
        'Cargo.lock',
        'Dockerfile',
        'codegen.sh',
        'src/main.rs',
        'src/items.rs',
        'src/auth/token.rs',
        'src/rpc/mod.rs',
        'vendor/connectrpc-health/Cargo.toml',
      ]) {
        expect(files).toContain(f);
      }
      expect(files).toContain('proto/user_profile/v1/user_profile.proto');
      expect(files).toContain('gen/buffa/user_profile.v1.user_profile.rs');
      expect(files).toContain('gen/connect/user_profile.v1.user_profile.__connect.rs');
      expect(files.some((f) => f.includes('example'))).toBe(false);
      // The staging link to the plugin cache must not travel with the project.
      expect(existsSync(join(root, '.codegen'))).toBe(false);
      expect(lstatSync(join(root, 'codegen.sh')).mode & 0o111).not.toBe(0);

      const manifest = readFileSync(join(root, 'Cargo.toml'), 'utf8');
      expect(manifest.match(/^name = "user-profile"$/gm)?.length).toBe(2);
      expect(manifest).toContain('default = []');
      expect(readFileSync(join(root, 'src/items.rs'), 'utf8')).toContain(
        'impl UserProfileService for Service',
      );
      expect(readFileSync(join(root, 'src/main.rs'), 'utf8')).toContain('use user_profile::');
      expect(readFileSync(join(root, 'src/auth/policy.rs'), 'utf8')).toContain(
        '"/user_profile.v1.UserProfileService/GetItem"',
      );
      // The constant name the template uses is the one the generator wrote.
      const connect = readFileSync(
        join(root, 'gen/connect/user_profile.v1.user_profile.__connect.rs'),
        'utf8',
      );
      expect(connect).toContain('USER_PROFILE_SERVICE_SERVICE_NAME');
      expect(readFileSync(join(root, 'src/rpc/mod.rs'), 'utf8')).toContain(
        'USER_PROFILE_SERVICE_SERVICE_NAME',
      );
      // The zone side still gets its contract and config entry.
      expect(existsSync(join(app, 'proto/user_profile/v1/user_profile.proto'))).toBe(true);
      expect(readFileSync(join(app, 'knext.grpc.json'), 'utf8')).toContain('"user-profile"');
    },
    REAL_TIMEOUT,
  );

  it.skipIf(needsRust)(
    'the scaffolded function builds, passes its tests, serves health without a token and fails closed',
    () => {
      const app = emptyDir('rust-build');
      expect(addFunction({ cwd: app, name: 'orders', lang: 'rust', io: capture().io })).toBe(0);
      const root = join(app, 'functions', 'orders');
      // `rust-toolchain.toml` pins the release; fetch it if this machine lacks it.
      spawnSync('rustup', ['toolchain', 'install'], { cwd: root });
      const build = spawnSync('cargo', ['build', '--locked', '--all-targets'], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(build.status, build.stderr).toBe(0);
      const test = spawnSync('cargo', ['test', '--locked', '--', '--format', 'terse'], {
        cwd: root,
        encoding: 'utf8',
      });
      const text = test.stdout + test.stderr;
      expect(test.status, text).toBe(0);
      const verbose = spawnSync('cargo', ['test', '--locked', '--lib', '--', '--list'], {
        cwd: root,
        encoding: 'utf8',
      });
      const tests = verbose.stdout;
      // The health check is served with no token on every protocol...
      for (const name of ['rpc::tests::protocol_matrix', 'auth::tests::health_check_is_exempt']) {
        expect(tests, `${name} is not in the scaffold`).toContain(`${name}: test`);
      }
      // ...and the token check refuses everything else when nothing can verify it.
      for (const name of [
        'rpc::tests::production_wiring_fails_closed_on_the_wire',
        'auth::tests::no_verifier_fails_closed',
        'auth::tests::no_jwks_mounted_rejects_every_non_health_rpc',
      ]) {
        expect(tests, `${name} is not in the scaffold`).toContain(`${name}: test`);
      }
      // The tests bound to the knext repository's vectors are not part of the copy.
      expect(tests).not.toContain('production_wiring_verifies_zone_tokens');
      expect(text).toMatch(/test result: ok\. [1-9]\d* passed; 0 failed/);
    },
    REAL_TIMEOUT,
  );

  it.skipIf(needsRust)(
    'generating the example contract reproduces the committed gen/ byte for byte (the same plugins as the template)',
    () => {
      const app = emptyDir('rust-gen-parity');
      expect(addFunction({ cwd: app, name: 'example', lang: 'rust', io: capture().io })).toBe(0);
      const generated = join(app, 'functions', 'example', 'gen');
      const committed = join(TEMPLATE, 'gen');
      const files = walk(committed);
      expect(files.length).toBeGreaterThan(0);
      expect(walk(generated)).toEqual(files);
      for (const f of files) {
        expect(readFileSync(join(generated, f), 'utf8'), f).toBe(
          readFileSync(join(committed, f), 'utf8'),
        );
      }
    },
    REAL_TIMEOUT,
  );

  it('leaves no template placeholder behind', () => {
    const app = emptyDir('rust-placeholders');
    expect(
      addFunction({ cwd: app, name: 'orders', lang: 'rust', io: capture().io, generate: stubGen }),
    ).toBe(0);
    const root = join(app, 'functions', 'orders');
    const stale = [
      'ExampleService',
      'EXAMPLE_SERVICE',
      'example.v1',
      'example::v1',
      'example/v1',
      'example.proto',
      'function::',
      'name = "function"',
      '--bin function',
      'target/release/function ',
    ];
    for (const f of walk(root)) {
      const text = readFileSync(join(root, f), 'utf8');
      for (const s of stale) expect(text.includes(s), `${f} still contains ${s}`).toBe(false);
    }
    expect(existsSync(join(root, 'proto/example'))).toBe(false);
    const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('--bin orders');
    expect(dockerfile).toContain('target/release/orders ');
  });

  it('renames the crate in Cargo.lock and keeps the lockfile in the order cargo writes it', () => {
    for (const name of ['aardvark', 'zebra']) {
      const app = emptyDir(`rust-lock-${name}`);
      expect(
        addFunction({ cwd: app, name, lang: 'rust', io: capture().io, generate: stubGen }),
      ).toBe(0);
      const lock = readFileSync(join(app, 'functions', name, 'Cargo.lock'), 'utf8');
      const names = [...lock.matchAll(/^name = "([^"]+)"$/gm)].map((m) => m[1] as string);
      expect(names).toContain(name);
      expect(names).not.toContain('function');
      expect(names).toEqual([...names].sort());
      // Nothing else in the lockfile changed: same packages, same bytes per block.
      const original = readFileSync(join(TEMPLATE, 'Cargo.lock'), 'utf8');
      const blocks = (t: string) => t.split('\n[[package]]\n').slice(1);
      expect(blocks(lock).length).toBe(blocks(original).length);
      expect(lock.startsWith(original.split('\n[[package]]\n')[0] as string)).toBe(true);
    }
  });

  it('refuses an existing function directory without writing anything', () => {
    const app = emptyDir('rust-exists');
    expect(
      addFunction({ cwd: app, name: 'orders', lang: 'rust', io: capture().io, generate: stubGen }),
    ).toBe(0);
    const c = capture();
    expect(
      addFunction({ cwd: app, name: 'orders', lang: 'rust', io: c.io, generate: stubGen }),
    ).toBe(1);
    expect(c.err()).toContain('already exists');
  });

  it('refuses --module for rust', () => {
    const app = emptyDir('rust-module');
    const c = capture();
    expect(
      addFunction({
        cwd: app,
        name: 'orders',
        lang: 'rust',
        module: 'a/b',
        io: c.io,
        generate: stubGen,
      }),
    ).toBe(1);
    expect(c.err()).toContain('--lang go only');
    expect(walk(app)).toEqual([]);
  });
});

describe('the scaffolded manifest and scripts', () => {
  it('names the package and bin target after the function and turns the repository-only tests off', () => {
    const app = emptyDir('rust-manifest');
    expect(
      addFunction({
        cwd: app,
        name: 'user-profile',
        lang: 'rust',
        io: capture().io,
        generate: stubGen,
      }),
    ).toBe(0);
    const root = join(app, 'functions', 'user-profile');
    const manifest = readFileSync(join(root, 'Cargo.toml'), 'utf8');
    expect(manifest.match(/^name = "user-profile"$/gm)?.length).toBe(2);
    expect(manifest).not.toContain('name = "function"');
    expect(manifest).toContain('default = []');
    expect(manifest).not.toContain('default = ["shared-vectors"]');
    expect(readFileSync(join(root, 'src/main.rs'), 'utf8')).toContain('use user_profile::{');
    // codegen.sh is run by hand to regenerate gen/: it keeps its executable bit.
    expect(lstatSync(join(root, 'codegen.sh')).mode & 0o111).not.toBe(0);
    // The files the repository-only tests need are not there.
    expect(existsSync(join(root, 'src/testvectors.rs'))).toBe(false);
    expect(existsSync(join(root, 'src/auth/vector_tests.rs'))).toBe(false);
  });
});

/**
 * Code generation with stand-ins for cargo and the three plugins, so the
 * generation PIPELINE (the toolchain check, the plugin install, `buf generate`
 * over the staged project, the cleanup) is exercised on every machine without
 * compiling anything. Real generation is covered by the cargo-gated tests above.
 */
describe('generation fails closed and leaves the app untouched', () => {
  const PLUGINS = ['protoc-gen-buffa', 'protoc-gen-buffa-packaging', 'protoc-gen-connect-rust'];
  const pins = () => {
    const sh = readFileSync(join(TEMPLATE, 'codegen.sh'), 'utf8');
    const v = (name: string) => sh.match(new RegExp(`^${name}=(\\d+\\.\\d+\\.\\d+)$`, 'm'))?.[1];
    return [
      ['protoc-gen-buffa', v('PROTOC_GEN_BUFFA_VERSION')],
      ['protoc-gen-buffa-packaging', v('PROTOC_GEN_BUFFA_PACKAGING_VERSION')],
      ['connectrpc-codegen', v('CONNECTRPC_CODEGEN_VERSION')],
    ] as const;
  };

  /** Run `body` with a stand-in `cargo` first on PATH and a prepared plugin cache. */
  function withFakes<T>(
    opts: { installed: boolean; pluginExit: number; cargo?: boolean },
    body: (env: { cargoLog: string; cache: string }) => T,
  ): T {
    const tools = emptyDir('rust-fake-tools');
    const cache = join(tools, 'cache');
    const cargoLog = join(tools, 'cargo.log');
    mkdirSync(join(cache, 'bin'), { recursive: true });
    writeFileSync(cargoLog, '');
    if (opts.cargo !== false) {
      writeFileSync(
        join(tools, 'cargo'),
        `#!/bin/sh\necho "$@" >> "${cargoLog}"\nif [ "$1" = "--version" ]; then echo cargo-stand-in; exit 0; fi\nexit 1\n`,
        { mode: 0o755 },
      );
    }
    if (opts.installed) {
      for (const p of PLUGINS) {
        writeFileSync(
          join(cache, 'bin', p),
          `#!/bin/sh\ncat > /dev/null\nexit ${opts.pluginExit}\n`,
          { mode: 0o755 },
        );
      }
      for (const [crate, version] of pins()) {
        expect(version, `no pin for ${crate} in codegen.sh`).toBeDefined();
        writeFileSync(join(cache, `${crate}-${version}.installed`), '');
      }
    }
    const saved = { PATH: process.env.PATH, DIR: process.env.KNEXT_RUST_CODEGEN_DIR };
    // With no stand-in cargo, PATH holds an (otherwise empty) directory only.
    process.env.PATH = opts.cargo === false ? tools : `${tools}:${saved.PATH}`;
    process.env.KNEXT_RUST_CODEGEN_DIR = cache;
    try {
      return body({ cargoLog, cache });
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.DIR === undefined) delete process.env.KNEXT_RUST_CODEGEN_DIR;
      else process.env.KNEXT_RUST_CODEGEN_DIR = saved.DIR;
    }
  }

  it('runs the cached plugins over the staged project and installs nothing already there', () => {
    withFakes({ installed: true, pluginExit: 0 }, ({ cargoLog }) => {
      const app = emptyDir('rust-fake-ok');
      const c = capture();
      expect(addFunction({ cwd: app, name: 'orders', lang: 'rust', io: c.io }), c.err()).toBe(0);
      const calls = readFileSync(cargoLog, 'utf8');
      expect(calls).toContain('--version');
      expect(calls).not.toContain('install');
      const root = join(app, 'functions', 'orders');
      // The link to the shared plugin cache was for the run only: the project does not keep it.
      expect(existsSync(join(root, '.codegen'))).toBe(false);
      expect(walk(root).some((f) => f.startsWith('.codegen/'))).toBe(false);
      expect(existsSync(join(root, 'proto/orders/v1/orders.proto'))).toBe(true);
    });
  });

  it('a plugin that fails stops the run: nothing is written and the reason is shown', () => {
    withFakes({ installed: true, pluginExit: 1 }, () => {
      const app = emptyDir('rust-fake-plugin');
      const c = capture();
      expect(addFunction({ cwd: app, name: 'orders', lang: 'rust', io: c.io })).toBe(1);
      expect(c.err()).toContain("generating the function's Rust code failed");
      expect(c.err()).toContain('nothing was changed');
      expect(walk(app)).toEqual([]);
    });
  });

  it('a failed plugin install stops the run: nothing is written', () => {
    withFakes({ installed: false, pluginExit: 0 }, ({ cargoLog }) => {
      const app = emptyDir('rust-fake-install');
      const c = capture();
      expect(addFunction({ cwd: app, name: 'orders', lang: 'rust', io: c.io })).toBe(1);
      expect(c.err()).toContain('installing the Rust code generators failed');
      expect(readFileSync(cargoLog, 'utf8')).toContain('install');
      expect(walk(app)).toEqual([]);
    });
  });

  it('no usable Rust toolchain says so and writes nothing', () => {
    withFakes({ installed: true, pluginExit: 0, cargo: false }, () => {
      const app = emptyDir('rust-no-cargo');
      const c = capture();
      expect(addFunction({ cwd: app, name: 'orders', lang: 'rust', io: c.io })).toBe(1);
      expect(c.err()).toContain('Rust toolchain');
      expect(c.err()).toContain('nothing was changed');
      expect(walk(app)).toEqual([]);
    });
  });
});

describe('a function name that cannot name the crate is refused before anything runs', () => {
  it.each([
    'std',
    'core',
    'test',
    'async',
    'type',
    'tokio',
    'serde',
    'serde-json',
    'hyper',
    'base64',
    'bytes',
  ])('%s', (name) => {
    const app = emptyDir(`rust-crate-${name}`);
    const c = capture();
    // A template that does not exist for scaffolding proves the check ran first.
    expect(
      addFunction({
        cwd: app,
        name,
        lang: 'rust',
        io: c.io,
        templateDir: TEMPLATE,
        generate: stubGen,
      }),
    ).toBe(1);
    expect(c.err()).toContain('Rust crate');
    expect(walk(app)).toEqual([]);
  });

  it('accepts the template own crate name and ordinary names', () => {
    expect(checkCrateName('function', TEMPLATE)).toBeNull();
    expect(checkCrateName('orders', TEMPLATE)).toBeNull();
    expect(checkCrateName('user-profile', TEMPLATE)).toBeNull();
  });
});

describe('the Rust scaffold copies templates/rust minus a counted exclude list', () => {
  it('the exclude list is exactly the reviewed, counted set', () => {
    expect(RUST_TEMPLATE_EXCLUDES.map((e) => e.path)).toEqual([
      '.gitignore',
      '.codegen',
      'README.md',
      'conformance.sh',
      'e2e/kind-e2e.sh',
      'e2e/ksvc.yaml',
      'gen',
      'proto',
      'src/auth/vector_tests.rs',
      'src/testvectors.rs',
      'target',
    ]);
    expect(RUST_TEMPLATE_EXCLUDES.length).toBe(11);
    for (const e of RUST_TEMPLATE_EXCLUDES) expect(e.why.length).toBeGreaterThan(10);
  });

  it('every exclude names something the template really has (no stale entries)', () => {
    const tracked = trackedTemplateFiles();
    for (const e of RUST_TEMPLATE_EXCLUDES) {
      if (BUILD_OUTPUT.includes(e.path)) continue;
      expect(
        tracked.some((f) => f === e.path || f.startsWith(`${e.path}/`)),
        `${e.path} is excluded but the template has no such path`,
      ).toBe(true);
    }
  });

  it('every tracked template file is copied, regenerated or on the exclude list', () => {
    const all = trackedTemplateFiles();
    const copied = rustTemplateFiles();
    const dropped = all.filter((f) => !copied.includes(f));
    expect(
      dropped.filter((f) => !isExcludedBy(RUST_TEMPLATE_EXCLUDES, f)),
      'silently dropped',
    ).toEqual([]);
    expect(copied.filter((f) => isExcludedBy(RUST_TEMPLATE_EXCLUDES, f))).toEqual([]);
    expect(copied.length + dropped.length).toBe(all.length);
    expect(copied.length).toBeGreaterThan(0);
  });

  it('what lands on disk is the copied set plus .gitignore, proto/ and gen/ and nothing else', () => {
    const app = emptyDir('rust-guard');
    expect(
      addFunction({ cwd: app, name: 'orders', lang: 'rust', io: capture().io, generate: stubGen }),
    ).toBe(0);
    const root = join(app, 'functions', 'orders');
    const onDisk = walk(root);
    expect(onDisk.filter((f) => !f.startsWith('proto/') && !f.startsWith('gen/'))).toEqual(
      [...scaffoldedRustFromTemplate(), '.gitignore'].sort(),
    );
  });

  it('build output next to the template is never read or copied', () => {
    const copy = join(emptyDir('rust-template-output'), 'rust');
    cpSync(TEMPLATE, copy, {
      recursive: true,
      filter: (src) => !BUILD_OUTPUT.some((o) => src === join(TEMPLATE, o)),
    });
    for (const o of BUILD_OUTPUT) {
      mkdirSync(join(copy, o, 'deep'), { recursive: true });
      writeFileSync(join(copy, o, 'deep', 'junk.bin'), 'junk');
    }
    const app = emptyDir('rust-output-app');
    expect(
      addFunction({
        cwd: app,
        name: 'orders',
        lang: 'rust',
        io: capture().io,
        templateDir: copy,
        generate: stubGen,
      }),
    ).toBe(0);
    const files = walk(join(app, 'functions', 'orders'));
    expect(files.some((f) => f.startsWith('target/') || f.startsWith('.codegen/'))).toBe(false);
  });
});

describe('which template a run scaffolds from', () => {
  const SRC = '/repo/packages/grpc/src/scaffold-rust.ts';
  const DIST = '/pkg/dist/cli.js';
  const everything = () => true;

  it('a source run uses the repository template, never the package copy', () => {
    const seen: string[] = [];
    const dir = resolveRustTemplateDir(SRC, (p) => {
      seen.push(p);
      return true;
    });
    expect(dir).toBe('/repo/templates/rust');
    expect(seen).toEqual(['/repo/templates/rust/Cargo.toml']);
  });

  it('a built run uses the copy packed beside dist/', () => {
    expect(resolveRustTemplateDir(DIST, everything)).toBe('/pkg/templates/rust');
  });

  it('fails loudly when the chosen template is missing, rather than falling back', () => {
    expect(() => resolveRustTemplateDir(SRC, () => false)).toThrow(/not available/);
    expect(() => resolveRustTemplateDir(DIST, () => false)).toThrow(/not available/);
  });

  it('the resolved template in this checkout is the repository one', () => {
    expect(rustTemplateDir()).toBe(TEMPLATE);
  });

  it('a change to the template shows up in the scaffold', () => {
    const copy = join(emptyDir('rust-template-copy'), 'rust');
    cpSync(TEMPLATE, copy, {
      recursive: true,
      filter: (src) => !BUILD_OUTPUT.some((o) => src === join(TEMPLATE, o)),
    });
    writeFileSync(join(copy, 'NOTES.md'), 'marker file\n');
    const main = readFileSync(join(copy, 'src/main.rs'), 'utf8');
    writeFileSync(join(copy, 'src/main.rs'), `${main}\n// template-edit-marker\n`);
    const app = emptyDir('rust-template-change');
    expect(
      addFunction({
        cwd: app,
        name: 'orders',
        lang: 'rust',
        io: capture().io,
        templateDir: copy,
        generate: stubGen,
      }),
    ).toBe(0);
    const root = join(app, 'functions', 'orders');
    expect(readFileSync(join(root, 'NOTES.md'), 'utf8')).toBe('marker file\n');
    expect(readFileSync(join(root, 'src/main.rs'), 'utf8')).toContain('// template-edit-marker');
  });

  it('refuses a template whose Cargo.toml no longer has the lines the scaffold rewrites', () => {
    const copy = join(emptyDir('rust-template-drift'), 'rust');
    cpSync(TEMPLATE, copy, {
      recursive: true,
      filter: (src) => !BUILD_OUTPUT.some((o) => src === join(TEMPLATE, o)),
    });
    const manifest = readFileSync(join(copy, 'Cargo.toml'), 'utf8');
    writeFileSync(join(copy, 'Cargo.toml'), manifest.replace('default = ["shared-vectors"]', ''));
    const app = emptyDir('rust-template-drift-app');
    expect(() =>
      addFunction({
        cwd: app,
        name: 'orders',
        lang: 'rust',
        io: capture().io,
        templateDir: copy,
        generate: stubGen,
      }),
    ).toThrow(/template changed/);
    expect(walk(app)).toEqual([]);
  });
});

describe('the pieces the scaffold is built from', () => {
  it('names the service constant the way the generator does', () => {
    expect(upperSnake('ExampleService')).toBe('EXAMPLE_SERVICE');
    expect(upperSnake('UserProfileService')).toBe('USER_PROFILE_SERVICE');
    expect(upperSnake('OrdersService')).toBe('ORDERS_SERVICE');
  });

  it('keeps the plugin cache in the user cache directory unless told otherwise', () => {
    expect(codegenCacheDir({ KNEXT_RUST_CODEGEN_DIR: '/x/y' })).toBe('/x/y');
    expect(codegenCacheDir({ XDG_CACHE_HOME: '/c' })).toBe('/c/knext/rust-codegen');
  });

  it('renameLockedPackage refuses a lockfile without exactly one such package', () => {
    const lock = 'version = 4\n\n[[package]]\nname = "a"\nversion = "1.0.0"\n';
    expect(() => renameLockedPackage(lock, 'function', 'b')).toThrow(/template changed/);
    expect(renameLockedPackage(lock, 'a', 'z')).toContain('name = "z"');
  });
});

describe('a failure at any step leaves the app as it was, and a rerun works', () => {
  const STEPS = [
    'stage',
    'buf.yaml',
    'proto/knext/v1/options.proto',
    'proto/orders/v1/orders.proto',
    'src/knext/authorize.ts',
    'knext.grpc.json',
    'install',
  ];
  it.each(STEPS)('failing at %s', (failAt) => {
    const app = emptyDir(`rust-fail-${failAt.replaceAll('/', '_')}`);
    const boom = new Error(`injected failure at ${failAt}`);
    expect(() =>
      addFunction({
        cwd: app,
        name: 'orders',
        lang: 'rust',
        io: capture().io,
        generate: stubGen,
        onStep: (step) => {
          if (step === failAt) throw boom;
        },
      }),
    ).toThrow(boom);
    expect(walk(app), `files left behind after failing at ${failAt}`).toEqual([]);
    expect(existsSync(join(app, 'functions'))).toBe(false);
    const c = capture();
    expect(
      addFunction({ cwd: app, name: 'orders', lang: 'rust', io: c.io, generate: stubGen }),
      c.err(),
    ).toBe(0);
  });

  it('a failing generator writes nothing', () => {
    const app = emptyDir('rust-fail-generate');
    expect(() =>
      addFunction({
        cwd: app,
        name: 'orders',
        lang: 'rust',
        io: capture().io,
        generate: () => {
          throw new Error('generator exploded');
        },
      }),
    ).toThrow('generator exploded');
    expect(walk(app)).toEqual([]);
  });

  it('restores an existing knext.grpc.json byte for byte when install fails', () => {
    const app = emptyDir('rust-fail-restore');
    expect(
      addFunction({ cwd: app, name: 'first', lang: 'go', serverProject: false, io: capture().io }),
    ).toBe(0);
    const before = walk(app).map((f) => [f, readFileSync(join(app, f), 'utf8')]);
    expect(() =>
      addFunction({
        cwd: app,
        name: 'orders',
        lang: 'rust',
        io: capture().io,
        generate: stubGen,
        onStep: (step) => {
          if (step === 'install') throw new Error('boom');
        },
      }),
    ).toThrow('boom');
    expect(walk(app).map((f) => [f, readFileSync(join(app, f), 'utf8')])).toEqual(before);
  });
});

describe('the build ships the template and turbo knows it', () => {
  it('turbo.json declares both templates as inputs and the packaged copy as an output', () => {
    const turbo = JSON.parse(readFileSync(join(PKG_DIR, 'turbo.json'), 'utf8')) as {
      extends: string[];
      tasks: { build: { inputs: string[]; outputs: string[] } };
    };
    expect(turbo.extends).toEqual(['//']);
    expect(turbo.tasks.build.outputs).toContain('templates/**');
    expect(turbo.tasks.build.outputs).toContain('$TURBO_EXTENDS$');
    expect(turbo.tasks.build.inputs).toContain('$TURBO_ROOT$/templates/go/**');
    expect(turbo.tasks.build.inputs).toContain('$TURBO_ROOT$/templates/rust/**');
    expect(turbo.tasks.build.inputs).toContain('$TURBO_DEFAULT$');
  });

  it('the packed tarball lists exactly the template files', () => {
    const copied = spawnSync('node', ['scripts/copy-templates.mjs'], { cwd: PKG_DIR });
    expect(copied.status, copied.stderr.toString()).toBe(0);
    const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: PKG_DIR,
      encoding: 'utf8',
    });
    expect(pack.status, pack.stderr).toBe(0);
    const files = (JSON.parse(pack.stdout)[0].files as { path: string }[]).map((f) => f.path);
    const packed = files
      .filter((p) => p.startsWith('templates/rust/'))
      .map((p) => p.slice('templates/rust/'.length))
      .sort();
    // npm drops a .gitignore from a tarball; the scaffold writes it instead.
    expect(packed).toEqual(trackedTemplateFiles().filter((f) => f !== '.gitignore'));
  }, 60_000);

  it('the packaged copy holds no build output', () => {
    const copied = spawnSync('node', ['scripts/copy-templates.mjs'], { cwd: PKG_DIR });
    expect(copied.status, copied.stderr.toString()).toBe(0);
    const files = walk(join(PKG_DIR, 'templates', 'rust'));
    expect(files.some((f) => f.startsWith('target/') || f.startsWith('.codegen/'))).toBe(false);
    expect(files).toEqual(trackedTemplateFiles());
  });

  it('the .gitignore the scaffold writes is the template one', () => {
    expect(readFileSync(join(TEMPLATE, '.gitignore'), 'utf8')).toBe(RUST_GITIGNORE);
    const app = emptyDir('rust-gitignore');
    expect(
      addFunction({ cwd: app, name: 'orders', lang: 'rust', io: capture().io, generate: stubGen }),
    ).toBe(0);
    expect(readFileSync(join(app, 'functions', 'orders', '.gitignore'), 'utf8')).toBe(
      RUST_GITIGNORE,
    );
  });
});
