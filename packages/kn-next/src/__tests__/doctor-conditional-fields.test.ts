/**
 * Doctor and the deploy preflight must agree about a CRD that predates the
 * fields this CLI emits only SOMETIMES (`spec.security.writeFree`, only when
 * `knext deploy` built the image; `spec.networking`, only for private apps).
 *
 *   - missing ALWAYS-emitted field      -> doctor FAILs (as before)
 *   - missing CONDITIONALLY-emitted one -> doctor WARNs, naming the feature
 *   - the CLI-built-image path against that same CRD -> the deploy preflight
 *     REFUSES, naming the field (the case that used to be untested).
 */

import { afterAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { buildNextAppCRObject } from "../cli/cr-builder";
import { type KubectlFn, runDoctor } from "../cli/doctor";
import {
    CONDITIONALLY_EMITTED_FIELDS,
    partitionMissingFields,
} from "../cli/schema/crd-schema";
import { EMITTED_CR_FIELD_PATHS } from "../cli/schema/emitted-fields.generated";
import { preflightCRSchema } from "../cli/schema/preflight";

const tempRoots: string[] = [];
afterAll(() => {
    for (const root of tempRoots)
        rmSync(root, { recursive: true, force: true });
});

const HERE = dirname(fileURLToPath(import.meta.url));
const CRD_YAML = join(
    HERE,
    "..",
    "..",
    "..",
    "..",
    "packages",
    "kn-next-operator",
    "config",
    "crd",
    "bases",
    "apps.kn-next.dev_nextapps.yaml",
);

type Node = { properties: Record<string, Node | unknown> };

/** The real CRD schema with the given paths deleted (an "old" operator). */
function oldSchema(...removed: string[]): Record<string, unknown> {
    const crd = YAML.parse(readFileSync(CRD_YAML, "utf-8")) as {
        spec: { versions: { schema: { openAPIV3Schema: Node } }[] };
    };
    const root = crd.spec.versions[0]?.schema.openAPIV3Schema as Node;
    for (const path of removed) {
        const parts = path.split(".");
        let node = root as Node;
        for (const p of parts.slice(0, -1)) node = node.properties[p] as Node;
        delete node.properties[parts[parts.length - 1] as string];
    }
    return root as unknown as Record<string, unknown>;
}

const openApiDoc = (schema: unknown) =>
    JSON.stringify({
        components: {
            schemas: { "dev.kn-next.apps.v1alpha1.NextApp": schema },
        },
    });

function stub(schema: unknown): KubectlFn {
    return (args) => {
        const key = args.join(" ");
        if (key === "kubectl get --raw /version")
            return { ok: true, stdout: "{}", stderr: "" };
        if (key.includes("/openapi/v3/apis"))
            return { ok: true, stdout: openApiDoc(schema), stderr: "" };
        return { ok: false, stdout: "", stderr: "not found" };
    };
}

async function schemaCheck(schema: unknown, verbose = false) {
    const report = await runDoctor(
        { kubectl: stub(schema), probeImage: mock(async () => "ok" as const) },
        verbose,
    );
    const check = report.checks.find((c) => c.id === "crd-schema");
    if (!check) throw new Error("no crd-schema check");
    return check;
}

describe("conditional-field classification (single source of truth)", () => {
    it("every conditional path is a real emitted path", () => {
        for (const p of Object.keys(CONDITIONALLY_EMITTED_FIELDS)) {
            expect(EMITTED_CR_FIELD_PATHS).toContain(p);
        }
    });

    it("names writeFree and networking", () => {
        expect(Object.keys(CONDITIONALLY_EMITTED_FIELDS)).toEqual(
            expect.arrayContaining([
                "spec.security.writeFree",
                "spec.networking",
            ]),
        );
    });

    it("partitions required vs conditional", () => {
        const p = partitionMissingFields([
            "spec.networking",
            "spec.database.roSecretRef",
        ]);
        expect(p.conditional.map((c) => c.path)).toEqual(["spec.networking"]);
        expect(p.required).toEqual(["spec.database.roSecretRef"]);
    });
});

describe("doctor — conditionally-emitted fields", () => {
    it("WARNs (not fails) when only writeFree + networking are missing, naming each feature", async () => {
        const check = await schemaCheck(
            oldSchema("spec.security.writeFree", "spec.networking"),
        );
        expect(check.status).toBe("warn");
        expect(check.detail).toContain("spec.security.writeFree");
        expect(check.detail).toContain("write-free");
        expect(check.detail).toContain("spec.networking");
        expect(check.detail).toContain("private apps");
        expect(check.detail).not.toContain("operator behind CLI");
    });

    it("still FAILs when an always-emitted field is missing", async () => {
        const check = await schemaCheck(oldSchema("spec.database.roSecretRef"));
        expect(check.status).toBe("fail");
        expect(check.detail).toContain("operator behind CLI");
    });

    it("FAILs (required wins) when a required AND a conditional field are missing", async () => {
        const check = await schemaCheck(
            oldSchema("spec.database.roSecretRef", "spec.networking"),
        );
        expect(check.status).toBe("fail");
    });
});

describe("deploy preflight — the CLI-built-image path against an old CRD", () => {
    it("REFUSES a CR carrying writeFree, naming spec.security.writeFree", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-1889-"));
        tempRoots.push(dir);
        const cr = buildNextAppCRObject(
            { name: "app", registry: "registry", build: "vinext" },
            "registry/app:t@sha256:deadbeef",
            "default",
            "b1",
            undefined,
            { builtThisRun: true },
        );
        expect(
            (cr as { spec: { security?: { writeFree?: boolean } } }).spec
                .security?.writeFree,
        ).toBe(true);
        const crPath = join(dir, "cr.yaml");
        writeFileSync(crPath, YAML.stringify(cr));
        const schema = oldSchema("spec.security.writeFree");
        const outcome = preflightCRSchema(
            {
                kubectl: (argv) => {
                    if (argv[1] === "apply")
                        return {
                            ok: false,
                            stdout: "",
                            stderr: 'strict decoding error: unknown field "spec.security.writeFree"',
                        };
                    if (argv.includes("--raw"))
                        return {
                            ok: true,
                            stdout: openApiDoc(schema),
                            stderr: "",
                        };
                    return { ok: false, stdout: "", stderr: "forbidden" };
                },
            },
            { crPath, namespace: "default" },
        );
        expect(outcome.verdict).toBe("skew");
        expect(outcome.unknownFields).toContain("spec.security.writeFree");
    });
});
