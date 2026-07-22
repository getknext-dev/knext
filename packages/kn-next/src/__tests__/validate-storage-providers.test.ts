import { describe, expect, it } from "vitest";
import {
    ConfigValidationError,
    SUPPORTED_STORAGE_PROVIDERS,
    validateConfig,
} from "../cli/validate";
import type { KnativeNextConfig, StorageProvider } from "../config";

/**
 * #474 — reconcile the storage-provider surfaces.
 *
 * `StorageProvider` (config.ts), `SUPPORTED_STORAGE_PROVIDERS` (validate.ts), and
 * the `uploadAssets` switch (asset-upload.ts) must name the SAME set. Azure was a
 * first-class type with a fully-coded + tested upload path, yet validate rejected
 * it — three surfaces disagreeing. Azure (AKS) is in knext's marketed multi-cloud
 * matrix, so it is PROMOTED to a supported provider (not trimmed). These tests
 * pin the supported set and guard against drift.
 */
describe("validateConfig storage providers", () => {
    function baseConfig(provider: StorageProvider): KnativeNextConfig {
        return {
            name: "shop",
            registry: "us-docker.pkg.dev/p/r",
            storage: {
                provider,
                bucket: "b",
                publicUrl: "https://example.test/b",
            },
        } as KnativeNextConfig;
    }

    it("supports the four multi-cloud providers (gcs, s3, minio, azure)", () => {
        expect([...SUPPORTED_STORAGE_PROVIDERS].sort()).toEqual(
            ["azure", "gcs", "minio", "s3"].sort(),
        );
    });

    it.each([
        ...SUPPORTED_STORAGE_PROVIDERS,
    ])("accepts the supported provider '%s'", (provider) => {
        expect(() => validateConfig(baseConfig(provider))).not.toThrow();
    });

    it("accepts azure specifically (promoted, not trimmed)", () => {
        expect(() => validateConfig(baseConfig("azure"))).not.toThrow(
            ConfigValidationError,
        );
    });

    it("rejects an unknown storage provider and lists the supported set", () => {
        // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid provider.
        const cfg = baseConfig("wasabi" as any);
        expect(() => validateConfig(cfg)).toThrow(ConfigValidationError);
        expect(() => validateConfig(cfg)).toThrow(/wasabi/i);
        expect(() => validateConfig(cfg)).toThrow(/azure/i);
    });
});
