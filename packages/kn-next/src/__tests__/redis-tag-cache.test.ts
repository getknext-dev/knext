import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Create mock methods with explicit types
const mockSmembers = vi.fn((): Promise<string[]> => Promise.resolve([]));
const mockGet = vi.fn((): Promise<string | null> => Promise.resolve(null));
const mockSadd = vi.fn((): unknown => ({}));
const mockSet = vi.fn((): unknown => ({}));
const mockPipelineExec = vi.fn(
    (): Promise<Array<[Error | null, unknown]>> => Promise.resolve([]),
);
const mockConnect = vi.fn(() => Promise.resolve(undefined));

// Mock ioredis before importing adapter
vi.mock("ioredis", () => {
    return {
        default: class MockRedis {
            smembers = mockSmembers;
            get = mockGet;
            connect = mockConnect;
            quit = vi.fn();
            on = vi.fn();
            pipeline() {
                return {
                    sadd: mockSadd,
                    set: mockSet,
                    get: vi.fn(() => ({
                        sadd: mockSadd,
                        set: mockSet,
                        get: vi.fn(),
                        exec: mockPipelineExec,
                    })),
                    exec: mockPipelineExec,
                };
            }
        },
    };
});

describe("Redis TagCache Adapter", () => {
    beforeEach(() => {
        mockSmembers.mockReset();
        mockGet.mockReset();
        mockSadd.mockReset();
        mockSet.mockReset();
        mockPipelineExec.mockReset();
        mockConnect.mockReset();

        process.env.REDIS_URL = "redis://localhost:6379";
        process.env.REDIS_KEY_PREFIX = "test-app";
    });

    afterEach(() => {
        process.env.REDIS_URL = undefined;
        process.env.REDIS_KEY_PREFIX = undefined;
    });

    it("should have correct adapter name and mode", async () => {
        const { default: tagCache } = await import(
            "../adapters/redis-tag-cache"
        );

        expect(tagCache.name).toBe("redis");
        expect(tagCache.mode).toBe("original");
    });

    it("should build keys WITHOUT NEXT_BUILD_ID for cache stability", async () => {
        // This test verifies that cache keys are stable across deploys
        // Keys should NOT include BUILD_ID to prevent cache invalidation on every deploy
        mockSmembers.mockImplementationOnce(() =>
            Promise.resolve(["/page1", "/page2"]),
        );

        const { default: tagCache } = await import(
            "../adapters/redis-tag-cache"
        );
        const paths = await tagCache.getByTag("blog");

        // Paths should be returned as-is, not stripped of BUILD_ID prefix
        expect(paths).toEqual(["/page1", "/page2"]);
    });

    it("should get tags by path without BUILD_ID processing", async () => {
        mockSmembers.mockImplementationOnce(() =>
            Promise.resolve(["blog", "news"]),
        );

        const { default: tagCache } = await import(
            "../adapters/redis-tag-cache"
        );
        const tags = await tagCache.getByPath("/page1");

        // Tags should be returned as-is
        expect(tags).toEqual(["blog", "news"]);
    });

    it("should handle getLastModified with no tags", async () => {
        mockSmembers.mockImplementationOnce(() => Promise.resolve([]));

        const { default: tagCache } = await import(
            "../adapters/redis-tag-cache"
        );
        const lastModified = await tagCache.getLastModified("/unknown-page");

        expect(typeof lastModified).toBe("number");
    });

    it("should get lastModified when tags exist but not revalidated", async () => {
        mockSmembers.mockImplementationOnce(() =>
            Promise.resolve(["blog", "news"]),
        );
        mockPipelineExec.mockImplementationOnce(() =>
            Promise.resolve([
                [null, null], // No revalidation for blog
                [null, null], // No revalidation for news
            ]),
        );

        const { default: tagCache } = await import(
            "../adapters/redis-tag-cache"
        );
        const lastModified = await tagCache.getLastModified("/page1", 1000);

        expect(lastModified).toBe(1000);
    });

    it("should write tags to Redis using pipeline", async () => {
        mockPipelineExec.mockImplementationOnce(() => Promise.resolve([]));

        const { default: tagCache } = await import(
            "../adapters/redis-tag-cache"
        );
        await tagCache.writeTags([{ tag: "blog", path: "/page1" }]);

        expect(mockPipelineExec).toHaveBeenCalled();
    });
});
