import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Guards the REDIS_KEY_PREFIX drift surfaced by the architecture review (#2):
 * the manifest generator sets REDIS_KEY_PREFIX to the app name, but the
 * cache-handler falls back to 'kn-next' when the var is unset. If that fallback
 * happens silently while Redis is in use, ISR keys land in a different keyspace
 * than the rest of the app's pods. The cache-handler now warns loudly instead.
 *
 * cache-handler.js reads env at module load, so each case resets the module
 * registry and re-imports with a fresh environment.
 */
describe("cache-handler REDIS_KEY_PREFIX guard", () => {
    const original = { ...process.env };

    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        process.env = { ...original };
        vi.restoreAllMocks();
    });

    const matcher = expect.stringContaining("REDIS_KEY_PREFIX is unset");
    // Non-literal specifier: cache-handler.js is a plain-JS runtime shim with no
    // type declarations; a variable import avoids tsc's implicit-any on the module.
    const CACHE_HANDLER: string = "../adapters/cache-handler.js";

    it("warns when REDIS_URL is set but REDIS_KEY_PREFIX is not", async () => {
        process.env.REDIS_URL = "redis://localhost:6379";
        delete process.env.REDIS_KEY_PREFIX;
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        await import(CACHE_HANDLER);

        expect(warn).toHaveBeenCalledWith(matcher);
    });

    it("does not warn when REDIS_KEY_PREFIX is set", async () => {
        process.env.REDIS_URL = "redis://localhost:6379";
        process.env.REDIS_KEY_PREFIX = "my-app";
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        await import(CACHE_HANDLER);

        expect(warn).not.toHaveBeenCalledWith(matcher);
    });

    it("does not warn in in-memory mode (no REDIS_URL)", async () => {
        delete process.env.REDIS_URL;
        delete process.env.REDIS_KEY_PREFIX;
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        await import(CACHE_HANDLER);

        expect(warn).not.toHaveBeenCalledWith(matcher);
    });
});
