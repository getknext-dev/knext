import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The kn-next framework logger (`../utils/logger`) builds a named pino instance
// at module load and also exposes `createLogger(bindings)` for child scoping.
// In production it writes raw JSON (no pino-pretty worker); we pin its real,
// observable contract:
//   - constructs/exports without throwing,
//   - honors LOG_LEVEL, with a prod default of "info",
//   - carries the load-bearing `name: "kn-next"` binding,
//   - and `createLogger` returns a child that merges extra bindings.

function forceProdEnv() {
    // Force the raw-JSON branch — no pino-pretty transport worker under vitest.
    vi.stubEnv("NODE_ENV", "production");
    // Delete LOG_LEVEL (not ''): kn-next reads it via `??`, so an empty string
    // would survive and hand pino an invalid level.
    vi.stubEnv("LOG_LEVEL", undefined);
}

describe("kn-next logger — instance contract", () => {
    beforeEach(() => {
        vi.resetModules();
        forceProdEnv();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("constructs and exports a usable logger without throwing", async () => {
        const { logger } = await import("../utils/logger");
        expect(logger).toBeDefined();
        expect(typeof logger.info).toBe("function");
        expect(() => logger.info({ hello: "world" }, "ping")).not.toThrow();
    });

    it("honors LOG_LEVEL from the environment", async () => {
        vi.stubEnv("LOG_LEVEL", "error");
        const { logger } = await import("../utils/logger");
        expect(logger.level).toBe("error");
        expect(logger.isLevelEnabled("error")).toBe(true);
        expect(logger.isLevelEnabled("warn")).toBe(false);
    });

    it("defaults to info level in production when LOG_LEVEL is unset", async () => {
        const { logger } = await import("../utils/logger");
        expect(logger.level).toBe("info");
    });

    it("defaults to debug level outside production when LOG_LEVEL is unset", async () => {
        // The pretty transport is skipped by passing an explicit destination
        // via the pino mock, so this stays worker-free under vitest while
        // still exercising the real non-prod level default.
        vi.stubEnv("NODE_ENV", "development");
        const realPino = (await import("pino")).default;
        vi.doMock("pino", () => {
            const factory = (options: Record<string, unknown>) =>
                realPino(
                    { ...options, transport: undefined },
                    { write: () => {} },
                );
            return { default: factory };
        });
        const { logger } = await import("../utils/logger");
        expect(logger.level).toBe("debug");
        vi.doUnmock("pino");
    });

    it('carries the load-bearing name binding ("kn-next")', async () => {
        const { logger } = await import("../utils/logger");
        expect(logger.bindings().name).toBe("kn-next");
    });
});

describe("kn-next logger — createLogger child scoping", () => {
    beforeEach(() => {
        vi.resetModules();
        forceProdEnv();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("returns a child logger that merges extra bindings onto the base", async () => {
        const { createLogger } = await import("../utils/logger");
        const child = createLogger({ module: "deploy" });
        const bindings = child.bindings();
        // Child keeps the parent's name and adds its own scope.
        expect(bindings.name).toBe("kn-next");
        expect(bindings.module).toBe("deploy");
        expect(() =>
            child.info({ imageTag: "v1.0.0" }, "deploying"),
        ).not.toThrow();
    });
});
