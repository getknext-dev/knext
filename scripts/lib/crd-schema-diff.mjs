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
 * VIOLATION CLASSES (what `diffCrdVersionSchema`/`diffOpenApiSchema`/`diffCrd` detect —
 * round 2, #1693 review, closes the blind spots the round-1 scope note above
 * used to wave past as "does not attempt full JSON-Schema-subset semantics"):
 *   - a field (`properties` key) present in the old schema but absent in the
 *     new one ("removed field"), at any depth;
 *   - a `type` that differs between old and new for the same field;
 *   - a field name that appears in the new schema's `required` array but not
 *     the old one's ("new required field"), at any depth;
 *   - an `enum` that had a value removed (narrowed), or that is newly added
 *     where no `enum` existed before (any value was previously allowed);
 *   - a narrowed bound on `minLength`/`maximum`/`minItems`/`minProperties`
 *     (increased) or `maxLength`/`maximum`/`maxItems`/`maxProperties`
 *     (decreased) — see `NARROWING_RULES` below for the precise direction
 *     per keyword;
 *   - a `pattern` that changed value, or was added where none existed before;
 *   - a whole served CRD *version* (`spec.versions[].name`) disappearing
 *     between the old and new document (`diffCrd`, top-level "version
 *     removed" finding);
 *   - a version's `served` flipping `true` -> `false` (existing clients
 *     addressing that version stop working) — `diffCrd`;
 *   - `storage: true` disappearing from a version with no OTHER version
 *     gaining `storage: true` in its place — `diffCrd`. A same-diff
 *     storage-version MOVE (one version loses it, a different one gains it)
 *     is allowed; a net LOSS is not.
 *   - an `x-kubernetes-validations` (CEL) entry whose `rule` text is new —
 *     i.e. not present verbatim in the old schema node's own rule set —
 *     covers both a brand-new rule and an existing rule's expression being
 *     edited (the edited text no longer matches anything in the old set, so
 *     it reads as "new"). A rule disappearing outright (nothing else added)
 *     is NOT flagged — dropping a CEL constraint widens what validates;
 *   - `nullable: true` flipping to `false` or being removed;
 *   - `x-kubernetes-preserve-unknown-fields: true` flipping to `false` or
 *     being removed;
 *   - `additionalProperties` narrowed: `true` or a schema narrowed to
 *     `false`, or (when both sides are schemas) the nested schema itself
 *     narrowed — recursed through the same `diffOpenApiSchema`, so any
 *     violation class above also applies inside `additionalProperties`;
 *   - `format` added where none existed, or changed to a different value,
 *     on an existing field (format REMOVED is not flagged — it widens);
 *   - `default` changed or removed on an existing field — a behavior change
 *     for objects that rely on the default, even though the field itself
 *     still exists and still accepts the same values.
 *
 * Adding an entirely NEW field, a NEW enum value, WIDENING a bound (loosening
 * `maxLength`, etc.), REMOVING a CEL rule, or REMOVING a `format` is never a
 * violation — only narrowing/tightening is.
 *
 * STILL NOT COVERED, named rather than silently absent (ADR-0017 Amendment 2
 * §4 carries the authoritative version of this list):
 *   - the Go type (`api/v1alpha1/nextapp_types.go`) that GENERATES this CRD
 *     via `make manifests` — this diffs the generated YAML only, which is
 *     what a cluster actually validates against and is what the Go type is
 *     downstream of;
 *   - `oneOf`/`anyOf`/`allOf`/`not` combinators — the NextApp CRD does not
 *     use them; adding partial, easy-to-get-wrong support for a construct
 *     this schema never exercises is worse than the documented gap;
 *   - reconciler/controller BEHAVIOR changes that touch no schema keyword —
 *     ADR-0017 §2.1 itself says field semantics are not frozen by the
 *     version string, and a schema-diff structurally cannot see a behavior
 *     change that leaves the schema text untouched.
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

  // x-kubernetes-validations (CEL): any new-text rule is a violation. A rule
  // whose EXPRESSION changed reads as "new" here too, because we match by
  // the rule string itself, not by array index/id (CEL rules carry no id).
  // A rule disappearing with nothing new added is allowed (widening).
  const oldValidations = Array.isArray(oldSchema['x-kubernetes-validations'])
    ? oldSchema['x-kubernetes-validations']
    : [];
  const newValidations = Array.isArray(newSchema['x-kubernetes-validations'])
    ? newSchema['x-kubernetes-validations']
    : [];
  const oldRuleTexts = new Set(oldValidations.map((v) => (isPlainObject(v) ? v.rule : undefined)));
  for (const rule of newValidations) {
    const ruleText = isPlainObject(rule) ? rule.rule : undefined;
    if (!oldRuleTexts.has(ruleText)) {
      violations.push(
        `${path}.x-kubernetes-validations: new or changed CEL rule: ${JSON.stringify(ruleText)}`,
      );
    }
  }

  // nullable: true -> false/removed narrows (fewer values now validate).
  if (oldSchema.nullable === true && newSchema.nullable !== true) {
    violations.push(
      `${path}.nullable: changed from true to ${newSchema.nullable === false ? 'false' : 'removed (defaults to false)'}`,
    );
  }

  // x-kubernetes-preserve-unknown-fields: true -> false/removed narrows (an
  // object that previously accepted arbitrary extra keys no longer does).
  if (
    oldSchema['x-kubernetes-preserve-unknown-fields'] === true &&
    newSchema['x-kubernetes-preserve-unknown-fields'] !== true
  ) {
    violations.push(
      `${path}.x-kubernetes-preserve-unknown-fields: changed from true to ` +
        `${newSchema['x-kubernetes-preserve-unknown-fields'] === false ? 'false' : 'removed (defaults to false)'}`,
    );
  }

  // additionalProperties: true/schema -> false narrows outright; true/schema
  // -> a different schema recurses through the SAME diff (so any violation
  // class above applies inside it too, e.g. a nested field removed).
  if (Object.prototype.hasOwnProperty.call(oldSchema, 'additionalProperties')) {
    const oldAP = oldSchema.additionalProperties;
    const newAP = newSchema.additionalProperties;
    const oldPermissive = oldAP === true || isPlainObject(oldAP);
    if (oldPermissive && newAP === false) {
      violations.push(`${path}.additionalProperties: narrowed to false`);
    } else if (isPlainObject(oldAP) && isPlainObject(newAP)) {
      diffOpenApiSchema(oldAP, newAP, `${path}.additionalProperties`, violations);
    }
  }

  // format: added where none existed, or changed value, on an existing
  // field. Removed format is NOT flagged — it widens what validates.
  if (typeof oldSchema.format === 'string') {
    if (typeof newSchema.format === 'string' && newSchema.format !== oldSchema.format) {
      violations.push(
        `${path}.format: changed from ${JSON.stringify(oldSchema.format)} to ${JSON.stringify(newSchema.format)}`,
      );
    }
  } else if (typeof newSchema.format === 'string') {
    violations.push(
      `${path}.format: added (${JSON.stringify(newSchema.format)}) where none existed before`,
    );
  }

  // default: changed or removed on an existing field is a behavior change
  // for objects relying on it, even though the field's accepted values are
  // unaffected.
  if (Object.prototype.hasOwnProperty.call(oldSchema, 'default')) {
    if (!Object.prototype.hasOwnProperty.call(newSchema, 'default')) {
      violations.push(`${path}.default: removed (was ${JSON.stringify(oldSchema.default)})`);
    } else if (JSON.stringify(newSchema.default) !== JSON.stringify(oldSchema.default)) {
      violations.push(
        `${path}.default: changed from ${JSON.stringify(oldSchema.default)} to ${JSON.stringify(newSchema.default)}`,
      );
    }
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
 * Also checks the version-level `served`/`storage` flags (see the module
 * header's VIOLATION CLASSES list) — a schema-tree diff alone cannot see
 * those, since they live on the version entry, not inside its schema.
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

    // served: true -> false breaks clients already addressing this version.
    if (oldVersion?.served === true && newVersion?.served !== true) {
      violations.push(`version "${name}": served flipped from true to false`);
    }

    const versionViolations = diffCrdVersionSchema(oldVersion, newVersion);
    for (const v of versionViolations) {
      violations.push(`version "${name}", ${v}`);
    }
  }

  // storage: true disappearing from a version with no OTHER version gaining
  // it is a violation — a CRD must always have exactly one storage version,
  // and losing the one that held it with nothing taking its place is a
  // silent write-path break. A storage-version MOVE (one loses it, a
  // DIFFERENT one gains it in the same diff) is allowed.
  const oldStorageNames = new Set(
    oldVersions.filter((v) => v?.storage === true).map((v) => v?.name),
  );
  const newStorageNames = new Set(
    newVersions.filter((v) => v?.storage === true).map((v) => v?.name),
  );
  const gainedStorage = [...newStorageNames].some((name) => !oldStorageNames.has(name));
  for (const name of oldStorageNames) {
    if (!newStorageNames.has(name) && !gainedStorage) {
      violations.push(
        `version "${name}": storage:true removed with no other version gaining storage:true`,
      );
    }
  }

  return { ok: violations.length === 0, violations };
}
