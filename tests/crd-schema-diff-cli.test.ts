import { describe, expect, it } from 'bun:test';
import { stringify } from 'yaml';
import { CRD_PATH, resolveLatestVTag, run } from '../scripts/crd-schema-diff.mjs';

/**
 * `scripts/crd-schema-diff.mjs` (#1670) — the CLI wiring around
 * `scripts/lib/crd-schema-diff.mjs`. Every test injects `execFileSyncFn`/
 * `readFileSyncFn` fakes, so nothing here shells out to real git or touches
 * the real repo tree (mirrors `ga-tarball-diff-gate.test.ts`'s injection
 * discipline — `runDiff` is always injected there too).
 */

function fakeExec(responses: Record<string, string | Error>) {
  return (cmd: string, args: string[]) => {
    const key = `${cmd} ${args.join(' ')}`;
    const response = responses[key];
    if (response === undefined) throw new Error(`unexpected exec: ${key}`);
    if (response instanceof Error) throw response;
    return response;
  };
}

function crdWith(fields: Record<string, unknown>, required: string[] = []) {
  return {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    spec: {
      group: 'apps.kn-next.dev',
      versions: [
        {
          name: 'v1alpha1',
          schema: {
            openAPIV3Schema: {
              type: 'object',
              properties: {
                spec: {
                  type: 'object',
                  properties: fields,
                  ...(required.length > 0 ? { required } : {}),
                },
              },
            },
          },
        },
      ],
    },
  };
}

describe('resolveLatestVTag', () => {
  it('returns the first line of `git tag --list v* --sort=-v:refname`', () => {
    const exec = fakeExec({
      'git tag --list v* --sort=-v:refname': 'v1.0.0-rc.2\nv1.0.0-rc.1\nv0.1.0\n',
    });
    expect(resolveLatestVTag(exec as never)).toBe('v1.0.0-rc.2');
  });

  it('returns null when there are no v* tags', () => {
    const exec = fakeExec({ 'git tag --list v* --sort=-v:refname': '' });
    expect(resolveLatestVTag(exec as never)).toBeNull();
  });
});

describe('run', () => {
  it('passes when the tracked file is an unchanged superset of the base ref', () => {
    const oldCrd = crdWith({ image: { type: 'string' } });
    const newCrd = crdWith({ image: { type: 'string' } });
    const logs: string[] = [];
    const exit = run([], {
      log: (m: string) => logs.push(m),
      execFileSyncFn: fakeExec({
        'git tag --list v* --sort=-v:refname': 'v1.0.0-rc.2\n',
        [`git show v1.0.0-rc.2:${CRD_PATH}`]: stringify(oldCrd),
      }) as never,
      readFileSyncFn: (() => stringify(newCrd)) as never,
    });
    expect(exit).toBe(0);
    expect(logs.some((l) => l.includes('PASS'))).toBe(true);
  });

  it('ACCEPTANCE CRITERION: fails when the tracked file removes a CRD field vs. the base ref', () => {
    const oldCrd = crdWith({ image: { type: 'string' }, replicas: { type: 'integer' } });
    const newCrd = crdWith({ image: { type: 'string' } });
    const logs: string[] = [];
    const exit = run([], {
      log: (m: string) => logs.push(m),
      execFileSyncFn: fakeExec({
        'git tag --list v* --sort=-v:refname': 'v1.0.0-rc.2\n',
        [`git show v1.0.0-rc.2:${CRD_PATH}`]: stringify(oldCrd),
      }) as never,
      readFileSyncFn: (() => stringify(newCrd)) as never,
    });
    expect(exit).toBe(1);
    expect(logs.some((l) => l.includes('FAIL'))).toBe(true);
    expect(logs.some((l) => l.includes('replicas') && l.includes('removed'))).toBe(true);
  });

  it('passes an allowed addition (a brand new optional field)', () => {
    const oldCrd = crdWith({ image: { type: 'string' } });
    const newCrd = crdWith({ image: { type: 'string' }, timeout: { type: 'integer' } });
    const logs: string[] = [];
    const exit = run([], {
      log: (m: string) => logs.push(m),
      execFileSyncFn: fakeExec({
        'git tag --list v* --sort=-v:refname': 'v1.0.0-rc.2\n',
        [`git show v1.0.0-rc.2:${CRD_PATH}`]: stringify(oldCrd),
      }) as never,
      readFileSyncFn: (() => stringify(newCrd)) as never,
    });
    expect(exit).toBe(0);
    expect(logs.some((l) => l.includes('PASS'))).toBe(true);
  });

  it('fails on a newly-required field', () => {
    const oldCrd = crdWith({ image: { type: 'string' } });
    const newCrd = crdWith({ image: { type: 'string' } }, ['image']);
    const logs: string[] = [];
    const exit = run([], {
      log: (m: string) => logs.push(m),
      execFileSyncFn: fakeExec({
        'git tag --list v* --sort=-v:refname': 'v1.0.0-rc.2\n',
        [`git show v1.0.0-rc.2:${CRD_PATH}`]: stringify(oldCrd),
      }) as never,
      readFileSyncFn: (() => stringify(newCrd)) as never,
    });
    expect(exit).toBe(1);
    expect(logs.some((l) => l.includes('newly required'))).toBe(true);
  });

  it('fails on a narrowed enum', () => {
    const oldCrd = crdWith({ mode: { type: 'string', enum: ['a', 'b', 'c'] } });
    const newCrd = crdWith({ mode: { type: 'string', enum: ['a', 'b'] } });
    const logs: string[] = [];
    const exit = run([], {
      log: (m: string) => logs.push(m),
      execFileSyncFn: fakeExec({
        'git tag --list v* --sort=-v:refname': 'v1.0.0-rc.2\n',
        [`git show v1.0.0-rc.2:${CRD_PATH}`]: stringify(oldCrd),
      }) as never,
      readFileSyncFn: (() => stringify(newCrd)) as never,
    });
    expect(exit).toBe(1);
    expect(logs.some((l) => l.includes('enum narrowed'))).toBe(true);
  });

  it('passes (nothing to compare) when there is no v* tag at all', () => {
    const logs: string[] = [];
    const exit = run([], {
      log: (m: string) => logs.push(m),
      execFileSyncFn: fakeExec({ 'git tag --list v* --sort=-v:refname': '' }) as never,
      readFileSyncFn: (() => {
        throw new Error('readFileSyncFn should not be called when there is no base ref');
      }) as never,
    });
    expect(exit).toBe(0);
    expect(logs.some((l) => l.includes('no v* tag found'))).toBe(true);
  });

  it('passes (nothing to compare) when the CRD file did not exist at the base ref', () => {
    const logs: string[] = [];
    const notFoundErr = Object.assign(new Error('exit'), {
      stderr: `fatal: path '${CRD_PATH}' does not exist in 'v0.1.0'`,
    });
    const exit = run([], {
      log: (m: string) => logs.push(m),
      execFileSyncFn: fakeExec({
        'git tag --list v* --sort=-v:refname': 'v0.1.0\n',
        [`git show v0.1.0:${CRD_PATH}`]: notFoundErr,
      }) as never,
      readFileSyncFn: (() => {
        throw new Error('readFileSyncFn should not be called when the base file did not exist');
      }) as never,
    });
    expect(exit).toBe(0);
    expect(logs.some((l) => l.includes('did not exist at v0.1.0'))).toBe(true);
  });

  it('surfaces a real git failure (bad ref / shallow checkout) as an error, not a silent pass', () => {
    const exec = fakeExec({
      'git tag --list v* --sort=-v:refname': 'v1.0.0-rc.2\n',
      [`git show v1.0.0-rc.2:${CRD_PATH}`]: Object.assign(new Error('exit'), {
        stderr: 'fatal: ambiguous argument: unknown revision or path',
      }),
    });
    expect(() =>
      run([], {
        log: () => {},
        execFileSyncFn: exec as never,
        readFileSyncFn: (() => '') as never,
      }),
    ).toThrow(/failed to read/);
  });

  it('accepts an explicit --base-ref override', () => {
    const oldCrd = crdWith({ image: { type: 'string' } });
    const newCrd = crdWith({ image: { type: 'string' } });
    const logs: string[] = [];
    const exit = run(['--base-ref', 'v0.1.0'], {
      log: (m: string) => logs.push(m),
      execFileSyncFn: fakeExec({
        [`git show v0.1.0:${CRD_PATH}`]: stringify(oldCrd),
      }) as never,
      readFileSyncFn: (() => stringify(newCrd)) as never,
    });
    expect(exit).toBe(0);
    expect(logs.some((l) => l.includes('v0.1.0'))).toBe(true);
  });
});
