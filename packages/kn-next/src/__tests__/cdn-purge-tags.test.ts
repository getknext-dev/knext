import { describe, expect, it } from "bun:test";

/**
 * ADR-0068 D5.2: every emitted tag is ASCII, lowercase, comma-free and
 * fixed-length, and "the purge side applies the same function to the tag
 * `revalidateTag` receives, so the two cannot drift".
 *
 * The expected values below are NOT computed by the function under test and
 * not restated from its source: they were produced independently with
 * `printf '%s' <tag> | shasum -a 256`, then cut to the ADR's lengths. They are
 * the contract the CDN-1 preload's encoder must also meet byte for byte.
 */
const TAGS: string = "../adapters/cdn-purge/tags.js";
const P = "abcdef012345";

describe("cdn-purge tag encoding (ADR-0068 D5.2)", () => {
    it("app tag is kn-<prefix>", async () => {
        const t = await import(TAGS);
        expect(t.appTag(P)).toBe("kn-abcdef012345");
    });

    it("Next tag is kn-<p>-t + first 16 hex of sha256(tag), against independent vectors", async () => {
        const t = await import(TAGS);
        expect(t.nextTag(P, "_N_T_/blog")).toBe(
            "kn-abcdef012345-tf015a2ba450e9cbd",
        );
        // A tag with a comma, a space and a non-ASCII letter cannot split or
        // corrupt a header once hashed.
        expect(t.nextTag(P, "a,b é")).toBe("kn-abcdef012345-t8ec7032b1d72e229");
    });

    it("build tag is kn-<p>-b + first 12 hex of sha256(buildId)", async () => {
        const t = await import(TAGS);
        expect(t.buildTag(P, "build-123")).toBe(
            "kn-abcdef012345-b383cf9300288",
        );
    });

    it("meets the vectors the CDN-1 header encoder pins, so the two sides cannot drift", async () => {
        const t = await import(TAGS);
        expect([
            t.appTag(P),
            t.buildTag(P, "build-xyz"),
            t.nextTag(P, "_N_T_/blog"),
            t.nextTag(P, "posts"),
        ]).toEqual([
            "kn-abcdef012345",
            "kn-abcdef012345-bf1adbc6c3c0e",
            "kn-abcdef012345-tf015a2ba450e9cbd",
            "kn-abcdef012345-ta44f1b9751711635",
        ]);
    });

    it("every encoded tag is ASCII lowercase, comma-free, and within Google's 120 bytes", async () => {
        const t = await import(TAGS);
        const hostile = ["x".repeat(256), "a,b", "ü", "A B\n", ""];
        for (const raw of hostile) {
            const out: string = t.nextTag(P, raw);
            expect(out).toMatch(/^[a-z0-9-]+$/);
            expect(out).not.toContain(",");
            expect(out.length).toBeLessThanOrEqual(120);
        }
    });

    it("is deterministic and injective enough: same input same tag, different input different tag", async () => {
        const t = await import(TAGS);
        expect(t.nextTag(P, "a")).toBe(t.nextTag(P, "a"));
        expect(t.nextTag(P, "a")).not.toBe(t.nextTag(P, "b"));
    });
});
