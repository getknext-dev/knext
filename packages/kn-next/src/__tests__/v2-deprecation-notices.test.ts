/**
 * Guard for the 2.0 deprecation announcements: the `kn-next` alias notice must
 * name 2.0 (not "a future minor"), and the test-only cache-handler seams that
 * 1.x marked `@deprecated` are gone from the published entry in 2.0.
 */
import { describe, expect, it } from "bun:test";
import { printDeprecatedKnNextNoticeIfNeeded } from "../cli/shared";

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

    // Announced as `@deprecated` in 1.x, removed in 2.0: the published entry no
    // longer exports them (they live on the unpublished implementation module).
    for (const seam of ["__resetEnvForTests", "__setRedisClientForTests"]) {
        it(`${seam} is removed from the published cache-handler entry in 2.0`, async () => {
            const published = await import(
                "../adapters/cache-handler.public.js"
            );
            expect(Object.keys(published)).not.toContain(seam);
            // ...and it is the test-only module that still carries it.
            const impl = await import("../adapters/cache-handler.js");
            expect(Object.keys(impl)).toContain(seam);
        });
    }
});
