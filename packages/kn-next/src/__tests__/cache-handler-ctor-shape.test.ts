/**
 * The CacheHandler constructor tells vinext's `{ env, options }` wrapper apart
 * from the options object Next.js passes bare.
 *
 * Telling them apart by the mere presence of an `env` or `options` key is a
 * silent hazard: if a future Next.js adds either key to its handler options,
 * the Next path would receive `undefined` options and never say so. So the
 * wrapper is recognised POSITIVELY — exactly the two keys vinext constructs it
 * with, `options` absent-valued or a plain object — and anything else is a
 * Next-shaped argument and passes through unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

type HandlerCtor = new (
    arg?: unknown,
) => {
    options: unknown;
};

const HERE = dirname(new URL(import.meta.url).pathname);
const PKG_ROOT = join(HERE, "..", "..");

let CacheHandler: HandlerCtor;

beforeAll(async () => {
    delete process.env.REDIS_URL;
    const mod = (await import(
        `../adapters/cache-handler.js?ctor-shape=${Math.random()}`
    )) as { default: HandlerCtor };
    CacheHandler = mod.default;
});

afterAll(() => {
    delete process.env.REDIS_URL;
});

/**
 * The keys of `CacheHandlerContext` in the Next.js this package builds against
 * (read from its published types, so a Next upgrade that adds a key is seen
 * here rather than in production).
 */
function nextHandlerContextKeys(): string[] {
    const require = createRequire(join(PKG_ROOT, "package.json"));
    const nextRoot = dirname(require.resolve("next/package.json"));
    const dts = readFileSync(
        join(nextRoot, "dist/server/lib/incremental-cache/index.d.ts"),
        "utf8",
    );
    const body = /export interface CacheHandlerContext \{([\s\S]*?)\n\}/.exec(
        dts,
    )?.[1];
    if (body === undefined) {
        throw new Error(
            "could not find `interface CacheHandlerContext` in Next's incremental-cache types; the type moved, update this test's source",
        );
    }
    return [...body.matchAll(/^\s*([A-Za-z_$][\w$]*)\??:/gm)].map(
        (m) => m[1] as string,
    );
}

describe("CacheHandler constructor argument shapes", () => {
    it("reads Next's real handler-context keys (the parse is not vacuous)", () => {
        const keys = nextHandlerContextKeys();
        expect(keys).toContain("serverDistDir");
        expect(keys).toContain("revalidatedTags");
    });

    it("passes Next's real handler options object through unchanged", () => {
        // Every key Next declares, each holding a plain object. This proves the
        // real key set passes through unchanged; it does NOT by itself guard a
        // colliding `env` + `options` pair. Next's argument always carries other
        // keys (serverDistDir, revalidatedTags, ...), and the wrapper is only
        // recognised when it has exactly those two keys, so a future Next adding
        // both is caught by the "carrying BOTH `env` and `options` plus its own
        // keys" test below, which is the real guard.
        const arg = Object.fromEntries(
            nextHandlerContextKeys().map((k) => [k, { sentinel: k }]),
        );
        expect(new CacheHandler(arg).options).toBe(arg);
    });

    it("does not mistake a Next-shaped argument that carries an `env` key for the vinext wrapper", () => {
        const arg = { serverDistDir: "/app/.next/server", env: "production" };
        expect(new CacheHandler(arg).options).toBe(arg);
    });

    it("does not mistake a Next-shaped argument that carries an `options` key for the vinext wrapper", () => {
        const arg = { serverDistDir: "/app/.next/server", options: {} };
        expect(new CacheHandler(arg).options).toBe(arg);
    });

    it("does not mistake a Next-shaped argument carrying BOTH `env` and `options` plus its own keys for the wrapper", () => {
        const arg = {
            serverDistDir: "/app/.next/server",
            revalidatedTags: [],
            env: {},
            options: { maxMemoryCacheSize: 1 },
        };
        expect(new CacheHandler(arg).options).toBe(arg);
    });

    it("an `env` key with a non-object `options` is not the wrapper", () => {
        const arg = { env: {}, options: "not-an-object" };
        expect(new CacheHandler(arg).options).toBe(arg);
    });

    it("unwraps vinext's { env, options } to its options", () => {
        const options = { maxMemoryCacheSize: 5 };
        expect(new CacheHandler({ env: {}, options }).options).toBe(options);
    });

    it("unwraps vinext's wrapper when it has no options (the factory is called with options undefined)", () => {
        expect(
            new CacheHandler({ env: {}, options: undefined }).options,
        ).toBeUndefined();
        expect(
            new CacheHandler({ env: undefined, options: undefined }).options,
        ).toBeUndefined();
    });

    it("passes an absent argument through", () => {
        expect(new CacheHandler().options).toBeUndefined();
    });
});
