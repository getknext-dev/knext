/**
 * Guard for the 2.0 deprecation announcements: the test-only cache-handler
 * seams must carry `@deprecated` in the published types.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..");

describe("v2 deprecation notices", () => {
    for (const seam of ["__resetEnvForTests", "__setRedisClientForTests"]) {
        it(`${seam} is @deprecated (removed in 2.0; test-only) in the types`, () => {
            const dts = readFileSync(
                join(SRC, "adapters", "cache-handler.d.ts"),
                "utf8",
            );
            const at = dts.indexOf(`export declare function ${seam}`);
            expect(at).toBeGreaterThan(-1);
            const doc = dts.slice(dts.lastIndexOf("/**", at), at);
            expect(doc).toContain("@deprecated");
            expect(doc).toContain("2.0");
            expect(doc).toContain("test-only");
        });
    }
});
