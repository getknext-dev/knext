/**
 * The #1888 seed depends on a private Next module
 * (`shared-cache-controls.external.js`). If a future Next renames it or changes
 * its shape, the handler fails open — and must SAY so, once per process, or the
 * stale-after-wake bug returns silently.
 *
 * Its own file: `mock.module` replaces the module for the whole file.
 */
process.env.KNEXT_TEST_SEAMS = "1";

import { afterAll, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A Next whose module no longer exposes the Map.
mock.module(
    "next/dist/server/lib/incremental-cache/shared-cache-controls.external.js",
    () => ({ SharedCacheControls: {} }),
);

function distWithBuildId(id: string): string {
    const next = join(mkdtempSync(join(tmpdir(), "knext-1888w-")), ".next");
    mkdirSync(join(next, "server"), { recursive: true });
    writeFileSync(join(next, "BUILD_ID"), id);
    return join(next, "server");
}

const warn = spyOn(console, "warn");
afterAll(() => warn.mockRestore());

describe("next cache-controls module unavailable (#1888)", () => {
    it("warns once per process, structured, and the read still succeeds", async () => {
        delete process.env.REDIS_URL;
        const dist = distWithBuildId("b1");
        const mod = (await import(
            `../adapters/cache-handler.js?missing=${Math.random()}`
        )) as {
            default: new (
                o: unknown,
            ) => {
                get: (k: string, ctx?: unknown) => Promise<unknown>;
            };
            __setRedisClientForTests: (c: unknown) => void;
        };
        const stored = JSON.stringify({
            buildId: "b1",
            value: { kind: "APP_PAGE", html: "x", headers: {}, status: 200 },
            lastModified: Date.now() - 60_000,
            tags: [],
            cacheControl: { revalidate: 3600 },
        });
        const client = {
            connected: true,
            async connect() {},
            async get() {
                return stored;
            },
            async send() {
                return "OK";
            },
        };
        warn.mockClear();
        for (const key of ["/isr/one", "/isr/two", "/isr/three"]) {
            const handler = new mod.default({ serverDistDir: dist });
            mod.__setRedisClientForTests(client);
            const entry = await handler.get(key, { kind: "APP_PAGE" });
            expect(
                entry,
                "fail-open: the entry is still returned",
            ).not.toBeNull();
        }
        const ours = warn.mock.calls
            .map((args) => String(args[0]))
            .filter((line) => line.includes("next_cache_controls_unavailable"));
        expect(ours.length, `warnings: ${JSON.stringify(ours)}`).toBe(1);
        const event = JSON.parse(ours[0] as string);
        expect(event.level).toBe("warn");
        expect(event.module).toContain("shared-cache-controls.external");
    });
});
