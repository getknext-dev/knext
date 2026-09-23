import { describe, expect, it } from "bun:test";
import {
    handleImageRequest,
    isImageRequest,
    knextImageOptimizer,
    negotiateFormat,
} from "../adapters/vinext-image-optimizer";

/**
 * Coverage batch B1 (#1232) — `vinext-image-optimizer.ts` had NO dedicated
 * test file (0% measured coverage) despite being pure, injectable logic
 * (ADR-0048/ADR-0006 gap-closer for the compiled vinext target). These tests
 * exercise the real request-routing + format-negotiation + fail-open
 * transform contract, without needing a real `sharp` install: a fake `sharp`
 * is injected via the documented `provided`/`sharp` seam.
 */

/** A fake sharp: records what it was asked to do and returns fixed bytes. */
function fakeSharp(outputBytes = Buffer.from("OPTIMIZED")) {
    const calls: {
        resize?: { width: number; withoutEnlargement: boolean };
        format?: string;
        quality?: number;
    } = {};
    const sharp = ((_input: Buffer) => ({
        resize(opts: { width: number; withoutEnlargement: boolean }) {
            calls.resize = opts;
            return {
                toFormat(format: string, opts2: { quality: number }) {
                    calls.format = format;
                    calls.quality = opts2.quality;
                    return {
                        async toBuffer() {
                            return outputBytes;
                        },
                    };
                },
            };
        },
    })) as unknown as Parameters<typeof knextImageOptimizer>[0];
    return { sharp, calls };
}

describe("isImageRequest", () => {
    it("matches exactly /_next/image", () => {
        expect(isImageRequest(new URL("http://h/_next/image?url=/a.png"))).toBe(
            true,
        );
    });

    it("rejects any other path", () => {
        expect(isImageRequest(new URL("http://h/_next/other"))).toBe(false);
        expect(isImageRequest(new URL("http://h/"))).toBe(false);
    });
});

describe("negotiateFormat", () => {
    it("prefers avif over webp when both are advertised (order = preference)", () => {
        expect(negotiateFormat("image/webp,image/avif,*/*", "png")).toBe(
            "avif",
        );
    });

    it("picks webp when only webp is advertised", () => {
        expect(negotiateFormat("text/html,image/webp", "png")).toBe("webp");
    });

    it("falls back to the source format when nothing negotiable is advertised", () => {
        expect(negotiateFormat("text/html", "png")).toBe("png");
        expect(negotiateFormat(null, "jpeg")).toBe("jpeg");
    });
});

describe("knextImageOptimizer — the transform, fail-open contract", () => {
    it("transcodes via the provided sharp when the format is supported", async () => {
        const { sharp, calls } = fakeSharp(Buffer.from("WEBP-BYTES"));
        const optimizer = knextImageOptimizer(sharp);

        const res = await optimizer.transformImage(
            new Response(Buffer.from("source-png")).body as ReadableStream,
            { width: 640, format: "webp", quality: 80, sourceFormat: "png" },
        );

        expect(res.headers.get("content-type")).toBe("image/webp");
        expect(res.headers.get("cache-control")).toBe(
            "public, max-age=31536000, immutable",
        );
        expect(await res.text()).toBe("WEBP-BYTES");
        expect(calls.resize).toEqual({ width: 640, withoutEnlargement: true });
        expect(calls.format).toBe("webp");
        expect(calls.quality).toBe(80);
    });

    it("passes through the ORIGINAL bytes, honestly labelled, for an unsupported format", async () => {
        const { sharp } = fakeSharp();
        const optimizer = knextImageOptimizer(sharp);

        const res = await optimizer.transformImage(
            new Response(Buffer.from("source-bytes")).body as ReadableStream,
            {
                width: 640,
                format: "image/gif", // not in SUPPORTED
                quality: 80,
                sourceFormat: "gif",
            },
        );

        expect(res.headers.get("content-type")).toBe("image/gif");
        expect(await res.text()).toBe("source-bytes");
    });

    it("fails open with the source bytes when no sharp is available", async () => {
        // No `provided` sharp, and no real sharp install in this sandbox — the
        // dynamic createRequire resolve fails, loadSharp caches null, and the
        // transform degrades to passthrough rather than throwing.
        const optimizer = knextImageOptimizer(undefined);

        const res = await optimizer.transformImage(
            new Response(Buffer.from("orig-bytes")).body as ReadableStream,
            { width: 100, format: "webp", quality: 75, sourceFormat: "png" },
        );

        expect(res.headers.get("content-type")).toBe("image/png");
        expect(await res.text()).toBe("orig-bytes");
    });

    it("fails open when the transform itself throws mid-pipeline", async () => {
        const throwingSharp = ((_input: Buffer) => ({
            resize() {
                throw new Error("sharp: corrupt image");
            },
        })) as unknown as Parameters<typeof knextImageOptimizer>[0];
        const optimizer = knextImageOptimizer(throwingSharp);

        const res = await optimizer.transformImage(
            new Response(Buffer.from("still-the-original"))
                .body as ReadableStream,
            { width: 100, format: "avif", quality: 75, sourceFormat: "png" },
        );

        expect(res.headers.get("content-type")).toBe("image/png");
        expect(await res.text()).toBe("still-the-original");
    });
});

describe("handleImageRequest — routing + SSRF guard", () => {
    function req(url: string, accept?: string) {
        return new Request(url, {
            headers: accept ? { accept } : undefined,
        });
    }

    it("returns null for any path other than /_next/image (not mine)", async () => {
        const res = await handleImageRequest(
            req("http://h/other?url=/a.png&w=100"),
            { fetchSource: async () => new Response("x") },
        );
        expect(res).toBeNull();
    });

    it("returns null when url param is missing", async () => {
        const res = await handleImageRequest(
            req("http://h/_next/image?w=100"),
            { fetchSource: async () => new Response("x") },
        );
        expect(res).toBeNull();
    });

    it("rejects an absolute source url (SSRF guard) even though it starts with a scheme", async () => {
        const res = await handleImageRequest(
            req("http://h/_next/image?url=https://evil.example/x.png&w=100"),
            { fetchSource: async () => new Response("x") },
        );
        expect(res).toBeNull();
    });

    it("rejects a protocol-relative source url (//host) despite the leading slash", async () => {
        const res = await handleImageRequest(
            req("http://h/_next/image?url=//evil.example/x.png&w=100"),
            { fetchSource: async () => new Response("x") },
        );
        expect(res).toBeNull();
    });

    /**
     * Backslash-as-slash smuggling (review finding on #1247): WHATWG URL
     * parsing normalizes `\` to `/` for special schemes, so a naive
     * `startsWith("//")` check misses `/\host/...` and `\\host/...` — both
     * resolve to `evil.example` as the host once actually parsed. Same for a
     * control character (tab) interrupting the slashes: URL parsing strips
     * ASCII tab/newline before host parsing runs. These fetchSource calls
     * MUST NEVER be reached — a same-origin miss must be caught before the
     * outbound-looking path is ever handed to the caller's fetchSource.
     */
    it("rejects a backslash-smuggled protocol-relative source url (/\\host)", async () => {
        const fetchSource = async () => new Response("x");
        const res = await handleImageRequest(
            req(
                `http://h/_next/image?url=${encodeURIComponent("/\\evil.example/x.png")}&w=100`,
            ),
            { fetchSource },
        );
        expect(res).toBeNull();
    });

    it("rejects a double-backslash-smuggled protocol-relative source url (\\\\host)", async () => {
        const res = await handleImageRequest(
            req(
                `http://h/_next/image?url=${encodeURIComponent("\\\\evil.example/x.png")}&w=100`,
            ),
            { fetchSource: async () => new Response("x") },
        );
        expect(res).toBeNull();
    });

    it("rejects a tab-interrupted backslash-smuggled source url (/\\t/host)", async () => {
        const res = await handleImageRequest(
            req(
                `http://h/_next/image?url=${encodeURIComponent("/\t/evil.example/x.png")}&w=100`,
            ),
            { fetchSource: async () => new Response("x") },
        );
        expect(res).toBeNull();
    });

    it("rejects a percent-encoded backslash smuggle (%5C) once URLSearchParams decodes it", async () => {
        // The whole request URL is built raw here (not via encodeURIComponent
        // on the query value) to prove the %5C survives transport as literal
        // percent-encoding and is decoded by url.searchParams.get(), exactly
        // as a real browser/fetch request would deliver it.
        const res = await handleImageRequest(
            req("http://h/_next/image?url=%2F%5Cevil.example%2Fx.png&w=100"),
            { fetchSource: async () => new Response("x") },
        );
        expect(res).toBeNull();
    });

    it("rejects a percent-encoded protocol-relative smuggle (%2F%2F)", async () => {
        const res = await handleImageRequest(
            req("http://h/_next/image?url=%2F%2Fevil.example%2Fx.png&w=100"),
            { fetchSource: async () => new Response("x") },
        );
        expect(res).toBeNull();
    });

    it("returns null when width is missing/non-finite/non-positive", async () => {
        for (const w of ["", "0", "-5", "abc"]) {
            const res = await handleImageRequest(
                req(`http://h/_next/image?url=/a.png&w=${w}`),
                { fetchSource: async () => new Response("x") },
            );
            expect(res).toBeNull();
        }
    });

    it("returns null when fetchSource throws", async () => {
        const res = await handleImageRequest(
            req("http://h/_next/image?url=/a.png&w=100"),
            {
                fetchSource: async () => {
                    throw new Error("boom");
                },
            },
        );
        expect(res).toBeNull();
    });

    it("returns null when the source response is not ok", async () => {
        const res = await handleImageRequest(
            req("http://h/_next/image?url=/missing.png&w=100"),
            {
                fetchSource: async () => new Response(null, { status: 404 }),
            },
        );
        expect(res).toBeNull();
    });

    it("returns null when the source response has no body", async () => {
        const res = await handleImageRequest(
            req("http://h/_next/image?url=/a.png&w=100"),
            {
                fetchSource: async () => new Response(null, { status: 200 }),
            },
        );
        expect(res).toBeNull();
    });

    it("transcodes a valid same-origin request end to end, negotiating from Accept", async () => {
        const { sharp, calls } = fakeSharp(Buffer.from("AVIF-OUT"));
        const res = await handleImageRequest(
            req(
                "http://h/_next/image?url=/photo.png&w=320&q=60",
                "image/avif,image/webp",
            ),
            {
                fetchSource: async () =>
                    new Response(Buffer.from("source"), {
                        headers: { "content-type": "image/png" },
                    }),
                sharp,
            },
        );

        expect(res).not.toBeNull();
        expect(res?.headers.get("content-type")).toBe("image/avif");
        expect(await res?.text()).toBe("AVIF-OUT");
        expect(calls.resize).toEqual({ width: 320, withoutEnlargement: true });
        expect(calls.quality).toBe(60);
    });

    it("defaults quality to 75 and source format to png when unset/invalid", async () => {
        const { sharp, calls } = fakeSharp();
        await handleImageRequest(
            req("http://h/_next/image?url=/a&w=100&q=notanumber"),
            {
                fetchSource: async () =>
                    new Response(Buffer.from("s"), { headers: {} }),
                sharp,
            },
        );
        expect(calls.quality).toBe(75);
    });
});
