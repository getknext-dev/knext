import { describe, expect, it } from 'bun:test';
import {
  BACKEND_SERVICE_API_VERSION,
  BACKEND_SERVICE_KIND,
  type BackendServiceInput,
  buildBackendServiceCR,
  checkImageDigest,
  renderBackendServiceCR,
} from '../backend-service';
import { GrpcUsageError } from '../config';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const IMAGE = `registry.example.com/shop/pricing@${DIGEST}`;

const base: BackendServiceInput = {
  name: 'pricing',
  namespace: 'shop',
  zone: 'orders',
  image: IMAGE,
  language: 'go',
};

describe('buildBackendServiceCR', () => {
  it('emits the BackendService kind in the same group and version as NextApp', () => {
    const cr = buildBackendServiceCR(base);
    expect(cr.apiVersion).toBe('apps.kn-next.dev/v1alpha1');
    expect(BACKEND_SERVICE_API_VERSION).toBe('apps.kn-next.dev/v1alpha1');
    expect(cr.kind).toBe('BackendService');
    expect(BACKEND_SERVICE_KIND).toBe('BackendService');
  });

  it('names the object after the function, in the target namespace', () => {
    const cr = buildBackendServiceCR(base);
    expect(cr.metadata).toEqual({ name: 'pricing', namespace: 'shop' });
  });

  it('carries the zone, image and language, and nothing the operator owns', () => {
    const cr = buildBackendServiceCR(base);
    expect(cr.spec).toEqual({ zone: 'orders', image: IMAGE, language: 'go' });
    // The operator sets the ownerReference from spec.zone; the CLI never writes
    // one, and never offers a ServiceAccount (ADR-0004 Amendment 2).
    const text = JSON.stringify(cr);
    expect(text).not.toContain('ownerReferences');
    expect(text).not.toContain('serviceAccountName');
    expect(text).not.toContain('status');
  });

  it('emits optional fields only when they are given', () => {
    const cr = buildBackendServiceCR({
      ...base,
      port: 9090,
      protoVersion: '1.4.0',
      wakeAhead: false,
      scaling: { minScale: 1, maxScale: 5, containerConcurrency: 50 },
    });
    expect(cr.spec).toEqual({
      zone: 'orders',
      image: IMAGE,
      language: 'go',
      port: 9090,
      protoVersion: '1.4.0',
      wakeAhead: false,
      scaling: { minScale: 1, maxScale: 5, containerConcurrency: 50 },
    });
  });

  it('renders JSON, which kubectl reads as a manifest, ending in a newline', () => {
    const text = renderBackendServiceCR(buildBackendServiceCR(base));
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(buildBackendServiceCR(base));
  });

  it.each([
    ['a tag-only image', 'registry.example.com/shop/pricing:1.0.0'],
    ['a :latest image', 'registry.example.com/shop/pricing:latest'],
    ['a bare name', 'pricing'],
    ['a short digest', 'registry.example.com/pricing@sha256:abc'],
    ['an uppercase digest', `registry.example.com/pricing@sha256:${'A'.repeat(64)}`],
  ])('refuses %s', (_label, image) => {
    expect(checkImageDigest(image)).toBeString();
    expect(() => buildBackendServiceCR({ ...base, image })).toThrow(GrpcUsageError);
  });

  it('accepts a digest-pinned image, with or without a tag', () => {
    expect(checkImageDigest(IMAGE)).toBeUndefined();
    expect(checkImageDigest(`registry.example.com/shop/pricing:1.0.0@${DIGEST}`)).toBeUndefined();
  });

  it.each([
    ['name', { name: 'Not_A_Label' }],
    ['name (reserved)', { name: 'knext' }],
    ['namespace', { namespace: 'Bad NS' }],
    ['zone', { zone: '' }],
    ['zone (not a label)', { zone: 'Orders' }],
    ['port (zero)', { port: 0 }],
    ['port (too large)', { port: 70000 }],
    ['port (fraction)', { port: 80.5 }],
    ['protoVersion', { protoVersion: 'v1' }],
    ['minScale (negative)', { scaling: { minScale: -1 } }],
    ['minScale above maxScale', { scaling: { minScale: 5, maxScale: 2 } }],
    ['containerConcurrency (too large)', { scaling: { containerConcurrency: 5000 } }],
  ])('refuses an invalid %s before anything is written', (_label, patch) => {
    expect(() => buildBackendServiceCR({ ...base, ...patch } as BackendServiceInput)).toThrow(
      GrpcUsageError,
    );
  });
});
