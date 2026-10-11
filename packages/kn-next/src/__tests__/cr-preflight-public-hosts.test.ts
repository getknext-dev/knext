/**
 * spec.networking.publicHosts is a NEW CRD field, so the CLI preflight must
 * know it in both directions:
 *  - against the CRD this repo ships, a CR that carries it is KNOWN (no field
 *    reported, nothing for an operator-first upgrade to trip over);
 *  - against an older CRD that has spec.networking (visibility) but not
 *    publicHosts, the preflight names exactly `spec.networking.publicHosts` and
 *    does NOT blame the older field it already understood.
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

function crdJson(withoutPublicHosts: boolean): string {
    const crd = YAML.parse(readFileSync(CRD_YAML, "utf-8")) as {
        spec: { versions: { schema: { openAPIV3Schema: Node } }[] };
    };
    const networking =
        crd.spec.versions[0]?.schema.openAPIV3Schema.properties.spec?.properties
            .networking;
    if (!networking) throw new Error("bundled CRD has no spec.networking");
    if (withoutPublicHosts) delete networking.properties.publicHosts;
    return JSON.stringify(crd);
}

const REJECT = {
    ok: false,
    stdout: "",
    // Deliberately names NO field: the preflight falls back to the apiserver's
    // message only when the CRD diff finds nothing, so a message that named
    // publicHosts would let the assertions below pass without the CLI knowing
    // the field at all.
    stderr: "strict decoding error: the server rejected this object",
};
const ACCEPT = { ok: true, stdout: "", stderr: "" };

interface Cluster {
    /** Serve a CRD that predates publicHosts. */
    withoutPublicHosts: boolean;
    /** Make the server-side dry-run apply reject the CR. */
    reject: boolean;
}

function kubectl(cluster: Cluster): KubectlCapture {
    const crd = crdJson(cluster.withoutPublicHosts);
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
    const dir = mkdtempSync(join(tmpdir(), "knext-public-hosts-"));
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

const WITH_HOSTS: KnativeNextConfig = {
    name: "app",
    registry: "registry",
    networking: { publicHosts: ["www.example.com"] },
};

describe("preflight knows spec.networking.publicHosts", () => {
    it("is in the set of fields the builder can emit", () => {
        expect(EMITTED_CR_FIELD_PATHS).toContain("spec.networking.publicHosts");
    });

    it("blames no field against the CRD this repo ships, even when the apply is rejected for another reason", () => {
        // reject:true forces the preflight to diff the CR against the CRD (an
        // accepted dry-run returns early and never reads it), so this goes red
        // if the shipped CRD stops defining spec.networking.publicHosts.
        expect(
            run(WITH_HOSTS, { withoutPublicHosts: false, reject: true }),
        ).toEqual([]);
    });

    it("names spec.networking.publicHosts against a CRD that predates it", () => {
        const fields = run(WITH_HOSTS, {
            withoutPublicHosts: true,
            reject: true,
        });
        expect(fields).toContain("spec.networking.publicHosts");
    });

    it("does not blame an older CRD for publicHosts when the CR does not carry it", () => {
        const fields = run(
            {
                name: "app",
                registry: "registry",
                networking: { visibility: "cluster-local" },
            },
            { withoutPublicHosts: true, reject: false },
        );
        expect(fields).not.toContain("spec.networking.publicHosts");
    });
});
