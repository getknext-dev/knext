import { describe, expect, it } from "vitest";
import { buildNextAppCRObject } from "../cli/cr-builder";
import type { KnativeNextConfig } from "../config";

/**
 * #417 — Phase 2-B1: surface the NextApp CRD's `spec.database` binding
 * (DatabaseSpec/DatabaseSecretRef, ADR-0019) in `kn-next.config.ts` →
 * `spec.database`.
 *
 * Round-trip contract (issue acceptance criteria):
 *  - a config with `database.secretRef` (+ optional `roSecretRef`) produces
 *    a NextApp CR whose `spec.database` carries the correct shape.
 *  - a config with no `database` block produces a CR with `spec.database`
 *    ABSENT (back-compat) — not present-as-undefined/null.
 */

const IMG = "registry/app:tag@sha256:deadbeef";

function baseConfig(
    database?: KnativeNextConfig["database"],
): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: {
            provider: "gcs",
            bucket: "b",
            publicUrl: "https://example.com",
        },
        database,
    };
}

function specOf(config: KnativeNextConfig) {
    return buildNextAppCRObject(config, IMG, "ns").spec as Record<
        string,
        unknown
    >;
}

describe("buildNextAppCRObject — database binding (#417)", () => {
    it("omits spec.database when config.database is unset (back-compat)", () => {
        const spec = specOf(baseConfig(undefined));
        expect(spec.database).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(spec, "database")).toBe(
            false,
        );
    });

    it("maps a bare secretRef into spec.database.secretRef (key defaults omitted)", () => {
        const spec = specOf(
            baseConfig({ secretRef: { name: "storefront-db" } }),
        );
        expect(spec.database).toEqual({
            secretRef: { name: "storefront-db" },
        });
    });

    it("maps secretRef with an explicit key", () => {
        const spec = specOf(
            baseConfig({
                secretRef: { name: "storefront-db", key: "DSN" },
            }),
        );
        expect(spec.database).toEqual({
            secretRef: { name: "storefront-db", key: "DSN" },
        });
    });

    it("maps secretRef + roSecretRef together (one-Secret-both-keys pattern)", () => {
        const spec = specOf(
            baseConfig({
                secretRef: { name: "storefront-db" },
                roSecretRef: { name: "storefront-db" },
            }),
        );
        expect(spec.database).toEqual({
            secretRef: { name: "storefront-db" },
            roSecretRef: { name: "storefront-db" },
        });
    });

    it("maps roSecretRef with an explicit key alongside secretRef", () => {
        const spec = specOf(
            baseConfig({
                secretRef: { name: "storefront-db" },
                roSecretRef: { name: "storefront-db-ro", key: "DSN_RO" },
            }),
        );
        expect(spec.database).toEqual({
            secretRef: { name: "storefront-db" },
            roSecretRef: { name: "storefront-db-ro", key: "DSN_RO" },
        });
    });

    it("does not leak database credentials — only name/key references are emitted", () => {
        const spec = specOf(
            baseConfig({ secretRef: { name: "storefront-db" } }),
        );
        const yaml = JSON.stringify(spec.database);
        expect(yaml).not.toMatch(/postgres(ql)?:\/\//);
    });
});
