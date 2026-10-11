import { describe, expect, it } from "bun:test";
import { ConfigValidationError, validateConfig } from "../cli/validate";
import type { KnativeNextConfig } from "../config";

/**
 * networking.publicHosts is validated locally with the same shape the CRD's
 * CEL rule enforces, so a typo is a fast config error rather than a
 * cluster-side admission rejection after the image is already built.
 */

function configWith(publicHosts: unknown): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: { provider: "gcs", bucket: "bucket" },
        networking: { publicHosts },
    } as unknown as KnativeNextConfig;
}

describe("validateConfig networking.publicHosts", () => {
    it("accepts plain lowercase DNS hostnames", () => {
        expect(() =>
            validateConfig(configWith(["www.example.com", "localhost"])),
        ).not.toThrow();
    });

    it("accepts an empty list", () => {
        expect(() => validateConfig(configWith([]))).not.toThrow();
    });

    it("rejects a non-array value", () => {
        expect(() => validateConfig(configWith("www.example.com"))).toThrow(
            /networking\.publicHosts/,
        );
    });

    it.each([
        ["a scheme", "https://example.com"],
        ["a path", "example.com/x"],
        ["a port", "example.com:8080"],
        ["userinfo", "user@example.com"],
        ["a wildcard", "*.example.com"],
        ["whitespace", "exa mple.com"],
        ["an empty string", ""],
        ["a comma", "a.example.com,b.example.com"],
        ["uppercase", "WWW.example.com"],
        ["a label ending in a hyphen", "example-.com"],
        ["the wildcard bind address", "0.0.0.0"],
        ["a non-string entry", 42],
    ])("rejects an entry with %s", (_name, entry) => {
        expect(() => validateConfig(configWith([entry]))).toThrow(
            ConfigValidationError,
        );
        expect(() => validateConfig(configWith([entry]))).toThrow(
            /networking\.publicHosts/,
        );
    });

    it("rejects more than 32 entries (the CRD maxItems)", () => {
        const hosts = Array.from({ length: 33 }, (_, i) => `h${i}.example.com`);
        expect(() => validateConfig(configWith(hosts))).toThrow(
            /networking\.publicHosts/,
        );
    });
});
