/**
 * Issue #91: per-PR ephemeral preview environments.
 *
 * The CLI must be able to emit a NextApp CR whose `spec.preview` block is set so
 * the operator applies preview overrides (max-scale=1, min-scale=0, 30s retention,
 * environment/pr-id labels). A preview CR carries the caller-supplied preview name
 * (`<app>-pr-<n>`) as `metadata.name` so its asset prefix / ksvc URL / finalizer
 * are all isolated by name from prod.
 *
 * ADR-0013: a preview is EPHEMERAL — shares nothing stateful with prod. Name-derived
 * isolation is automatic; the CR just has to switch the operator into preview mode.
 */

import { describe, expect, it } from "bun:test";
import { buildNextAppCRObject } from "../cli/cr-builder";
import type { KnativeNextConfig } from "../config";

const baseConfig: KnativeNextConfig = {
    name: "my-app-pr-42",
    registry: "registry.example.com",
    storage: {
        provider: "gcs",
        bucket: "b",
        publicUrl: "https://example.com",
    },
};

const image =
    "registry.example.com/my-app-pr-42:123@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1";

describe("buildNextAppCRObject — preview block (#91)", () => {
    it("omits spec.preview entirely when no preview arg is given (back-compat)", () => {
        const cr = buildNextAppCRObject(baseConfig, image, "default");
        const spec = cr.spec as Record<string, unknown>;
        expect(spec.preview).toBeUndefined();
    });

    it("spreads spec.preview = {enabled, prId, branch} when a preview arg is given", () => {
        const cr = buildNextAppCRObject(
            baseConfig,
            image,
            "previews",
            undefined,
            {
                prId: "42",
                branch: "feat/x",
            },
        );
        const spec = cr.spec as Record<string, unknown>;
        expect(spec.preview).toEqual({
            enabled: true,
            prId: "42",
            branch: "feat/x",
        });
    });

    it("uses the caller-supplied preview name as metadata.name (name-derived isolation)", () => {
        const cr = buildNextAppCRObject(
            baseConfig,
            image,
            "previews",
            undefined,
            {
                prId: "42",
                branch: "feat/x",
            },
        );
        const metadata = cr.metadata as Record<string, unknown>;
        expect(metadata.name).toBe("my-app-pr-42");
        expect(metadata.namespace).toBe("previews");
    });

    it("does NOT emit spec.traffic on a preview CR (single revision, max-scale=1)", () => {
        const cr = buildNextAppCRObject(
            baseConfig,
            image,
            "previews",
            undefined,
            {
                prId: "42",
                branch: "feat/x",
            },
        );
        const spec = cr.spec as Record<string, unknown>;
        expect(spec.traffic).toBeUndefined();
    });

    it("still carries the buildId when given alongside a preview block (#93 lock-step)", () => {
        const cr = buildNextAppCRObject(baseConfig, image, "previews", "123", {
            prId: "42",
            branch: "feat/x",
        });
        const spec = cr.spec as Record<string, unknown>;
        expect(spec.buildId).toBe("123");
        expect(spec.preview).toEqual({
            enabled: true,
            prId: "42",
            branch: "feat/x",
        });
    });
});
