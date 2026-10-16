/**
 * Zone functions add two CRD surfaces: `NextApp.spec.backends[]` (the zone half
 * of a binding) and the `BackendService` kind. The CLI's schema preflight must
 * know both, in both directions:
 *  - against the CRDs this repo ships, every new field is KNOWN;
 *  - against an older CRD that lacks them, the preflight's diff names exactly
 *    the missing fields, so an operator-first upgrade is enforced before the
 *    cluster is touched;
 *  - `serviceAccountName` is NOT a BackendService field, so a strict apply
 *    rejects it and a non-strict one prunes it: a user can never choose the
 *    identity a function runs as.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
    BACKENDSERVICE_CRD_NAME,
    BACKENDSERVICE_KIND,
    crdGetArgv,
    crdSchemaFromCrdObject,
    crdSchemaFromOpenApiV3Doc,
    flattenSchemaPaths,
    unknownEmittedFields,
} from "../cli/schema/crd-schema";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASES = join(
    HERE,
    "..",
    "..",
    "..",
    "kn-next-operator",
    "config",
    "crd",
    "bases",
);

type Node = { properties?: Record<string, Node>; items?: Node };

function loadCrd(file: string): {
    spec: { versions: { schema: { openAPIV3Schema: Node } }[] };
} {
    return YAML.parse(readFileSync(join(BASES, file), "utf-8"));
}

function known(crd: unknown): ReadonlySet<string> {
    const schema = crdSchemaFromCrdObject(crd);
    if (!schema) throw new Error("no v1alpha1 schema in the bundled CRD");
    return flattenSchemaPaths(schema);
}

const NEXTAPP_FIELDS = [
    "spec.backends",
    "spec.backends.*.name",
    "spec.backends.*.service",
];

const BACKENDSERVICE_FIELDS = [
    "spec.zone",
    "spec.image",
    "spec.language",
    "spec.port",
    "spec.protoVersion",
    "spec.wakeAhead",
    "spec.scaling.minScale",
    "spec.scaling.maxScale",
    "spec.scaling.containerConcurrency",
    "spec.resources.cpuLimit",
    "spec.env.*.name",
    "spec.env.*.valueFrom.secretKeyRef.name",
    "spec.envFrom.*.secretRef.name",
    "spec.volumes.*.name",
    "spec.volumes.*.mountPath",
    "spec.volumes.*.secret.secretName",
    "spec.volumes.*.projected.sources.*.secret.name",
    "spec.volumes.*.projected.sources.*.configMap.name",
    "spec.imagePullSecrets.*.name",
    "status.servedProtoVersion",
];

describe("CLI schema preflight knows the zone-function CRD fields", () => {
    it("the bundled NextApp CRD defines spec.backends[]", () => {
        const set = known(loadCrd("apps.kn-next.dev_nextapps.yaml"));
        expect(unknownEmittedFields(NEXTAPP_FIELDS, set)).toEqual([]);
    });

    it("an older NextApp CRD without spec.backends is diagnosed by name", () => {
        const crd = loadCrd("apps.kn-next.dev_nextapps.yaml");
        const spec =
            crd.spec.versions[0]?.schema.openAPIV3Schema.properties?.spec;
        if (!spec?.properties?.backends)
            throw new Error("bundled CRD has no spec.backends");
        delete spec.properties.backends;
        expect(unknownEmittedFields(NEXTAPP_FIELDS, known(crd))).toEqual([
            "spec.backends",
        ]);
    });

    it("the bundled BackendService CRD defines every field the CLI will emit", () => {
        const set = known(loadCrd("apps.kn-next.dev_backendservices.yaml"));
        expect(unknownEmittedFields(BACKENDSERVICE_FIELDS, set)).toEqual([]);
    });

    it("an older BackendService CRD without spec.zone is diagnosed by name", () => {
        const crd = loadCrd("apps.kn-next.dev_backendservices.yaml");
        const spec =
            crd.spec.versions[0]?.schema.openAPIV3Schema.properties?.spec;
        if (!spec?.properties?.zone)
            throw new Error("bundled CRD has no spec.zone");
        delete spec.properties.zone;
        expect(unknownEmittedFields(BACKENDSERVICE_FIELDS, known(crd))).toEqual(
            ["spec.zone"],
        );
    });

    it("serviceAccountName is not a BackendService field (a function never runs as a user-chosen identity)", () => {
        const set = known(loadCrd("apps.kn-next.dev_backendservices.yaml"));
        expect(
            unknownEmittedFields(
                ["spec.serviceAccountName", "spec.template"],
                set,
            ),
        ).toEqual(["spec.serviceAccountName", "spec.template"]);
    });

    it("reads the BackendService schema by kind and by CRD name", () => {
        expect(crdGetArgv(BACKENDSERVICE_CRD_NAME)).toEqual([
            "kubectl",
            "get",
            "crd",
            "backendservices.apps.kn-next.dev",
            "-o",
            "json",
        ]);
        const crd = loadCrd("apps.kn-next.dev_backendservices.yaml");
        const schema = crdSchemaFromCrdObject(crd);
        const doc = {
            components: {
                schemas: {
                    "dev.kn-next.apps.v1alpha1.BackendServiceList": {},
                    "dev.kn-next.apps.v1alpha1.BackendService": schema,
                    "dev.kn-next.apps.v1alpha1.NextApp": {},
                },
            },
        };
        const found = crdSchemaFromOpenApiV3Doc(doc, BACKENDSERVICE_KIND);
        expect(found?.schema).toBe(schema);
    });
});
