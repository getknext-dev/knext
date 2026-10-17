/**
 * `knext deploy function`: the apply carries `--validate=strict` and the
 * server-side preflight runs FIRST, proved across the real pair — core's
 * dispatcher and host (`packages/kn-next/src/cli/grpc-dispatch.ts`) driving the
 * real `@getknext/grpc` verb — with only the kubectl process faked.
 *
 * What is faked is exactly the OS boundary: every kubectl invocation is
 * recorded, in order, as the argv that would have been spawned. So the order
 * and the flags asserted here are the order and flags a cluster would see.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  buildDeployHost,
  dispatchGrpcVerb,
  type GrpcCliModule,
} from '../packages/kn-next/src/cli/grpc-dispatch';

const REPO = resolve(import.meta.dir, '..');
const FIXTURE_ZONE = join(REPO, 'packages', 'grpc', 'fixtures', 'zone');
// The real package, loaded from source the way core loads it from dist.
const grpc = (await import('../packages/grpc/src/cli')) as unknown as GrpcCliModule;

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const DIGEST = `sha256:${'c'.repeat(64)}`;
const IMAGE = `registry.example.com/shop/orders@${DIGEST}`;
const ARGS = ['function', 'orders', '--zone', 'shop', '--image', IMAGE, '--namespace', 'prod'];

type Spawn = { kind: 'capture' | 'run'; argv: readonly string[]; cr: string };

/** Run the verb in a fresh copy of the fixture zone with kubectl faked. */
async function deployWith(
  extra: string[],
  captureResult: { ok: boolean; stdout?: string; stderr?: string },
  runThrows = false,
) {
  const dir = mkdtempSync(join(tmpdir(), 'knext-deploy-function-'));
  scratch.push(dir);
  cpSync(FIXTURE_ZONE, dir, { recursive: true });
  const spawns: Spawn[] = [];
  const crOf = (argv: readonly string[]) => {
    const i = argv.indexOf('-f');
    return i === -1 ? '' : readFileSync(argv[i + 1] as string, 'utf8');
  };
  let out = '';
  let err = '';
  const cwd = process.cwd();
  process.chdir(dir);
  let code: number;
  try {
    code = await dispatchGrpcVerb('deploy', [...ARGS, ...extra], '2.0.0', {
      load: async () => grpc,
      stdout: (s) => {
        out += s;
      },
      stderr: (s) => {
        err += s;
      },
      kubectl: {
        capture: (argv) => {
          spawns.push({ kind: 'capture', argv, cr: crOf(argv) });
          return {
            ok: captureResult.ok,
            stdout: captureResult.stdout ?? '',
            stderr: captureResult.stderr ?? '',
          };
        },
        run: (argv) => {
          spawns.push({ kind: 'run', argv, cr: crOf(argv) });
          if (runThrows) throw new Error('Command failed: kubectl apply');
        },
      },
    });
  } finally {
    process.chdir(cwd);
  }
  return { code, spawns, out, err, dir };
}

describe('knext deploy function: preflight first, then a strict apply', () => {
  it('the first kubectl call is the server-side strict dry-run; the second is the strict apply', async () => {
    const { code, spawns } = await deployWith([], { ok: true });
    expect(code).toBe(0);
    expect(spawns.map((s) => s.kind)).toEqual(['capture', 'run']);
    const [pre, apply] = spawns as [Spawn, Spawn];
    expect(pre.argv.slice(0, 4)).toEqual([
      'kubectl',
      'apply',
      '--dry-run=server',
      '--validate=strict',
    ]);
    expect(pre.argv.slice(-2)).toEqual(['-n', 'prod']);
    expect(apply.argv.slice(0, 3)).toEqual(['kubectl', 'apply', '--validate=strict']);
    expect(apply.argv).not.toContain('--dry-run=server');
    expect(apply.argv.slice(-2)).toEqual(['-n', 'prod']);
  });

  it('both calls carry the very same BackendService document', async () => {
    const { spawns } = await deployWith([], { ok: true });
    const [pre, apply] = spawns as [Spawn, Spawn];
    expect(pre.cr.length).toBeGreaterThan(0);
    expect(apply.cr).toBe(pre.cr);
    const cr = JSON.parse(apply.cr);
    expect(cr.kind).toBe('BackendService');
    expect(cr.spec.zone).toBe('shop');
    expect(cr.metadata).toEqual({ name: 'orders', namespace: 'prod' });
  });

  it('binds --context into both the preflight and the apply', async () => {
    const { spawns } = await deployWith(['--context', 'staging'], { ok: true });
    for (const s of spawns) {
      expect(s.argv.slice(0, 3), s.kind).toEqual(['kubectl', '--context', 'staging']);
    }
  });

  it('a strict-decoding rejection stops the run before any apply', async () => {
    const { code, spawns, err } = await deployWith([], {
      ok: false,
      stderr: 'Error from server (BadRequest): strict decoding error: unknown field "spec.zone"',
    });
    expect(code).toBe(1);
    // The dry-run, then only read-only schema diagnosis; no write ever ran.
    expect(spawns.some((s) => s.kind === 'run')).toBe(false);
    expect(spawns[0]?.argv).toContain('--dry-run=server');
    expect(err).toContain('PREFLIGHT FAILED');
    expect(err).toContain('BackendService');
  });

  it('a kubectl too old for --validate=strict stops the run before any apply', async () => {
    const { code, spawns, err } = await deployWith([], {
      ok: false,
      stderr: 'error: invalid argument "strict" for "--validate" flag',
    });
    expect(code).toBe(1);
    expect(spawns.some((s) => s.kind === 'run')).toBe(false);
    expect(err).toContain('v1.25');
  });

  it('an unreachable cluster stops the run before any apply', async () => {
    const { code, spawns } = await deployWith([], { ok: false, stderr: 'connection refused' });
    expect(code).toBe(1);
    expect(spawns.some((s) => s.kind === 'run')).toBe(false);
  });

  it('a failed apply is a failure, not a swallowed success', async () => {
    const { code, spawns, err } = await deployWith([], { ok: true }, true);
    expect(code).toBe(1);
    expect(spawns.map((s) => s.kind)).toEqual(['capture', 'run']);
    expect(err).toContain('BackendService');
  });

  it('--dry-run reaches no kubectl at all', async () => {
    const { code, spawns, out } = await deployWith(['--dry-run'], { ok: true });
    expect(code).toBe(0);
    expect(spawns).toEqual([]);
    expect(JSON.parse(out).kind).toBe('BackendService');
  });
});

describe('core has exactly one lazy dispatch line for `deploy function`', () => {
  const deploySrc = readFileSync(
    join(REPO, 'packages', 'kn-next', 'src', 'cli', 'deploy.ts'),
    'utf8',
  );

  it('routes `deploy function` to the lazy dispatcher before the default deploy', () => {
    const branch =
      /else if \(\s*process\.argv\[2\] === "deploy" &&\s*process\.argv\[3\] === "function"\s*\) \{[\s\S]*?await import\("\.\/grpc-dispatch"\)[\s\S]*?deployFunctionMain\(process\.argv\.slice\(4\)\)/;
    const m = branch.exec(deploySrc);
    expect(m, 'the deploy function branch is missing from the bin dispatcher').not.toBeNull();
    const defaultDeploy = deploySrc.indexOf('await deploy();', (m as RegExpExecArray).index);
    expect(defaultDeploy).toBeGreaterThan((m as RegExpExecArray).index);
  });

  it('never imports the package or the dispatcher statically', () => {
    expect(deploySrc).not.toMatch(/^import .*grpc-dispatch/m);
    expect(deploySrc).not.toMatch(/@getknext\/grpc/);
  });
});

describe('the seam core hands @getknext/grpc cannot run an arbitrary program', () => {
  const ran: (readonly string[])[] = [];
  const captured: (readonly string[])[] = [];
  /** The text of the file each kubectl process was told to read, as it was at that moment. */
  const filesSeen: string[] = [];
  const readNow = (argv: readonly string[]) => {
    const i = argv.indexOf('-f');
    if (i !== -1) filesSeen.push(readFileSync(argv[i + 1] as string, 'utf8'));
  };
  const host = buildDeployHost({
    capture: (argv) => {
      captured.push(argv);
      readNow(argv);
      return { ok: true, stdout: '', stderr: '' };
    },
    run: (argv) => {
      ran.push(argv);
      readNow(argv);
    },
  });
  const API = 'apps.kn-next.dev/v1alpha1';
  const cr = (over: Record<string, unknown> = {}) => ({
    apiVersion: API,
    kind: 'BackendService',
    metadata: { name: 'orders', namespace: 'prod' },
    spec: { zone: 'shop', image: IMAGE, language: 'go' },
    ...over,
  });
  /** Write `text` to a fresh file and return its path. */
  function file(text: string, name = 'cr.json') {
    const dir = mkdtempSync(join(tmpdir(), 'knext-host-apply-'));
    scratch.push(dir);
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  }
  const json = (o: unknown) => JSON.stringify(o);

  it('has exactly two methods: preflight and apply', () => {
    expect(Object.keys(host).sort()).toEqual(['apply', 'preflight']);
  });

  it("apply runs kubectl apply --validate=strict on core's own copy, and nothing else", () => {
    ran.length = 0;
    const path = file(json(cr()));
    host.apply({ crPath: path, namespace: 'prod' });
    expect(ran).toHaveLength(1);
    const argv = ran[0] as readonly string[];
    expect(argv.slice(0, 4)).toEqual(['kubectl', 'apply', '--validate=strict', '-f']);
    expect(argv.slice(5)).toEqual(['-n', 'prod']);
    // the file kubectl reads is core's, never the caller's path
    expect(argv[4]).not.toBe(path);
    expect(basename(argv[4] as string)).toBe('backendservice-orders.json');
  });

  it("kubectl is told to read core's file, not crPath, for BOTH the preflight and the apply", () => {
    ran.length = 0;
    captured.length = 0;
    const path = file(json(cr()));
    host.preflight({ crPath: path, namespace: 'prod' });
    host.apply({ crPath: path, namespace: 'prod' });
    const pre = captured[0] as readonly string[];
    expect(pre.slice(0, 4)).toEqual(['kubectl', 'apply', '--dry-run=server', '--validate=strict']);
    const preFile = pre[pre.indexOf('-f') + 1] as string;
    const applyFile = (ran[0] as readonly string[])[4] as string;
    expect(preFile).not.toBe(path);
    expect(applyFile).not.toBe(path);
    expect(dirname(preFile)).not.toBe(dirname(path));
    expect(dirname(applyFile)).not.toBe(dirname(path));
  });

  it("core's copy is the validated object re-serialised, and is removed afterwards", () => {
    ran.length = 0;
    filesSeen.length = 0;
    // the YAML spelling, with comments and spacing the copy must not inherit
    const yaml = `# a comment\napiVersion: ${API}\nkind: BackendService\nmetadata: { name: orders, namespace: prod }\nspec:\n  zone: shop\n  image: ${IMAGE}\n  language: go\n`;
    host.apply({ crPath: file(yaml, 'cr.yaml'), namespace: 'prod' });
    expect(filesSeen).toHaveLength(1);
    expect(Object.keys(JSON.parse(filesSeen[0] as string)).sort()).toEqual([
      'apiVersion',
      'kind',
      'metadata',
      'spec',
    ]);
    expect(JSON.parse(filesSeen[0] as string)).toEqual(cr());
    expect(filesSeen[0]).not.toContain('# a comment');
    const copy = (ran[0] as readonly string[])[4] as string;
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(dirname(copy))).toBe(false);
  });

  it("removes core's copy even when kubectl fails", () => {
    const failing = buildDeployHost({
      capture: () => ({ ok: true, stdout: '', stderr: '' }),
      run: (argv) => {
        seen = argv[4] as string;
        throw new Error('exit 1');
      },
    });
    let seen = '';
    expect(() => failing.apply({ crPath: file(json(cr())), namespace: 'prod' })).toThrow(/exit 1/);
    expect(seen).not.toBe('');
    expect(existsSync(dirname(seen))).toBe(false);
  });

  it('apply binds the kubectl context', () => {
    ran.length = 0;
    host.apply({ crPath: file(json(cr())), namespace: 'prod', context: 'staging' });
    expect(ran[0]?.slice(0, 3)).toEqual(['kubectl', '--context', 'staging']);
  });

  it('a path that looks like a command never reaches kubectl at all', () => {
    ran.length = 0;
    const path = file(json(cr()), '; func deploy.json');
    host.apply({ crPath: path, namespace: 'prod' });
    expect(ran[0]?.[0]).toBe('kubectl');
    expect(ran[0]?.join(' ')).not.toContain('func deploy');
  });

  it('accepts the YAML spelling of the same single BackendService', () => {
    ran.length = 0;
    const yaml = `apiVersion: ${API}\nkind: BackendService\nmetadata:\n  name: orders\nspec:\n  zone: shop\n  image: ${IMAGE}\n`;
    host.apply({ crPath: file(yaml, 'cr.yaml'), namespace: 'prod' });
    expect(ran).toHaveLength(1);
  });

  it.each([
    ['a Secret', () => json(cr({ kind: 'Secret' })), /BackendService/],
    ['a NextApp', () => json(cr({ kind: 'NextApp' })), /BackendService/],
    [
      'a wrong apiVersion',
      () => json(cr({ apiVersion: 'apps.kn-next.dev/v1beta1' })),
      /apiVersion/,
    ],
    ['a core-group apiVersion', () => json(cr({ apiVersion: 'v1' })), /apiVersion/],
    [
      'a multi-document file',
      () => `${json(cr())}\n---\n${json(cr({ kind: 'Secret' }))}\n`,
      /one/i,
    ],
    ['a list', () => json({ apiVersion: 'v1', kind: 'List', items: [cr()] }), /BackendService/],
    [
      'a BackendService with a top-level items field (kubectl would apply the items, not the wrapper)',
      () =>
        json(
          cr({
            items: [
              {
                apiVersion: 'v1',
                kind: 'ConfigMap',
                metadata: { name: 'smuggled', namespace: 'prod' },
              },
            ],
          }),
        ),
      /items/,
    ],
    ['an unknown top-level key (status)', () => json(cr({ status: {} })), /status/],
    ['an unknown top-level key (foo)', () => json(cr({ foo: 1 })), /foo/],
    [
      'an unknown top-level key in a YAML file',
      () =>
        `apiVersion: ${API}\nkind: BackendService\nmetadata:\n  name: orders\nspec: {}\nitems: []\n`,
      /items/,
    ],
    [
      'metadata that carries an ownerReference',
      () => json(cr({ metadata: { name: 'orders', ownerReferences: [{ kind: 'NextApp' }] } })),
      /ownerReferences/,
    ],
    ['a metadata name that is not a name', () => json(cr({ metadata: { name: '../x' } })), /name/],
    ['no metadata name', () => json(cr({ metadata: { namespace: 'prod' } })), /name/],
    ['an array', () => json([cr()]), /single|object/i],
    ['text that is not an object', () => 'just text', /object|single/i],
    ['an empty file', () => '', /one|object/i],
    [
      'a namespace other than the one it is applied to',
      () => json(cr({ metadata: { name: 'orders', namespace: 'kube-system' } })),
      /namespace/,
    ],
  ])('refuses %s: nothing is applied', (_label, make, message) => {
    ran.length = 0;
    expect(() => host.apply({ crPath: file(make()), namespace: 'prod' })).toThrow(message);
    expect(ran).toEqual([]);
  });

  it('refuses the same files in the preflight: kubectl is never started', () => {
    captured.length = 0;
    const smuggle = json(
      cr({ items: [{ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'smuggled' } }] }),
    );
    const out = host.preflight({ crPath: file(smuggle), namespace: 'prod' });
    expect(out.verdict).toBe('blocked');
    expect(out.reason).toBe('invalid-file');
    expect(out.stderr).toContain('items');
    expect(captured).toEqual([]);
  });

  it('refuses a file that cannot be read: nothing is applied', () => {
    ran.length = 0;
    expect(() =>
      host.apply({ crPath: join(tmpdir(), 'knext-no-such-file.json'), namespace: 'prod' }),
    ).toThrow();
    expect(ran).toEqual([]);
  });
});
