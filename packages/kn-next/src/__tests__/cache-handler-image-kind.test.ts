/**
 * IMAGE-kind entries through the knext cache handler (write-free runtime).
 *
 * With `images.customCacheHandler: true` (set by the knext adapter when the
 * app uses this handler), Next's image optimizer stores each optimized variant
 * through the incremental cache handler instead of writing
 * `.next/cache/images` — which is what lets a storage-configured app run with
 * no writable volume at all. The value carries the encoded image as a raw
 * `Buffer` (`{ kind: 'IMAGE', etag, buffer, extension, upstreamEtag,
 * revalidate }`), and Next writes it straight to the response on a hit, so:
 *
 *   - on the Redis path the Buffer must survive JSON (a plain
 *     `JSON.stringify` turns it into `{ type: 'Buffer', data: [...] }` and the
 *     hit serves garbage);
 *   - on the in-memory fallback the variants must be BYTE-BOUNDED, or a pod
 *     with no Redis grows without limit, one optimized image at a time.
 */
// The cache handler's mutating test seams fail closed on a published
// subpath (design-gate block, sprint close): the harness opts in.
process.env.KNEXT_TEST_SEAMS = "1";

import { afterEach, describe, expect, it } from "bun:test";

type Handler = {
    get: (k: string) => Promise<Record<string, unknown> | null>;
    set: (k: string, d: unknown, c: unknown) => Promise<void> | void;
};

const IMAGE_CTX = { cacheControl: { revalidate: 60, expire: undefined } };

function imageValue(bytes: Buffer) {
    return {
        kind: "IMAGE",
        etag: "etag-1",
        buffer: bytes,
        extension: "webp",
        upstreamEtag: "up-1",
        revalidate: 60,
    };
}

const savedBudget = process.env.KNEXT_IMAGE_CACHE_MEMORY_BYTES;
afterEach(() => {
    if (savedBudget === undefined)
        delete process.env.KNEXT_IMAGE_CACHE_MEMORY_BYTES;
    else process.env.KNEXT_IMAGE_CACHE_MEMORY_BYTES = savedBudget;
});

async function memoryHandler(): Promise<Handler> {
    delete process.env.REDIS_URL;
    const mod = (await import(
        `../adapters/cache-handler.js?img=${Math.random()}`
    )) as { default: new () => Handler; __resetEnvForTests: () => void };
    mod.__resetEnvForTests();
    return new mod.default();
}

/** A native-client fake that actually stores what SET writes, so GET reads it back. */
function storingClient() {
    const store = new Map<string, string>();
    return {
        store,
        client: {
            connected: true,
            async connect() {},
            async get(key: string) {
                return store.get(key) ?? null;
            },
            async send(command: string, args: string[] = []) {
                if (command === "SET") store.set(args[0], args[1]);
                return "OK";
            },
        },
    };
}

async function redisHandler() {
    const mod = (await import(
        `../adapters/cache-handler.js?imgredis=${Math.random()}`
    )) as {
        default: new () => Handler;
        __setRedisClientForTests: (c: unknown) => void;
    };
    const fake = storingClient();
    const handler = new mod.default();
    mod.__setRedisClientForTests(fake.client);
    return { handler, store: fake.store };
}

describe("IMAGE entries on the Redis path", () => {
    it("round-trips the image bytes as a real Buffer", async () => {
        const { handler, store } = await redisHandler();
        const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x10]);
        await handler.set("img-key", imageValue(bytes), IMAGE_CTX);
        expect(store.size, "the variant was written to Redis").toBe(1);

        const hit = await handler.get("img-key");
        const value = hit?.value as { buffer?: unknown; kind?: string };
        expect(value?.kind).toBe("IMAGE");
        expect(Buffer.isBuffer(value?.buffer)).toBe(true);
        expect(Buffer.compare(value.buffer as Buffer, bytes)).toBe(0);
    });

    it("stores the bytes as base64, not as a JSON number array", async () => {
        const { handler, store } = await redisHandler();
        const bytes = Buffer.alloc(64, 7);
        await handler.set("img-compact", imageValue(bytes), IMAGE_CTX);
        const raw = [...store.values()][0] as string;
        expect(raw).toContain(bytes.toString("base64"));
        expect(raw).not.toContain('"type":"Buffer"');
    });
});

describe("IMAGE entries on the in-memory fallback", () => {
    it("serves a stored variant back", async () => {
        const handler = await memoryHandler();
        const bytes = Buffer.from("variant-bytes");
        await handler.set("mem-img", imageValue(bytes), IMAGE_CTX);
        const hit = await handler.get("mem-img");
        const value = hit?.value as { buffer: Buffer };
        expect(Buffer.compare(value.buffer, bytes)).toBe(0);
    });

    it("evicts the oldest variants once the byte budget is exceeded", async () => {
        process.env.KNEXT_IMAGE_CACHE_MEMORY_BYTES = "100";
        const handler = await memoryHandler();
        await handler.set("old", imageValue(Buffer.alloc(60, 1)), IMAGE_CTX);
        await handler.set("new", imageValue(Buffer.alloc(60, 2)), IMAGE_CTX);
        // Both halves: the newest is kept AND the oldest was dropped.
        expect(await handler.get("new")).not.toBeNull();
        expect(await handler.get("old")).toBeNull();
    });

    it("evicts least-recently-USED, not least-recently-written: a read keeps a variant alive", async () => {
        process.env.KNEXT_IMAGE_CACHE_MEMORY_BYTES = "100";
        const handler = await memoryHandler();
        await handler.set("a", imageValue(Buffer.alloc(40, 1)), IMAGE_CTX);
        await handler.set("b", imageValue(Buffer.alloc(40, 2)), IMAGE_CTX);
        // Read the OLDER entry, so it becomes the most recently used.
        expect(await handler.get("a")).not.toBeNull();
        // 40 + 40 + 40 > 100: one entry must go, and it must be the unread one.
        await handler.set("c", imageValue(Buffer.alloc(40, 3)), IMAGE_CTX);
        expect(
            await handler.get("a"),
            "the recently read entry survives",
        ).not.toBeNull();
        expect(
            await handler.get("b"),
            "the older, unread entry is evicted",
        ).toBeNull();
        expect(await handler.get("c")).not.toBeNull();
    });

    it("never stores a single variant larger than the whole budget", async () => {
        process.env.KNEXT_IMAGE_CACHE_MEMORY_BYTES = "100";
        const handler = await memoryHandler();
        await handler.set("small", imageValue(Buffer.alloc(10, 1)), IMAGE_CTX);
        await handler.set("huge", imageValue(Buffer.alloc(500, 2)), IMAGE_CTX);
        expect(await handler.get("huge")).toBeNull();
        expect(
            await handler.get("small"),
            "an oversized variant must not flush the rest of the cache",
        ).not.toBeNull();
    });

    it("leaves non-image entries outside the image budget", async () => {
        process.env.KNEXT_IMAGE_CACHE_MEMORY_BYTES = "10";
        const handler = await memoryHandler();
        await handler.set(
            "page",
            { kind: "APP_PAGE", html: "x".repeat(50) },
            { revalidate: 60, cacheControl: { revalidate: 60 }, tags: [] },
        );
        await handler.set("img", imageValue(Buffer.alloc(8, 1)), IMAGE_CTX);
        await handler.set("img2", imageValue(Buffer.alloc(8, 2)), IMAGE_CTX);
        expect(await handler.get("page")).not.toBeNull();
    });
});
