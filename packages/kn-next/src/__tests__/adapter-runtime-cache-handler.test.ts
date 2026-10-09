/**
 * #1843 — the build picks the cache handler for the configured runtime.
 *
 * `knext build`/`deploy`/`preview` export the app's runtime to `next build`
 * (`KNEXT_RUNTIME`), and the knext adapter's `modifyConfig` points a knext
 * `cacheHandler` at the per-runtime entry:
 *
 *   - node → `cache-handler-node.js`, whose LITERAL `import('ioredis')` Next's
 *     standalone tracing follows into the node image;
 *   - bun  → `cache-handler-bun.js`, Bun's native client, no ioredis.
 *
 * A user's own handler, an unset runtime (`next dev`, a plain `next build`)
 * and an unknown runtime value all leave `cacheHandler` alone.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import adapter from "../adapters/next-adapter";
import { KNEXT_RUNTIME_ENV } from "../adapters/runtime-env";

type ModifyConfig = NonNullable<typeof adapter.modifyConfig>;
const modifyConfig = adapter.modifyConfig as ModifyConfig;

const dir = mkdtempSync(join(tmpdir(), "knext-adapter-rt-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const saved = process.env.KNEXT_RUNTIME;
afterEach(() => {
    if (saved === undefined) delete process.env.KNEXT_RUNTIME;
    else process.env.KNEXT_RUNTIME = saved;
});

function file(name: string, body: string): string {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
}

// The one-line re-export every knext scaffold generates (cache-handler.js.hbs).
const KNEXT_REEXPORT = file(
    "cache-handler.js",
    'export { default } from "@getknext/core/adapters/cache-handler";\n',
);
const USER_HANDLER = file(
    "my-cache-handler.js",
    "export default class MyHandler { async get() { return null; } async set() {} }\n",
);

function run(runtime: string | undefined, cacheHandler: string) {
    if (runtime === undefined) delete process.env.KNEXT_RUNTIME;
    else process.env.KNEXT_RUNTIME = runtime;
    spyOn(console, "log").mockImplementation(() => {});
    const out = modifyConfig(
        {
            cacheHandler,
            images: { customCacheHandler: false },
        } as Parameters<ModifyConfig>[0],
        { phase: "phase-production-build" } as Parameters<ModifyConfig>[1],
    ) as { cacheHandler?: string; images?: { customCacheHandler?: boolean } };
    return out;
}

describe("adapter.modifyConfig — cacheHandler follows the configured runtime (#1843)", () => {
    it("names the env var the CLI exports", () => {
        expect(KNEXT_RUNTIME_ENV).toBe("KNEXT_RUNTIME");
    });

    it("node → the node entry (literal ioredis import, traced into the image)", () => {
        const out = run("node", KNEXT_REEXPORT);
        expect(out.cacheHandler).toMatch(
            /[\\/]adapters[\\/]cache-handler-node\.js$/,
        );
    });

    it("bun → the bun entry (Bun native client)", () => {
        const out = run("bun", KNEXT_REEXPORT);
        expect(out.cacheHandler).toMatch(
            /[\\/]adapters[\\/]cache-handler-bun\.js$/,
        );
    });

    it("the selected entry is still recognised as knext's, so images keep routing through it", () => {
        expect(run("node", KNEXT_REEXPORT).images?.customCacheHandler).toBe(
            true,
        );
        expect(run("bun", KNEXT_REEXPORT).images?.customCacheHandler).toBe(
            true,
        );
    });

    it("no runtime exported (next dev, a plain next build) → the app's handler is kept", () => {
        expect(run(undefined, KNEXT_REEXPORT).cacheHandler).toBe(
            KNEXT_REEXPORT,
        );
    });

    it("an unknown runtime value → the app's handler is kept, never guessed", () => {
        expect(run("deno", KNEXT_REEXPORT).cacheHandler).toBe(KNEXT_REEXPORT);
    });

    it("a user's own handler is never replaced", () => {
        expect(run("node", USER_HANDLER).cacheHandler).toBe(USER_HANDLER);
        expect(run("bun", USER_HANDLER).cacheHandler).toBe(USER_HANDLER);
    });
});
