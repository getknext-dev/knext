/**
 * spec.backends is a NEW field on the NextApp CRD, so the CLI must know it in
 * both directions, and what it emits must satisfy the CRD it ships against:
 *  - the shipped CRD defines every path the builder can emit under it, and the
 *    entries the builder produces satisfy that CRD's own patterns, bounds and
 *    list rules;
 *  - against an older CRD that predates `backends`, the preflight names
 *    `spec.backends` (an operator-first upgrade, never a silent prune), and a
 *    CR with no backends is not blamed for a field it does not carry.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { buildNextAppCRObject, renderNextAppCR } from "../cli/cr-builder";
import {
    crdSchemaFromCrdObject,
    flattenSchemaPaths,
    unknownEmittedFields,
} from "../cli/schema/crd-schema";
import { EMITTED_CR_FIELD_PATHS } from "../cli/schema/emitted-fields.generated";
import type { KubectlCapture } from "../cli/schema/preflight";
import { preflightCRSchema } from "../cli/schema/preflight";
import type { KnativeNextConfig } from "../config";

const HERE = dirname(fileURLToPath(import.meta.url));
const CRD_YAML = join(
    HERE,
    "..",
    "..",
    "..",
    "kn-next-operator",
    "config",
    "crd",
    "bases",
    "apps.kn-next.dev_nextapps.yaml",
);
const IMG = `registry/app@sha256:${"a".repeat(64)}`;

type Node = { properties: Record<string, Node> };
type Crd = {
    spec: { versions: { schema: { openAPIV3Schema: Node } }[] };
};

function loadCrd(): Crd {
    return YAML.parse(readFileSync(CRD_YAML, "utf-8")) as Crd;
}

function crdJson(withoutBackends: boolean, withoutImagePin = false): string {
    const crd = loadCrd();
    const spec = crd.spec.versions[0]?.schema.openAPIV3Schema.properties.spec;
    if (!spec) throw new Error("bundled CRD has no spec");
    if (withoutBackends) delete spec.properties.backends;
    // A CRD from the release that added spec.backends but not the image pin.
    const items = (
        spec.properties.backends as unknown as {
            items?: { properties: Record<string, unknown> };
        }
    )?.items;
    if (withoutImagePin && items) delete items.properties.image;
    return JSON.stringify(crd);
}

const REJECT = {
    ok: false,
    stdout: "",
    // Names NO field: the preflight falls back to the apiserver's message only
    // when the CRD diff finds nothing, so a message that named `backends` would
    // let the assertions below pass without the CLI knowing the field at all.
    stderr: "strict decoding error: the server rejected this object",
};
const ACCEPT = { ok: true, stdout: "", stderr: "" };

interface Cluster {
    /** Serve a CRD that predates spec.backends. */
    withoutBackends: boolean;
    /** Make the server-side dry-run apply reject the CR. */
    reject: boolean;
    /** Serve a CRD that has spec.backends but not its image pin. */
    withoutImagePin?: boolean;
}

function kubectl(cluster: Cluster): KubectlCapture {
    const crd = crdJson(cluster.withoutBackends, cluster.withoutImagePin);
    return (argv) => {
        if (argv[1] === "apply") return cluster.reject ? REJECT : ACCEPT;
        if (argv.join(" ").includes("openapi"))
            return { ok: false, stdout: "", stderr: "forbidden" };
        return { ok: true, stdout: crd, stderr: "" };
    };
}

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
});

function run(config: KnativeNextConfig, cluster: Cluster): string[] {
    const dir = mkdtempSync(join(tmpdir(), "knext-backends-"));
    dirs.push(dir);
    const crPath = join(dir, "cr.yaml");
    // The same renderer deploy hands the preflight and the apply.
    writeFileSync(crPath, renderNextAppCR(config, IMG, "ns", "b1"));
    return preflightCRSchema(
        { kubectl: kubectl(cluster) },
        { crPath, namespace: "ns" },
    ).unknownFields;
}

const WITH_BACKENDS: KnativeNextConfig = {
    name: "app",
    registry: "registry",
    backends: [{ name: "user-profile" }, { name: "pricing", service: "price" }],
};

describe("the NextApp the CLI emits matches the shipped CRD for spec.backends", () => {
    it("every path the builder can emit under spec.backends is defined by the CRD", () => {
        const emitted = EMITTED_CR_FIELD_PATHS.filter((p) =>
            p.startsWith("spec.backends"),
        );
        expect(emitted).toEqual([
            "spec.backends",
            "spec.backends.*.image",
            "spec.backends.*.name",
            "spec.backends.*.service",
        ]);
        const schema = crdSchemaFromCrdObject(loadCrd());
        if (!schema) throw new Error("no v1alpha1 schema in the bundled CRD");
        expect(
            unknownEmittedFields(emitted, flattenSchemaPaths(schema)),
        ).toEqual([]);
    });

    it("the entries satisfy the CRD's own patterns, bounds and list rules", () => {
        const cr = buildNextAppCRObject(WITH_BACKENDS, IMG, "ns", "b1");
        const entries = (
            cr.spec as { backends: { name: string; service: string }[] }
        ).backends;
        const schema = (
            loadCrd().spec.versions[0]?.schema.openAPIV3Schema.properties.spec
                ?.properties.backends as unknown as {
                maxItems: number;
                items: {
                    required: string[];
                    properties: Record<
                        string,
                        { pattern: string; maxLength: number }
                    >;
                };
            }
        ).items;
        expect(entries.length).toBeGreaterThan(0);
        for (const entry of entries) {
            // required: both keys are always sent
            for (const key of schema.required) {
                expect(Object.keys(entry), key).toContain(key);
            }
            for (const key of ["name", "service"] as const) {
                const field = schema.properties[key] as {
                    pattern: string;
                    maxLength: number;
                };
                expect(entry[key].length).toBeLessThanOrEqual(field.maxLength);
                expect(new RegExp(field.pattern).test(entry[key]), key).toBe(
                    true,
                );
            }
        }
        // listMapKey=name and "each service bound once"
        expect(new Set(entries.map((e) => e.name)).size).toBe(entries.length);
        expect(new Set(entries.map((e) => e.service)).size).toBe(
            entries.length,
        );
    });
});

describe("preflight knows the backends image pin", () => {
    const PINNED: KnativeNextConfig = {
        name: "app",
        registry: "registry",
        backends: [{ name: "pricing", image: `@sha256:${"ab12".repeat(16)}` }],
    };

    it("the pin the builder emits satisfies the CRD's own pattern and bound", () => {
        const cr = buildNextAppCRObject(PINNED, IMG, "ns", "b1");
        const entry = (cr.spec as { backends: { image: string }[] })
            .backends[0] as { image: string };
        const field = (
            loadCrd().spec.versions[0]?.schema.openAPIV3Schema.properties.spec
                ?.properties.backends as unknown as {
                items: {
                    properties: Record<
                        string,
                        { pattern: string; maxLength: number }
                    >;
                };
            }
        ).items.properties.image as { pattern: string; maxLength: number };
        expect(entry.image.length).toBeLessThanOrEqual(field.maxLength);
        expect(new RegExp(field.pattern).test(entry.image)).toBe(true);
    });

    it("blames no field against the CRD this repo ships", () => {
        expect(run(PINNED, { withoutBackends: false, reject: true })).toEqual(
            [],
        );
    });

    it("names the pin against a CRD that has backends but not the pin (operator first, then CLI)", () => {
        const fields = run(PINNED, {
            withoutBackends: false,
            withoutImagePin: true,
            reject: true,
        });
        expect(fields).toContain("spec.backends.*.image");
    });

    it("does not blame that CRD when no entry is pinned (a config without pins keeps working)", () => {
        const fields = run(WITH_BACKENDS, {
            withoutBackends: false,
            withoutImagePin: true,
            reject: true,
        });
        expect(fields).toEqual([]);
    });
});

describe("preflight knows spec.backends", () => {
    it("blames no field against the CRD this repo ships, even when the apply is rejected for another reason", () => {
        // reject:true forces the preflight to diff the CR against the CRD (an
        // accepted dry-run returns early and never reads it), so this goes red
        // if the shipped CRD stops defining spec.backends.
        expect(
            run(WITH_BACKENDS, { withoutBackends: false, reject: true }),
        ).toEqual([]);
    });

    it("names spec.backends against a CRD that predates it", () => {
        const fields = run(WITH_BACKENDS, {
            withoutBackends: true,
            reject: true,
        });
        expect(fields).toContain("spec.backends");
    });

    it("does not blame an older CRD when the config has no backends (old operators keep working)", () => {
        const fields = run(
            { name: "app", registry: "registry" },
            { withoutBackends: true, reject: true },
        );
        expect(fields.filter((f) => f.startsWith("spec.backends"))).toEqual([]);
    });
});
