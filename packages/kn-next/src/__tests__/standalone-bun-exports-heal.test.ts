/**
 * standalone-bun-exports.ts — healBunExportTargets (#188). `next build` traces
 * under Node, so a package's "bun"-condition export targets (react-dom/server →
 * server.bun.js) are missing from .next/standalone while the exports map still
 * points at them. The heal copies the missing targets (+ their same-package
 * relative requires) byte-identical from the app's real node_modules, guarded by
 * a version-equality check. Driven here with a real temp filesystem.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    collectBunConditionTargets,
    healBunExportTargets,
} from "../adapters/standalone-bun-exports";

let root: string;
let projectDir: string;
let standaloneDir: string;

const EXPORTS = {
    "./server": { bun: "./server.bun.js", node: "./server.node.js" },
};

function writePkg(
    base: string,
    name: string,
    version: string,
    withFiles: boolean,
): void {
    const dir = join(base, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name, version, exports: EXPORTS }),
    );
    if (withFiles) {
        writeFileSync(join(dir, "server.bun.js"), "require('./helper');\n");
        writeFileSync(join(dir, "helper.js"), "module.exports = 1;\n");
    }
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knext-heal-"));
    projectDir = join(root, "app");
    standaloneDir = join(root, "app", ".next", "standalone");
    mkdirSync(standaloneDir, { recursive: true });
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("collectBunConditionTargets", () => {
    it("collects only relative targets under a bun condition", () => {
        expect(collectBunConditionTargets(EXPORTS)).toEqual([
            "./server.bun.js",
        ]);
        expect(
            collectBunConditionTargets({ "./x": { node: "./x.node.js" } }),
        ).toEqual([]);
    });
});

describe("healBunExportTargets", () => {
    it("copies a missing bun target AND its transitive same-package require", () => {
        // Source (app node_modules) HAS the files; standalone tree is missing them.
        writePkg(projectDir, "mypkg", "1.0.0", true);
        writePkg(standaloneDir, "mypkg", "1.0.0", false);

        const res = healBunExportTargets({ projectDir, standaloneDir });

        expect(res.copied).toContain("mypkg/server.bun.js");
        // server.bun.js requires ./helper → helper.js is pulled in too.
        expect(res.copied).toContain("mypkg/helper.js");
    });

    it("skips a package whose standalone version mismatches the source", () => {
        writePkg(projectDir, "mypkg", "1.0.0", true);
        writePkg(standaloneDir, "mypkg", "2.0.0", false);

        const res = healBunExportTargets({ projectDir, standaloneDir });

        expect(res.copied).toEqual([]);
        expect(res.skipped.join(" ")).toMatch(/version mismatch/);
    });

    it("skips when the source package is not resolvable from the project", () => {
        // No source package in projectDir/node_modules → nothing to copy from.
        writePkg(standaloneDir, "mypkg", "1.0.0", false);

        const res = healBunExportTargets({ projectDir, standaloneDir });

        expect(res.copied).toEqual([]);
        expect(res.skipped.join(" ")).toMatch(/source package not resolvable/);
    });

    it("is a no-op when the bun targets already exist in the standalone tree", () => {
        writePkg(projectDir, "mypkg", "1.0.0", true);
        writePkg(standaloneDir, "mypkg", "1.0.0", true); // already present

        const res = healBunExportTargets({ projectDir, standaloneDir });
        expect(res.copied).toEqual([]);
    });
});
