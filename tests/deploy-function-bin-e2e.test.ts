/**
 * `knext deploy function`, end to end at the process level: the REAL built bin
 * (`packages/kn-next/dist/cli/kn-next.js`) loads the REAL `@getknext/grpc`
 * verb from the app's `node_modules`, and the only fake is the cluster - a
 * `kubectl` script on PATH that records the argv it was started with.
 *
 * What a live apply would additionally prove (the operator reconciling the
 * CR into a Knative Service) needs the zone-function kind harness; that is
 * out of this PR's scope and is stated in its body. What this proves is the
 * part the CLI owns: the exact processes started, in order, with the exact
 * flags, and that `func` and `kn` are never started - fake `func` and `kn`
 * scripts sit on the same PATH and the test fails if either ran.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..');
const DIST_BIN = join(REPO, 'packages', 'kn-next', 'dist', 'cli', 'kn-next.js');
const FIXTURE_ZONE = join(REPO, 'packages', 'grpc', 'fixtures', 'zone');
const GRPC_SRC_CLI = join(REPO, 'packages', 'grpc', 'src', 'cli.ts');
const GRPC_PKG = join(REPO, 'packages', 'grpc', 'package.json');

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const DIGEST = `sha256:${'e'.repeat(64)}`;
const IMAGE = `registry.example.com/shop/orders@${DIGEST}`;

/** An app dir (the fixture zone) with @getknext/grpc installed and fake cluster tools on PATH. */
function arrange() {
  const root = mkdtempSync(join(tmpdir(), 'knext-deploy-function-bin-'));
  scratch.push(root);
  const app = join(root, 'app');
  cpSync(FIXTURE_ZONE, app, { recursive: true });

  // The package as an app has it. Its `cli` entry re-exports the source so the
  // test needs no build of the package; the bin is run under bun, which reads TS.
  const pkgDir = join(app, 'node_modules', '@getknext', 'grpc');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: '@getknext/grpc',
      version: '0.0.0',
      type: 'module',
      exports: { './cli': './cli.js' },
    }),
  );
  // The peer range is widened to this core's version: the repo's core is still
  // on the 1.x line while the package targets 2.x, and the pair check itself is
  // covered by grpc-dispatch.test.ts. An explicit export beats the star export.
  writeFileSync(
    join(pkgDir, 'cli.js'),
    `export * from ${JSON.stringify(GRPC_SRC_CLI)};\nexport const CORE_PEER_RANGE = ">=0.0.0";\n`,
  );
  // cli.ts reads ../package.json relative to itself, which resolves in the repo.
  expect(existsSync(GRPC_PKG)).toBe(true);

  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = join(root, 'kubectl.log');
  const forbidden = join(root, 'forbidden.log');
  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  tool(
    'kubectl',
    [
      'printf "%s\\n" "$*" >> "$KUBECTL_LOG"',
      'case "$*" in',
      '  *--dry-run=server*)',
      '    if [ -n "$FAKE_DRYRUN_FAIL" ]; then',
      '      echo \'Error from server (BadRequest): strict decoding error: unknown field "spec.zone"\' >&2',
      '      exit 1',
      '    fi;;',
      'esac',
      'exit 0',
    ].join('\n'),
  );
  tool('func', 'printf "func %s\\n" "$*" >> "$FORBIDDEN_LOG"; exit 0');
  tool('kn', 'printf "kn %s\\n" "$*" >> "$FORBIDDEN_LOG"; exit 0');
  return { app, bin, log, forbidden };
}

function runBin(args: string[], opts: { dryrunFail?: boolean } = {}) {
  const t = arrange();
  const r = Bun.spawnSync([process.execPath, DIST_BIN, ...args], {
    cwd: t.app,
    env: {
      ...process.env,
      PATH: `${t.bin}:${process.env.PATH}`,
      KUBECTL_LOG: t.log,
      FORBIDDEN_LOG: t.forbidden,
      ...(opts.dryrunFail ? { FAKE_DRYRUN_FAIL: '1' } : {}),
      NO_COLOR: '1',
      NODE_OPTIONS: '',
      // A stale context in the developer's shell must not leak into the argv.
      KN_CONTEXT: '',
      KN_NAMESPACE: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n') : []);
  return {
    status: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
    kubectl: read(t.log),
    forbidden: read(t.forbidden),
    app: t.app,
  };
}

const ARGS = [
  'deploy',
  'function',
  'orders',
  '--zone',
  'shop',
  '--image',
  IMAGE,
  '--namespace',
  'prod',
];

describe('knext deploy function through the built bin', () => {
  it('requires the built bin (build @getknext/core first)', () => {
    expect(existsSync(DIST_BIN), `${DIST_BIN} missing - build core first`).toBe(true);
  });

  it('starts the strict dry-run first, then the strict apply, and never func or kn', () => {
    const r = runBin(ARGS);
    expect(r.status, r.stderr).toBe(0);
    expect(r.kubectl.length).toBe(2);
    expect(r.kubectl[0]).toMatch(
      /^apply --dry-run=server --validate=strict -f .*backendservice-orders\.json -n prod$/,
    );
    expect(r.kubectl[1]).toMatch(
      /^apply --validate=strict -f .*backendservice-orders\.json -n prod$/,
    );
    expect(r.forbidden).toEqual([]);
  });

  it('applies a BackendService, not a NextApp, with spec.zone', () => {
    const r = runBin(ARGS);
    const cr = JSON.parse(
      readFileSync(join(r.app, '.output', 'backendservice-orders.json'), 'utf8'),
    );
    expect(cr.kind).toBe('BackendService');
    expect(cr.spec.zone).toBe('shop');
    expect(cr.spec.language).toBe('go');
  });

  it('binds --context into every kubectl process', () => {
    const r = runBin([...ARGS, '--context', 'staging']);
    expect(r.status, r.stderr).toBe(0);
    for (const line of r.kubectl) expect(line).toMatch(/^--context staging apply /);
  });

  it('stops after a failed dry-run: the strict apply never starts', () => {
    const r = runBin(ARGS, { dryrunFail: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('PREFLIGHT FAILED');
    expect(r.stderr).toContain('spec.zone');
    expect(r.kubectl.some((l) => l.startsWith('apply --validate=strict '))).toBe(false);
    expect(r.kubectl[0]).toContain('--dry-run=server');
    expect(r.forbidden).toEqual([]);
  });

  it('--dry-run starts no process at all', () => {
    const r = runBin([...ARGS, '--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).kind).toBe('BackendService');
    expect(r.kubectl).toEqual([]);
    expect(r.forbidden).toEqual([]);
  });

  it('the bare `knext deploy` is still the NextApp deploy, not a function deploy', () => {
    const r = runBin(['deploy', 'nonsense']);
    expect(r.status).toBe(1);
    expect(r.kubectl).toEqual([]);
  });
});
