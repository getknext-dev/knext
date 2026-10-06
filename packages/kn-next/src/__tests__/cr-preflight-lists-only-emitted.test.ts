/**
 * The preflight must name ONLY the unknown fields present in the CR actually
 * being applied — not every field this CLI version can emit. An older CRD that
 * lacks both `spec.networking` and `spec.security.writeFree` must not have a
 * `--private` CR (networking only) blamed for writeFree. Both halves asserted.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { buildNextAppCRObject, type WriteFreeFacts } from "../cli/cr-builder";
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

/** The bundled CRD minus spec.networking and spec.security.writeFree (a v1.0 operator). */
function olderCrdJson(): string {
    type Node = { properties: Record<string, Node> };
    const crd = YAML.parse(readFileSync(CRD_YAML, "utf-8")) as {
        spec: { versions: { schema: { openAPIV3Schema: Node } }[] };
    };
    const specProps =
        crd.spec.versions[0]?.schema.openAPIV3Schema.properties.spec
            ?.properties;
    if (!specProps) throw new Error("bundled CRD has no spec properties");
    delete specProps.networking;
    delete specProps.security?.properties.writeFree;
    return JSON.stringify(crd);
}

const REJECT = {
    ok: false,
    stdout: "",
    stderr: 'strict decoding error: unknown field "spec.networking"',
};

function kubectl(): KubectlCapture {
    const crd = olderCrdJson();
    return (argv) => {
        if (argv[1] === "apply") return REJECT;
        if (argv.join(" ").includes("openapi"))
            return { ok: false, stdout: "", stderr: "forbidden" };
        return { ok: true, stdout: crd, stderr: "" };
    };
}

const dirs: string[] = [];
afterEach(() => {
    while (dirs.length)
        rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function run(config: KnativeNextConfig, facts?: WriteFreeFacts): string[] {
    const dir = mkdtempSync(join(tmpdir(), "knext-1897-"));
    dirs.push(dir);
    const crPath = join(dir, "cr.yaml");
    writeFileSync(
        crPath,
        YAML.stringify(
            buildNextAppCRObject(config, IMG, "ns", "b1", undefined, facts),
        ),
    );
    return preflightCRSchema(
        { kubectl: kubectl() },
        { crPath, namespace: "ns" },
    ).unknownFields;
}

const PRIVATE: KnativeNextConfig = {
    name: "app",
    registry: "registry",
    networking: { visibility: "cluster-local" },
};

describe("preflight lists only fields in the CR being applied (#1897)", () => {
    it("a --private CR with no writeFree lists spec.networking and NOT spec.security.writeFree", () => {
        const fields = run(PRIVATE);
        expect(fields).toContain("spec.networking");
        expect(fields).not.toContain("spec.security.writeFree");
    });

    it("a CR that does carry writeFree lists both", () => {
        const fields = run(
            { ...PRIVATE, build: "vinext" },
            { builtThisRun: true },
        );
        expect(fields).toContain("spec.networking");
        expect(fields).toContain("spec.security.writeFree");
    });
});
