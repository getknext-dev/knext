/**
 * Guard for the 2.0 deprecation announcements: the `kn-next` alias notice must
 * name 2.0 (not "a future minor"), and the test-only cache-handler seams must
 * carry `@deprecated` in the published types.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { printDeprecatedKnNextNoticeIfNeeded } from "../cli/shared";

const SRC = join(import.meta.dir, "..");

describe("v2 deprecation notices", () => {
    it("the kn-next alias notice says it is removed in 2.0 and points at knext", () => {
        const writes: string[] = [];
        printDeprecatedKnNextNoticeIfNeeded("/x/.bin/kn-next", {}, (t) =>
            writes.push(t),
        );
        expect(writes).toHaveLength(1);
        expect(writes[0]).toContain("removed in 2.0");
        expect(writes[0]).toContain("`knext`");
        expect(writes[0]).not.toContain("future minor");
    });

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
