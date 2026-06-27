import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    type Mock,
    vi,
} from "vitest";

/**
 * P1 data-plane resilience — deploy-time object-store-LOSS chaos case.
 *
 * Counterpart to the cache-handler fail-OPEN chaos test. The asymmetry is
 * deliberate and load-bearing (CLAUDE.md §9):
 *   - the ISR cache (Redis) fails OPEN — a missing cache degrades to origin render;
 *   - the asset store (GCS / S3) fails LOUD — a missing object MUST abort the
 *     deploy with a non-zero exit, because shipping an app whose `_next/static`
 *     chunks are absent produces a broken, 404-ing site. Assets must NEVER be
 *     silently skipped.
 *
 * This case simulates the object store losing everything (or being unreachable):
 * after the bulk upload the verification `ls` returns an EMPTY listing, so every
 * local key is missing. The deploy must throw (→ non-zero exit) and name the
 * offending keys.
 */

vi.mock("../cli/exec", () => ({
    runQuiet: vi.fn(),
    runCapture: vi.fn(),
}));

import { runCapture, runQuiet } from "../cli/exec";
import type { KnativeNextConfig } from "../config";
import { uploadAssets } from "../utils/asset-upload";

const runQuietMock = runQuiet as unknown as Mock;
const runCaptureMock = runCapture as unknown as Mock;

function makeConfig(): KnativeNextConfig {
    return {
        name: "shop",
        storage: {
            provider: "gcs",
            bucket: "my-bucket",
            publicUrl: "https://example.test/my-bucket",
        },
    } as unknown as KnativeNextConfig;
}

describe("uploadAssets chaos: object-store loss fails LOUD", () => {
    let assetsDir: string;
    let prevCwd: string;
    const localKeys = [
        "_next/static/buildX/main.js",
        "_next/static/css/app.css",
        "favicon.ico",
    ];

    beforeEach(async () => {
        prevCwd = process.cwd();
        const root = await fs.mkdtemp(join(tmpdir(), "knext-chaos-assets-"));
        assetsDir = join(root, ".output", "public");
        for (const key of localKeys) {
            const full = join(assetsDir, key);
            await fs.mkdir(join(full, ".."), { recursive: true });
            await fs.writeFile(full, `bytes:${key}`);
        }
        process.chdir(root);
        runQuietMock.mockReset();
        runCaptureMock.mockReset();
    });

    afterEach(() => {
        process.chdir(prevCwd);
        vi.clearAllMocks();
    });

    it("aborts the deploy (throws → non-zero exit) when the store lists nothing back", async () => {
        // The object store is gone / unreachable: the verification listing is
        // empty, so EVERY local key is missing even after a retry.
        runCaptureMock.mockReturnValue("");

        await expect(uploadAssets(makeConfig())).rejects.toThrow();
    });

    it("names at least one missing key so the operator sees what was lost", async () => {
        runCaptureMock.mockReturnValue("");

        // The thrown error must reference a concrete missing object, not a vague
        // failure — so the deploy log points at the lost asset.
        await expect(uploadAssets(makeConfig())).rejects.toThrow(
            /favicon\.ico|_next\/static/,
        );
    });

    it("does NOT swallow the loss into a silent success (fail-open would be a bug here)", async () => {
        runCaptureMock.mockReturnValue("");
        let resolved = false;
        try {
            await uploadAssets(makeConfig());
            resolved = true;
        } catch {
            // expected
        }
        expect(resolved).toBe(false);
    });
});
