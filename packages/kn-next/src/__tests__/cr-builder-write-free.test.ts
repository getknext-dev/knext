import { describe, expect, it } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { buildNextAppCRObject, type WriteFreeFacts } from "../cli/cr-builder";
import {
    crdSchemaFromCrdObject,
    flattenSchemaPaths,
    unknownEmittedFields,
} from "../cli/schema/crd-schema";
import { readImageCacheRouted } from "../cli/write-free";
import type { KnativeNextConfig } from "../config";

/**
 * `spec.security.writeFree` — the CLI tells the operator that the image it
 * just built writes nothing to local disk, so the operator can drop the last
 * shape-inferred emptyDir (each one costs pod-sandbox setup on every cold
 * wake). Emitted ONLY when the CLI built the image in this run AND the field
 * changes the operator's mount decision; every other CR stays byte-identical.
 */

const IMG = "registry/app:tag@sha256:deadbeef";
const NS = "default";
const STORAGE = {
    provider: "gcs" as const,
    bucket: "b",
    publicUrl: "https://example.com",
};

function cfg(overrides: Partial<KnativeNextConfig> = {}): KnativeNextConfig {
    return { name: "app", registry: "registry", ...overrides };
}

const specOf = (
    config: KnativeNextConfig,
    facts?: WriteFreeFacts,
): Record<string, unknown> =>
    (
        buildNextAppCRObject(config, IMG, NS, "b1", undefined, facts) as {
            spec: Record<string, unknown>;
        }
    ).spec;

const BUILT: WriteFreeFacts = { builtThisRun: true };
const BUILT_ROUTED: WriteFreeFacts = {
    builtThisRun: true,
    imageCacheRouted: true,
};

describe("spec.security.writeFree on the emitted CR", () => {
    it("emits nothing when no facts are passed (every existing caller stays byte-identical)", () => {
        expect(specOf(cfg({ build: "vinext" }))).not.toHaveProperty("security");
    });

    it("vinext disk-mode binary built this run: writeFree", () => {
        expect(specOf(cfg({ build: "vinext" }), BUILT).security).toEqual({
            writeFree: true,
        });
    });

    it("vinext SELF-CONTAINED binary (unpacks sharp into $TMPDIR): never writeFree", () => {
        expect(
            specOf(cfg({ build: "vinext", selfContained: true }), BUILT),
        ).not.toHaveProperty("security");
    });

    it("an image the CLI did not build (--image / --skip-build): never writeFree", () => {
        expect(
            specOf(cfg({ build: "vinext" }), { builtThisRun: false }),
        ).not.toHaveProperty("security");
    });

    it("standalone + storage with images routed through the knext cache handler: writeFree", () => {
        expect(
            specOf(cfg({ build: "turbopack", storage: STORAGE }), BUILT_ROUTED)
                .security,
        ).toEqual({ writeFree: true });
    });

    it("standalone + storage whose build still writes .next/cache/images: not writeFree", () => {
        expect(
            specOf(cfg({ build: "turbopack", storage: STORAGE }), {
                builtThisRun: true,
                imageCacheRouted: false,
            }),
        ).not.toHaveProperty("security");
    });

    it("standalone self-contained Bun executable (no native addons): writeFree", () => {
        expect(
            specOf(
                cfg({
                    build: "turbopack",
                    runtime: "bun",
                    selfContained: true,
                }),
                BUILT,
            ).security,
        ).toEqual({ writeFree: true });
    });

    it("default standalone with no storage: nothing to drop, CR stays byte-identical", () => {
        expect(specOf(cfg(), BUILT_ROUTED)).not.toHaveProperty("security");
        expect(
            specOf(cfg({ runtime: "node" }), BUILT_ROUTED),
        ).not.toHaveProperty("security");
    });

    it("the emitted field is known to the bundled CRD", () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const crdPath = join(
            here,
            "..",
            "..",
            "..",
            "..",
            "packages",
            "kn-next-operator",
            "config",
            "crd",
            "bases",
            "apps.kn-next.dev_nextapps.yaml",
        );
        const crd = YAML.parse(readFileSync(crdPath, "utf-8")) as Record<
            string,
            unknown
        >;
        const schema = crdSchemaFromCrdObject(crd, "v1alpha1");
        if (!schema) throw new Error("bundled CRD has no v1alpha1 schema");
        expect(
            unknownEmittedFields(
                ["spec.security.writeFree"],
                flattenSchemaPaths(schema),
            ),
        ).toEqual([]);
    });
});

describe("readImageCacheRouted (standalone build output)", () => {
    function app(files: Record<string, string>): string {
        const dir = mkdtempSync(join(tmpdir(), "knext-write-free-"));
        for (const [rel, body] of Object.entries(files)) {
            mkdirSync(dirname(join(dir, rel)), { recursive: true });
            writeFileSync(join(dir, rel), body);
        }
        return dir;
    }
    const rsf = (customCacheHandler: unknown) =>
        JSON.stringify({ config: { images: { customCacheHandler } } });

    it("true when THIS build (BUILD_ID == deploy tag) routes images through the cache handler", () => {
        const dir = app({
            ".next/BUILD_ID": "tag-1",
            ".next/required-server-files.json": rsf(true),
        });
        try {
            expect(readImageCacheRouted(dir, "tag-1")).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("false when the build writes images to disk", () => {
        const dir = app({
            ".next/BUILD_ID": "tag-1",
            ".next/required-server-files.json": rsf(false),
        });
        try {
            expect(readImageCacheRouted(dir, "tag-1")).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("false for a stale build output (BUILD_ID is not this deploy's tag)", () => {
        const dir = app({
            ".next/BUILD_ID": "older-tag",
            ".next/required-server-files.json": rsf(true),
        });
        try {
            expect(readImageCacheRouted(dir, "tag-1")).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("false (never throws) when the build output is missing or malformed", () => {
        const missing = app({});
        const bad = app({
            ".next/BUILD_ID": "tag-1",
            ".next/required-server-files.json": "{not json",
        });
        try {
            expect(readImageCacheRouted(missing, "tag-1")).toBe(false);
            expect(readImageCacheRouted(bad, "tag-1")).toBe(false);
        } finally {
            rmSync(missing, { recursive: true, force: true });
            rmSync(bad, { recursive: true, force: true });
        }
    });
});
