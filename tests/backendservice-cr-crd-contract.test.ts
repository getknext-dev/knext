/**
 * Contract between the `BackendService` the CLI emits (`@getknext/grpc`) and the
 * CRD this repo ships (the operator's generated `backendservices` CRD).
 *
 * The CLI applies with `--validate=strict`, so a field the CRD does not define
 * is a rejected deploy, and a required field the CLI omits is one too. Rather
 * than hand-list the fields, this derives them from the CR the builder actually
 * returns for a maximal input, so a field added to the builder without the CRD
 * (or the other way round) fails here, before a cluster says so.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { buildBackendServiceCR } from '../packages/grpc/src/backend-service';
import { NEXTAPP_API_VERSION } from '../packages/kn-next/src/cli/crd-api-version';
import {
  BACKENDSERVICE_KIND,
  crdSchemaFromCrdObject,
  flattenSchemaPaths,
  unknownEmittedFields,
} from '../packages/kn-next/src/cli/schema/crd-schema';

const REPO = resolve(import.meta.dir, '..');
const CRD_FILE = join(
  REPO,
  'packages',
  'kn-next-operator',
  'config',
  'crd',
  'bases',
  'apps.kn-next.dev_backendservices.yaml',
);

type Schema = {
  required?: string[];
  properties?: Record<string, Schema & { pattern?: string; minLength?: number }>;
};

const crd = YAML.parse(readFileSync(CRD_FILE, 'utf8')) as {
  spec: {
    group: string;
    names: { kind: string };
    versions: { name: string; schema: { openAPIV3Schema: Schema } }[];
  };
};
const root = crd.spec.versions[0]?.schema.openAPIV3Schema as Schema;
const specSchema = root.properties?.spec as Schema;

const DIGEST = `sha256:${'d'.repeat(64)}`;
const MAXIMAL = buildBackendServiceCR({
  name: 'pricing',
  namespace: 'shop',
  zone: 'orders',
  image: `registry.example.com/shop/pricing@${DIGEST}`,
  language: 'rust',
  port: 9090,
  protoVersion: '1.4.0-rc.1',
  wakeAhead: false,
  scaling: { minScale: 1, maxScale: 3, containerConcurrency: 10 },
});

/** Dotted field paths of a JSON value; array items are `*` (the crd-schema grammar). */
function paths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => paths(v, prefix ? `${prefix}.*` : '*'));
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    return [p, ...paths(v, p)];
  });
}

describe('the BackendService the CLI emits matches the shipped CRD', () => {
  it('apiVersion, group and kind agree with the CRD and with NextApp', () => {
    expect<string>(MAXIMAL.kind).toBe(crd.spec.names.kind);
    expect(MAXIMAL.kind).toBe(BACKENDSERVICE_KIND);
    expect<string>(MAXIMAL.apiVersion).toBe(`${crd.spec.group}/${crd.spec.versions[0]?.name}`);
    expect(MAXIMAL.apiVersion).toBe(NEXTAPP_API_VERSION);
  });

  it('every field the builder can emit is defined by the CRD (strict apply would reject otherwise)', () => {
    const schema = crdSchemaFromCrdObject(crd);
    if (!schema) throw new Error('no v1alpha1 schema in the bundled BackendService CRD');
    const known = flattenSchemaPaths(schema);
    const emitted = paths({ spec: MAXIMAL.spec });
    expect(emitted).toContain('spec.scaling.containerConcurrency');
    expect(unknownEmittedFields(emitted, known)).toEqual([]);
  });

  it('the minimal CR carries every field the CRD requires', () => {
    const minimal = buildBackendServiceCR({
      name: 'pricing',
      namespace: 'shop',
      zone: 'orders',
      image: `registry.example.com/shop/pricing@${DIGEST}`,
      language: 'go',
    });
    for (const required of specSchema.required ?? []) {
      expect(Object.keys(minimal.spec), required).toContain(required);
    }
    // And nothing the CRD would treat as a defaulted field is forced on.
    expect(Object.keys(minimal.spec).sort()).toEqual(['image', 'language', 'zone']);
  });

  it("the builder's values satisfy the CRD's own patterns", () => {
    const props = specSchema.properties ?? {};
    for (const key of ['zone', 'language', 'protoVersion'] as const) {
      const pattern = props[key]?.pattern;
      expect(pattern, `${key} has a pattern in the CRD`).toBeString();
      expect(new RegExp(pattern as string).test(MAXIMAL.spec[key] as string), key).toBe(true);
    }
  });

  it('never emits a field the operator owns or the CRD refuses', () => {
    const all = paths(MAXIMAL).join(' ');
    for (const forbidden of ['ownerReferences', 'serviceAccountName', 'status', 'finalizers']) {
      expect(all, forbidden).not.toContain(forbidden);
    }
  });
});
