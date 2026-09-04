// The cache handler's mutating test seams fail closed on a published
// subpath (design-gate block, sprint close): the harness opts in.
process.env.KNEXT_TEST_SEAMS = "1";

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    spyOn,
} from "bun:test";

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

    beforeEach(async () => {
        // The cache-handler's own reset. It re-reads the env vars it caches in
        // module-level `let`s at load — which is all `vi.resetModules()` was
        // achieving here, and bun has no registry reset. Exported rather than
        // inferred: it states exactly which state this module owns.
        (await import("../adapters/cache-handler.js")).__resetEnvForTests();
    });

    afterEach(async () => {
        process.env = { ...original };
        jest.restoreAllMocks();
    });

    const matcher = expect.stringContaining("REDIS_KEY_PREFIX is unset");
    // Non-literal specifier: cache-handler.js is a plain-JS runtime shim with no
    // type declarations; a variable import avoids tsc's implicit-any on the module.
    const CACHE_HANDLER: string = "../adapters/cache-handler.js";

    it("warns when REDIS_URL is set but REDIS_KEY_PREFIX is not", async () => {
        process.env.REDIS_URL = "redis://localhost:6379";
        // The reset runs AFTER the env it reads is in place.
        // `__resetEnvForTests` recomputes `useRedis` from `REDIS_URL`, so
        // calling it in `beforeEach` — before this line — left the handler
        // disabled and every ISR write a no-op. The drain then had nothing to
        // await, `gracefulShutdown` exited immediately, and the test failed
        // saying the drain was not awaited when it had never been given work.
        (await import("../adapters/cache-handler.js")).__resetEnvForTests();
        delete process.env.REDIS_KEY_PREFIX;
        const warn = spyOn(console, "warn").mockImplementation(() => {});

        // `__resetEnvForTests()`, not a bare re-import. Under vitest the
        // `vi.resetModules()` in `beforeEach` made this `import` re-EVALUATE the
        // module, which is what emitted the warning. bun caches it, so the
        // import is a no-op and the warning was never re-run — the guard read as
        // missing when it was simply never invoked.
        //
        // Called HERE rather than in `beforeEach` on purpose: the spy has to be
        // installed first, or the warning fires unobserved and the assertion
        // fails for the opposite reason.
        (await import(CACHE_HANDLER)).__resetEnvForTests();

        expect(warn).toHaveBeenCalledWith(matcher);
    });

    it("does not warn when REDIS_KEY_PREFIX is set", async () => {
        process.env.REDIS_URL = "redis://localhost:6379";
        (await import("../adapters/cache-handler.js")).__resetEnvForTests();
        process.env.REDIS_KEY_PREFIX = "my-app";
        const warn = spyOn(console, "warn").mockImplementation(() => {});

        // `__resetEnvForTests()`, not a bare re-import. Under vitest the
        // `vi.resetModules()` in `beforeEach` made this `import` re-EVALUATE the
        // module, which is what emitted the warning. bun caches it, so the
        // import is a no-op and the warning was never re-run — the guard read as
        // missing when it was simply never invoked.
        //
        // Called HERE rather than in `beforeEach` on purpose: the spy has to be
        // installed first, or the warning fires unobserved and the assertion
        // fails for the opposite reason.
        (await import(CACHE_HANDLER)).__resetEnvForTests();

        expect(warn).not.toHaveBeenCalledWith(matcher);
    });

    it("does not warn in in-memory mode (no REDIS_URL)", async () => {
        delete process.env.REDIS_URL;
        delete process.env.REDIS_KEY_PREFIX;
        const warn = spyOn(console, "warn").mockImplementation(() => {});

        // `__resetEnvForTests()`, not a bare re-import. Under vitest the
        // `vi.resetModules()` in `beforeEach` made this `import` re-EVALUATE the
        // module, which is what emitted the warning. bun caches it, so the
        // import is a no-op and the warning was never re-run — the guard read as
        // missing when it was simply never invoked.
        //
        // Called HERE rather than in `beforeEach` on purpose: the spy has to be
        // installed first, or the warning fires unobserved and the assertion
        // fails for the opposite reason.
        (await import(CACHE_HANDLER)).__resetEnvForTests();

        expect(warn).not.toHaveBeenCalledWith(matcher);
    });
});
