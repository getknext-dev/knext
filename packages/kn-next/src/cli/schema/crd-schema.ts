/**
 * crd-schema.ts — read the NextApp structural schema from whatever the cluster
 * is willing to hand us, and compare it against the fields this CLI emits.
 *
 * RUNTIME MODULE (no TypeScript-compiler import): it ships in the CLI bundle
 * and is used by the prune preflight and by `doctor`'s schema-coverage check.
 *
 * Two sources, deliberately in this order (ADR/decision D-3, docs/SPRINT_2.md):
 *   - the aggregated **OpenAPI v3 discovery** document
 *     (`/openapi/v3/apis/<group>/<version>`), which needs no cluster-scoped
 *     RBAC — `system:discovery` is bound to `system:authenticated`;
 *   - `kubectl get crd <name> -o json`, which needs cluster-scoped
 *     `get customresourcedefinitions` and is therefore ENRICHMENT ONLY.
 *
 * Neither is the verdict. The verdict is the server-side dry-run apply in
 * preflight.ts; these only make its message name the field. A failure here
 * degrades the message, never the verdict.
 *
 * PATH GRAMMAR — identical to extract-emitted-fields.ts:
 *   `spec.database.roSecretRef.name`, `spec.env`, `spec.secrets.envMap.*.secretKey`
 *   (`*` = a dynamic map key, from `additionalProperties`, or an array index,
 *   from `items`).
 */

export const NEXTAPP_GROUP = "apps.kn-next.dev";
export const NEXTAPP_VERSION = "v1alpha1";
export const NEXTAPP_KIND = "NextApp";
export const NEXTAPP_CRD_NAME = `nextapps.${NEXTAPP_GROUP}`;

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Flatten an OpenAPI v3 / structural schema to the set of paths it defines.
 *
 * `resolveRef` lets the caller supply `#/components/schemas/...` resolution for
 * the aggregated discovery document (CRD structural schemas are inline, but the
 * envelope's `metadata` is a $ref).
 */
export function flattenSchemaPaths(
    schema: unknown,
    options: {
        prefix?: string;
        resolveRef?: (ref: string) => unknown;
        maxDepth?: number;
    } = {},
): Set<string> {
    const out = new Set<string>();
    const { resolveRef, maxDepth = 24 } = options;
    const seen = new Set<unknown>();

    const walk = (node: unknown, path: string, depth: number): void => {
        if (!isObject(node) || depth > maxDepth) return;
        const current: Json = node;
        const ref = current.$ref;
        if (typeof ref === "string" && resolveRef) {
            const resolved = resolveRef(ref);
            // `seen` is a RECURSION STACK, not a visited-set: the same schema
            // (ObjectMeta, say) is legitimately referenced from several paths,
            // and a permanent visited-set would silently drop every occurrence
            // after the first — reporting real fields as missing.
            if (!isObject(resolved) || seen.has(resolved)) return;
            seen.add(resolved);
            walk(resolved, path, depth + 1);
            seen.delete(resolved);
            return;
        }
        // Composition keywords. The apiserver's aggregated document does NOT
        // inline the envelope the way a CRD file does — `metadata` arrives as
        // `{ description, allOf: [ { $ref: …ObjectMeta } ] }` (observed live on
        // kind). Unhandled, `metadata.name` reads as a field the CRD does not
        // define and `doctor` reports a FAIL on a healthy cluster.
        let composed = false;
        for (const key of ["allOf", "oneOf", "anyOf"] as const) {
            const branch = current[key];
            if (!Array.isArray(branch)) continue;
            for (const sub of branch) {
                composed = true;
                walk(sub, path, depth + 1);
            }
        }

        const props = current.properties;
        if (isObject(props)) {
            for (const [key, child] of Object.entries(props)) {
                const childPath = path ? `${path}.${key}` : key;
                out.add(childPath);
                walk(child, childPath, depth + 1);
            }
        }
        const additional = current.additionalProperties;
        if (isObject(additional)) {
            const childPath = path ? `${path}.*` : "*";
            out.add(childPath);
            walk(additional, childPath, depth + 1);
        }
        const items = current.items;
        if (isObject(items)) {
            const childPath = path ? `${path}.*` : "*";
            out.add(childPath);
            walk(items, childPath, depth + 1);
        }
        // An OPAQUE node — an object that declares no properties, no
        // additionalProperties and no items, or one that explicitly preserves
        // unknown fields. The schema says nothing about what lives below it, so
        // nothing below it can be called "missing". `metadata: {type: object}`
        // is the case that matters here: ObjectMeta is validated by the
        // apiserver itself, never by the CRD, and `metadata.name` is not
        // prunable. Marked with `.**` so the subset check can see it rather
        // than special-casing a field name.
        const declaresChildren =
            isObject(props) ||
            isObject(additional) ||
            isObject(items) ||
            composed;
        const isObjectNode =
            current.type === "object" ||
            current["x-kubernetes-preserve-unknown-fields"] === true;
        if (path && isObjectNode && !declaresChildren) {
            out.add(`${path}.**`);
        }
    };

    walk(schema, options.prefix ?? "", 0);
    return out;
}

/**
 * Is `path` covered by the schema? Either the schema defines it, or it lives
 * below an OPAQUE node (`.**`) whose contents the schema does not describe —
 * notably `metadata`, which the apiserver validates itself.
 */
export function isFieldKnown(
    path: string,
    known: ReadonlySet<string>,
): boolean {
    if (known.has(path)) return true;
    const parts = path.split(".");
    for (let i = 1; i < parts.length; i++) {
        if (known.has(`${parts.slice(0, i).join(".")}.**`)) return true;
    }
    return false;
}

/**
 * The emitted paths the schema does NOT define, shallowest-first and with
 * descendants of an already-missing path removed — so a pruned
 * `spec.database.roSecretRef` is reported once, by the name the user authored,
 * rather than as three unfamiliar leaves.
 */
export function unknownEmittedFields(
    emitted: readonly string[],
    known: ReadonlySet<string>,
): string[] {
    const missing = emitted.filter((p) => !isFieldKnown(p, known));
    const missingSet = new Set(missing);
    const hasMissingAncestor = (p: string): boolean => {
        const parts = p.split(".");
        for (let i = 1; i < parts.length; i++) {
            if (missingSet.has(parts.slice(0, i).join("."))) return true;
        }
        return false;
    };
    return missing.filter((p) => !hasMissingAncestor(p)).sort();
}

/** The v1alpha1 structural schema out of a `kubectl get crd -o json` object. */
export function crdSchemaFromCrdObject(
    crd: unknown,
    version: string = NEXTAPP_VERSION,
): Json | undefined {
    if (!isObject(crd)) return undefined;
    const spec = crd.spec;
    if (!isObject(spec) || !Array.isArray(spec.versions)) return undefined;
    for (const v of spec.versions) {
        if (!isObject(v) || v.name !== version) continue;
        const schema = v.schema;
        if (!isObject(schema)) continue;
        const open = schema.openAPIV3Schema;
        return isObject(open) ? open : undefined;
    }
    return undefined;
}

/**
 * The NextApp schema out of an aggregated OpenAPI v3 discovery document
 * (`kubectl get --raw /openapi/v3/apis/apps.kn-next.dev/v1alpha1`).
 *
 * Component keys are reverse-DNS (`dev.kn-next.apps.v1alpha1.NextApp`), so the
 * lookup matches on the SUFFIX rather than hardcoding the reversal — and it
 * must not match `NextAppList` / `NextAppStatus`.
 */
export function crdSchemaFromOpenApiV3Doc(
    doc: unknown,
    kind: string = NEXTAPP_KIND,
): { schema: Json; resolveRef: (ref: string) => unknown } | undefined {
    if (!isObject(doc)) return undefined;
    const components = doc.components;
    if (!isObject(components)) return undefined;
    const schemas = components.schemas;
    if (!isObject(schemas)) return undefined;
    const key = Object.keys(schemas).find((k) => k.endsWith(`.${kind}`));
    if (!key) return undefined;
    const schema = schemas[key];
    if (!isObject(schema)) return undefined;
    const resolveRef = (ref: string): unknown => {
        const name = ref.replace("#/components/schemas/", "");
        return (schemas as Json)[name];
    };
    return { schema, resolveRef };
}

/** argv for the OpenAPI v3 read — no cluster-scoped RBAC required. */
export function openApiV3Argv(
    group: string = NEXTAPP_GROUP,
    version: string = NEXTAPP_VERSION,
): string[] {
    return ["kubectl", "get", "--raw", `/openapi/v3/apis/${group}/${version}`];
}

/** argv for the CRD read — needs cluster-scoped get customresourcedefinitions. */
export function crdGetArgv(name: string = NEXTAPP_CRD_NAME): string[] {
    return ["kubectl", "get", "crd", name, "-o", "json"];
}

/**
 * Field names the apiserver itself named in a strict-decoding rejection:
 *   `strict decoding error: unknown field "spec.database.roSecretRef"`
 * The last-resort diagnosis tier — it needs no extra permission at all,
 * because the apiserver already put the answer in the error it returned.
 */
export function parseUnknownFieldsFromError(stderr: string): string[] {
    const out: string[] = [];
    for (const m of stderr.matchAll(/unknown field "([^"]+)"/g)) {
        const field = m[1];
        if (field && !out.includes(field)) out.push(field);
    }
    return out;
}
