/**
 * The spec digest a zone pins on `backends[].specDigest` (ADR-0004 Amendment 4).
 * The CLI computes it here; the Go operator re-computes it from the live
 * BackendService and compares, so the two MUST agree byte for byte. One shared
 * fixture (packages/kn-next-operator/internal/controller/testdata/
 * backend-spec-digest-vectors.json) is asserted on both sides: the operator's Go
 * test (TestSpecDigestVectors) and this one recompute every entry. Changing the
 * canonical form on either side alone reds the other side's test.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BACKEND_SPEC_PINNED_FIELDS,
  backendSpecDigest,
  canonicalBackendSpec,
  SPEC_DIGEST_DOMAIN,
} from '../spec-digest';

interface Vector {
  name: string;
  spec: Record<string, unknown>;
  canonical: string;
  digest: string;
}

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'kn-next-operator',
  'internal',
  'controller',
  'testdata',
  'backend-spec-digest-vectors.json',
);

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  domain: string;
  vectors: Vector[];
};

const IMG = `registry.example.com/fn@sha256:${'a'.repeat(64)}`;

describe('spec digest: the shared vectors', () => {
  it('covers several cases and carries the same domain as the operator', () => {
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(8);
    expect(fixture.domain).toBe(SPEC_DIGEST_DOMAIN);
  });

  for (const v of fixture.vectors) {
    it(v.name, () => {
      expect(canonicalBackendSpec(v.spec)).toBe(v.canonical);
      expect(backendSpecDigest(v.spec)).toBe(v.digest);
    });
  }

  it('binds exactly the members the operator binds', () => {
    expect([...BACKEND_SPEC_PINNED_FIELDS]).toEqual(['image', 'env', 'envFrom', 'volumes']);
  });
});

describe('spec digest: properties', () => {
  it('is sha256:<64 lowercase hex>', () => {
    expect(backendSpecDigest({ image: IMG })).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('does not depend on the order object keys were written in', () => {
    const a = backendSpecDigest({
      image: IMG,
      env: [{ name: 'A', value: '1' }],
    });
    const b = backendSpecDigest({
      env: [{ value: '1', name: 'A' }],
      image: IMG,
    });
    expect(a).toBe(b);
  });

  it('depends on list order (env order decides $(VAR) expansion)', () => {
    const ab = backendSpecDigest({
      image: IMG,
      env: [
        { name: 'A', value: '1' },
        { name: 'B', value: '$(A)' },
      ],
    });
    const ba = backendSpecDigest({
      image: IMG,
      env: [
        { name: 'B', value: '$(A)' },
        { name: 'A', value: '1' },
      ],
    });
    expect(ab).not.toBe(ba);
  });

  it('ignores what is not bound: port, scaling, resources, protoVersion, pull secrets', () => {
    const plain = backendSpecDigest({ zone: 'orders', image: IMG });
    const tuned = backendSpecDigest({
      zone: 'billing',
      image: IMG,
      language: 'go',
      port: 9090,
      protoVersion: '1.2.3',
      wakeAhead: false,
      scaling: { minScale: 1 },
      resources: { cpuRequest: '100m' },
      imagePullSecrets: [{ name: 'regcred' }],
    });
    expect(tuned).toBe(plain);
  });

  it('changes when env, envFrom or volumes are added', () => {
    const plain = backendSpecDigest({ image: IMG });
    expect(backendSpecDigest({ image: IMG, env: [{ name: 'X', value: '1' }] })).not.toBe(plain);
    expect(backendSpecDigest({ image: IMG, envFrom: [{ secretRef: { name: 's' } }] })).not.toBe(
      plain,
    );
    expect(
      backendSpecDigest({
        image: IMG,
        volumes: [{ name: 'v', mountPath: '/v', emptyDir: { medium: 'Memory' } }],
      }),
    ).not.toBe(plain);
  });

  it('refuses what has no canonical encoding rather than guess', () => {
    expect(() => backendSpecDigest({ image: IMG, env: [{ name: 'A', value: 1.5 }] })).toThrow(
      /integer/,
    );
    expect(() => backendSpecDigest({ image: IMG, env: [null] })).toThrow();
    expect(() => backendSpecDigest({ image: IMG, env: [{ name: 'A', value: '\ud800' }] })).toThrow(
      /UTF-8/,
    );
  });

  it('requires an image', () => {
    expect(() => backendSpecDigest({})).toThrow(/image/);
  });
});
