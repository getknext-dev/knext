/**
 * `knext preview` reaches `runProjectBuild` directly, so it must refuse
 * Bun + turbopackModuleFragments before any build work. Same seam discipline
 * as preview-buildarg-passthrough.test.ts, but `runProjectBuild` stays REAL.
 */

import {
    afterAll,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    mock,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireIsolatedProcess } from "../../../../tests/helpers/require-isolated-process";
import type { KnativeNextConfig } from "../config";

requireIsolatedProcess("preview-turbopack-fragments-guard.test.ts");

// biome-ignore lint/suspicious/noExplicitAny: thin mock factory plumbing
type AnyFn = (...args: unknown[]) => any;

const __realExec = { ...(await import("../cli/exec")) };
const runQuiet = mock<AnyFn>();
mock.module("../cli/exec", () => ({
    ...__realExec,
    runQuiet: (...a: unknown[]) => runQuiet(...a),
    runInherit: mock(),
    runCapture: mock(() => ""),
    isEntrypoint: () => false,
}));
const __realTracing = { ...(await import("../cli/tracing-root")) };
mock.module("../cli/tracing-root", () => ({
    ...__realTracing,
    requireBuildContext: () => "/throwaway/build-context",
}));
const __realCr = { ...(await import("../cli/cr-builder")) };
mock.module("../cli/cr-builder", () => ({
    ...__realCr,
    renderNextAppCR: mock(),
    resolveDigest: async () => "r/x@sha256:deadbeef",
    validateCRImageRef: mock(),
}));
afterAll(() => {
    mock.module("../cli/exec", () => __realExec);
    mock.module("../cli/tracing-root", () => __realTracing);
    mock.module("../cli/cr-builder", () => __realCr);
});

const saved = process.cwd();
let dir: string;
beforeEach(() => {
    jest.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "knext-prev-frag-"));
    writeFileSync(
        join(dir, "next.config.ts"),
        "export default { experimental: { turbopackModuleFragments: true } };",
    );
    process.chdir(dir);
});

const base: KnativeNextConfig = {
    name: "acme",
    registry: "r.example.com/acme",
};

describe("preview refuses bun + turbopackModuleFragments", () => {
    it("refuses (default runtime is bun) before running the project build", async () => {
        const { defaultBuildAndPush } = await import("../cli/preview");
        try {
            await expect(
                defaultBuildAndPush(
                    "acme-pr-1",
                    { ...base, build: "turbopack" },
                    "f/x",
                ),
            ).rejects.toThrow(/turbopackModuleFragments/);
            expect(runQuiet).not.toHaveBeenCalled();
        } finally {
            process.chdir(saved);
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
