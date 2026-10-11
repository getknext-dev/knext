/**
 * `knext doctor` pairs the CLI with the cluster by CRD API VERSION.
 *
 * The CLI emits `apiVersion: apps.kn-next.dev/<version>` (cr-builder.ts); the
 * installed NextApp CRD lists the versions the apiserver serves. A pair is
 * supported when the emitted version is served -- NOT when the package major
 * equals the operator major, because a 2.0 `@getknext/core` pairs with the same
 * operator line as 1.x. Every dep is injected; nothing shells out to kubectl.
 */

import { describe, expect, it } from "bun:test";
import { buildNextAppCRObject, NEXTAPP_API_VERSION } from "../cli/cr-builder";
import { crdCheck } from "../cli/doctor/checks/crd";
import {
    classifyCrdPairing,
    servedCrdVersions,
} from "../cli/doctor/crd-version";
import type { CheckContext, DoctorDeps, KubectlFn } from "../cli/doctor/types";
import { NEXTAPP_CRD } from "../cli/doctor/types";
import type { KnativeNextConfig } from "../config";

const EMITTED = "v1alpha1";

function crdJson(
    versions: { name: string; served: boolean; storage?: boolean }[],
): string {
    return JSON.stringify({ spec: { group: "apps.kn-next.dev", versions } });
}

function ctxFor(
    result: { ok: boolean; stdout?: string; stderr?: string },
    verbose = false,
): CheckContext {
    const kubectl: KubectlFn = (args) => {
        expect(args.join(" ")).toBe(`kubectl get crd ${NEXTAPP_CRD} -o json`);
        return {
            ok: result.ok,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
        };
    };
    return {
        deps: { kubectl, probeImage: async () => "ok" } as DoctorDeps,
        kubectl,
        skipAll: false,
        verbose,
    };
}

function only<T>(rows: T[]): T {
    expect(rows).toHaveLength(1);
    return rows[0] as T;
}

describe("the version the CLI emits is read from cr-builder, not re-typed", () => {
    it("NEXTAPP_API_VERSION is exactly what buildNextAppCRObject stamps", () => {
        const cr = buildNextAppCRObject(
            { name: "a" } as unknown as KnativeNextConfig,
            `registry.example/a@sha256:${"a".repeat(64)}`,
            "ns",
        );
        expect(cr.apiVersion).toBe(NEXTAPP_API_VERSION);
        expect(NEXTAPP_API_VERSION).toBe(`apps.kn-next.dev/${EMITTED}`);
    });
});

describe("servedCrdVersions / classifyCrdPairing (pure)", () => {
    it("lists only served versions, in order", () => {
        const served = servedCrdVersions({
            spec: {
                versions: [
                    { name: "v1alpha1", served: true },
                    { name: "v1beta1", served: false },
                    { name: "v1", served: true },
                ],
            },
        });
        expect(served).toEqual(["v1alpha1", "v1"]);
    });

    it("is undefined when the document has no versions list at all", () => {
        expect(servedCrdVersions({ spec: {} })).toBeUndefined();
        expect(servedCrdVersions(undefined)).toBeUndefined();
    });

    it("paired: the emitted version is among several served versions", () => {
        expect(
            classifyCrdPairing(NEXTAPP_API_VERSION, ["v1beta1", "v1alpha1"]),
        ).toEqual({
            kind: "paired",
            emitted: EMITTED,
            served: ["v1beta1", "v1alpha1"],
        });
    });

    it("not-served: the emitted version is absent from the served list", () => {
        expect(classifyCrdPairing(NEXTAPP_API_VERSION, ["v1beta1"])).toEqual({
            kind: "not-served",
            emitted: EMITTED,
            served: ["v1beta1"],
            direction: "crd-newer",
        });
    });

    it("direction follows Kubernetes API version priority (alpha < beta < GA, then by number)", () => {
        const dir = (emitted: string, served: string[]) => {
            const p = classifyCrdPairing(`apps.kn-next.dev/${emitted}`, served);
            return p.kind === "not-served" ? p.direction : p.kind;
        };
        // The CRD only serves versions ahead of the CLI: the CLI is behind.
        expect(dir("v1alpha1", ["v1beta1"])).toBe("crd-newer");
        expect(dir("v1alpha1", ["v1alpha2"])).toBe("crd-newer");
        expect(dir("v1beta2", ["v1"])).toBe("crd-newer");
        expect(dir("v1beta1", ["v1", "v2"])).toBe("crd-newer");
        expect(dir("v1beta1", ["v2beta1"])).toBe("crd-newer");
        // The CRD only serves versions behind the CLI: the operator is behind.
        expect(dir("v1", ["v1beta1"])).toBe("crd-older");
        expect(dir("v1", ["v2beta1"])).toBe("crd-older"); // stability outranks the major, as in the apiserver
        expect(dir("v1beta1", ["v1alpha1", "v1alpha2"])).toBe("crd-older");
        expect(dir("v2", ["v1", "v2beta1"])).toBe("crd-older");
        expect(dir("v1beta2", ["v1beta1"])).toBe("crd-older");
        // Served on both sides of the emitted version, or not a Kubernetes
        // version name at all: no direction can be claimed.
        expect(dir("v1beta1", ["v1alpha1", "v1"])).toBe("unknown");
        expect(dir("v1alpha1", ["latest"])).toBe("unknown");
        expect(dir("v1alpha1", ["v1beta1", "stable"])).toBe("unknown");
        expect(dir("not-a-version", ["v1"])).toBe("unknown");
    });

    it("paired wins over direction: an older or newer sibling is irrelevant when the emitted version is served", () => {
        expect(
            classifyCrdPairing(NEXTAPP_API_VERSION, ["v1", "v1alpha1"]).kind,
        ).toBe("paired");
    });

    it("not-served: a prefix/suffix of a served name does not count", () => {
        expect(
            classifyCrdPairing(NEXTAPP_API_VERSION, ["v1alpha10", "xv1alpha1"])
                .kind,
        ).toBe("not-served");
    });

    it("a malformed emitted apiVersion never pairs (fails closed, does not throw)", () => {
        for (const bad of ["v1alpha1", "apps.kn-next.dev/", "/v1alpha1", ""]) {
            expect(classifyCrdPairing(bad, ["v1alpha1"]).kind).toBe(
                "not-served",
            );
        }
    });
});

describe("crdCheck pairs the emitted CRD version with the served versions", () => {
    it("PASS: the CRD serves the emitted version", () => {
        const row = only(
            crdCheck(
                ctxFor({
                    ok: true,
                    stdout: crdJson([{ name: EMITTED, served: true }]),
                }),
            ),
        );
        expect(row.status).toBe("pass");
        expect(row.detail).toContain(NEXTAPP_API_VERSION);
        expect(row.detail).toContain("served version: v1alpha1");
    });

    it("PASS: the CRD serves several versions, one of them the emitted one", () => {
        const row = only(
            crdCheck(
                ctxFor({
                    ok: true,
                    stdout: crdJson([
                        { name: "v1", served: true },
                        { name: EMITTED, served: true, storage: true },
                    ]),
                }),
            ),
        );
        expect(row.status).toBe("pass");
        expect(row.detail).toContain("served version: v1, v1alpha1");
    });

    it("FAIL: a CRD serving only a NEWER version means the CLI is behind -- upgrade the CLI, not the operator", () => {
        const row = only(
            crdCheck(
                ctxFor({
                    ok: true,
                    stdout: crdJson([{ name: "v1beta1", served: true }]),
                }),
            ),
        );
        expect(row.status).toBe("fail");
        expect(row.detail).toContain(NEXTAPP_API_VERSION);
        expect(row.detail).toContain("v1beta1");
        expect(row.detail).toMatch(/not serve/i);
        expect(row.detail).toMatch(/upgrade the CLI to match the operator/i);
        expect(row.detail).not.toMatch(/upgrade the operator first/i);
        expect(row.hint).toMatch(/upgrade the CLI/i);
        expect(row.hint).not.toMatch(/operator.*FIRST/);
    });

    it("FAIL: a CRD serving only an OLDER version means the operator is behind -- upgrade the operator first", () => {
        // The CLI's emitted version is a constant, so exercise the "CRD older" side by
        // giving the check a newer emitted version than the CRD serves.
        const row = only(
            crdCheck(
                ctxFor({
                    ok: true,
                    stdout: crdJson([{ name: "v1beta1", served: true }]),
                }),
                "apps.kn-next.dev/v1",
            ),
        );
        expect(row.status).toBe("fail");
        expect(row.detail).toContain("emits apps.kn-next.dev/v1,");
        expect(row.detail).toMatch(
            /upgrade the operator first \(operator, then CLI\)/i,
        );
        expect(row.detail).not.toMatch(/upgrade the CLI to match/i);
        expect(row.hint).toMatch(/operator.*FIRST/);
    });

    it("FAIL: served versions on both sides of the emitted one, or incomparable names, say both directions", () => {
        for (const versions of [
            [
                { name: "v1alpha1", served: false },
                { name: "v1beta1", served: true },
                { name: "stable", served: true },
            ],
            [{ name: "latest", served: true }],
        ]) {
            const row = only(
                crdCheck(ctxFor({ ok: true, stdout: crdJson(versions) })),
            );
            expect(row.status).toBe("fail");
            expect(row.detail).toMatch(/not serve/i);
            expect(row.detail).toMatch(/upgrade the operator first/i);
            expect(row.detail).toMatch(/upgrade the CLI/i);
        }
        const mixed = only(
            crdCheck(
                ctxFor({
                    ok: true,
                    stdout: crdJson([
                        { name: "v1alpha1", served: true },
                        { name: "v1", served: true },
                    ]),
                }),
                "apps.kn-next.dev/v1beta1",
            ),
        );
        expect(mixed.status).toBe("fail");
        expect(mixed.detail).toMatch(/upgrade the operator first/i);
        expect(mixed.detail).toMatch(/upgrade the CLI/i);
    });

    it("PASS: a deprecated but still served version pairs (deprecation is not an unserved version)", () => {
        const row = only(
            crdCheck(
                ctxFor({
                    ok: true,
                    stdout: JSON.stringify({
                        spec: {
                            versions: [
                                {
                                    name: "v1beta1",
                                    served: true,
                                    storage: true,
                                },
                                {
                                    name: EMITTED,
                                    served: true,
                                    storage: false,
                                    deprecated: true,
                                    deprecationWarning: "use v1beta1",
                                },
                            ],
                        },
                    }),
                }),
            ),
        );
        expect(row.status).toBe("pass");
        expect(row.detail).toContain("v1beta1, v1alpha1");
    });

    it("FAIL: the emitted version is listed but no longer served", () => {
        const row = only(
            crdCheck(
                ctxFor({
                    ok: true,
                    stdout: crdJson([
                        { name: EMITTED, served: false },
                        { name: "v1", served: true },
                    ]),
                }),
            ),
        );
        expect(row.status).toBe("fail");
        expect(row.detail).toMatch(/not serve/i);
    });

    it("FAIL (closed): unparseable CRD output is not read as a pass", () => {
        const row = only(
            crdCheck(ctxFor({ ok: true, stdout: "<html>proxy error</html>" })),
        );
        expect(row.status).toBe("fail");
        expect(row.detail).toMatch(/could not read/i);
    });

    it("FAIL (closed): a CRD document with no versions list is unreadable", () => {
        const row = only(
            crdCheck(
                ctxFor({ ok: true, stdout: JSON.stringify({ spec: {} }) }),
            ),
        );
        expect(row.status).toBe("fail");
        expect(row.detail).toMatch(/could not read/i);
    });

    it("FAIL: a CRD that lists versions but serves none keeps its own message", () => {
        const row = only(
            crdCheck(
                ctxFor({
                    ok: true,
                    stdout: crdJson([{ name: EMITTED, served: false }]),
                }),
            ),
        );
        expect(row.status).toBe("fail");
    });

    it("FAIL: an absent CRD stays a fail naming the install step", () => {
        const row = only(
            crdCheck(
                ctxFor({
                    ok: false,
                    stderr: `Error from server (NotFound): customresourcedefinitions.apiextensions.k8s.io "${NEXTAPP_CRD}" not found`,
                }),
            ),
        );
        expect(row.status).toBe("fail");
        expect(row.detail).toMatch(/not found/i);
    });

    it("ERROR (never a pass): a transport failure cannot verify the pairing", () => {
        const row = only(
            crdCheck(
                ctxFor({
                    ok: false,
                    stderr: "Unable to connect to the server: net/http: TLS handshake timeout",
                }),
            ),
        );
        expect(row.status).toBe("error");
    });

    it("SKIP: unreachable cluster", () => {
        const c = ctxFor({ ok: true });
        const row = only(crdCheck({ ...c, skipAll: true }));
        expect(row.status).toBe("skip");
    });
});
