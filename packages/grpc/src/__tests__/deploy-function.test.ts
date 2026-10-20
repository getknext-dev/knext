import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { helpText, run } from '../cli';
import type { DeployHost, PreflightResult } from '../deploy-function';
import { backendSpecDigest } from '../spec-digest';
import { capture, copyFixtureZone, emptyDir, removeScratchDirs } from './helpers';

afterAll(removeScratchDirs);

const DIGEST = `sha256:${'b'.repeat(64)}`;
const IMAGE = `registry.example.com/shop/orders@${DIGEST}`;

const OK: PreflightResult = { verdict: 'ok', reason: 'none', unknownFields: [], stderr: '' };

type Call =
  | { op: 'preflight'; crPath: string; namespace: string; context?: string; crText: string }
  | { op: 'apply'; crPath: string; namespace: string; context?: string; crText: string };

/** A host that records every cluster-facing call, in order, with the CR file as it was then. */
function recordingHost(opts: { preflight?: PreflightResult; runError?: Error } = {}) {
  const calls: Call[] = [];
  const host: DeployHost = {
    preflight: (args) => {
      calls.push({
        op: 'preflight',
        crPath: args.crPath,
        namespace: args.namespace,
        context: args.context,
        crText: readFileSync(args.crPath, 'utf8'),
      });
      return opts.preflight ?? OK;
    },
    apply: (args) => {
      calls.push({
        op: 'apply',
        crPath: args.crPath,
        namespace: args.namespace,
        context: args.context,
        crText: readFileSync(args.crPath, 'utf8'),
      });
      if (opts.runError) throw opts.runError;
    },
  };
  return { host, calls };
}

const ARGS = ['function', 'orders', '--zone', 'shop', '--image', IMAGE, '--namespace', 'prod'];

describe('knext deploy function: apply order and strictness', () => {
  it('runs the server-side preflight FIRST, then a strict apply of the same CR', async () => {
    const dir = copyFixtureZone('deploy-order');
    const { host, calls } = recordingHost();
    const c = capture();

    const code = await run('deploy', ARGS, { ...c.io, cwd: dir, host });

    expect(code).toBe(0);
    expect(calls.map((x) => x.op)).toEqual(['preflight', 'apply']);
    const [pre, apply] = calls as [
      Extract<Call, { op: 'preflight' }>,
      Extract<Call, { op: 'apply' }>,
    ];
    expect(pre.namespace).toBe('prod');
    // Core builds the argv (kubectl apply --validate=strict), asserted in
    // tests/deploy-function-apply-order.test.ts; here the seam gets the same
    // file and namespace the preflight used, and nothing else to run.
    expect(apply.crPath).toBe(pre.crPath);
    expect(apply.namespace).toBe('prod');
    // The preflight validated the exact bytes the apply sends.
    expect(apply.crText).toBe(pre.crText);
  });

  it('applies exactly one BackendService CR, with spec.zone and no ownerReference', async () => {
    const dir = copyFixtureZone('deploy-cr');
    const { host, calls } = recordingHost();
    await run('deploy', ARGS, { ...capture().io, cwd: dir, host });

    const cr = JSON.parse((calls[1] as Call).crText);
    expect(cr.kind).toBe('BackendService');
    expect(cr.metadata).toEqual({ name: 'orders', namespace: 'prod' });
    // `lang` comes from knext.grpc.json, where `knext add function` recorded it.
    expect(cr.spec).toEqual({ zone: 'shop', image: IMAGE, language: 'go' });
    expect(JSON.stringify(cr)).not.toContain('ownerReferences');
  });

  it('prints the exact backends entry to paste, with the image digest as the pin', async () => {
    const dir = copyFixtureZone('deploy-pin-hint');
    const { host } = recordingHost();
    const c = capture();
    expect(await run('deploy', ARGS, { ...c.io, cwd: dir, host })).toBe(0);
    // The zone's pin is the digest only (the registry path may move, the content
    // may not): "@sha256:<64 hex>", exactly what the CRD accepts.
    expect(c.out()).toContain(`{ name: 'orders', image: '@${DIGEST}' }`);
    expect(c.out()).toMatch(/pins? the image/i);
    expect(c.out()).not.toContain(IMAGE);
  });

  it('prints the same pin entry whatever tag the image reference carries', async () => {
    const dir = copyFixtureZone('deploy-pin-hint-tag');
    const { host } = recordingHost();
    const c = capture();
    const tagged = `registry.example.com/shop/orders:v7@${DIGEST}`;
    const args = ['function', 'orders', '--zone', 'shop', '--image', tagged];
    expect(await run('deploy', args, { ...c.io, cwd: dir, host })).toBe(0);
    expect(c.out()).toContain(`{ name: 'orders', image: '@${DIGEST}' }`);
  });

  it('prints the spec pin entry to paste: the digest of the spec it just applied', async () => {
    const dir = copyFixtureZone('deploy-spec-pin-hint');
    const { host, calls } = recordingHost();
    const c = capture();
    expect(await run('deploy', ARGS, { ...c.io, cwd: dir, host })).toBe(0);

    const applied = JSON.parse((calls[1] as Call).crText);
    const specDigest = backendSpecDigest(applied.spec);
    expect(specDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(c.out()).toContain(`{ name: 'orders', specDigest: '${specDigest}' }`);
    // The spec pin binds the image AND env, envFrom and volumes, so the output
    // says that, and says the digest has to be re-pinned when those change.
    expect(c.out()).toMatch(/env, envFrom and volumes/);
    expect(c.out()).toMatch(/specDigest/);
  });

  it('keeps the image-only pin as the weaker option, and says so', async () => {
    const dir = copyFixtureZone('deploy-image-only-weaker');
    const { host } = recordingHost();
    const c = capture();
    expect(await run('deploy', ARGS, { ...c.io, cwd: dir, host })).toBe(0);
    expect(c.out()).toContain(`{ name: 'orders', image: '@${DIGEST}' }`);
    // Only the image: a writer of the BackendService can still add env.
    expect(c.out()).toMatch(/image only|only the image/i);
  });

  it('prints a spec digest that ignores tuning flags and follows the image', async () => {
    const digestFor = async (extra: string[], image = IMAGE) => {
      const dir = copyFixtureZone(`deploy-spec-pin-${extra.length}-${image.length}`);
      const { host, calls } = recordingHost();
      const c = capture();
      const args = ['function', 'orders', '--zone', 'shop', '--image', image, ...extra];
      expect(await run('deploy', args, { ...c.io, cwd: dir, host })).toBe(0);
      expect(calls.length).toBe(2);
      const m = c.out().match(/specDigest: '(sha256:[a-f0-9]{64})'/);
      expect(m).not.toBeNull();
      return (m as RegExpMatchArray)[1];
    };
    const plain = await digestFor([]);
    // port, scaling and protoVersion are tuning: not bound, so no re-pin.
    expect(
      await digestFor(['--port', '9090', '--min-scale', '1', '--proto-version', '1.2.3']),
    ).toBe(plain);
    // A different image is a different spec.
    const other = `registry.example.com/shop/orders@sha256:${'c'.repeat(64)}`;
    expect(await digestFor([], other)).not.toBe(plain);
  });

  it('threads --context to both the preflight and the apply', async () => {
    const dir = copyFixtureZone('deploy-context');
    const { host, calls } = recordingHost();
    await run('deploy', [...ARGS, '--context', 'staging'], { ...capture().io, cwd: dir, host });
    expect(calls.map((x) => x.context)).toEqual(['staging', 'staging']);
  });

  it('defaults the namespace to default', async () => {
    const dir = copyFixtureZone('deploy-ns');
    const { host, calls } = recordingHost();
    const args = ['function', 'orders', '--zone', 'shop', '--image', IMAGE];
    await run('deploy', args, { ...capture().io, cwd: dir, host });
    const apply = calls[1] as Extract<Call, { op: 'apply' }>;
    expect(apply.namespace).toBe('default');
  });

  it.each([
    [
      'skew',
      {
        verdict: 'skew',
        reason: 'unknown-field',
        unknownFields: ['spec.zone'],
        stderr: 'strict decoding error',
      },
    ],
    [
      'blocked',
      { verdict: 'blocked', reason: 'apply-failed', unknownFields: [], stderr: 'forbidden' },
    ],
    [
      'invalid file',
      {
        verdict: 'blocked',
        reason: 'invalid-file',
        unknownFields: [],
        stderr: 'refusing to apply x: unexpected top-level field(s) items',
      },
    ],
    [
      'client-too-old',
      { verdict: 'blocked', reason: 'client-too-old', unknownFields: [], stderr: '' },
    ],
    [
      'webhook down',
      { verdict: 'blocked', reason: 'webhook-unavailable', unknownFields: [], stderr: 'webhook' },
    ],
  ] satisfies [
    string,
    PreflightResult,
  ][])('never applies when the preflight verdict is %s', async (_label, preflight) => {
    const dir = copyFixtureZone('deploy-blocked');
    const { host, calls } = recordingHost({ preflight });
    const c = capture();

    const code = await run('deploy', ARGS, { ...c.io, cwd: dir, host });

    expect(code).toBe(1);
    expect(calls.map((x) => x.op)).toEqual(['preflight']);
    expect(c.err()).toContain('BackendService');
    expect(c.err()).toContain('Nothing was applied');
  });

  it('names the unknown field and the upgrade order on skew', async () => {
    const dir = copyFixtureZone('deploy-skew');
    const { host } = recordingHost({
      preflight: {
        verdict: 'skew',
        reason: 'unknown-field',
        unknownFields: ['spec.zone'],
        stderr: '',
      },
    });
    const c = capture();
    await run('deploy', ARGS, { ...c.io, cwd: dir, host });
    expect(c.err()).toContain('spec.zone');
    expect(c.err()).toMatch(/operator.*first/i);
  });

  it('reports a failed apply as a failure, never swallows it', async () => {
    const dir = copyFixtureZone('deploy-apply-fails');
    const { host, calls } = recordingHost({ runError: new Error('exit 1') });
    const c = capture();
    const code = await run('deploy', ARGS, { ...c.io, cwd: dir, host });
    expect(code).toBe(1);
    expect(calls.map((x) => x.op)).toEqual(['preflight', 'apply']);
    expect(c.err()).toContain('kubectl apply of the BackendService');
  });

  it('--dry-run prints the CR and touches neither the cluster nor the disk', async () => {
    const dir = copyFixtureZone('deploy-dry');
    const { host, calls } = recordingHost();
    const c = capture();
    const code = await run('deploy', [...ARGS, '--dry-run'], { ...c.io, cwd: dir, host });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(JSON.parse(c.out()).kind).toBe('BackendService');
    expect(existsSync(join(dir, '.output'))).toBe(false);
  });
});

describe('knext deploy function: refusals happen before any cluster call', () => {
  const cases: [string, string[]][] = [
    ['a tag-only image', ['function', 'orders', '--zone', 'shop', '--image', 'r.io/o:1']],
    ['no image', ['function', 'orders', '--zone', 'shop']],
    ['no zone', ['function', 'orders', '--image', IMAGE]],
    ['an unknown flag', [...ARGS, '--zzz']],
    [
      'a function not in knext.grpc.json',
      ['function', 'ghost', '--zone', 'shop', '--image', IMAGE],
    ],
    ['no function name', ['function', '--zone', 'shop', '--image', IMAGE]],
    ['an extra positional', [...ARGS, 'extra']],
    ['a bad port', [...ARGS, '--port', '0']],
    ['a bad proto version', [...ARGS, '--proto-version', 'one']],
  ];
  it.each(cases)('exits 1 and calls nothing for %s', async (_label, argv) => {
    const dir = copyFixtureZone('deploy-refuse');
    const { host, calls } = recordingHost();
    const c = capture();
    expect(await run('deploy', argv, { ...c.io, cwd: dir, host })).toBe(1);
    expect(calls).toEqual([]);
    expect(c.err().length).toBeGreaterThan(0);
  });

  it('refuses outside a zone (no knext.grpc.json) and says how to start', async () => {
    const dir = emptyDir('deploy-nozone');
    const { host, calls } = recordingHost();
    const c = capture();
    expect(await run('deploy', ARGS, { ...c.io, cwd: dir, host })).toBe(1);
    expect(calls).toEqual([]);
    expect(c.err()).toContain('knext add function');
  });

  it('refuses when core supplied no cluster host', async () => {
    const dir = copyFixtureZone('deploy-nohost');
    const c = capture();
    expect(await run('deploy', ARGS, { ...c.io, cwd: dir })).toBe(1);
    expect(c.err()).toContain('@getknext/core');
  });

  it('only `deploy function` exists: `deploy` alone is a usage error', async () => {
    const dir = copyFixtureZone('deploy-usage');
    const { host, calls } = recordingHost();
    const c = capture();
    expect(await run('deploy', [], { ...c.io, cwd: dir, host })).toBe(1);
    expect(calls).toEqual([]);
    expect(c.err()).toContain('knext deploy function');
  });
});

describe('knext deploy function: help', () => {
  it('answers --help without a host or a zone', async () => {
    const c = capture();
    expect(
      await run('deploy', ['function', '--help'], { ...c.io, cwd: emptyDir('deploy-help') }),
    ).toBe(0);
    expect(c.out()).toContain('knext deploy function');
    expect(c.out()).toContain('Exit code');
    expect(helpText('deploy')).toBe(c.out().trimEnd());
  });

  it('says what is applied and what is never run', () => {
    const text = helpText('deploy');
    expect(text).toContain('--validate=strict');
    expect(text).toContain('--zone');
    expect(text).toContain('--image');
  });
});
