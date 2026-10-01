/**
 * #1233 (coverage batch B2) — cr-builder.ts honest-uncovered gaps.
 *
 * Targets the emission branches no existing cr-builder test exercised:
 * spec.resources (from the legacy scaling.cpu/memory knobs), spec.revalidation
 * (kafka queue), spec.secrets.envMap, spec.preview, and the remaining throw
 * message continuations in validateTaggedRef / validateCRImageRef / resolveDigest.
 */

import { describe, expect, it } from "bun:test";
import {
    buildNextAppCRObject,
    resolveDigest,
    validateCRImageRef,
    validateTaggedRef,
} from "../cli/cr-builder";
import type { KnativeNextConfig } from "../config";

const IMG = "registry/app:tag@sha256:deadbeef";

function baseConfig(
    overrides: Partial<KnativeNextConfig> = {},
): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: {
            provider: "gcs",
            bucket: "b",
            publicUrl: "https://example.com",
        },
        ...overrides,
    };
}

describe("buildNextAppCRObject — spec.resources (legacy scaling.cpu/memory knobs)", () => {
    it("emits resources with all 4 defaults filled when any one knob is set", () => {
        const cr = buildNextAppCRObject(
            baseConfig({ scaling: { cpuRequest: "500m" } }),
            IMG,
            "ns",
        );
        expect((cr.spec as Record<string, unknown>).resources).toEqual({
            cpuRequest: "500m",
            memoryRequest: "512Mi",
            cpuLimit: "1000m",
            memoryLimit: "1Gi",
        });
    });

    it("emits resources verbatim when all 4 knobs are set explicitly", () => {
        const cr = buildNextAppCRObject(
            baseConfig({
                scaling: {
                    cpuRequest: "1",
                    memoryRequest: "2Gi",
                    cpuLimit: "2",
                    memoryLimit: "4Gi",
                },
            }),
            IMG,
            "ns",
        );
        expect((cr.spec as Record<string, unknown>).resources).toEqual({
            cpuRequest: "1",
            memoryRequest: "2Gi",
            cpuLimit: "2",
            memoryLimit: "4Gi",
        });
    });

    it("omits the resources key entirely when no cpu/memory knob is set (back-compat)", () => {
        const cr = buildNextAppCRObject(
            baseConfig({ scaling: { minScale: 0, maxScale: 5 } }),
            IMG,
            "ns",
        );
        expect(Object.keys(cr.spec as Record<string, unknown>)).not.toContain(
            "resources",
        );
    });
});

describe("buildNextAppCRObject — spec.revalidation (kafka queue)", () => {
    it("emits revalidation.queue/kafkaBrokerUrl when queue.provider is kafka", () => {
        const cr = buildNextAppCRObject(
            baseConfig({
                queue: { provider: "kafka", brokerUrl: "kafka:9092" },
            }),
            IMG,
            "ns",
        );
        expect((cr.spec as Record<string, unknown>).revalidation).toEqual({
            queue: "kafka",
            kafkaBrokerUrl: "kafka:9092",
        });
    });

    it("omits revalidation when queue.provider is none", () => {
        const cr = buildNextAppCRObject(
            baseConfig({ queue: { provider: "none" } }),
            IMG,
            "ns",
        );
        expect(Object.keys(cr.spec as Record<string, unknown>)).not.toContain(
            "revalidation",
        );
    });

    it("omits revalidation when queue is absent entirely", () => {
        const cr = buildNextAppCRObject(baseConfig(), IMG, "ns");
        expect(Object.keys(cr.spec as Record<string, unknown>)).not.toContain(
            "revalidation",
        );
    });
});

describe("buildNextAppCRObject — spec.secrets.envMap", () => {
    it("maps envMap entries to {secretName, secretKey}, defaulting secretKey to the map key", () => {
        const cr = buildNextAppCRObject(
            baseConfig({
                secrets: {
                    envMap: {
                        API_KEY: { name: "api-secret" },
                        DB_PASS: { name: "db-secret", key: "password" },
                    },
                },
            }),
            IMG,
            "ns",
        );
        const secrets = (cr.spec as Record<string, unknown>).secrets as {
            envMap: Record<string, { secretName: string; secretKey: string }>;
        };
        expect(secrets.envMap).toEqual({
            API_KEY: { secretName: "api-secret", secretKey: "API_KEY" },
            DB_PASS: { secretName: "db-secret", secretKey: "password" },
        });
    });

    it("omits envMap when secrets is set but envMap is absent", () => {
        const cr = buildNextAppCRObject(
            baseConfig({ secrets: { envFrom: ["shared-secret"] } }),
            IMG,
            "ns",
        );
        const secrets = (cr.spec as Record<string, unknown>).secrets as {
            envFrom?: string[];
            envMap?: unknown;
        };
        expect(secrets.envFrom).toEqual(["shared-secret"]);
        expect(secrets.envMap).toBeUndefined();
    });
});

describe("buildNextAppCRObject — spec.preview", () => {
    it("emits preview {enabled:true, prId, branch} when preview input is given", () => {
        const cr = buildNextAppCRObject(baseConfig(), IMG, "ns", undefined, {
            prId: "42",
            branch: "feat/thing",
        });
        expect((cr.spec as Record<string, unknown>).preview).toEqual({
            enabled: true,
            prId: "42",
            branch: "feat/thing",
        });
    });

    it("omits preview entirely on a non-preview deploy", () => {
        const cr = buildNextAppCRObject(baseConfig(), IMG, "ns");
        expect(Object.keys(cr.spec as Record<string, unknown>)).not.toContain(
            "preview",
        );
    });
});

describe("validateTaggedRef — full rejection message", () => {
    it("names the offending ref and the allowed-character set in the thrown message", () => {
        let thrown: Error | undefined;
        try {
            validateTaggedRef("bad ref;rm -rf");
        } catch (e) {
            thrown = e as Error;
        }
        expect(thrown?.message).toContain("bad ref;rm -rf");
        expect(thrown?.message).toContain(
            "Only [A-Za-z0-9._:/@-] are allowed.",
        );
        expect(thrown?.message).toContain("Shell metacharacters");
    });
});

describe("validateCRImageRef — full rejection message", () => {
    it("names the offending ref and points at resolveDigest() in the thrown message", () => {
        let thrown: Error | undefined;
        try {
            validateCRImageRef("registry/app:latest");
        } catch (e) {
            thrown = e as Error;
        }
        expect(thrown?.message).toContain("registry/app:latest");
        expect(thrown?.message).toContain(
            "The operator requires a ref containing @sha256:",
        );
        expect(thrown?.message).toContain("resolveDigest()");
    });
});

describe("resolveDigest — docker-inspect fallback failure message", () => {
    it("names the taggedRef and the raw docker-inspect output in the thrown message", async () => {
        const execSpy = async () => "<no value>";
        let thrown: Error | undefined;
        try {
            await resolveDigest("registry/app:untagged", execSpy);
        } catch (e) {
            thrown = e as Error;
        }
        expect(thrown?.message).toContain("registry/app:untagged");
        expect(thrown?.message).toContain(
            'docker inspect returned: "<no value>"',
        );
        expect(thrown?.message).toContain(
            "Ensure the image was pushed before calling resolveDigest().",
        );
    });
});
