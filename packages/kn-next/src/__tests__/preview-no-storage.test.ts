/**
 * ADR-0047 — the PREVIEW path in the no-storage mode (review F1). A preview
 * builds, pushes, and applies a NextApp CR — it IS a deploy — so condition 1
 * binds it the same way it binds `kn-next deploy`. Pinned, mirroring
 * deploy-no-storage.test.ts:
 *
 *   - a storage-less preview COMPLETES (the CR still applies) but ANNOUNCES
 *     the image-served static mode at info — never a silent skip;
 *   - an inherited ASSET_PREFIX env var is CLEARED BEFORE buildAndPush runs,
 *     so preview's `next build` cannot bake bucket URLs into HTML that
 *     nothing uploads;
 *   - regression pins: with storage configured the notice is NOT printed and
 *     an inherited ASSET_PREFIX is left for the build step to overwrite.
 */

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    mock,
} from "bun:test";
import type { KnativeNextConfig } from "../config";

type AnyFn = (...args: unknown[]) => unknown;

// Capture the announcement: preview logs through createLogger().
const logInfo = mock<AnyFn>();
mock.module("../utils/logger", () => ({
    createLogger: () => ({
        info: (...a: unknown[]) => logInfo(...a),
        warn: mock(),
        error: mock(),
        debug: mock(),
        fatal: mock(),
        trace: mock(),
    }),
}));

// Imported DYNAMICALLY, after the `mock.module` calls above.
//
// A static import is hoisted and evaluated BEFORE any of them register, so
// `../cli/preview` binds the real `createLogger` and the mock never sees a
// call — the notice this file asserts on is emitted to a logger nobody is
// watching, and the failure reads as "the notice was not emitted".
const { runPreviewDeploy } = await import("../cli/preview");

const storagelessConfig: KnativeNextConfig = {
    name: "my-app",
    registry: "registry.example.com",
};

const storageBackedConfig: KnativeNextConfig = {
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

function infoMessages(): string[] {
    return logInfo.mock.calls.map((call) =>
        call
            .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
            .join(" "),
    );
}

function makeDeps() {
    return {
        apply: mock((_argv: readonly string[]) => {}),
        capture: mock(
            (_argv: readonly string[]) =>
                "https://my-app-pr-42.previews.example.com",
        ),
        buildAndPush: mock(async (_name: string) => digestImage),
        preflight: () => {},
    };
}

const savedEnv = { ...process.env };

beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ASSET_PREFIX;
});

afterEach(() => {
    process.env = { ...savedEnv };
});

describe("preview without storage (ADR-0047 condition 1 — review F1)", () => {
    it("still deploys, and announces the mode at info with the docs link", async () => {
        const deps = makeDeps();
        const url = await runPreviewDeploy(
            storagelessConfig,
            { prId: "42", branch: "feat/x", namespace: "previews" },
            deps,
        );

        expect(url).toBe("https://my-app-pr-42.previews.example.com");
        expect(deps.apply).toHaveBeenCalledTimes(1);

        const notice = infoMessages().find((m) =>
            /no object storage configured/i.test(m),
        );
        expect(notice).toBeDefined();
        expect(notice).toMatch(/served from the image/i);
        expect(notice).toMatch(/CDN/);
        expect(notice).toMatch(/retention/);
        expect(notice).toMatch(/skew/i);
        expect(notice).toMatch(/https:\/\/knext\.dev\/docs\//);
    });

    it("clears an inherited ASSET_PREFIX BEFORE buildAndPush runs", async () => {
        process.env.ASSET_PREFIX = "https://stale-bucket.example.com/app";
        const deps = makeDeps();
        let prefixDuringBuild: string | undefined = "unset-sentinel";
        deps.buildAndPush.mockImplementation(async (_name: string) => {
            prefixDuringBuild = process.env.ASSET_PREFIX;
            return digestImage;
        });

        await runPreviewDeploy(
            storagelessConfig,
            { prId: "42", branch: "feat/x", namespace: "previews" },
            deps,
        );

        // The clear must land before `next build` (inside buildAndPush) reads
        // the env — clearing after the build would be decoration.
        expect(prefixDuringBuild).toBeUndefined();
        expect(process.env.ASSET_PREFIX).toBeUndefined();
    });
});

describe("preview WITH storage — unchanged (regression pins)", () => {
    it("prints no mode notice and leaves an inherited ASSET_PREFIX alone", async () => {
        process.env.ASSET_PREFIX = "https://cdn.example.com/my-app";
        const deps = makeDeps();

        await runPreviewDeploy(
            storageBackedConfig,
            { prId: "42", branch: "feat/x", namespace: "previews" },
            deps,
        );

        expect(
            infoMessages().some((m) => /no object storage configured/i.test(m)),
        ).toBe(false);
        // With storage, the prefix is buildAndPush's to manage (it overwrites
        // it from config.storage.publicUrl) — runPreviewDeploy must not touch it.
        expect(process.env.ASSET_PREFIX).toBe("https://cdn.example.com/my-app");
    });
});
