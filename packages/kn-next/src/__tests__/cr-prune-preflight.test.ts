/**
 * T6 — the prune preflight. Three tiers, one verdict.
 *
 * The design is docs/SPRINT_2.md decision D-3, and its premise is what makes
 * "fail hard on denial" and "namespace-scoped users can still deploy"
 * compatible rather than opposed:
 *
 *   Tier 1 (VERDICT)    a server-side `--dry-run=server --validate=strict`
 *                       apply of the exact CR, as the FIRST cluster-touching
 *                       step. It needs `create`/`patch` on nextapps in the
 *                       target namespace — precisely what `deploy` already
 *                       needs. No kubeconfig can deploy but not preflight, so
 *                       hard failure costs nothing.
 *   Tier 2 (DIAGNOSIS)  the aggregated OpenAPI v3 discovery document, which
 *                       needs no cluster-scoped RBAC. If denied, degrade to
 *                       parsing the apiserver's own `unknown field "…"`
 *                       message, which already names the field.
 *   Tier 3 (ENRICHMENT) `kubectl get crd`, when permitted.
 *
 * **Failure of tiers 2–3 degrades the MESSAGE, never the VERDICT.** The tests
 * below are written to fail if that inverts — a warning instead of a failure is
 * useless exactly when it matters.
 *
 * The named case throughout is `spec.database.roSecretRef`: when it is pruned
 * the operator never injects DATABASE_URL_RO, `getDbRO()` falls back to the
 * writer pool, and staleness-tolerant reads run on the read-WRITE primary
 * credential — a pruned field silently escalating database privilege, on a CR
 * that still reports Ready=True.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import {
    crdSchemaFromOpenApiV3Doc,
    flattenSchemaPaths,
    unknownEmittedFields,
} from "../cli/schema/crd-schema";
import type { KubectlCapture } from "../cli/schema/preflight";
import {
    formatPreflightFailure,
    preflightCRSchema,
    readKnownCRDFields,
} from "../cli/schema/preflight";

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

/** The real bundled CRD, parsed fresh so a test can mutate its own copy. */
function crdObject(): Record<string, unknown> {
    return YAML.parse(readFileSync(CRD_YAML, "utf-8")) as Record<
        string,
        unknown
    >;
}

function crdSchemaObject(
    crd: Record<string, unknown>,
): Record<string, unknown> {
    const spec = crd.spec as {
        versions: { schema: Record<string, unknown> }[];
    };
    return spec.versions[0]?.schema.openAPIV3Schema as Record<string, unknown>;
}

/**
 * An aggregated OpenAPI v3 discovery document carrying the given schema, keyed
 * the way the apiserver keys it (reverse-DNS group + version + kind).
 */
function openApiDoc(schema: unknown): string {
    return JSON.stringify({
        openapi: "3.0.0",
        components: {
            schemas: {
                "dev.kn-next.apps.v1alpha1.NextAppList": { type: "object" },
                "dev.kn-next.apps.v1alpha1.NextApp": schema,
            },
        },
    });
}

/** Delete a field from a real CRD schema — authored independently of the generator. */
function withoutRoSecretRef(): Record<string, unknown> {
    const crd = crdObject();
    const schema = crdSchemaObject(crd);
    const spec = (
        schema.properties as Record<
            string,
            { properties: Record<string, unknown> }
        >
    ).spec as { properties: Record<string, unknown> };
    const database = spec.properties.database as {
        properties: Record<string, unknown>;
    };
    delete database.properties.roSecretRef;
    return schema;
}

const OK = { ok: true, stdout: "", stderr: "" };
const STRICT_REJECTION = {
    ok: false,
    stdout: "",
    stderr:
        'Error from server (BadRequest): error when creating "nextapp-cr.yaml": ' +
        'NextApp in version "v1alpha1" cannot be handled as a NextApp: strict decoding error: ' +
        'unknown field "spec.database.roSecretRef"',
};

/** A kubectl stub driven by argv shape. */
function stubKubectl(
    handlers: Partial<{
        apply: { ok: boolean; stdout: string; stderr: string };
        openapi: { ok: boolean; stdout: string; stderr: string };
        crd: { ok: boolean; stdout: string; stderr: string };
    }>,
): { fn: KubectlCapture; calls: string[][] } {
    const calls: string[][] = [];
    const fn: KubectlCapture = (argv) => {
        const a = [...argv];
        calls.push(a);
        if (a[1] === "apply") {
            return handlers.apply ?? OK;
        }
        if (a.includes("--raw")) {
            return (
                handlers.openapi ?? {
                    ok: false,
                    stdout: "",
                    stderr: 'Error from server (Forbidden): forbidden: User "u" cannot get path "/openapi/v3"',
                }
            );
        }
        return (
            handlers.crd ?? {
                ok: false,
                stdout: "",
                stderr: 'Error from server (Forbidden): customresourcedefinitions.apiextensions.k8s.io is forbidden: User "u" cannot get',
            }
        );
    };
    return { fn, calls };
}

const ARGS = { crPath: "/tmp/nextapp-cr.yaml", namespace: "prod" };

describe("tier 1 — the verdict is a server-side dry-run apply", () => {
    it("is the FIRST cluster call, and asserts server-side dry-run + strict validation", () => {
        const { fn, calls } = stubKubectl({ apply: OK });
        preflightCRSchema({ kubectl: fn }, ARGS);
        const first = calls[0] as string[];
        expect(first[0]).toBe("kubectl");
        expect(first[1]).toBe("apply");
        expect(first).toContain("--dry-run=server");
        expect(first).toContain("--validate=strict");
        expect(first.filter((a) => a.startsWith("--validate"))).toHaveLength(1);
        expect(first[first.indexOf("-f") + 1]).toBe(ARGS.crPath);
        expect(first[first.indexOf("-n") + 1]).toBe("prod");
    });

    it("needs no permission beyond the apply itself — it reads NOTHING on the happy path", () => {
        // The whole reason hard failure is affordable (D-3): a passing preflight
        // must not depend on a read a restricted kubeconfig might be denied.
        const { fn, calls } = stubKubectl({ apply: OK });
        const outcome = preflightCRSchema({ kubectl: fn }, ARGS);
        expect(outcome.verdict).toBe("ok");
        expect(calls).toHaveLength(1);
    });

    it("a strict-decoding rejection is a SKEW verdict, never a warning", () => {
        const { fn } = stubKubectl({ apply: STRICT_REJECTION });
        const outcome = preflightCRSchema({ kubectl: fn }, ARGS);
        expect(outcome.verdict).toBe("skew");
        expect(outcome.unknownFields).toContain("spec.database.roSecretRef");
    });

    it("any other apply failure is BLOCKED — the deploy does not proceed on an unverified cluster", () => {
        const { fn } = stubKubectl({
            apply: {
                ok: false,
                stdout: "",
                stderr: 'Error from server (Forbidden): nextapps.apps.kn-next.dev is forbidden: User "u" cannot create',
            },
        });
        const outcome = preflightCRSchema({ kubectl: fn }, ARGS);
        expect(outcome.verdict).toBe("blocked");
        // …and it says so where the user can act on it: the same RBAC the
        // deploy itself needs.
        expect(formatPreflightFailure(outcome)).toMatch(/create|patch/i);
    });

    it("distinguishes a DOWN admission webhook from CLI/operator skew", () => {
        const { fn } = stubKubectl({
            apply: {
                ok: false,
                stdout: "",
                stderr:
                    'Error from server (InternalError): Internal error occurred: failed calling webhook "vnextapp.kb.io": ' +
                    'failed to call webhook: Post "https://webhook-service.kn-next-operator-system.svc:443/validate": ' +
                    "dial tcp 10.0.0.1:443: connect: connection refused",
            },
        });
        const outcome = preflightCRSchema({ kubectl: fn }, ARGS);
        expect(outcome.verdict).toBe("blocked");
        expect(outcome.reason).toBe("webhook-unavailable");
        const msg = formatPreflightFailure(outcome);
        expect(msg).toMatch(/webhook/i);
        // Misdiagnosing this as skew sends the user to upgrade the wrong thing.
        expect(msg).not.toMatch(/older than this CLI/i);
    });
});

describe("tier 2 — diagnosis degrades the message, never the verdict", () => {
    it("names the field from the OpenAPI v3 document (no cluster-scoped RBAC)", () => {
        const { fn, calls } = stubKubectl({
            apply: STRICT_REJECTION,
            openapi: {
                ok: true,
                stdout: openApiDoc(withoutRoSecretRef()),
                stderr: "",
            },
        });
        const outcome = preflightCRSchema({ kubectl: fn }, ARGS);
        expect(outcome.verdict).toBe("skew");
        expect(outcome.diagnosis).toBe("openapi-v3");
        expect(outcome.unknownFields).toContain("spec.database.roSecretRef");
        // It read the aggregated discovery doc, NOT the CRD.
        expect(
            calls.some((c) => c.join(" ").includes("/openapi/v3/apis")),
        ).toBe(true);
        expect(calls.some((c) => c[2] === "crd")).toBe(false);
    });

    it("the roSecretRef message says WHY a pruned field is dangerous (privilege escalation)", () => {
        const { fn } = stubKubectl({
            apply: STRICT_REJECTION,
            openapi: {
                ok: true,
                stdout: openApiDoc(withoutRoSecretRef()),
                stderr: "",
            },
        });
        const msg = formatPreflightFailure(
            preflightCRSchema({ kubectl: fn }, ARGS),
        );
        expect(msg).toMatch(/spec\.database\.roSecretRef/);
        expect(msg).toMatch(/DATABASE_URL_RO/);
        expect(msg).toMatch(/read-write|read-WRITE|write/);
        // Upgrade order is load-bearing and must be stated, not assumed.
        expect(msg).toMatch(/operator.*then.*CLI/i);
    });

    it("degrades to the apiserver's own message when OpenAPI v3 is denied — verdict UNCHANGED", () => {
        const { fn } = stubKubectl({ apply: STRICT_REJECTION }); // both reads forbidden
        const outcome = preflightCRSchema({ kubectl: fn }, ARGS);
        expect(outcome.verdict).toBe("skew");
        expect(outcome.diagnosis).toBe("apiserver-message");
        expect(outcome.unknownFields).toEqual(["spec.database.roSecretRef"]);
        expect(formatPreflightFailure(outcome)).toMatch(
            /spec\.database\.roSecretRef/,
        );
    });

    it("falls through to the CRD (tier 3) only when the OpenAPI read fails", () => {
        const crd = crdObject();
        const schema = crdSchemaObject(crd);
        const spec = (
            schema.properties as Record<
                string,
                { properties: Record<string, unknown> }
            >
        ).spec;
        delete spec.properties.buildId;
        const { fn, calls } = stubKubectl({
            apply: {
                ok: false,
                stdout: "",
                stderr: 'strict decoding error: unknown field "spec.buildId"',
            },
            crd: { ok: true, stdout: JSON.stringify(crd), stderr: "" },
        });
        const outcome = preflightCRSchema({ kubectl: fn }, ARGS);
        expect(outcome.verdict).toBe("skew");
        expect(outcome.diagnosis).toBe("crd");
        expect(outcome.unknownFields).toContain("spec.buildId");
        expect(calls.some((c) => c[2] === "crd")).toBe(true);
    });
});

describe("readKnownCRDFields — the shared schema read (doctor uses the same one)", () => {
    it("prefers OpenAPI v3 and reports its source", () => {
        const { fn } = stubKubectl({
            openapi: {
                ok: true,
                stdout: openApiDoc(crdSchemaObject(crdObject())),
                stderr: "",
            },
        });
        const read = readKnownCRDFields(fn);
        expect(read.source).toBe("openapi-v3");
        expect(read.known?.has("spec.database.roSecretRef")).toBe(true);
    });

    it("reports `none` (not an empty schema) when both reads are denied", () => {
        const { fn } = stubKubectl({});
        const read = readKnownCRDFields(fn);
        expect(read.source).toBe("none");
        expect(read.known).toBeUndefined();
        // An empty known-set would report EVERY field as missing — a confident
        // wrong answer is worse than an admitted unknown.
        expect(read.detail).toMatch(/forbidden|denied|could not/i);
    });
});

describe("the aggregated document's own shapes (observed on a live cluster, not guessed)", () => {
    // Discovered by running the real preflight against kind with a restricted
    // kubeconfig: the apiserver does NOT inline the envelope's `metadata` the
    // way the CRD file does — it emits
    //   metadata: { description: …, allOf: [ { $ref: …ObjectMeta } ] }
    // With `allOf` unhandled, `metadata.name` reads as a field the CRD does not
    // define, and doctor reports a FAIL on a perfectly healthy cluster. A
    // false positive on the honest-status path is not a cosmetic bug.
    it("resolves `allOf` + `$ref` so envelope fields are not reported missing", () => {
        const doc = JSON.parse(
            JSON.stringify({
                components: {
                    schemas: {
                        "io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta": {
                            type: "object",
                            properties: {
                                name: { type: "string" },
                                namespace: { type: "string" },
                            },
                        },
                        "dev.kn-next.apps.v1alpha1.NextApp": {
                            type: "object",
                            properties: {
                                metadata: {
                                    description: "Standard object's metadata.",
                                    allOf: [
                                        {
                                            $ref: "#/components/schemas/io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta",
                                        },
                                    ],
                                },
                            },
                        },
                    },
                },
            }),
        ) as unknown;
        const found = crdSchemaFromOpenApiV3Doc(doc);
        if (!found) throw new Error("no NextApp schema in the fixture");
        const known = flattenSchemaPaths(found.schema, {
            resolveRef: found.resolveRef,
        });
        expect(known.has("metadata.name")).toBe(true);
        expect(known.has("metadata.namespace")).toBe(true);
        expect(
            unknownEmittedFields(
                ["metadata.name", "metadata.namespace"],
                known,
            ),
        ).toEqual([]);
    });
});

describe("preview deploy runs the same preflight BEFORE it builds", () => {
    it("aborts before buildAndPush when the CR would be pruned", async () => {
        const { runPreviewDeploy } = await import("../cli/preview");
        const order: string[] = [];
        const preflight = vi.fn(() => {
            order.push("preflight");
            throw new Error(
                "preflight: unknown field spec.database.roSecretRef",
            );
        });
        const buildAndPush = vi.fn(async () => {
            order.push("build");
            return `registry.example.com/app-pr-1:t@sha256:${"a".repeat(64)}`;
        });
        await expect(
            runPreviewDeploy(
                {
                    name: "app",
                    registry: "registry.example.com",
                    storage: {
                        provider: "gcs",
                        bucket: "b",
                        publicUrl: "https://example.com",
                    },
                },
                { prId: "1", branch: "b", namespace: "previews" },
                {
                    apply: vi.fn(),
                    capture: () => "",
                    buildAndPush,
                    preflight,
                },
            ),
        ).rejects.toThrow(/roSecretRef/);
        expect(order).toEqual(["preflight"]);
        expect(buildAndPush).not.toHaveBeenCalled();
    });
});
