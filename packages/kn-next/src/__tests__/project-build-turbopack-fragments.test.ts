/**
 * The Bun + turbopackModuleFragments guard lives in `runProjectBuild`, so
 * build, deploy and preview all sit behind it. Real module, temp-dir cwd, the
 * `run` seam stubbed (no mocks of project modules).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProjectBuild } from "../cli/project-build";

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knext-pb-frag-"));
    writeFileSync(
        join(dir, "next.config.ts"),
        "export default { experimental: { turbopackModuleFragments: true } };",
    );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const go = (runtimeId: string, builderId: string) => {
    const calls: unknown[] = [];
    const attempt = () =>
        runProjectBuild({
            requireEsm: false,
            cwd: dir,
            runtimeId,
            builderId,
            run: (argv) => {
                calls.push(argv);
            },
        });
    return { calls, attempt };
};

describe("runProjectBuild guards turbopackModuleFragments on Bun", () => {
    it("refuses bun + turbopack and never runs the build", () => {
        const { calls, attempt } = go("bun", "turbopack");
        expect(attempt).toThrow(/turbopackModuleFragments/);
        expect(calls).toHaveLength(0);
    });
    it("allows node, webpack and vinext, running the build exactly once", () => {
        for (const [r, b] of [
            ["node", "turbopack"],
            ["bun", "webpack"],
            ["bun", "vinext"],
        ] as const) {
            const { calls, attempt } = go(r, b);
            expect(attempt).not.toThrow();
            expect(calls).toHaveLength(1);
        }
    });
});
