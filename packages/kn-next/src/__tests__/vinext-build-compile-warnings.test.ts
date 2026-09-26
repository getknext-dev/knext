/**
 * #1385 — `buildVinextExecutable`'s DEFAULT `run` (when the caller does not
 * inject one, i.e. the real `kn-next build` path) must wire the compile
 * step's `runQuiet` call to surface `[knext compile]`-prefixed stdout lines
 * — the console.log lines `apps/docs/content/docs/build-pipeline.mdx` quotes
 * verbatim (e.g. which server externals load from
 * `.output/server/node_modules` vs. stay bundled), which `runQuiet`'s
 * fully-quiet default previously discarded entirely. (Its console.warn
 * lines were already visible via stderr — only the console.log half was
 * ever at risk.)
 *
 * Every other test in `vinext-build.test.ts` injects `opts.run` explicitly,
 * so none of them exercises this wiring — this file is the one that does,
 * by mocking `./exec` (the pattern `rollback-main.test.ts` /
 * `preview-entrypoint-dispatch.test.ts` already use) and asserting on the
 * REAL `runQuiet`'s call args, not a hand-rolled stub.
 */

import {
    afterAll,
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    mock,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runQuiet = (() => mock())();
mock.module("../cli/exec", () => ({ runQuiet }));

import { buildVinextExecutable, COMPILE_LOG_PREFIX } from "../cli/vinext-build";

const tempDirs: string[] = [];
afterAll(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** A cwd with a pre-built `.output/server/index.mjs`, so `skipViteBuild`
 * reaches the compile step without needing a real vite build. */
function cwdWithOutput(): string {
    const cwd = mkdtempSync(join(tmpdir(), "knext-1385-compile-warn-"));
    tempDirs.push(cwd);
    mkdirSync(join(cwd, ".output", "server"), { recursive: true });
    writeFileSync(join(cwd, ".output", "server", "index.mjs"), "export {};");
    return cwd;
}

beforeEach(() => {
    runQuiet.mockClear();
    runQuiet.mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe("buildVinextExecutable's default run (#1385)", () => {
    it("calls the real runQuiet with surfaceStdoutPrefix set to COMPILE_LOG_PREFIX for the compile step, when opts.run is NOT injected", () => {
        buildVinextExecutable({
            cwd: cwdWithOutput(),
            bunVersion: "1.4.0",
            skipViteBuild: true,
            // opts.run deliberately OMITTED — this is the real `kn-next
            // build` path, not a test double for the exec layer itself.
        });

        expect(runQuiet).toHaveBeenCalledTimes(1);
        const [argv, options] = runQuiet.mock.calls[0] as [
            string[],
            { surfaceStdoutPrefix?: string } | undefined,
        ];
        expect(argv[0]).toBe("bun");
        expect(options?.surfaceStdoutPrefix).toBe(COMPILE_LOG_PREFIX);
        expect(COMPILE_LOG_PREFIX).toBe("[knext compile]");
    });
});
