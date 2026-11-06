import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * BEHAVIOUR tests for the provenance gate in scripts/e2e-native-rebuild-musl.sh
 * (#2713). The REAL script runs against fake `npm` / `node-gyp` / `apk` / ...
 * shims, so no docker, registry or toolchain is needed. A traced native package
 * whose source is local (a `file:` dependency) has no registry identity: the
 * script must never fetch a package of that name from the registry, and a
 * package whose provenance cannot be established is treated as local (fail
 * closed: keep the traced tree, log a WARNING, no fetch).
 *
 * A note on `--ignore-scripts`: the unpinned registry path deliberately relies
 * on the package's own install script to run `node-gyp rebuild`, so the flag
 * would leave no .node file. It is therefore NOT added, and no test asserts it.
 */
const REPO_ROOT = resolve(import.meta.dir, '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/e2e-native-rebuild-musl.sh');

const TMP_DIRS: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  TMP_DIRS.push(d);
  return d;
}
afterAll(() => {
  for (const d of TMP_DIRS) rmSync(d, { recursive: true, force: true });
});

let SHIMS = '';
let NPM_LOG = '';

function sh(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeAll(() => {
  SHIMS = tmp('knext-musl-shims-');
  NPM_LOG = join(SHIMS, 'npm.log');
  for (const noop of ['apk', 'adduser', 'chown']) sh(join(SHIMS, noop), 'exit 0');
  sh(join(SHIMS, 'stat'), 'echo 0:0');
  sh(join(SHIMS, 'su-exec'), 'shift; exec "$@"');
  sh(join(SHIMS, 'node-gyp'), 'echo "node-gyp $*" >> "$NPM_LOG"; exit 0');
  // fake npm: records argv + cwd, and "installs" the requested package name
  sh(
    join(SHIMS, 'npm'),
    `echo "npm $* (cwd=$(pwd))" >> "$NPM_LOG"
case "$1" in
install|ci)
  if [ "$1" = ci ]; then
    n="$(node -e 'process.stdout.write(Object.keys(require("./package.json").dependencies)[0])')"
  else
    for a; do last="$a"; done
    n="\${last%@*}"
  fi
  mkdir -p "node_modules/$n/build/Release"
  printf '{"name":"%s","version":"1.0.0","fresh":true}' "$n" > "node_modules/$n/package.json"
  : > "node_modules/$n/build/Release/fresh.node"
  ;;
esac
exit 0`,
  );
});

interface Opts {
  lock?: unknown; // node_modules/.package-lock.json content
  rootPkg?: unknown; // standalone root package.json
  tracedExtra?: Record<string, unknown>; // extra keys in the traced package.json
  pinned?: boolean;
  credential?: boolean;
}

function run(opts: Opts) {
  const root = tmp('knext-musl-root-');
  const scratch = tmp('knext-musl-scratch-');
  const pkgDir = join(root, 'node_modules', 'native-addon');
  mkdirSync(join(pkgDir, 'build', 'Release'), { recursive: true });
  writeFileSync(join(pkgDir, 'build', 'Release', 'orig.node'), '');
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'native-addon', version: '1.0.0', ...(opts.tracedExtra ?? {}) }),
  );
  if (opts.rootPkg) writeFileSync(join(root, 'package.json'), JSON.stringify(opts.rootPkg));
  if (opts.lock)
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), JSON.stringify(opts.lock));
  const args = [SCRIPT, root];
  if (opts.pinned) {
    const locks = tmp('knext-musl-locks-');
    const pin = join(locks, 'native-addon-1.0.0');
    mkdirSync(pin);
    writeFileSync(
      join(pin, 'package.json'),
      JSON.stringify({ name: 'pin', version: '0.0.0', dependencies: { 'native-addon': '1.0.0' } }),
    );
    writeFileSync(join(pin, 'package-lock.json'), '{}');
    args.push(locks);
  }
  writeFileSync(NPM_LOG, '');
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${SHIMS}:${process.env.PATH}`,
    TMPDIR: scratch,
    NPM_LOG,
  };
  delete env.KNEXT_COMPAT_MODE;
  if (opts.credential) env.KNEXT_COMPAT_MODE = 'credential';
  const r = spawnSync('sh', args, { encoding: 'utf8', env });
  const npmLog = readFileSync(NPM_LOG, 'utf8');
  return {
    status: r.status,
    out: `${r.stdout}${r.stderr}`,
    npmLog,
    fetched: /npm (install|ci)/.test(npmLog),
    kept: existsSync(join(pkgDir, 'build', 'Release', 'orig.node')),
    replaced: existsSync(join(pkgDir, 'build', 'Release', 'fresh.node')),
  };
}

const LINK_LOCK = {
  packages: {
    'node_modules/native-addon': { resolved: 'native-addon', link: true },
    'native-addon': { name: 'native-addon', version: '1.0.0' },
  },
};
const REGISTRY_LOCK = {
  packages: {
    'node_modules/native-addon': {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/native-addon/-/native-addon-1.0.0.tgz',
      integrity: 'sha512-x',
    },
  },
};

describe('provenance gate in the musl rebuild (#2713)', () => {
  it('a local file: addon (link entry in .package-lock.json) is never fetched; tree kept; WARNING names it', () => {
    const r = run({ lock: LINK_LOCK });
    expect(r.status).toBe(0);
    expect(r.fetched).toBe(false);
    expect(r.kept).toBe(true);
    expect(r.replaced).toBe(false);
    expect(r.out).toMatch(/WARNING.*native-addon/);
  });

  it('a local addon declared as file: in the root manifest is never fetched', () => {
    const r = run({ rootPkg: { dependencies: { 'native-addon': 'file:native-addon' } } });
    expect(r.fetched).toBe(false);
    expect(r.kept).toBe(true);
    expect(r.out).toMatch(/WARNING.*native-addon/);
  });

  it('a traced manifest whose _resolved is a local path is never fetched', () => {
    const r = run({
      tracedExtra: { _resolved: 'file:../native-addon', _from: 'file:native-addon' },
    });
    expect(r.fetched).toBe(false);
    expect(r.kept).toBe(true);
  });

  it('a local addon is not fetched even when a committed pin shares its name@version', () => {
    const r = run({ lock: LINK_LOCK, pinned: true });
    expect(r.fetched).toBe(false);
    expect(r.kept).toBe(true);
    expect(r.out).toMatch(/WARNING.*native-addon/);
  });

  it('unknown provenance (no signal at all) fails closed: no fetch, tree kept, WARNING, not silent', () => {
    const r = run({});
    expect(r.status).toBe(0);
    expect(r.fetched).toBe(false);
    expect(r.kept).toBe(true);
    expect(r.out).toMatch(/WARNING.*native-addon/);
    expect(r.out).toMatch(/::warning::/);
  });

  it('a local signal outranks a registry signal (link entry beats a registry _resolved)', () => {
    const r = run({
      lock: { packages: { 'node_modules/native-addon': { link: true } } },
      tracedExtra: {
        _resolved: 'https://registry.npmjs.org/native-addon/-/native-addon-1.0.0.tgz',
      },
    });
    expect(r.fetched).toBe(false);
    expect(r.kept).toBe(true);
  });

  it('a file: root-manifest spec outranks a registry lockfile record', () => {
    const r = run({
      lock: REGISTRY_LOCK,
      rootPkg: { dependencies: { 'native-addon': 'file:native-addon' } },
    });
    expect(r.fetched).toBe(false);
    expect(r.kept).toBe(true);
  });

  it('a registry package with a committed lockfile pin still runs npm ci and replaces the tree', () => {
    for (const lock of [REGISTRY_LOCK, undefined]) {
      const r = run({ lock, pinned: true });
      expect(r.status).toBe(0);
      expect(r.npmLog).toMatch(/npm ci /);
      expect(r.replaced).toBe(true);
    }
  });

  it('an unpinned package PROVEN registry-sourced (lockfile resolved URL) takes the fresh install', () => {
    const r = run({ lock: REGISTRY_LOCK });
    expect(r.status).toBe(0);
    expect(r.npmLog).toMatch(/npm install .*native-addon@1\.0\.0/);
    expect(r.replaced).toBe(true);
  });

  it('an unpinned package with a registry _resolved in the traced manifest takes the fresh install', () => {
    const r = run({
      tracedExtra: {
        _resolved: 'https://registry.npmjs.org/native-addon/-/native-addon-1.0.0.tgz',
      },
    });
    expect(r.npmLog).toMatch(/npm install /);
    expect(r.replaced).toBe(true);
  });

  it('credential mode still refuses an unpinned addon outright (exit 1)', () => {
    const r = run({ lock: REGISTRY_LOCK, credential: true });
    expect(r.status).toBe(1);
    expect(r.fetched).toBe(false);
    expect(r.out).toMatch(/::error::/);
  });
});
