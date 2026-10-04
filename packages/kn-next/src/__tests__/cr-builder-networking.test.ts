import { describe, expect, it } from "bun:test";
import { buildNextAppCRObject, renderNextAppCR } from "../cli/cr-builder";
import type { KnativeNextConfig } from "../config";

/**
 * #1865 — spec.networking.visibility. The platform way to keep an app's
 * Knative Route off the external gateway when it has mutating endpoints and
 * no auth of its own.
 */

const IMG = "registry/app:tag@sha256:deadbeef";

function baseConfig(visibility?: string): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: {
            provider: "gcs",
            bucket: "bucket",
            publicUrl: "https://storage.googleapis.com/bucket",
        },
        ...(visibility !== undefined ? { networking: { visibility } } : {}),
    } as KnativeNextConfig;
}

describe("cr-builder spec.networking (#1865)", () => {
    it("omits spec.networking entirely when config.networking is unset (zero-diff default)", () => {
        const cr = buildNextAppCRObject(baseConfig(), IMG, "default");
        const spec = cr.spec as Record<string, unknown>;
        expect(spec).not.toHaveProperty("networking");
    });

    it('omits spec.networking when visibility is explicitly "public"', () => {
        const cr = buildNextAppCRObject(baseConfig("public"), IMG, "default");
        const spec = cr.spec as Record<string, unknown>;
        expect(spec).not.toHaveProperty("networking");
    });

    it('emits spec.networking.visibility "cluster-local" verbatim when configured', () => {
        const cr = buildNextAppCRObject(
            baseConfig("cluster-local"),
            IMG,
            "default",
        );
        const spec = cr.spec as Record<string, unknown>;
        expect(spec.networking).toEqual({ visibility: "cluster-local" });
    });

    it("renders networking/cluster-local in the YAML output when set", () => {
        const yaml = renderNextAppCR(
            baseConfig("cluster-local"),
            IMG,
            "default",
        );
        expect(yaml).toContain("networking");
        expect(yaml).toContain("cluster-local");
    });

    it("does not render a networking key in the YAML output when unset", () => {
        const yaml = renderNextAppCR(baseConfig(), IMG, "default");
        expect(yaml).not.toContain("networking");
    });
});
