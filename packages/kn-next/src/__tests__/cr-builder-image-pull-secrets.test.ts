import { describe, expect, it } from "bun:test";
import { buildNextAppCRObject, renderNextAppCR } from "../cli/cr-builder";
import type { KnativeNextConfig } from "../config";

/**
 * #794/#952 — private-registry pull secrets.
 *
 * `kn-next.config.ts` may declare `imagePullSecrets: ["ocir-secret"]` — a list
 * of Secret NAMES in the app's namespace. The CR builder maps them to the CRD's
 * `spec.imagePullSecrets`, which takes core `LocalObjectReference` objects
 * (`[{ name }]`), so the operator can write them onto `<app>-sa` and the app's
 * pods pull a private image instead of ImagePullBackOff.
 */

const IMG = "registry/app:tag@sha256:deadbeef";

function baseConfig(imagePullSecrets?: string[]): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: {
            provider: "gcs",
            bucket: "bucket",
            publicUrl: "https://storage.googleapis.com/bucket",
        },
        ...(imagePullSecrets ? { imagePullSecrets } : {}),
    };
}

describe("cr-builder spec.imagePullSecrets (#794/#952)", () => {
    it("maps config.imagePullSecrets (names) to spec.imagePullSecrets ([{name}])", () => {
        const cr = buildNextAppCRObject(
            baseConfig(["ocir-secret"]),
            IMG,
            "default",
        );
        const spec = cr.spec as Record<string, unknown>;
        expect(spec.imagePullSecrets).toEqual([{ name: "ocir-secret" }]);
    });

    it("preserves order for multiple secrets", () => {
        const cr = buildNextAppCRObject(
            baseConfig(["ocir-secret", "gcr-secret"]),
            IMG,
            "default",
        );
        const spec = cr.spec as Record<string, unknown>;
        expect(spec.imagePullSecrets).toEqual([
            { name: "ocir-secret" },
            { name: "gcr-secret" },
        ]);
    });

    it("omits spec.imagePullSecrets when config.imagePullSecrets is absent", () => {
        const cr = buildNextAppCRObject(baseConfig(), IMG, "default");
        const spec = cr.spec as Record<string, unknown>;
        expect(spec).not.toHaveProperty("imagePullSecrets");
    });

    it("omits spec.imagePullSecrets when the list is empty (no empty wire field)", () => {
        const cr = buildNextAppCRObject(baseConfig([]), IMG, "default");
        const spec = cr.spec as Record<string, unknown>;
        expect(spec).not.toHaveProperty("imagePullSecrets");
    });

    it("renders imagePullSecrets in the YAML output", () => {
        const yaml = renderNextAppCR(
            baseConfig(["ocir-secret"]),
            IMG,
            "default",
        );
        expect(yaml).toContain("imagePullSecrets");
        expect(yaml).toContain("ocir-secret");
    });
});
