/**
 * T6 (doctor half) — `kn-next doctor` reports SCHEMA COVERAGE, not CRD
 * existence.
 *
 * The pre-#314 check answered "is the NextApp CRD installed and does it serve a
 * version" — which is green on precisely the cluster this whole workstream
 * exists for: one whose CRD is installed, served, and older than the CLI. The
 * question a user needs answered is "does the CRD on this cluster define every
 * field this CLI emits", and it is a different question.
 *
 * Division of labour with the deploy preflight, deliberately: `doctor` is
 * read-only and advisory, so when both schema reads are denied it SKIPS — and
 * its skip is visible in the table and the JSON. The VERDICT lives in
 * `deploy`'s server-side dry run, which needs no read at all. A doctor that
 * hard-failed on a denied read would fail restricted kubeconfigs for a
 * diagnosis, which is exactly what D-3 dissolves.
 */

import { describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { type KubectlFn, runDoctor } from "../cli/doctor";

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

function crdObject(): Record<string, unknown> {
    return YAML.parse(readFileSync(CRD_YAML, "utf-8")) as Record<
        string,
        unknown
    >;
}

function schemaOf(crd: Record<string, unknown>): Record<string, unknown> {
    const spec = crd.spec as {
        versions: { schema: Record<string, unknown> }[];
    };
    return spec.versions[0]?.schema.openAPIV3Schema as Record<string, unknown>;
}

function openApiDoc(schema: unknown): string {
    return JSON.stringify({
        components: {
            schemas: { "dev.kn-next.apps.v1alpha1.NextApp": schema },
        },
    });
}

const FORBIDDEN = {
    ok: false,
    stdout: "",
    stderr: 'Error from server (Forbidden): forbidden: User "u" cannot get',
};

/**
 * A kubectl stub good enough to reach the schema check: the cluster is
 * reachable, everything else answers "not found" (those checks fail, which is
 * fine — this suite asserts the schema row only).
 */
function stub(overrides: {
    openapi?: { ok: boolean; stdout?: string; stderr?: string };
    crd?: { ok: boolean; stdout?: string; stderr?: string };
}): KubectlFn {
    return (args) => {
        const key = args.join(" ");
        if (key === "kubectl get --raw /version") {
            return { ok: true, stdout: "{}", stderr: "" };
        }
        if (key.includes("/openapi/v3/apis")) {
            const o = overrides.openapi ?? FORBIDDEN;
            return { ok: o.ok, stdout: o.stdout ?? "", stderr: o.stderr ?? "" };
        }
        if (args[2] === "crd" && args[3]?.startsWith("nextapps")) {
            const o = overrides.crd ?? FORBIDDEN;
            return { ok: o.ok, stdout: o.stdout ?? "", stderr: o.stderr ?? "" };
        }
        return { ok: false, stdout: "", stderr: "not found" };
    };
}

const probeImage = mock(async () => "ok" as const);

async function schemaCheck(kubectl: KubectlFn) {
    const report = await runDoctor({ kubectl, probeImage });
    const check = report.checks.find((c) => c.id === "crd-schema");
    if (!check) throw new Error("doctor has no `crd-schema` check");
    return { check, report };
}

describe("doctor — NextApp CRD schema coverage", () => {
    it("PASSES when the installed schema defines every field this CLI emits", async () => {
        const { check } = await schemaCheck(
            stub({
                openapi: {
                    ok: true,
                    stdout: openApiDoc(schemaOf(crdObject())),
                },
            }),
        );
        expect(check.status).toBe("pass");
        expect(check.detail).toMatch(/field/i);
    });

    it("FAILS and NAMES the field when the CRD is missing one (mutation-proved against a real CRD)", async () => {
        const crd = crdObject();
        const spec = (
            schemaOf(crd).properties as Record<
                string,
                { properties: Record<string, unknown> }
            >
        ).spec;
        const database = spec.properties.database as {
            properties: Record<string, unknown>;
        };
        delete database.properties.roSecretRef;

        const { check, report } = await schemaCheck(
            stub({ openapi: { ok: true, stdout: openApiDoc(schemaOf(crd)) } }),
        );
        expect(check.status).toBe("fail");
        expect(check.detail).toMatch(/spec\.database\.roSecretRef/);
        expect(report.exitCode).toBe(1);
    });

    it("is about COVERAGE, not existence — a served CRD is not enough to pass", async () => {
        // The pre-#314 check would be green here: the CRD exists and serves
        // v1alpha1. This one must not be.
        const crd = crdObject();
        const spec = (
            schemaOf(crd).properties as Record<
                string,
                { properties: Record<string, unknown> }
            >
        ).spec;
        delete spec.properties.buildId;
        const { check } = await schemaCheck(
            stub({ crd: { ok: true, stdout: JSON.stringify(crd) } }),
        );
        expect(check.status).toBe("fail");
        expect(check.detail).toMatch(/spec\.buildId/);
    });

    it("SKIPS visibly when both schema reads are denied — and does not fail the run", async () => {
        const { check, report } = await schemaCheck(stub({}));
        expect(check.status).toBe("skip");
        // Visible: it says what was denied and where the real verdict lives.
        expect(check.detail).toMatch(/could not read|forbidden/i);
        expect(`${check.detail} ${check.hint ?? ""}`).toMatch(
            /deploy|preflight/i,
        );
        // A denied DIAGNOSIS must not fail doctor — the verdict is deploy's.
        // (Other rows in this stub do fail, so assert the precise claim: this
        // check is not among the ones driving the exit code.)
        expect(
            report.checks
                .filter((c) => c.status === "fail" || c.status === "error")
                .map((c) => c.id),
        ).not.toContain("crd-schema");
    });

    it("skips when the cluster is unreachable", async () => {
        const kubectl: KubectlFn = () => ({
            ok: false,
            stdout: "",
            stderr: "connection refused",
        });
        const { check } = await schemaCheck(kubectl);
        expect(check.status).toBe("skip");
    });
});
