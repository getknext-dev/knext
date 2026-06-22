/**
 * Issue #91: per-PR ephemeral preview environments — CLI surface.
 *
 * `preview deploy --pr <n> --branch <ref>` builds + pushes a digest-pinned image,
 * renders a NextApp CR WITH the preview block under the derived name
 * `<app>-pr-<n>`, applies it, and reads back status.url.
 *
 * `preview destroy --pr <n>` deletes ONLY the NextApp CR `<app>-pr-<n>`
 * (--ignore-not-found); the operator's finalizer reaps the name-scoped assets.
 *
 * ADR-0001: the CLI emits INTENT — it writes ONLY the `nextapp` resource, never
 * ksvc / Route / kn directly.
 */

import { describe, expect, it, vi } from "vitest";
import {
    derivePreviewName,
    runPreviewDeploy,
    runPreviewDestroy,
    validatePreviewName,
} from "../cli/preview";
import type { KnativeNextConfig } from "../config";

const baseConfig: KnativeNextConfig = {
    name: "my-app",
    registry: "registry.example.com",
    storage: {
        provider: "gcs",
        bucket: "b",
        publicUrl: "https://example.com",
    },
};

const digestImage =
    "registry.example.com/my-app-pr-42:123@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1";

describe("derivePreviewName (#91)", () => {
    it("derives <app>-pr-<n>", () => {
        expect(derivePreviewName("my-app", "42")).toBe("my-app-pr-42");
    });
});

describe("validatePreviewName (#91)", () => {
    it("accepts a normal DNS-1123 name", () => {
        expect(() => validatePreviewName("my-app-pr-42")).not.toThrow();
    });

    it("rejects names longer than 63 chars (guards long app names)", () => {
        const long = `${"a".repeat(60)}-pr-42`;
        expect(() => validatePreviewName(long)).toThrow(/63/);
    });

    it("rejects non-DNS-1123 names (uppercase / underscores)", () => {
        expect(() => validatePreviewName("My_App-pr-1")).toThrow(/DNS-1123/);
    });
});

describe("runPreviewDeploy (#91)", () => {
    it("applies a NextApp CR named <app>-pr-<n> carrying spec.preview, then reads status.url", async () => {
        const apply = vi.fn((_argv: readonly string[]) => {});
        const capture = vi.fn(
            (_argv: readonly string[]) =>
                "https://my-app-pr-42.previews.example.com",
        );
        const buildAndPush = vi.fn(async (_name: string) => digestImage);

        const url = await runPreviewDeploy(
            baseConfig,
            { prId: "42", branch: "feat/x", namespace: "previews" },
            { apply, capture, buildAndPush },
        );

        expect(url).toBe("https://my-app-pr-42.previews.example.com");

        // Exactly one apply, of a CR file, in the previews namespace.
        expect(apply).toHaveBeenCalledTimes(1);
        const applyArgv = apply.mock.calls[0][0] as string[];
        expect(applyArgv[0]).toBe("kubectl");
        expect(applyArgv[1]).toBe("apply");
        expect(applyArgv).toContain("-n");
        expect(applyArgv[applyArgv.indexOf("-n") + 1]).toBe("previews");

        // The rendered CR (passed to buildAndPush/apply) targets the preview name.
        const renderedName = buildAndPush.mock.calls[0][0] as string;
        expect(renderedName).toBe("my-app-pr-42");

        // status.url read-back targets the preview nextapp.
        const captureArgv = capture.mock.calls.at(-1)?.[0] as string[];
        expect(captureArgv[0]).toBe("kubectl");
        expect(captureArgv).toContain("nextapp");
        expect(captureArgv).toContain("my-app-pr-42");
        expect(captureArgv.join(" ")).toContain("status.url");
    });

    it("NEGATIVE (data sovereignty / destroy-safety): name-scopes the Redis keyPrefix so a preview neither shares nor reaps prod's cache keyspace", async () => {
        // A prod config with a Redis cache + a prod keyPrefix. If the preview
        // copied this verbatim, (1) it would read/write/poison prod's ISR cache,
        // and (2) `preview destroy` -> finalizer CleanupCache would flush
        // `prod:*`, wiping prod's Redis. The preview MUST get its own
        // `<app>-pr-<n>` keyPrefix.
        const prodConfig: KnativeNextConfig = {
            ...baseConfig,
            cache: {
                provider: "redis",
                url: "redis://prod:6379",
                keyPrefix: "prod",
            },
        };

        const apply = vi.fn((_argv: readonly string[]) => {});
        const capture = vi.fn((_argv: readonly string[]) => "https://x");
        const buildAndPush = vi.fn(
            async (
                _name: string,
                _config: KnativeNextConfig,
                _branch: string,
            ) => digestImage,
        );

        await runPreviewDeploy(
            prodConfig,
            { prId: "42", branch: "feat/x", namespace: "previews" },
            { apply, capture, buildAndPush },
        );

        // The config handed to the build/render step must carry the preview's OWN
        // name-derived keyPrefix — never prod's.
        const previewConfig = buildAndPush.mock
            .calls[0][1] as KnativeNextConfig;
        expect(previewConfig.cache?.provider).toBe("redis");
        const cache = previewConfig.cache as Extract<
            KnativeNextConfig["cache"],
            { provider: "redis" }
        >;
        expect(cache.keyPrefix).toBe("my-app-pr-42");
        expect(cache.keyPrefix).not.toBe("prod");
        // The rest of the cache config (url) is preserved.
        expect(cache.url).toBe("redis://prod:6379");
    });

    it("leaves cache undefined when prod has no cache configured (no spurious cache block)", async () => {
        const apply = vi.fn((_argv: readonly string[]) => {});
        const capture = vi.fn((_argv: readonly string[]) => "https://x");
        const buildAndPush = vi.fn(
            async (
                _name: string,
                _config: KnativeNextConfig,
                _branch: string,
            ) => digestImage,
        );

        await runPreviewDeploy(
            baseConfig,
            { prId: "42", branch: "feat/x", namespace: "previews" },
            { apply, capture, buildAndPush },
        );

        const previewConfig = buildAndPush.mock
            .calls[0][1] as KnativeNextConfig;
        expect(previewConfig.cache).toBeUndefined();
    });

    it("NEGATIVE (ADR-0001): writes ONLY nextapp — never ksvc/route/kn/service", async () => {
        const apply = vi.fn((_argv: readonly string[]) => {});
        const capture = vi.fn((_argv: readonly string[]) => "https://x");
        const buildAndPush = vi.fn(async (_name: string) => digestImage);

        await runPreviewDeploy(
            baseConfig,
            { prId: "42", branch: "feat/x", namespace: "previews" },
            { apply, capture, buildAndPush },
        );

        const forbidden = [
            "ksvc",
            "service",
            "services",
            "route",
            "routes",
            "kn",
            "knative",
            "svc",
        ];
        // The only write is `kubectl apply` of a file; reads target nextapp only.
        for (const call of [...apply.mock.calls, ...capture.mock.calls]) {
            const argv = call[0] as string[];
            for (const tok of argv) {
                expect(forbidden).not.toContain(tok);
            }
        }
    });

    it("validates the derived name before any cluster write (long app name aborts)", async () => {
        const apply = vi.fn((_argv: readonly string[]) => {});
        const capture = vi.fn((_argv: readonly string[]) => "");
        const buildAndPush = vi.fn(async (_name: string) => digestImage);
        const longConfig: KnativeNextConfig = {
            ...baseConfig,
            name: "a".repeat(60),
        };

        await expect(
            runPreviewDeploy(
                longConfig,
                { prId: "42", branch: "feat/x", namespace: "previews" },
                { apply, capture, buildAndPush },
            ),
        ).rejects.toThrow(/63/);

        expect(apply).not.toHaveBeenCalled();
        expect(buildAndPush).not.toHaveBeenCalled();
    });
});

describe("runPreviewDestroy (#91)", () => {
    it("deletes ONLY the nextapp <app>-pr-<n> with --ignore-not-found", () => {
        const del = vi.fn((_argv: readonly string[]) => {});
        runPreviewDestroy(
            baseConfig,
            { prId: "42", namespace: "previews" },
            del,
        );

        expect(del).toHaveBeenCalledTimes(1);
        const argv = del.mock.calls[0][0] as string[];
        expect(argv[0]).toBe("kubectl");
        expect(argv[1]).toBe("delete");
        expect(argv[2]).toBe("nextapp");
        expect(argv).toContain("my-app-pr-42");
        expect(argv).toContain("--ignore-not-found");
        expect(argv[argv.indexOf("-n") + 1]).toBe("previews");
    });

    it("NEGATIVE (ADR-0001): destroy targets only the nextapp kind", () => {
        const del = vi.fn((_argv: readonly string[]) => {});
        runPreviewDestroy(
            baseConfig,
            { prId: "42", namespace: "previews" },
            del,
        );
        const argv = del.mock.calls[0][0] as string[];
        expect(argv[2]).toBe("nextapp");
        const forbidden = ["ksvc", "service", "route", "kn", "knative", "svc"];
        for (const tok of argv) {
            expect(forbidden).not.toContain(tok);
        }
    });
});
