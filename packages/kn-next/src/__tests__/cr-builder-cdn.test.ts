import { describe, expect, it } from "bun:test";
import { buildNextAppCRObject, renderNextAppCR } from "../cli/cr-builder";
import type { KnativeNextConfig } from "../config";

/**
 * cdn -> spec.cdn (ADR-0068 D3). The builder only carries the typed block; the
 * operator renders the KNEXT_CDN_* env and derives the tag prefix. The CLI never
 * writes a prefix, and the purge token is only ever a Secret REFERENCE.
 */

const IMG = "registry/app:tag@sha256:deadbeef";

function config(cdn?: unknown): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: {
            provider: "gcs",
            bucket: "bucket",
            publicUrl: "https://storage.googleapis.com/bucket",
        },
        ...(cdn ? { cdn } : {}),
    } as KnativeNextConfig;
}

function specOf(c: KnativeNextConfig): Record<string, unknown> {
    return buildNextAppCRObject(c, IMG, "default").spec as Record<
        string,
        unknown
    >;
}

describe("cr-builder spec.cdn", () => {
    it("carries every field verbatim under spec.cdn", () => {
        const spec = specOf(
            config({
                provider: "cloudflare",
                htmlTTLSeconds: 45,
                staleWhileRevalidateSeconds: 10,
                excludePaths: ["/account"],
                includePaths: ["/blog"],
                purge: {
                    secretRef: { name: "cdn-purge", key: "token" },
                    target: "0123456789abcdef0123456789abcdef",
                    requestsPerMinute: 20,
                },
            }),
        );
        expect(spec.cdn).toEqual({
            provider: "cloudflare",
            htmlTTLSeconds: 45,
            staleWhileRevalidateSeconds: 10,
            excludePaths: ["/account"],
            includePaths: ["/blog"],
            purge: {
                secretRef: { name: "cdn-purge", key: "token" },
                target: "0123456789abcdef0123456789abcdef",
                requestsPerMinute: 20,
            },
        });
    });

    it("emits only provider for a minimal block (the CRD supplies the defaults)", () => {
        expect(specOf(config({ provider: "cloudfront" })).cdn).toEqual({
            provider: "cloudfront",
        });
    });

    it("omits empty lists so a block never carries an empty field", () => {
        const cdn = specOf(
            config({
                provider: "cloudflare",
                excludePaths: [],
                includePaths: [],
            }),
        ).cdn;
        expect(cdn).toEqual({ provider: "cloudflare" });
    });

    it("carries the emulator endpoint", () => {
        const url = "http://cdn-emulator.e2e.svc.cluster.local:8080";
        expect(
            specOf(config({ provider: "emulator", emulatorEndpoint: url })).cdn,
        ).toEqual({ provider: "emulator", emulatorEndpoint: url });
    });

    it("omits spec.cdn entirely when unset (zero-diff default)", () => {
        expect(specOf(config())).not.toHaveProperty("cdn");
    });

    it("never writes a tag prefix: the operator derives it", () => {
        const yaml = renderNextAppCR(
            config({ provider: "cloudflare" }),
            IMG,
            "default",
        );
        expect(yaml).not.toMatch(/tagPrefix|KNEXT_CDN/i);
    });

    it("carries the purge token only as a reference, never a value", () => {
        const yaml = renderNextAppCR(
            config({
                provider: "cloudflare",
                purge: {
                    secretRef: { name: "cdn-purge", key: "token" },
                    target: "0123456789abcdef0123456789abcdef",
                },
            }),
            IMG,
            "default",
        );
        expect(yaml).toContain("secretRef");
        expect(yaml).toContain("cdn-purge");
        expect(yaml).not.toMatch(/token:\s*\S/); // `key: token` is a key NAME
    });
});
