/**
 * `/_next/image` on the vinext target.
 *
 * These cover the ROUTING and the HONESTY, not sharp's encoder — the transform
 * is sharp's job and testing it here would only assert that sharp works.
 *
 * The honesty half is not theoretical. A fail-open path in this file really did
 * return PNG bytes labelled `image/avif`, because it labelled the response with
 * the format that was REQUESTED rather than the format it actually produced.
 * A browser cannot decode that, which makes the fallback worse than the problem
 * it exists to soften. Byte-size checks alone would not have caught it, and
 * content-type checks alone would not have caught it either.
 */

import { describe, expect, it, mock } from "bun:test";
import {
    handleImageRequest,
    isImageRequest,
    knextImageOptimizer,
    negotiateFormat,
} from "../vinext-image-optimizer";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function imageRequest(
    query: string,
    accept = "image/avif,image/webp,*/*",
): Request {
    return new Request(`http://app.test/_next/image?${query}`, {
        headers: { accept },
    });
}

/** A source that always succeeds, so a test failure means the ROUTE decided it. */
function okSource(): (path: string) => Promise<Response> {
    return mock(
        async () =>
            new Response(PNG, { headers: { "content-type": "image/png" } }),
    );
}

describe("#ADR-0048 image route — what it claims", () => {
    it("only claims /_next/image", () => {
        // Both halves: it takes the route it owns AND declines the ones it does
        // not. Asserting only the first would pass on a handler that swallowed
        // every request in the app.
        expect(
            isImageRequest(new URL("http://a.test/_next/image?url=/x.png")),
        ).toBe(true);
        expect(isImageRequest(new URL("http://a.test/_next/image/other"))).toBe(
            false,
        );
        expect(isImageRequest(new URL("http://a.test/api/health"))).toBe(false);
        expect(isImageRequest(new URL("http://a.test/"))).toBe(false);
    });
});

describe("#ADR-0048 image route — requests it passes through", () => {
    /**
     * Every miss returns null, meaning "let the app have it". A miss must never
     * become an error status: the page keeps working, the image is just not
     * optimized.
     */
    const passesThrough: Array<[string, string]> = [
        ["no url param", "w=640"],
        [
            "absolute http url (SSRF surface, no allowlist here)",
            "url=http%3A%2F%2Fevil.test%2Fa.png&w=640",
        ],
        ["absolute https url", "url=https%3A%2F%2Fevil.test%2Fa.png&w=640"],
        [
            "protocol-relative url — starts with / but is NOT same-origin",
            "url=%2F%2Fevil.test%2Fa.png&w=640",
        ],
        ["missing width", "url=%2Fa.png"],
        ["non-numeric width", "url=%2Fa.png&w=wide"],
        ["zero width", "url=%2Fa.png&w=0"],
        ["negative width", "url=%2Fa.png&w=-640"],
    ];

    for (const [label, query] of passesThrough) {
        it(`passes through: ${label}`, async () => {
            await expect(
                handleImageRequest(imageRequest(query), {
                    fetchSource: okSource(),
                }),
            ).resolves.toBeNull();
        });
    }

    it("never fetches a source for a request it will not handle", async () => {
        // The SSRF case is the reason this matters: returning null is not
        // enough if the fetch already happened.
        const fetchSource = okSource();
        await handleImageRequest(
            imageRequest("url=https%3A%2F%2Fevil.test%2Fa.png&w=640"),
            { fetchSource },
        );
        expect(fetchSource).not.toHaveBeenCalled();
    });

    it("passes through when the source cannot be fetched", async () => {
        const missing = async () => new Response("nope", { status: 404 });
        await expect(
            handleImageRequest(imageRequest("url=%2Fgone.png&w=640"), {
                fetchSource: missing,
            }),
        ).resolves.toBeNull();
    });

    it("passes through when fetching the source throws", async () => {
        const boom = async () => {
            throw new Error("connection reset");
        };
        await expect(
            handleImageRequest(imageRequest("url=%2Fa.png&w=640"), {
                fetchSource: boom,
            }),
        ).resolves.toBeNull();
    });
});

describe("#ADR-0048 content negotiation", () => {
    it("prefers avif, then webp, from what the client advertises", () => {
        expect(negotiateFormat("image/avif,image/webp,*/*", "png")).toBe(
            "avif",
        );
        expect(negotiateFormat("image/webp,*/*", "png")).toBe("webp");
    });

    it("falls back to the SOURCE format for a client that advertises neither", () => {
        // The fallback is the source format, not a hardcoded default: handing a
        // legacy client webp because webp is "better" gives it a file it cannot
        // decode.
        expect(negotiateFormat("*/*", "png")).toBe("png");
        expect(negotiateFormat("*/*", "jpeg")).toBe("jpeg");
        expect(negotiateFormat(null, "png")).toBe("png");
    });
});

describe("#ADR-0048 fail-open honesty", () => {
    it("labels unconvertible output with the SOURCE format, not the requested one", async () => {
        // The regression: requested format was echoed into content-type even
        // when the bytes were never converted. `tiff` is not in the supported
        // set, so this takes the first fail-open branch without needing sharp
        // to be absent.
        const res = await knextImageOptimizer().transformImage(
            new Response(PNG).body as ReadableStream,
            { width: 640, format: "tiff", quality: 75, sourceFormat: "png" },
        );

        expect(res.headers.get("content-type")).toBe("image/png");
        expect(res.headers.get("content-type")).not.toBe("image/tiff");

        // And the bytes really are the untouched source — the claim and the
        // payload have to agree, which is the whole point of the assertion.
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    });

    it("still sets the caching and sniffing headers on the fallback", async () => {
        // A fallback that drops these would silently change caching behaviour
        // between the optimized and unoptimized paths.
        const res = await knextImageOptimizer().transformImage(
            new Response(PNG).body as ReadableStream,
            { width: 640, format: "tiff", quality: 75, sourceFormat: "png" },
        );
        expect(res.headers.get("cache-control")).toBe(
            "public, max-age=31536000, immutable",
        );
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });
});
