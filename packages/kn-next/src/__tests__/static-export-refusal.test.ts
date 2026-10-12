/**
 * The CLI refuses a static export instead of deploying it.
 *
 * `output: 'export'` makes `next build` write a static `out/` folder and no
 * server. knext deploys a Next.js SERVER, so continuing would hand the operator
 * an image with no server in it. Next records a successful export in
 * `.next/export-detail.json` (and deletes that file on every non-export build,
 * so it is never stale), which is the signal `runProjectBuild` — the one seam
 * build, deploy and preview all share — checks after the project's build.
 */

import { describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProjectBuild } from "../cli/project-build";
import { USAGE_ERROR_CODE } from "../cli/shared";

function appDirWithExport(): string {
    const dir = mkdtempSync(join(tmpdir(), "knext-static-export-"));
    mkdirSync(join(dir, ".next"), { recursive: true });
    writeFileSync(
        join(dir, ".next", "export-detail.json"),
        JSON.stringify({
            version: 1,
            outDirectory: join(dir, "out"),
            success: true,
        }),
    );
    return dir;
}

describe("runProjectBuild static-export refusal", () => {
    it("refuses a build that produced a static export, with actionable guidance", () => {
        const dir = appDirWithExport();
        const run = mock();
        let caught: unknown;
        try {
            runProjectBuild({ requireEsm: false, cwd: dir, run });
        } catch (err) {
            caught = err;
        }
        expect(run).toHaveBeenCalledTimes(1);
        const message = (caught as Error).message;
        expect(caught).toMatchObject({ code: USAGE_ERROR_CODE });
        expect(message).toContain("static export is not a server deployment");
        expect(message).toContain("knext deploys a Next.js server");
        expect(message).toContain("remove `output: 'export'`");
        expect(message).toContain("`out/`");
        expect(message).toContain("static host");
    });

    it("does not interfere with a normal (non-export) build", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-no-export-"));
        mkdirSync(join(dir, ".next"), { recursive: true });
        const run = mock();
        expect(() =>
            runProjectBuild({ requireEsm: false, cwd: dir, run }),
        ).not.toThrow();
    });
});
