/**
 * boot-trace-wiring.test.ts — source guards for the boot phase trace (#441/#592).
 *
 * The tracer is only useful if the marks sit at the RIGHT points, and it is only
 * safe if it stays free. Both are properties of `node-server.ts`'s source, not of
 * any runtime object, so they are guarded here:
 *
 *  - `entry-eval` must be the FIRST statement of the module body. In ESM the
 *    static imports evaluate before the body, so this position is what makes the
 *    mark mean "node bootstrap + the whole entry module graph". One statement
 *    earlier is impossible; one later and the mark silently starts excluding
 *    work it is supposed to cover.
 *  - `spawn-issued` must come AFTER the `spawn(...)` call — before it, the mark
 *    would time the intent rather than the syscall.
 *  - `boot-trace.ts` must stay import-free. It is imported by the supervisor
 *    entry, on the pre-spawn critical path, in EVERY deployment including ones
 *    with the trace off. A dependency added here is a dependency every cold
 *    start pays for — the exact class of cost #441 exists to remove.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTERS = resolve(__dirname, "..", "adapters");
const NODE_SERVER_SRC = resolve(ADAPTERS, "node-server.ts");
const BOOT_TRACE_SRC = resolve(ADAPTERS, "boot-trace.ts");

/** Strip block + line comments so a comment reference can't false-match. */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("node-server boot trace wiring (#441/#592)", () => {
    const src = stripComments(readFileSync(NODE_SERVER_SRC, "utf8"));

    it("marks every phase of the boot decomposition", () => {
        for (const phase of [
            "entry-eval",
            "spawn-issued",
            "child-listening",
            "supervisor-ready",
        ]) {
            expect(src, `missing bootTrace.mark("${phase}")`).toContain(
                `bootTrace.mark("${phase}"`,
            );
        }
    });

    it("marks entry-eval as the first statement of the module body", () => {
        // End of the last static import = start of the module body.
        const lastImport = src.lastIndexOf("\nimport ");
        expect(lastImport).toBeGreaterThan(-1);
        const bodyStart = src.indexOf(";", lastImport) + 1;

        const firstStatement = src
            .slice(bodyStart)
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.length > 0);

        expect(firstStatement).toBe('bootTrace.mark("entry-eval");');
    });

    it("marks spawn-issued after the spawn call, not before it", () => {
        const spawnAt = src.indexOf("spawn(process.execPath");
        const markAt = src.indexOf('bootTrace.mark("spawn-issued"');

        expect(spawnAt).toBeGreaterThan(-1);
        expect(markAt).toBeGreaterThan(spawnAt);
    });
});

describe("boot-trace stays free (#441)", () => {
    const src = stripComments(readFileSync(BOOT_TRACE_SRC, "utf8"));

    it("imports nothing — it runs on the pre-spawn path in every deployment", () => {
        const imports = src.match(/^\s*import[\s{'"]/gm) ?? [];
        expect(imports).toEqual([]);
        expect(src).not.toMatch(/\brequire\s*\(/);
        expect(src).not.toMatch(/\bimport\s*\(/);
    });
});
