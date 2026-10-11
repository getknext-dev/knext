import { describe, expect, it } from "bun:test";
import { buildNextAppCRObject, renderNextAppCR } from "../cli/cr-builder";
import type { KnativeNextConfig } from "../config";

/**
 * networking.publicHosts -> spec.networking.publicHosts. The operator renders
 * it as the KNEXT_PUBLIC_ORIGINS allowlist; the builder only carries it.
 */

const IMG = "registry/app:tag@sha256:deadbeef";

function config(networking?: Record<string, unknown>): KnativeNextConfig {
    return {
        name: "app",
        registry: "registry",
        storage: {
            provider: "gcs",
            bucket: "bucket",
            publicUrl: "https://storage.googleapis.com/bucket",
        },
        ...(networking ? { networking } : {}),
    } as KnativeNextConfig;
}

function specOf(c: KnativeNextConfig): Record<string, unknown> {
    return buildNextAppCRObject(c, IMG, "default").spec as Record<
        string,
        unknown
    >;
}

describe("cr-builder spec.networking.publicHosts", () => {
    it("emits publicHosts verbatim, in order, under spec.networking", () => {
        const spec = specOf(
            config({ publicHosts: ["www.example.com", "app.example.org"] }),
        );
        expect(spec.networking).toEqual({
            publicHosts: ["www.example.com", "app.example.org"],
        });
    });

    it("emits publicHosts alongside a cluster-local visibility", () => {
        const spec = specOf(
            config({
                visibility: "cluster-local",
                publicHosts: ["www.example.com"],
            }),
        );
        expect(spec.networking).toEqual({
            visibility: "cluster-local",
            publicHosts: ["www.example.com"],
        });
    });

    it("omits spec.networking entirely for an empty publicHosts list (zero-diff default)", () => {
        expect(specOf(config({ publicHosts: [] }))).not.toHaveProperty(
            "networking",
        );
    });

    it("omits spec.networking entirely when networking is unset", () => {
        expect(specOf(config())).not.toHaveProperty("networking");
    });

    it("does not leak an empty publicHosts next to a visibility-only networking block", () => {
        const spec = specOf(
            config({ visibility: "cluster-local", publicHosts: [] }),
        );
        expect(spec.networking).toEqual({ visibility: "cluster-local" });
    });

    it("renders the hosts in the YAML output", () => {
        const yaml = renderNextAppCR(
            config({ publicHosts: ["www.example.com"] }),
            IMG,
            "default",
        );
        expect(yaml).toContain("publicHosts");
        expect(yaml).toContain("www.example.com");
    });
});
