/**
 * scripts/lib/crd-schema-diff.mjs — pure structural diff for a Kubernetes CRD's
 * OpenAPI v3 schema (#1670).
 *
 * WHY: ADR-0017 Amendment 2 holds knext to an additive-only discipline for the
 * `NextApp` CRD while it stays `v1alpha1` — new optional fields are fine;
 * removing a field, changing a field's type, adding a new required field, or
 * narrowing an enum/validation constraint is NOT an in-place edit (it needs a
 * new API version). That rule was documented practice only (ADR-0017 §2.1,
 * action item "Enforce §2.1 ... mechanically. Today it is documented practice").
 * This module is the mechanical enforcement.
 *
 * SCOPE: this diffs the OpenAPI v3 schema tree only (`properties`, `items`,
 * `required`, `type`, `enum`, and the common validation keywords below). It
 * does not attempt full JSON-Schema-subset semantics (e.g. `oneOf`/`anyOf`
 * combinators, `additionalProperties` schemas) — the NextApp CRD does not use
 * those, and adding support for a construct that would otherwise silently
 * pass through undiffed is worse than a documented scope boundary.
 *
 * VIOLATION CLASSES (what `diffCrdVersionSchema`/`diffOpenApiSchema` detect):
 *   - a field (`properties` key) present in the old schema but absent in the
 *     new one ("removed field"), at any depth;
 *   - a `type` that differs between old and new for the same field;
 *   - a field name that appears in the new schema's `required` array but not
 *     the old one's ("new required field"), at any depth;
 *   - an `enum` that had a value removed (narrowed), or that is newly added
 *     where no `enum` existed before (any value was previously allowed);
 *   - a narrowed bound on `minLength`/`maximum`/`minItems`/`minProperties`
 *     (increased) or `maxLength`/`maximum`/`maxItems`/`maxProperties`
 *     (decreased) — wait, see `NARROWING_RULES` below for the precise
 *     direction per keyword;
 *   - a `pattern` that changed value, or was added where none existed before.
 *
 * A whole served CRD *version* (`spec.versions[].name`) disappearing between
 * the old and new document is also a violation — `diffCrd` reports it as a
 * top-level "version removed" finding rather than silently having nothing to
 * diff.
 *
 * Adding an entirely NEW field, a NEW enum value, or WIDENING a bound
 * (loosening `maxLength`, etc.) is never a violation — only narrowing is.
 */

/** @type {Record<string, { boundKey: string, direction: 'increase-narrows' | 'decrease-narrows' }>} */
const NARROWING_RULES = {
  minLength: { direction: 'increase-narrows' },
  maxLength: { direction: 'decrease-narrows' },
  minimum: { direction: 'increase-narrows' },
  maximum: { direction: 'decrease-narrows' },
  minItems: { direction: 'increase-narrows' },
  maxItems: { direction: 'decrease-narrows' },
  minProperties: { direction: 'increase-narrows' },
  maxProperties: { direction: 'decrease-narrows' },
};

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Structurally diff two OpenAPI v3 schema NODES (not whole documents),
 * recursing through `properties` and `items`. Appends human-readable
 * violation strings, prefixed with `path`, to `violations`.
 */
export function diffOpenApiSchema(oldSchema, newSchema, path, violations) {
  if (!isPlainObject(oldSchema) || !isPlainObject(newSchema)) return;

  // Type change.
  if (
    typeof oldSchema.type === 'string' &&
    typeof newSchema.type === 'string' &&
    oldSchema.type !== newSchema.type
  ) {
    violations.push(`${path}: type changed from "${oldSchema.type}" to "${newSchema.type}"`);
  }

  // Enum narrowing.
  if (Array.isArray(oldSchema.enum)) {
    if (Array.isArray(newSchema.enum)) {
      const newSet = new Set(newSchema.enum);
      const removed = oldSchema.enum.filter((v) => !newSet.has(v));
      if (removed.length > 0) {
        violations.push(`${path}: enum narrowed, removed value(s): ${JSON.stringify(removed)}`);
      }
    }
    // enum -> no enum is WIDENING (every prior value plus everything else is
    // now allowed) — not a violation.
  } else if (Array.isArray(newSchema.enum)) {
    violations.push(
      `${path}: enum added where none existed before (narrows previously-unconstrained values)`,
    );
  }

  // Bound narrowing (minLength/maxLength/minimum/maximum/minItems/maxItems/
  // minProperties/maxProperties).
  for (const [key, rule] of Object.entries(NARROWING_RULES)) {
    const oldVal = oldSchema[key];
    const newVal = newSchema[key];
    if (typeof oldVal !== 'number' || typeof newVal !== 'number') continue;
    const narrowed = rule.direction === 'increase-narrows' ? newVal > oldVal : newVal < oldVal;
    if (narrowed) {
      violations.push(`${path}.${key}: narrowed from ${oldVal} to ${newVal}`);
    }
  }

  // Pattern.
  if (typeof oldSchema.pattern === 'string') {
    if (typeof newSchema.pattern === 'string' && newSchema.pattern !== oldSchema.pattern) {
      violations.push(
        `${path}.pattern: changed from ${JSON.stringify(oldSchema.pattern)} to ${JSON.stringify(newSchema.pattern)}`,
      );
    }
  } else if (typeof newSchema.pattern === 'string') {
    violations.push(
      `${path}.pattern: added (${JSON.stringify(newSchema.pattern)}) where none existed before`,
    );
  }

  // Required fields: anything newly required.
  const oldRequired = new Set(Array.isArray(oldSchema.required) ? oldSchema.required : []);
  const newRequired = new Set(Array.isArray(newSchema.required) ? newSchema.required : []);
  for (const field of newRequired) {
    if (!oldRequired.has(field)) {
      violations.push(`${path}: "${field}" is newly required`);
    }
  }

  // Properties: recurse, and flag removals.
  const oldProps = isPlainObject(oldSchema.properties) ? oldSchema.properties : {};
  const newProps = isPlainObject(newSchema.properties) ? newSchema.properties : {};
  for (const key of Object.keys(oldProps)) {
    const childPath = `${path}.${key}`;
    if (!Object.prototype.hasOwnProperty.call(newProps, key)) {
      violations.push(`${childPath}: field removed`);
      continue;
    }
    diffOpenApiSchema(oldProps[key], newProps[key], childPath, violations);
  }

  // Array items.
  if (isPlainObject(oldSchema.items) && isPlainObject(newSchema.items)) {
    diffOpenApiSchema(oldSchema.items, newSchema.items, `${path}[]`, violations);
  }
}

/**
 * Diff one CRD *version* entry's `schema.openAPIV3Schema`
 * (`spec.versions[].schema.openAPIV3Schema`). Returns a fresh violations array.
 */
export function diffCrdVersionSchema(oldVersion, newVersion) {
  const violations = [];
  const oldSchema = oldVersion?.schema?.openAPIV3Schema;
  const newSchema = newVersion?.schema?.openAPIV3Schema;
  if (!isPlainObject(oldSchema) || !isPlainObject(newSchema)) return violations;
  diffOpenApiSchema(oldSchema, newSchema, '$', violations);
  return violations;
}

/**
 * Diff two full CRD documents (parsed YAML: `{ spec: { versions: [...] } }`).
 * Returns `{ ok: boolean, violations: string[] }`. A served version present
 * in the old document but absent from the new one is reported as a
 * top-level violation (it is the whole-schema analogue of a removed field).
 */
export function diffCrd(oldCrd, newCrd) {
  const violations = [];
  const oldVersions = Array.isArray(oldCrd?.spec?.versions) ? oldCrd.spec.versions : [];
  const newVersions = Array.isArray(newCrd?.spec?.versions) ? newCrd.spec.versions : [];
  const newByName = new Map(newVersions.map((v) => [v?.name, v]));

  for (const oldVersion of oldVersions) {
    const name = oldVersion?.name;
    const newVersion = newByName.get(name);
    if (!newVersion) {
      violations.push(`version "${name}": removed from the CRD entirely`);
      continue;
    }
    const versionViolations = diffCrdVersionSchema(oldVersion, newVersion);
    for (const v of versionViolations) {
      violations.push(`version "${name}", ${v}`);
    }
  }

  return { ok: violations.length === 0, violations };
}
