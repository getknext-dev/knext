/**
 * gc.ts — gcMain entry (help path + a full read-only run). Complements the
 * gc-cli / gc-toctou / gc-skip suites (which drive runAssetGC + renderGcReport
 * directly) by covering the gcMain wiring: parse → loadConfig → runAssetGC →
 * renderGcReport, with the exec + prune + config seams mocked so no cluster or
 * object store is touched.
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

const runCapture = (() => mock(() => ""))();
const __knextRealShared = { ...(await import("../cli/shared")) };

mock.module("../cli/exec", () => ({ runCapture, isEntrypoint: () => false }));

const loadConfig = (() => mock())();
// Only loadConfig is faked. UsageError (and the handlers beside it) stay REAL,
// so the "unknown flag" assertion below still exercises the class the CLI
// actually throws — a stubbed one would let the presentation contract rot.
const __knextReal1 = { ...(await import("../cli/shared")) };
mock.module("../cli/shared", () => ({
    // bun replaces a mocked module WHOLESALE — no partial mock, no
    // automock — so a factory listing only what the test drives drops
    // every other export and the importer dies naming the CONSUMER, not
    // this factory. Spreading keeps it honest as `../cli/shared` grows.
    ...__knextRealShared,
    ...__knextReal1,
    loadConfig,
}));

const pruneOldBuilds = (() =>
    mock(() => ({
        reaped: [],
        keptWindow: [],
        keptLive: [],
        keptUnmarked: [],
        reservedExcluded: [],
        dryRun: false,
    })),
)();
const __knextReal2 = { ...(await import("../utils/asset-upload")) };
mock.module("../utils/asset-upload", async () => {
    const actual = __knextReal2;
    return { ...actual, pruneOldBuilds };
});

import { gcMain } from "../cli/gc";
import { USAGE_ERROR_CODE } from "../cli/shared";

const cfg = {
    name: "my-app",
    registry: "r",
    storage: { provider: "gcs", bucket: "b" },
};

beforeEach(() => {
    runCapture.mockReturnValue("");
    loadConfig.mockResolvedValue(cfg);
    pruneOldBuilds.mockClear();
});

afterEach(() => jest.restoreAllMocks());

describe("gcMain", () => {
    it("returns 0 for --help without loading config", async () => {
        expect(await gcMain(["--help"])).toBe(0);
        expect(loadConfig).not.toHaveBeenCalled();
    });

    it("runs the GC (empty traffic, no pin) and prunes, returning 0", async () => {
        // runCapture returns "" for status.currentTraffic + spec pin → empty
        // live set, empty pin → the prune runs over an empty live-build set.
        expect(await gcMain([])).toBe(0);
        expect(loadConfig).toHaveBeenCalledTimes(1);
        expect(pruneOldBuilds).toHaveBeenCalledTimes(1);
    });

    it("--dry-run computes the plan and issues no drift re-read", async () => {
        pruneOldBuilds.mockReturnValue({
            reaped: [],
            keptWindow: [],
            keptLive: [],
            keptUnmarked: [],
            reservedExcluded: [],
            dryRun: true,
        });
        expect(await gcMain(["--dry-run"])).toBe(0);
        const [, , , opts] = pruneOldBuilds.mock.calls[0] as unknown[];
        expect((opts as { dryRun: boolean }).dryRun).toBe(true);
    });

    it("propagates a parse error for an unknown flag, tagged as a usage error", async () => {
        // Assert the CODE, not only the message: a plain Error satisfies
        // `/unknown flag/` just as well, and it is the code that routes this to
        // a one-line message instead of a FATAL stack dump (ADR-0046).
        await expect(gcMain(["--bogus"])).rejects.toThrow(/unknown flag/);
        await expect(gcMain(["--bogus"])).rejects.toMatchObject({
            code: USAGE_ERROR_CODE,
        });
    });
});
