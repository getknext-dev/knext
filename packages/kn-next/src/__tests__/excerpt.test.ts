/**
 * Unit tests for the shared `excerpt()` CLI helper (v3-P6a).
 *
 * `excerpt()` is the single source of truth for building a bounded,
 * whitespace-collapsed stderr excerpt. Both `doctor.ts` and `status.ts`
 * previously hand-rolled this (inconsistently — status did NOT collapse
 * whitespace); they now share this helper so the two sites behave identically.
 */

import { describe, expect, it } from "vitest";
import { excerpt } from "../cli/shared";

describe("excerpt", () => {
    it("returns an empty string for an empty input", () => {
        expect(excerpt("")).toBe("");
    });

    it("returns an empty string for whitespace-only input (trims to nothing)", () => {
        expect(excerpt("   \n\t  ")).toBe("");
    });

    it("trims leading and trailing whitespace", () => {
        expect(excerpt("  hello world  ")).toBe("hello world");
    });

    it("collapses runs of whitespace (including newlines) to a single space", () => {
        expect(excerpt("line one\n\n  line   two\tthree")).toBe(
            "line one line two three",
        );
    });

    it("caps output at the default 160 characters", () => {
        const raw = "x".repeat(500);
        expect(excerpt(raw)).toHaveLength(160);
    });

    it("honors a custom max", () => {
        expect(excerpt("abcdefghij", 4)).toBe("abcd");
    });

    it("collapses THEN caps (multiline over-limit input)", () => {
        // 200 words separated by newlines → collapsed to space-joined, then
        // sliced. First 160 chars are "a " repeated (80 pairs) = 160 chars.
        const raw = Array.from({ length: 200 }, () => "a").join("\n");
        const out = excerpt(raw);
        expect(out).toHaveLength(160);
        expect(out).toBe("a ".repeat(80));
    });

    it("does not split a multi-byte unicode code point at the cap boundary", () => {
        // Emoji are surrogate pairs in JS strings; a naive `.slice(0, n)` can
        // cut one in half and emit a lone surrogate. The helper must slice by
        // code point, never producing an unpaired surrogate.
        const raw = "😀".repeat(200); // each emoji is 1 code point / 2 UTF-16 units
        const out = excerpt(raw, 5);
        expect(Array.from(out)).toHaveLength(5);
        expect(out).toBe("😀😀😀😀😀");
        // No lone surrogate anywhere in the output.
        for (const unit of out) {
            const code = unit.codePointAt(0) ?? 0;
            expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
        }
    });

    it("preserves multi-byte content that fits within the cap", () => {
        expect(excerpt("café — münchen")).toBe("café — münchen");
    });
});
