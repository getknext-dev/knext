/**
 * node-server-log-after-spawn.test.ts — cold-start perf (#441 follow-up).
 *
 * The supervisor imports `createLogger` and, in the OLD layout, emitted
 * `log.info(..., "Starting Next.js standalone server")` BEFORE spawning the
 * Next.js child. Because pino now loads lazily on the first emit, that eager
 * startup log would pull pino's ~13.5ms onto the cold-start critical path — the
 * exact CPU-contention window the #441 deferral work protects.
 *
 * Source guard: in `node-server.ts` the `spawn(process.execPath, ...)` call must
 * appear BEFORE the "Starting Next.js standalone server" `log.info`, so the
 * NORMAL path emits nothing (and loads no pino) before the child is spawned.
 * Comments are stripped first so a comment mention can't false-match.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE_SERVER_SRC = resolve(__dirname, "..", "adapters", "node-server.ts");

/** Strip block + line comments so a comment reference can't false-match. */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("node-server startup log ordering (#441)", () => {
    const src = stripComments(readFileSync(NODE_SERVER_SRC, "utf8"));

    it("emits nothing before spawn: startup log.info comes AFTER spawn()", () => {
        const spawnAt = src.indexOf("spawn(process.execPath");
        const startupLogAt = src.indexOf(
            '"Starting Next.js standalone server"',
        );

        expect(spawnAt).toBeGreaterThan(-1);
        expect(startupLogAt).toBeGreaterThan(-1);
        // The startup log must NOT precede the spawn — pino stays off the
        // pre-spawn critical path.
        expect(startupLogAt).toBeGreaterThan(spawnAt);
    });
});
