import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    type Mock,
    mock,
} from "bun:test";

/**
 * Coverage batch B1 (#1232) — two genuine gaps in `asset-upload.ts` left
 * uncovered by the existing upload/prune suites:
 *
 *  1. `hasStorage` — the type guard every function in this module relies on
 *     to narrow `KnativeNextConfig` to `StorageBackedConfig` (ADR-0047: an
 *     absent `storage` block is the announced image-served static mode). It
 *     was never called directly by a test.
 *  2. `pruneOldBuilds`'s listing-failure fallback — when the remote listing
 *     itself throws (a transient provider CLI error), the deploy-time GC must
 *     skip pruning rather than fail the deploy that has already shipped
 *     (over-keep, never break a successful deploy).
 */

mock.module("../cli/exec", () => ({
    runQuiet: mock(),
    runCapture: mock(),
    runQuietAllowFail: mock(),
}));

import { runCapture, runQuietAllowFail } from "../cli/exec";
import type { KnativeNextConfig } from "../config";
import {
    hasStorage,
    pruneOldBuilds,
    type StorageBackedConfig,
} from "../utils/asset-upload";

const runCaptureMock = runCapture as unknown as Mock<typeof runCapture>;
const runDeleteMock = runQuietAllowFail as unknown as Mock<
    typeof runQuietAllowFail
>;

describe("hasStorage", () => {
    it("returns true and narrows when config.storage is present", () => {
        const config: KnativeNextConfig = {
            name: "shop",
            storage: {
                provider: "gcs",
                bucket: "b",
                publicUrl: "https://example.test/b",
            },
        } as unknown as KnativeNextConfig;

        expect(hasStorage(config)).toBe(true);
        if (hasStorage(config)) {
            // Narrowing compiles AND the runtime value is the same object —
            // proves the guard actually inspects `storage`, not a stub.
            expect(config.storage.bucket).toBe("b");
        }
    });

    it("returns false when config.storage is absent (ADR-0047 image-served mode)", () => {
        const config: KnativeNextConfig = {
            name: "shop",
        } as unknown as KnativeNextConfig;

        expect(hasStorage(config)).toBe(false);
    });
});

describe("pruneOldBuilds — remote listing failure (#93)", () => {
    beforeEach(() => {
        runCaptureMock.mockReset();
        runDeleteMock.mockReset();
    });
    afterEach(() => jest.clearAllMocks());

    function makeConfig(): StorageBackedConfig {
        return {
            name: "shop",
            storage: {
                provider: "gcs",
                bucket: "b",
                publicUrl: "https://example.test/b",
            },
        } as unknown as StorageBackedConfig;
    }

    it("skips GC (never throws) when the remote listing itself fails — a stuck listing must not break a shipped deploy", () => {
        runCaptureMock.mockImplementation(() => {
            throw new Error("gsutil: connection reset");
        });

        // Must not throw: a listing failure degrades to "skip GC", not a
        // failed deploy — the deploy already shipped by the time this runs.
        const summary = pruneOldBuilds(makeConfig(), [], "newbuild");

        expect(summary.reaped).toEqual([]);
        expect(summary.keptWindow).toEqual([]);
        expect(summary.keptLive).toEqual([]);
        expect(summary.dryRun).toBe(false);
        // No delete was ever attempted — the failure must short-circuit
        // before any reap decision, not merely produce an empty plan.
        expect(runDeleteMock).not.toHaveBeenCalled();
    });

    it("a listing failure under --dry-run also reports an empty plan, not a throw", () => {
        runCaptureMock.mockImplementation(() => {
            throw new Error("network unreachable");
        });

        const summary = pruneOldBuilds(makeConfig(), [], "newbuild", {
            dryRun: true,
        });

        expect(summary.dryRun).toBe(true);
        expect(summary.reaped).toEqual([]);
        expect(runDeleteMock).not.toHaveBeenCalled();
    });
});
