import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { helpText, run } from '../cli';
import type { DeployHost, PreflightResult } from '../deploy-function';
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
