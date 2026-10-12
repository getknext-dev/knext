/**
 * spec.cdn is a NEW CRD field, so the CLI preflight must know it in both
 * directions:
 *  - against the CRD this repo ships, a CR that carries it is KNOWN;
 *  - against an older CRD that lacks spec.cdn, the preflight names exactly
 *    `spec.cdn` (and its sub-fields), so an operator-first upgrade is enforced
 *    before the cluster is touched.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { buildNextAppCRObject } from "../cli/cr-builder";
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

function crdJson(withoutCdn: boolean): string {
    const crd = YAML.parse(readFileSync(CRD_YAML, "utf-8")) as {
        spec: { versions: { schema: { openAPIV3Schema: Node } }[] };
    };
    const spec = crd.spec.versions[0]?.schema.openAPIV3Schema.properties.spec;
    if (!spec?.properties.cdn) throw new Error("bundled CRD has no spec.cdn");
    if (withoutCdn) delete spec.properties.cdn;
    return JSON.stringify(crd);
}

const REJECT = {
    ok: false,
    stdout: "",
    // Deliberately names NO field: the preflight falls back to the apiserver's
    // message only when the CRD diff finds nothing, so a message that named cdn
    // would let the assertions below pass without the CLI knowing the field.
    stderr: "strict decoding error: the server rejected this object",
};
const ACCEPT = { ok: true, stdout: "", stderr: "" };

function kubectl(opts: {
    withoutCdn: boolean;
    reject: boolean;
}): KubectlCapture {
    const crd = crdJson(opts.withoutCdn);
    return (argv) => {
        if (argv[1] === "apply") return opts.reject ? REJECT : ACCEPT;
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

function run(
    config: KnativeNextConfig,
    cluster: { withoutCdn: boolean; reject: boolean },
): string[] {
    const dir = mkdtempSync(join(tmpdir(), "knext-cdn-"));
    dirs.push(dir);
    const crPath = join(dir, "cr.yaml");
    writeFileSync(
        crPath,
        YAML.stringify(buildNextAppCRObject(config, IMG, "ns", "b1")),
    );
    return preflightCRSchema(
        { kubectl: kubectl(cluster) },
        { crPath, namespace: "ns" },
    ).unknownFields;
}

const WITH_CDN: KnativeNextConfig = {
    name: "app",
    registry: "registry",
    cdn: {
        provider: "cloudflare",
        excludePaths: ["/account"],
        purge: {
            secretRef: { name: "cdn-purge", key: "token" },
            target: "0123456789abcdef0123456789abcdef",
        },
    },
};

describe("preflight knows spec.cdn", () => {
    it("is in the set of fields the builder can emit", () => {
        for (const path of [
            "spec.cdn",
            "spec.cdn.provider",
            "spec.cdn.htmlTTLSeconds",
            "spec.cdn.staleWhileRevalidateSeconds",
            "spec.cdn.excludePaths",
            "spec.cdn.includePaths",
            "spec.cdn.purge",
            "spec.cdn.purge.secretRef",
            "spec.cdn.purge.secretRef.name",
            "spec.cdn.purge.secretRef.key",
            "spec.cdn.purge.target",
            "spec.cdn.purge.requestsPerMinute",
            "spec.cdn.emulatorEndpoint",
        ]) {
            expect(EMITTED_CR_FIELD_PATHS).toContain(path);
        }
    });

    it("never lists a tag prefix: the operator derives it", () => {
        expect(
            EMITTED_CR_FIELD_PATHS.filter((p) => /prefix/i.test(p)).filter(
                (p) => p.startsWith("spec.cdn"),
            ),
        ).toEqual([]);
    });

    it("blames no field against the CRD this repo ships, even when the apply is rejected for another reason", () => {
        // reject:true forces the preflight to diff the CR against the CRD, so
        // this goes red if the shipped CRD stops defining spec.cdn.*.
        expect(run(WITH_CDN, { withoutCdn: false, reject: true })).toEqual([]);
    });

    it("names spec.cdn against a CRD that predates it", () => {
        const fields = run(WITH_CDN, { withoutCdn: true, reject: true });
        expect(fields).toContain("spec.cdn");
    });

    it("does not blame an older CRD for cdn when the CR does not carry it", () => {
        const fields = run(
            { name: "app", registry: "registry" },
            { withoutCdn: true, reject: false },
        );
        expect(fields.filter((f) => f.startsWith("spec.cdn"))).toEqual([]);
    });
});
