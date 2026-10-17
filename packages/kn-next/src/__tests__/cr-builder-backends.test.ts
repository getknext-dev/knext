import { describe, expect, it } from "bun:test";
import YAML from "yaml";
import { buildNextAppCRObject, renderNextAppCR } from "../cli/cr-builder";
import type { KnativeNextConfig } from "../config";

/**
 * backends -> spec.backends: the zone's half of a function binding. The
 * operator renders <NAME>_SERVICE_URL and friends into the Knative Service
 * from it and never writes it back, so the builder only carries the list.
 */

const IMG = "registry/app:tag@sha256:deadbeef";

function config(backends?: unknown): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: {
            provider: "gcs",
            bucket: "bucket",
            publicUrl: "https://storage.googleapis.com/bucket",
        },
        ...(backends === undefined ? {} : { backends }),
    } as KnativeNextConfig;
}

function specOf(
    c: KnativeNextConfig,
    preview?: { prId: string; branch: string },
): Record<string, unknown> {
    return buildNextAppCRObject(c, IMG, "default", undefined, preview)
        .spec as Record<string, unknown>;
}

describe("cr-builder spec.backends", () => {
    it("a configured function lands in the NextApp as {name, service}", () => {
        const spec = specOf(
            config([{ name: "user-profile", service: "user-profile" }]),
        );
        expect(spec.backends).toEqual([
            { name: "user-profile", service: "user-profile" },
        ]);
    });

    it("service defaults to the name (a function's object is named after it)", () => {
        const spec = specOf(config([{ name: "pricing" }]));
        expect(spec.backends).toEqual([
            { name: "pricing", service: "pricing" },
        ]);
    });

    it("keeps a service that differs from the binding name, and keeps config order", () => {
        const spec = specOf(
            config([
                { name: "zeta", service: "zeta-fn" },
                { name: "alpha", service: "alpha" },
            ]),
        );
        expect(spec.backends).toEqual([
            { name: "zeta", service: "zeta-fn" },
            { name: "alpha", service: "alpha" },
        ]);
    });

    it("carries the zone's image pin into the NextApp, and only when set", () => {
        const pin = `@sha256:${"ab12".repeat(16)}`;
        const spec = specOf(
            config([{ name: "pricing", image: pin }, { name: "search" }]),
        );
        expect(spec.backends).toEqual([
            { name: "pricing", service: "pricing", image: pin },
            { name: "search", service: "search" },
        ]);
        // An unpinned entry carries no `image` key at all, so a CR written
        // without pins is byte-identical to every CR written before the field.
        expect("image" in (spec.backends as object[])[1]).toBe(false);
    });

    it("carries the zone's spec pin into the NextApp, and only when set", () => {
        const specDigest = `sha256:${"cd34".repeat(16)}`;
        const spec = specOf(
            config([{ name: "pricing", specDigest }, { name: "search" }]),
        );
        expect(spec.backends).toEqual([
            { name: "pricing", service: "pricing", specDigest },
            { name: "search", service: "search" },
        ]);
        expect("specDigest" in (spec.backends as object[])[1]).toBe(false);
    });

    it("carries both pins when both are set", () => {
        const image = `@sha256:${"ab12".repeat(16)}`;
        const specDigest = `sha256:${"cd34".repeat(16)}`;
        const yaml = renderNextAppCR(
            config([{ name: "pricing", image, specDigest }]),
            IMG,
            "default",
        );
        const parsed = YAML.parse(yaml) as {
            spec: { backends: { image?: string; specDigest?: string }[] };
        };
        expect(parsed.spec.backends[0]?.image).toBe(image);
        expect(parsed.spec.backends[0]?.specDigest).toBe(specDigest);
    });

    it("the rendered YAML carries the pin the apply will send", () => {
        const pin = `@sha256:${"ab12".repeat(16)}`;
        const yaml = renderNextAppCR(
            config([{ name: "pricing", image: pin }]),
            IMG,
            "default",
        );
        const parsed = YAML.parse(yaml) as {
            spec: { backends: { image?: string }[] };
        };
        expect(parsed.spec.backends[0]?.image).toBe(pin);
    });

    it("a config without pins renders a CR byte-identical to one that never knew the field", () => {
        const plain = renderNextAppCR(
            config([{ name: "pricing" }]),
            IMG,
            "default",
        );
        expect(plain).not.toContain("image: @sha256");
        expect(plain).toContain("service: pricing");
    });

    it("emits no field at all when backends is absent (old operators see an unchanged CR)", () => {
        const spec = specOf(config());
        expect("backends" in spec).toBe(false);
    });

    it("emits no field for an empty list", () => {
        const spec = specOf(config([]));
        expect("backends" in spec).toBe(false);
        expect(renderNextAppCR(config([]), IMG, "default")).not.toContain(
            "backends",
        );
    });

    it("the rendered YAML round-trips the list the apply will send", () => {
        const yaml = renderNextAppCR(
            config([{ name: "user-profile" }]),
            IMG,
            "default",
        );
        const parsed = YAML.parse(yaml) as {
            spec: { backends: unknown };
        };
        expect(parsed.spec.backends).toEqual([
            { name: "user-profile", service: "user-profile" },
        ]);
    });

    it("never copies keys the config did not define into the CR", () => {
        const spec = specOf(
            config([{ name: "pricing", service: "pricing", extra: "x" }]),
        );
        expect(spec.backends).toEqual([
            { name: "pricing", service: "pricing" },
        ]);
    });

    it("a preview does not carry the base app's bindings (a function names one zone)", () => {
        const spec = specOf(config([{ name: "pricing" }]), {
            prId: "42",
            branch: "feat/x",
        });
        expect("backends" in spec).toBe(false);
    });

    it("does not touch the function half: no BackendService, ownerReferences or env", () => {
        const cr = buildNextAppCRObject(
            config([{ name: "pricing" }]),
            IMG,
            "default",
        );
        expect(cr.kind).toBe("NextApp");
        const text = JSON.stringify(cr);
        expect(text).not.toContain("ownerReferences");
        expect(text).not.toContain("_SERVICE_URL");
    });
});
