import { describe, expect, it } from 'bun:test';
import {
  diffCrd,
  diffCrdVersionSchema,
  diffOpenApiSchema,
} from '../scripts/lib/crd-schema-diff.mjs';

/**
 * `scripts/lib/crd-schema-diff.mjs` (#1670) — structural additive-only diff
 * for the `NextApp` CRD's OpenAPI v3 schema, enforcing ADR-0017 Amendment 2
 * §2.1 mechanically. One test per violation class named in the issue
 * ("removed fields, type changes, new required fields, narrowed
 * enums/validation"), plus one proving an allowed addition stays green.
 */

function schemaWith(props: Record<string, unknown>, required: string[] = []) {
  return {
    type: 'object',
    properties: props,
    ...(required.length > 0 ? { required } : {}),
  };
}

describe('diffOpenApiSchema', () => {
  it('flags a removed field', () => {
    const oldSchema = schemaWith({ foo: { type: 'string' }, bar: { type: 'string' } });
    const newSchema = schemaWith({ foo: { type: 'string' } });
    const violations: string[] = [];
    diffOpenApiSchema(oldSchema, newSchema, '$', violations);
    expect(violations).toContain('$.bar: field removed');
  });

  it('flags a type change', () => {
    const oldSchema = schemaWith({ foo: { type: 'string' } });
    const newSchema = schemaWith({ foo: { type: 'integer' } });
    const violations: string[] = [];
    diffOpenApiSchema(oldSchema, newSchema, '$', violations);
    expect(violations).toContain('$.foo: type changed from "string" to "integer"');
  });

  it('flags a newly required field', () => {
    const oldSchema = schemaWith({ foo: { type: 'string' }, bar: { type: 'string' } });
    const newSchema = schemaWith({ foo: { type: 'string' }, bar: { type: 'string' } }, ['bar']);
    const violations: string[] = [];
    diffOpenApiSchema(oldSchema, newSchema, '$', violations);
    expect(violations).toContain('$: "bar" is newly required');
  });

  it('does not flag an already-required field staying required', () => {
    const oldSchema = schemaWith({ foo: { type: 'string' } }, ['foo']);
    const newSchema = schemaWith({ foo: { type: 'string' } }, ['foo']);
    const violations: string[] = [];
    diffOpenApiSchema(oldSchema, newSchema, '$', violations);
    expect(violations).toEqual([]);
  });

  it('flags a narrowed enum (a value removed)', () => {
    const oldSchema = schemaWith({ mode: { type: 'string', enum: ['a', 'b', 'c'] } });
    const newSchema = schemaWith({ mode: { type: 'string', enum: ['a', 'b'] } });
    const violations: string[] = [];
    diffOpenApiSchema(oldSchema, newSchema, '$', violations);
    expect(violations).toContain('$.mode: enum narrowed, removed value(s): ["c"]');
  });

  it('flags an enum newly added where none existed (narrows previously-open values)', () => {
    const oldSchema = schemaWith({ mode: { type: 'string' } });
    const newSchema = schemaWith({ mode: { type: 'string', enum: ['a', 'b'] } });
    const violations: string[] = [];
    diffOpenApiSchema(oldSchema, newSchema, '$', violations);
    expect(violations).toContain(
      '$.mode: enum added where none existed before (narrows previously-unconstrained values)',
    );
  });

  it('does not flag an enum gaining a value (widening)', () => {
    const oldSchema = schemaWith({ mode: { type: 'string', enum: ['a', 'b'] } });
    const newSchema = schemaWith({ mode: { type: 'string', enum: ['a', 'b', 'c'] } });
    const violations: string[] = [];
    diffOpenApiSchema(oldSchema, newSchema, '$', violations);
    expect(violations).toEqual([]);
  });

  it('flags narrowed validation: minLength increased', () => {
    const oldSchema = schemaWith({ name: { type: 'string', minLength: 1 } });
    const newSchema = schemaWith({ name: { type: 'string', minLength: 5 } });
    const violations: string[] = [];
    diffOpenApiSchema(oldSchema, newSchema, '$', violations);
    expect(violations).toContain('$.name.minLength: narrowed from 1 to 5');
  });

  it('flags narrowed validation: maxLength decreased', () => {
    const oldSchema = schemaWith({ name: { type: 'string', maxLength: 100 } });
    const newSchema = schemaWith({ name: { type: 'string', maxLength: 10 } });
    const violations: string[] = [];
    diffOpenApiSchema(oldSchema, newSchema, '$', violations);
    expect(violations).toContain('$.name.maxLength: narrowed from 100 to 10');
  });

  it('does not flag maxLength widened or minLength lowered', () => {
    const oldSchema = schemaWith({
      name: { type: 'string', minLength: 5, maxLength: 10 },
    });
    const newSchema = schemaWith({
      name: { type: 'string', minLength: 1, maxLength: 100 },
    });
    const violations: string[] = [];
    diffOpenApiSchema(oldSchema, newSchema, '$', violations);
    expect(violations).toEqual([]);
  });

  it('flags a pattern added where none existed before', () => {
    const oldSchema = schemaWith({ image: { type: 'string' } });
    const newSchema = schemaWith({ image: { type: 'string', pattern: '^[a-z]+$' } });
    const violations: string[] = [];
    diffOpenApiSchema(oldSchema, newSchema, '$', violations);
    expect(violations).toContain('$.image.pattern: added ("^[a-z]+$") where none existed before');
  });

  it('flags a pattern that changed value', () => {
    const oldSchema = schemaWith({ image: { type: 'string', pattern: '^[a-z]+$' } });
    const newSchema = schemaWith({ image: { type: 'string', pattern: '^[a-z0-9]+$' } });
    const violations: string[] = [];
    diffOpenApiSchema(oldSchema, newSchema, '$', violations);
    expect(violations).toContain('$.image.pattern: changed from "^[a-z]+$" to "^[a-z0-9]+$"');
  });

  it('recurses into nested object properties', () => {
    const oldSchema = schemaWith({
      spec: schemaWith({ nested: { type: 'string' } }),
    });
    const newSchema = schemaWith({
      spec: schemaWith({}),
    });
    const violations: string[] = [];
    diffOpenApiSchema(oldSchema, newSchema, '$', violations);
    expect(violations).toContain('$.spec.nested: field removed');
  });

  it('recurses into array items', () => {
    const oldSchema = schemaWith({
      list: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
    });
    const newSchema = schemaWith({
      list: { type: 'array', items: { type: 'object', properties: {} } },
    });
    const violations: string[] = [];
    diffOpenApiSchema(oldSchema, newSchema, '$', violations);
    expect(violations).toContain('$.list[].id: field removed');
  });

  it('ALLOWED ADDITION: a brand new optional field is never a violation', () => {
    const oldSchema = schemaWith({ foo: { type: 'string' } });
    const newSchema = schemaWith({ foo: { type: 'string' }, brandNew: { type: 'string' } });
    const violations: string[] = [];
    diffOpenApiSchema(oldSchema, newSchema, '$', violations);
    expect(violations).toEqual([]);
  });
});

describe('diffCrdVersionSchema', () => {
  it('diffs the schema.openAPIV3Schema of one version entry', () => {
    const oldVersion = {
      name: 'v1alpha1',
      schema: { openAPIV3Schema: schemaWith({ foo: { type: 'string' } }) },
    };
    const newVersion = {
      name: 'v1alpha1',
      schema: { openAPIV3Schema: schemaWith({}) },
    };
    const violations = diffCrdVersionSchema(oldVersion, newVersion);
    expect(violations).toContain('$.foo: field removed');
  });
});

describe('diffCrd', () => {
  it('is ok (no violations) for an unchanged CRD', () => {
    const crd = {
      spec: {
        versions: [
          {
            name: 'v1alpha1',
            schema: { openAPIV3Schema: schemaWith({ foo: { type: 'string' } }) },
          },
        ],
      },
    };
    const result = diffCrd(crd, structuredClone(crd));
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('flags a served version removed entirely', () => {
    const oldCrd = {
      spec: {
        versions: [
          {
            name: 'v1alpha1',
            schema: { openAPIV3Schema: schemaWith({ foo: { type: 'string' } }) },
          },
        ],
      },
    };
    const newCrd = { spec: { versions: [] } };
    const result = diffCrd(oldCrd, newCrd);
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('version "v1alpha1": removed from the CRD entirely');
  });

  it('reports ok:false with prefixed violations when a field is removed', () => {
    const oldCrd = {
      spec: {
        versions: [
          {
            name: 'v1alpha1',
            schema: {
              openAPIV3Schema: schemaWith({
                spec: schemaWith({ image: { type: 'string' } }),
              }),
            },
          },
        ],
      },
    };
    const newCrd = {
      spec: {
        versions: [
          {
            name: 'v1alpha1',
            schema: { openAPIV3Schema: schemaWith({ spec: schemaWith({}) }) },
          },
        ],
      },
    };
    const result = diffCrd(oldCrd, newCrd);
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('version "v1alpha1", $.spec.image: field removed');
  });
});
